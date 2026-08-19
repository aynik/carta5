/** Directional global-offset search for the ATRAC3plus second allocation pass. */

import {
  CODING_UNIT_MAX_CHANNELS,
  DIRECTION_LOWER,
  DIRECTION_RAISE,
  MAX_ITERATION,
  OFFSET_MAX_UNITS,
  OFFSET_MIN_UNITS,
  OFFSET_SCALE,
  QUANTIZATION_UNIT_COUNT,
  SECOND_PASS_TARGET_FACTOR,
} from '../core/constants.js'
import { effectiveAllocationBand } from '../core/geometry.js'
import { secondPassOffsetWeight } from './allocation-policy.js'

import { initializeQuantizationOffsets } from './quantization-offset.js'
import { priceSpectrumBand } from './spectrum-pricing.js'
import { raisePrecommitOffsetsToBudget } from './offset-refinement.js'
import { planWordLengthSection } from '../io/word-length-syntax.js'
import { WordLengthAccountingTransaction } from '../state/word-length.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../state/spectrum-pricing.js'

/**
 * Verify the raw incumbent, offset plans, budget, and paired pricing snapshots required by the directional second pass.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function validateSecondPass(transaction, shared) {
  if (
    !shared ||
    transaction.channelCount < 1 ||
    transaction.channelCount > CODING_UNIT_MAX_CHANNELS ||
    !(
      transaction.wordLengthTransaction instanceof
      WordLengthAccountingTransaction
    ) ||
    !transaction.wordLengthTransaction.rawOnly ||
    !Number.isInteger(transaction.allocationBudgetBits) ||
    transaction.allocationBudgetBits < 0
  ) {
    throw new RangeError('ATRAC3plus second allocation pass is not ready')
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
      throw new RangeError('ATRAC3plus second-pass channel binding is invalid')
    }
  }
}

/**
 * Clamp a directional search step to a valid quantization mode.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} channel
 * @param {number} band
 * @param {number} offset
 * @returns {number}
 */
function targetMode(transaction, channel, band, offset) {
  const effectiveBand = effectiveAllocationBand(
    band,
    transaction.sampleRateHz,
    transaction.bandCount
  )
  const weight = secondPassOffsetWeight(effectiveBand, offset > 0)
  const weightedOffset = Math.fround(weight * offset)
  const target = Math.fround(
    Math.fround(
      weightedOffset +
        transaction.baseAllocationScores[
          channel * QUANTIZATION_UNIT_COUNT + band
        ]
    ) + Math.fround(0.5)
  )
  const rounded = Math.trunc(target)
  const maximum =
    transaction.sourceChannels[channel].maximumQuantizationModes[band]
  return rounded > maximum ? maximum : rounded <= 0 ? 1 : rounded
}

/**
 * Apply one directional quantization-offset step to the live word-length rows.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} offsetUnits
 * @param {boolean} firstEvaluation
 * @returns {number}
 */
function applyOffset(transaction, offsetUnits, firstEvaluation) {
  const offset = Math.fround(offsetUnits / OFFSET_SCALE)
  let canLower = false
  let canRaise = false
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    const modes = block.syntax.wordLengths
    const context = block.syntax.codeTableContext & 1
    const pricing = transaction.spectrumPricingStates[channel]
    const priced = transaction.spectrumPricedBands[channel]
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    let spectrumBits = transaction.spectrumBits[channel][context]
    for (let band = 0; band < transaction.bandCount; band++) {
      if (
        transaction.initialWordLengths[
          channel * QUANTIZATION_UNIT_COUNT + band
        ] === 0
      ) {
        continue
      }
      const previousMode = modes[band]
      const mode = targetMode(transaction, channel, band, offset)
      modes[band] = mode
      const maximum =
        transaction.sourceChannels[channel].maximumQuantizationModes[band]
      canLower ||= mode > 1
      canRaise ||= mode > 0 && mode < maximum
      const forced =
        firstEvaluation &&
        mode > 0 &&
        transaction.quantizationOffsets[channel][band] > 0
      if (!forced && mode === previousMode) continue
      const oldBits = previousMode > 0 ? pricing.selectedCost(context, band) : 0
      priceSpectrumBand(
        pricing,
        transaction.normalizedSpectra[channel],
        thresholds,
        context,
        band,
        mode,
        transaction.quantizationOffsets[channel][band],
        priced
      )
      const newBits = pricing.commit(priced, context)
      spectrumBits += newBits - oldBits
    }
    transaction.spectrumBits[channel][context] = spectrumBits
  }
  transaction.secondPassFrontiers = Number(canLower) | (Number(canRaise) << 1)
  return transaction.recomputeBits()
}

