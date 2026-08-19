/** Exact multi-round spending of an ATRAC3plus allocation bit surplus. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  TARGET_DEFERRED,
  TARGET_EXHAUSTED,
  TARGET_LIVE,
  TARGET_RETIRED,
  ALLOCATION_BASE_BITS,
  WORD_LENGTH_MODE_BITS,
} from '../core/constants.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { planCodeTableSection } from '../io/code-table-syntax.js'
import { CodeTableAccountingTransaction } from '../state/code-table.js'
import {
  planWordLengthSection,
  repriceWordLengthSection,
} from '../io/word-length-syntax.js'
import { WordLengthAccountingTransaction } from '../state/word-length.js'
import {
  priceSpectrumBand,
  selectSpectrumCodeTable,
} from './spectrum-pricing.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../state/spectrum-pricing.js'

/**
 * Verify that the incumbent ordering, exact accounting, and per-channel rollback work are ready to spend spare bits.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function validateFill(transaction, shared) {
  const bandCount = transaction.bandCount
  if (
    !shared ||
    transaction.channelCount < 1 ||
    transaction.channelCount > CODING_UNIT_MAX_CHANNELS ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT ||
    transaction.allocationBandOrder.count !==
      transaction.channelCount * bandCount ||
    transaction.allocationBandOrder.bandCount !== bandCount ||
    !Number.isInteger(transaction.allocationBudgetBits) ||
    transaction.allocationBudgetBits < 0 ||
    !(
      transaction.wordLengthTransaction instanceof
      WordLengthAccountingTransaction
    ) ||
    !transaction.wordLengthTransaction.initialized ||
    transaction.wordLengthTransaction.rawOnly ||
    !(
      transaction.codeTableTransaction instanceof CodeTableAccountingTransaction
    )
  ) {
    throw new RangeError('ATRAC3plus budget fill is not ready')
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    if (
      !transaction.channelBlocks[channel]?.syntax ||
      !(
        transaction.spectrumPricingStates[channel] instanceof
        SpectrumPricingState
      ) ||
      !(transaction.spectrumPricedBands[channel] instanceof PricedSpectrumBand)
    ) {
      throw new RangeError('ATRAC3plus budget-fill channel binding is invalid')
    }
  }
}

/**
 * Measure the initial code-table plans and seed exact per-context spectrum totals.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function initializeCodeTableAccounting(transaction, shared) {
  planCodeTableSection(
    transaction.channelBlocks,
    shared,
    true,
    transaction.codeTableTransaction
  )
  transaction.replaceCodeTableBits(transaction.codeTableTransaction.bits)
  transaction.codeTableCostAvailable = true
}

/**
 * Snapshot only the syntax rows and accounting changed by a speculative batch.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 */
function captureCheckpoint(transaction) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    transaction.checkpointWordLengths[channel].set(block.syntax.wordLengths)
    const active = block.syntax.codeTableContext & 1
    transaction.checkpointSpectrumBits[channel] =
      transaction.spectrumBits[channel][active]
    transaction.spectrumPricingStates[channel].captureWorkContext(active)
  }
}

/**
 * Restore batch-owned syntax and accounting, then rebuild its packing plans.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function restoreCheckpoint(transaction, shared) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    block.syntax.wordLengths.set(transaction.checkpointWordLengths[channel])
    const active = block.syntax.codeTableContext & 1
    transaction.spectrumBits[channel][active] =
      transaction.checkpointSpectrumBits[channel]
    const pricing = transaction.spectrumPricingStates[channel]
    pricing.restoreWorkContext(active)
    const start = active * QUANTIZATION_UNIT_COUNT
    block.syntax.codeTables.set(
      pricing.selectedIndices.subarray(start, start + QUANTIZATION_UNIT_COUNT)
    )
  }
  planWordLengthSection(
    transaction.channelBlocks,
    shared.bandLimit,
    shared.shapeCount,
    transaction.wordLengthTransaction
  )
  planCodeTableSection(
    transaction.channelBlocks,
    shared,
    true,
    transaction.codeTableTransaction
  )
  transaction.wordLengthBits = transaction.wordLengthTransaction.bits
  transaction.codeTableBits = transaction.codeTableTransaction.bits
  transaction.recomputeBits()
}

/**
 * Compute the smallest useful bit target for the remaining fill pass.
 *
 * @param {number} band
 * @returns {number}
 */
function minimumTargetBits(band) {
  const coefficientGroups =
    (QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]) >> 4
  return Math.max(coefficientGroups, ALLOCATION_BASE_BITS)
}

/**
 * Restore one rejected raise and retain its exact deferred state in the fill workspace.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} target Ordered fill target index.
 * @param {number} candidateTotal Exact rejected allocation width.
 * @returns {false}
 */
