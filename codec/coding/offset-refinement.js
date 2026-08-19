/** Exact pre-context and committed offset refinement for over-budget ATRAC3plus units. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'

import { planCodeTableSection } from '../io/code-table-syntax.js'
import { CodeTableAccountingTransaction } from '../state/code-table.js'
import {
  priceSpectrumBand,
  selectSpectrumCodeTable,
} from './spectrum-pricing.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../state/spectrum-pricing.js'

/**
 * Verify the coding-unit geometry and per-channel pricing work required by speculative offset refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 */
function validateRequest(transaction) {
  if (
    transaction.channelCount < 1 ||
    transaction.channelCount > CODING_UNIT_MAX_CHANNELS ||
    transaction.bandCount < 1 ||
    transaction.bandCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(transaction.allocationBudgetBits)
  ) {
    throw new RangeError('ATRAC3plus offset refinement is not ready')
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
      throw new RangeError('ATRAC3plus offset-refine channel is invalid')
    }
  }
}

/**
 * Reprice one active-context band and publish its exact spectrum-cost delta.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} channel
 * @param {number} band
 */
function repriceActiveBand(transaction, channel, band) {
  const block = transaction.channelBlocks[channel]
  const context = block.syntax.codeTableContext & 1
  const pricing = transaction.spectrumPricingStates[channel]
  const priced = transaction.spectrumPricedBands[channel]
  const thresholds =
    transaction.sourceChannels[channel].quantizationThresholdScales
  const oldBits = pricing.selectedCost(context, band)
  priceSpectrumBand(
    pricing,
    transaction.normalizedSpectra[channel],
    thresholds,
    context,
    band,
    block.syntax.wordLengths[band],
    transaction.quantizationOffsets[channel][band],
    priced
  )
  const delta = pricing.commit(priced, context) - oldBits
  transaction.spectrumBits[channel][context] += delta
  transaction.bitsTotal += delta
}

/**
 * Choose the bounded number of offset-refinement rounds from one retained origin image.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} startBand
 * @param {number} bandCount
 * @param {number} maximumOffset
 * @param {Int32Array[]} origins Per-channel starting offsets.
 * @returns {number}
 */
function offsetRefinementRoundCount(
  transaction,
  startBand,
  bandCount,
  maximumOffset,
  origins
) {
  let rounds = 0
  for (let band = bandCount - 1; band >= startBand; band--) {
    for (let channel = 0; channel < transaction.channelCount; channel++) {
      if (transaction.channelBlocks[channel].syntax.wordLengths[band] < 1) {
        continue
      }
      rounds = Math.max(rounds, maximumOffset - origins[channel][band])
    }
  }
  return Math.max(rounds, 0)
}

/**
 * Walk high bands in reference order until the staged allocation fits its budget.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} startBand
 * @param {number} maximumOffset
 * @param {number} bandCount
 * @returns {number} Resulting exact allocation width.
 */
function runPrecommitOffsetReduction(
  transaction,
  startBand,
  maximumOffset,
  bandCount
) {
  const rounds = offsetRefinementRoundCount(
    transaction,
    startBand,
    bandCount,
    maximumOffset,
    transaction.quantizationOffsets
  )
  for (let round = 0; round < rounds; round++) {
    if (transaction.bitsTotal <= transaction.allocationBudgetBits) break
    for (let band = bandCount - 1; band >= startBand; band--) {
      for (let channel = 0; channel < transaction.channelCount; channel++) {
        if (transaction.bitsTotal <= transaction.allocationBudgetBits) {
          return transaction.bitsTotal
        }
        if (transaction.channelBlocks[channel].syntax.wordLengths[band] < 1) {
          continue
        }
        const candidate = transaction.quantizationOffsets[channel][band] + 1
        if (candidate > maximumOffset) continue
        transaction.quantizationOffsets[channel][band] = candidate
        repriceActiveBand(transaction, channel, band)
      }
    }
  }
  return transaction.recomputeBits()
}

/**
 * Raise planned offsets until the unit fits or the configured frontier ends.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @returns {number} Resulting exact allocation width.
 */
export function raisePrecommitOffsetsToBudget(transaction) {
  validateRequest(transaction)
  const maximumOffset = transaction.cbIterationLimit
  const startBand = transaction.cbStartBand
  const bandCount = transaction.bandCount
  if (
    transaction.bitsTotal <= transaction.allocationBudgetBits ||
    maximumOffset <= 0 ||
    startBand < 0 ||
    startBand >= bandCount
  ) {
    return transaction.bitsTotal
  }
  return runPrecommitOffsetReduction(
    transaction,
    startBand,
    maximumOffset,
    bandCount
  )
}

/**
 * Verify finalized scale-factor geometry and code-table accounting before committed offset refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {number} scaleFactorCount
 */
function validateCommittedRequest(transaction, shared, scaleFactorCount) {
  validateRequest(transaction)
  if (
    !shared ||
    !Number.isInteger(scaleFactorCount) ||
    scaleFactorCount < 0 ||
    scaleFactorCount > transaction.bandCount ||
    !(
      transaction.codeTableTransaction instanceof CodeTableAccountingTransaction
    )
  ) {
    throw new RangeError('ATRAC3plus committed offset refinement is not ready')
  }
}

/**
 * Retain the starting offset row used to generate each bounded refinement round.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} startBand First retained band.
 * @param {number} bandCount End-exclusive retained band.
 */