/**
 * Execute the bounded directional search and retain its best packable candidate.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @returns {number}
 */
function runDirectionalSearch(transaction) {
  const bitLimit = transaction.allocationBudgetBits
  const initialBits = transaction.bitsTotal
  const startsFull = bitLimit - initialBits <= 0
  const targetBits = Math.trunc(
    Math.fround(Math.fround(bitLimit) * SECOND_PASS_TARGET_FACTOR)
  )
  let offsetUnits = startsFull ? -OFFSET_SCALE : OFFSET_SCALE
  let stepUnits = OFFSET_SCALE
  let previousDirection = startsFull ? DIRECTION_LOWER : DIRECTION_RAISE
  let iteration = 0
  for (;;) {
    const totalBits = applyOffset(transaction, offsetUnits, iteration === 0)
    const withinLimit = totalBits <= bitLimit
    const direction = totalBits < bitLimit ? DIRECTION_RAISE : DIRECTION_LOWER
    const frontierAllows =
      (transaction.secondPassFrontiers & (1 << direction)) !== 0
    if (
      (withinLimit &&
        (totalBits > targetBits || offsetUnits >= OFFSET_MAX_UNITS)) ||
      offsetUnits <= OFFSET_MIN_UNITS ||
      iteration >= MAX_ITERATION ||
      !frontierAllows
    ) {
      return totalBits
    }
    if (direction !== previousDirection) stepUnits /= 2
    offsetUnits += direction === DIRECTION_LOWER ? -stepUnits : stepUnits
    previousDirection = direction
    iteration++
  }
}

/**
 * Price the alternate entropy context for one selected channel image.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {number} channel Coding-unit channel ordinal.
 */
function priceAlternateContext(transaction, channel) {
  const block = transaction.channelBlocks[channel]
  const active = block.syntax.codeTableContext & 1
  const alternate = active ^ 1
  const pricing = transaction.spectrumPricingStates[channel]
  const priced = transaction.spectrumPricedBands[channel]
  const thresholds =
    transaction.sourceChannels[channel].quantizationThresholdScales
  let sum = 0
  for (let band = 0; band < transaction.bandCount; band++) {
    const mode = block.syntax.wordLengths[band]
    if (mode < 1) continue
    priceSpectrumBand(
      pricing,
      transaction.normalizedSpectra[channel],
      thresholds,
      alternate,
      band,
      mode,
      transaction.quantizationOffsets[channel][band],
      priced
    )
    sum += pricing.commit(priced, alternate)
  }
  transaction.spectrumBits[channel][alternate] = sum
}

/**
 * Select each channel's cheaper entropy context and publish its code-table row.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 */
function selectSpectrumContexts(transaction) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    priceAlternateContext(transaction, channel)
    const bits = transaction.spectrumBits[channel]
    const block = transaction.channelBlocks[channel]
    const context = Number(bits[1] < bits[0])
    const pricing = transaction.spectrumPricingStates[channel]
    block.syntax.codeTableContext = context
    for (let band = 0; band < QUANTIZATION_UNIT_COUNT; band++) {
      block.syntax.codeTables[band] = pricing.selectedIndex(context, band)
    }
    if (transaction.channelCount !== 2) {
      for (let band = 0; band < transaction.bandCount; band++) {
        if (block.syntax.wordLengths[band] === 0) {
          block.syntax.codeTables[band] = 0
        }
      }
    }
  }
}

/**
 * Complete directional mode search, precommit offset correction, and entropy-context selection.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @returns {number}
 */
export function searchAllocation(transaction, shared) {
  validateSecondPass(transaction, shared)
  initializeQuantizationOffsets(transaction)
  runDirectionalSearch(transaction)
  planWordLengthSection(
    transaction.channelBlocks,
    shared.bandLimit,
    shared.shapeCount,
    transaction.wordLengthTransaction
  )
  transaction.replaceWordLengthBits(transaction.wordLengthTransaction.bits)
  transaction.recomputeBits()
  raisePrecommitOffsetsToBudget(transaction)
  selectSpectrumContexts(transaction)
  return transaction.recomputeBits()
}