function deferRaise(transaction, target, candidateTotal) {
  transaction.wordLengthTransaction.discardCandidate()
  transaction.codeTableTransaction.discardCandidate()
  const overage = candidateTotal - transaction.allocationBudgetBits
  transaction.quantizationUnits[target] =
    transaction.quantizationUnits[target] === TARGET_DEFERRED ||
    overage >= ALLOCATION_BASE_BITS
      ? TARGET_RETIRED
      : TARGET_DEFERRED
  transaction.initialWordLengths[target] =
    candidateTotal - transaction.bitsTotal
  return false
}

/**
 * Probe the next quantization mode for one band and commit it only when the remaining budget permits.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} target Ordered fill target index.
 * @param {number} channel
 * @param {number} band
 * @param {number} budgetBits Maximum width for this scheduling policy.
 * @param {boolean} exactSidechains Whether to reprice word-length syntax before deciding.
 * @returns {boolean} Whether the raise was accepted.
 */
function tryRaiseBand(
  transaction,
  target,
  channel,
  band,
  budgetBits,
  exactSidechains
) {
  const block = transaction.channelBlocks[channel]
  const oldMode = block.syntax.wordLengths[band]
  const maximum =
    transaction.sourceChannels[channel].maximumQuantizationModes[band]
  if (
    oldMode <= 0 ||
    oldMode >= maximum ||
    transaction.quantizationOffsets[channel][band] > 0x0e
  ) {
    transaction.quantizationUnits[target] = TARGET_EXHAUSTED
    return false
  }

  const active = block.syntax.codeTableContext & 1
  const pricing = transaction.spectrumPricingStates[channel]
  const priced = transaction.spectrumPricedBands[channel]
  block.syntax.wordLengths[band] = oldMode + 1
  try {
    priceSpectrumBand(
      pricing,
      transaction.normalizedSpectra[channel],
      transaction.sourceChannels[channel].quantizationThresholdScales,
      active,
      band,
      oldMode + 1,
      transaction.quantizationOffsets[channel][band],
      priced
    )
    const choice = selectSpectrumCodeTable(transaction, channel, priced)
    let wordLength = transaction.wordLengthBits
    let candidateTotal = transaction.bitsTotal + choice.delta
    if (exactSidechains) {
      const minimumWordLengthBits =
        transaction.channelCount * WORD_LENGTH_MODE_BITS
      const minimumCandidateTotal =
        candidateTotal + minimumWordLengthBits - wordLength
      if (minimumCandidateTotal > budgetBits) {
        block.syntax.wordLengths[band] = oldMode
        return deferRaise(transaction, target, minimumCandidateTotal)
      }
      wordLength = repriceWordLengthSection(
        transaction.channelBlocks,
        channel,
        band,
        transaction.wordLengthTransaction
      )
      candidateTotal += wordLength - transaction.wordLengthBits
    }
    if (candidateTotal > budgetBits) {
      block.syntax.wordLengths[band] = oldMode
      if (exactSidechains) {
        return deferRaise(transaction, target, candidateTotal)
      }
      transaction.codeTableTransaction.discardCandidate()
      return false
    }

    if (exactSidechains) {
      transaction.wordLengthTransaction.acceptCandidate()
    }
    if (transaction.codeTableTransaction.candidateReady) {
      transaction.codeTableTransaction.acceptCandidate()
    }
    block.syntax.codeTables[band] = choice.selectedIndex
    pricing.commit(priced, active, choice.selectedIndex)
    transaction.spectrumBits[channel][active] += choice.spectrumDelta
    transaction.wordLengthBits = wordLength
    transaction.codeTableBits = choice.codeTableBits
    transaction.bitsTotal = candidateTotal
    transaction.quantizationUnits[target] =
      oldMode + 1 >= maximum ? TARGET_EXHAUSTED : TARGET_LIVE
    return true
  } catch (error) {
    block.syntax.wordLengths[band] = oldMode
    transaction.wordLengthTransaction.discardCandidate()
    transaction.codeTableTransaction.discardCandidate()
    throw error
  }
}

/**
 * Sweep the prioritized bands once and retain every affordable bit-budget
 * improvement.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @returns {boolean} Whether the round accepted any band raise.
 */
function scanRound(transaction) {
  const order = transaction.allocationBandOrder
  // Second-pass inputs are dead before fill, so their integer rows become the
  // target-state and deferred-delta workspace for this phase.
  const states = transaction.quantizationUnits
  let changed = false
  for (let index = 0; index < order.count; index++) {
    const state = states[index]
    if (state === TARGET_EXHAUSTED || state === TARGET_RETIRED) continue
    if (
      state === TARGET_DEFERRED &&
      transaction.bitsTotal + transaction.initialWordLengths[index] >
        transaction.allocationBudgetBits
    ) {
      continue
    }
    const channel = order.channel(index)
    const band = order.band(index)
    if (
      transaction.bitsTotal + minimumTargetBits(band) >
      transaction.allocationBudgetBits
    ) {
      continue
    }
    const raised = tryRaiseBand(
      transaction,
      index,
      channel,
      band,
      transaction.allocationBudgetBits,
      true
    )
    changed ||= raised
  }
  return changed
}