function captureOffsetOrigins(transaction, startBand, bandCount) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    for (let band = startBand; band < bandCount; band++) {
      transaction.checkpointWordLengths[channel][band] =
        transaction.quantizationOffsets[channel][band]
    }
  }
}

/**
 * Rebuild code-table accounting for spectrum whose quantization offset is already committed.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function prepareCommittedCodeTable(transaction, shared) {
  if (transaction.codeTableCostAvailable) {
    if (
      !transaction.codeTableTransaction.initialized ||
      transaction.codeTableTransaction.bits !== transaction.codeTableBits
    ) {
      throw new RangeError(
        'ATRAC3plus committed code-table accounting is stale'
      )
    }
    return
  }
  planCodeTableSection(
    transaction.channelBlocks,
    shared,
    true,
    transaction.codeTableTransaction
  ).retainAccountedBits(transaction.codeTableBits)
}

/**
 * Index the committed-probe ledger by channel, band, and candidate slot.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} channel
 * @param {number} band
 * @param {number} candidateOffset
 * @returns {number}
 */
function probeCommittedOffset(transaction, channel, band, candidateOffset) {
  const block = transaction.channelBlocks[channel]
  const active = block.syntax.codeTableContext & 1
  const mode = block.syntax.wordLengths[band]
  const priced = transaction.spectrumPricedBands[channel]
  priceSpectrumBand(
    transaction.spectrumPricingStates[channel],
    transaction.normalizedSpectra[channel],
    transaction.sourceChannels[channel].quantizationThresholdScales,
    active,
    band,
    mode,
    candidateOffset,
    priced
  )
  return selectSpectrumCodeTable(transaction, channel, priced)
}

/**
 * Publish the selected quantization offset and its fully repriced sidechain accounting.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} channel
 * @param {number} band
 * @param {number} candidateOffset
 * @param {PricedSpectrumBand} choice Selected spectrum and code-table representation.
 */
function commitOffsetChoice(
  transaction,
  channel,
  band,
  candidateOffset,
  choice
) {
  const block = transaction.channelBlocks[channel]
  const active = block.syntax.codeTableContext & 1
  transaction.quantizationOffsets[channel][band] = candidateOffset
  if (transaction.codeTableTransaction.candidateReady) {
    transaction.codeTableTransaction.acceptCandidate()
  }
  block.syntax.codeTables[band] = choice.selectedIndex
  transaction.spectrumPricingStates[channel].commit(
    transaction.spectrumPricedBands[channel],
    active,
    choice.selectedIndex
  )
  transaction.spectrumBits[channel][active] += choice.spectrumDelta
  transaction.codeTableBits = choice.codeTableBits
  transaction.bitsTotal += choice.delta
}

/**
 * Probe negative-cost committed offsets in correction order until the allocation fits.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {number} scaleFactorCount
 * @returns {number} Resulting exact allocation width.
 */
function runCommittedReduction(transaction, shared, scaleFactorCount) {
  prepareCommittedCodeTable(transaction, shared)
  const startBand = transaction.cbStartBand
  const minimumBand =
    scaleFactorCount <= startBand
      ? Math.max(startBand - 2, 0)
      : Math.max(startBand, 0)
  captureOffsetOrigins(transaction, minimumBand, scaleFactorCount)
  const rounds = offsetRefinementRoundCount(
    transaction,
    minimumBand,
    scaleFactorCount,
    15,
    transaction.checkpointWordLengths
  )
  let changed = false
  for (let round = 0; round < rounds; round++) {
    if (transaction.bitsTotal <= transaction.allocationBudgetBits) break
    for (let band = scaleFactorCount - 1; band >= minimumBand; band--) {
      for (let channel = 0; channel < transaction.channelCount; channel++) {
        if (transaction.channelBlocks[channel].syntax.wordLengths[band] < 1) {
          continue
        }
        const initial = transaction.checkpointWordLengths[channel][band]
        const candidateOffset = initial + round + 1
        if (candidateOffset > 15) continue
        const choice = probeCommittedOffset(
          transaction,
          channel,
          band,
          candidateOffset
        )
        if (choice.delta >= 0) {
          if (transaction.codeTableTransaction.candidateReady) {
            transaction.codeTableTransaction.discardCandidate()
          }
          continue
        }
        commitOffsetChoice(transaction, channel, band, candidateOffset, choice)
        changed = true
        if (transaction.bitsTotal <= transaction.allocationBudgetBits) {
          transaction.codeTableCostAvailable = true
          transaction.quantizationDirty ||= changed
          return transaction.bitsTotal
        }
      }
    }
  }
  transaction.codeTableCostAvailable = true
  transaction.quantizationDirty ||= changed
  return transaction.bitsTotal
}

/**
 * Raise committed offsets in the live allocation transaction.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @returns {number} Resulting exact allocation width.
 */
export function reduceCommittedAllocationToBudget(transaction, shared) {
  const scaleFactorCount = shared?.scaleFactorCount
  validateCommittedRequest(transaction, shared, scaleFactorCount)
  if (
    transaction.bitsTotal <= transaction.allocationBudgetBits ||
    scaleFactorCount === 0
  ) {
    return transaction.bitsTotal
  }
  try {
    return runCommittedReduction(transaction, shared, scaleFactorCount)
  } catch (error) {
    transaction.codeTableTransaction.discardCandidate()
    throw error
  }
}