/**
 * Spend the remaining budget after exact code-table accounting is current.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @returns {number} Resulting exact allocation width.
 */
function fillPreparedBudgetExactly(transaction) {
  transaction.quantizationUnits.fill(TARGET_LIVE)
  transaction.initialWordLengths.fill(0)
  let changed = false
  if (
    transaction.bitsTotal + ALLOCATION_BASE_BITS <=
    transaction.allocationBudgetBits
  ) {
    for (;;) {
      if (!scanRound(transaction)) {
        break
      }
      changed = true
    }
  }
  transaction.codeTableCostAvailable = true
  transaction.quantizationDirty ||= changed
  return transaction.bitsTotal
}

/**
 * Initialize exact code-table accounting, then spend the remaining budget.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @returns {number} Resulting exact allocation width.
 */
function fillBudgetExactly(transaction, shared) {
  initializeCodeTableAccounting(transaction, shared)
  return fillPreparedBudgetExactly(transaction)
}

/**
 * Publish exact whole-section accounting after a batch of mode changes.
 *
 * Unlike the exact probe loop this reprices the coupled word-length and
 * code-table sections once per batch, rather than once per accepted band.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function commitBatchedSidechains(transaction, shared) {
  planWordLengthSection(
    transaction.channelBlocks,
    shared.bandLimit,
    shared.shapeCount,
    transaction.wordLengthTransaction
  )
  planCodeTableSection(
    transaction.channelBlocks,
    shared,
    true,
    transaction.codeTableTransaction
  )
  transaction.replaceWordLengthBits(transaction.wordLengthTransaction.bits)
  transaction.replaceCodeTableBits(transaction.codeTableTransaction.bits)
  transaction.recomputeBits()
}

/**
 * Follow the coherent band order using fixed storage. Obvious
 * upgrades are committed with spectrum-exact arithmetic; only the syntax edge
 * is handed back to the exact probe loop.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @returns {number} Resulting exact allocation width.
 */
function fillRemainingBitBudgetBatched(transaction, shared) {
  validateFill(transaction, shared)
  initializeCodeTableAccounting(transaction, shared)
  const order = transaction.allocationBandOrder
  // The quantization-unit row is no longer consumed after the second pass.
  const visited = transaction.quantizationUnits
  visited.fill(TARGET_LIVE)

  // Preserve enough room for coupled word-length/code-table syntax. The exact
  // loop below spends this small edge after the batch has been validated.
  const batchLimit = Math.max(0, transaction.allocationBudgetBits - 128)
  let estimatedTotal = transaction.bitsTotal
  let changed = false
  for (;;) {
    captureCheckpoint(transaction)
    let roundChanged = false
    let completeRound = true
    for (let index = 0; index < order.count; index++) {
      if (visited[index] === TARGET_EXHAUSTED) continue
      const channel = order.channel(index)
      const band = order.band(index)
      if (estimatedTotal + minimumTargetBits(band) > batchLimit) {
        completeRound = false
        break
      }
      if (!tryRaiseBand(transaction, index, channel, band, batchLimit, false)) {
        if (visited[index] === TARGET_EXHAUSTED) continue
        completeRound = false
        break
      }
      estimatedTotal = transaction.bitsTotal
      roundChanged = true
    }
    if (!completeRound) {
      restoreCheckpoint(transaction, shared)
      estimatedTotal = transaction.bitsTotal
      break
    }
    commitBatchedSidechains(transaction, shared)
    estimatedTotal = transaction.bitsTotal
    if (!roundChanged || estimatedTotal > batchLimit) {
      if (estimatedTotal > batchLimit) {
        restoreCheckpoint(transaction, shared)
        estimatedTotal = transaction.bitsTotal
      }
      break
    }
    changed = true
  }

  // Finish only the syntax-coupled edge with the exact rule.
  fillPreparedBudgetExactly(transaction)
  transaction.codeTableCostAvailable = true
  transaction.quantizationDirty ||= changed
  return transaction.bitsTotal
}

/**
 * Select the fill kernel for the measured rate regime.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {boolean} batchCompleteRounds Whether complete rounds are large enough to amortize batching.
 * @returns {number}
 */
export function fillRemainingBitBudget(
  transaction,
  shared,
  batchCompleteRounds
) {
  if (batchCompleteRounds) {
    return fillRemainingBitBudgetBatched(transaction, shared)
  }
  validateFill(transaction, shared)
  return fillBudgetExactly(transaction, shared)
}
