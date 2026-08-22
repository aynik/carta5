/** Atomic publication of pack-visible symbols for the active ATRAC3plus allocation. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { quantizeSpectrumBand } from './spectrum.js'

import { SpectrumPricingState } from '../state/spectrum-pricing.js'

/**
 * Verify active syntax, source samples, pricing, and destination rows.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {Int16Array[]} output
 */
function validateQuantization(transaction, output) {
  const bandCount = transaction.bandCount
  if (
    transaction.channelCount < 1 ||
    transaction.channelCount > CODING_UNIT_MAX_CHANNELS ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT
  ) {
    throw new RangeError('ATRAC3plus active quantization is not ready')
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    const spectrum = transaction.normalizedSpectra[channel]
    const symbols = output[channel]
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    if (
      !block?.syntax ||
      !(symbols instanceof Int16Array) ||
      !(spectrum instanceof Float32Array) ||
      !(
        transaction.spectrumPricingStates[channel] instanceof
        SpectrumPricingState
      )
    ) {
      throw new RangeError(
        'ATRAC3plus active quantization channel binding is invalid'
      )
    }
    for (let band = 0; band < bandCount; band++) {
      const mode = block.syntax.wordLengths[band]
      if (mode < 1) continue
      const offset = transaction.quantizationOffsets[channel][band]
      const required = QUANTIZATION_UNIT_OFFSETS[band + 1]
      if (
        mode > 7 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 15 ||
        !Number.isFinite(thresholds[band]) ||
        thresholds[band] < 0 ||
        required === undefined ||
        required > spectrum.length ||
        required > symbols.length
      ) {
        throw new RangeError('ATRAC3plus active quantization input is invalid')
      }
    }
  }
}

/**
 * Quantize every active band into explicit caller-owned rows.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {Int16Array[]} output Destination symbol rows.
 * @returns {CodingUnitAllocationTransaction} The updated transaction.
 */
function quantize(transaction, output) {
  validateQuantization(transaction, output)
  const bandCount = transaction.bandCount
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    const spectrum = transaction.normalizedSpectra[channel]
    const symbols = output[channel]
    symbols.fill(0)
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    const pricing = transaction.spectrumPricingStates[channel]
    for (let band = 0; band < bandCount; band++) {
      const mode = block.syntax.wordLengths[band]
      if (mode < 1) continue
      const offset = transaction.quantizationOffsets[channel][band]
      if (pricing.writeCachedQuantizedBand(band, mode, offset, symbols)) {
        continue
      }
      quantizeSpectrumBand(spectrum, thresholds, band, mode, offset, symbols)
    }
  }
  return transaction
}

/**
 * Materialize allocation-local symbols used by reconstruction refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @returns {CodingUnitAllocationTransaction} The updated transaction.
 */
export function quantizeTrial(transaction) {
  quantize(transaction, transaction.trialSpectra)
  transaction.quantizationDirty = false
  return transaction
}

/**
 * Materialize the retained symbols consumed by packing.
 *
 * @param {CodingUnitAllocationTransaction} transaction Retained allocation.
 * @returns {CodingUnitAllocationTransaction} The updated transaction.
 */
export function quantizeSymbols(transaction) {
  if (transaction.quantizationDirty) {
    throw new RangeError('ATRAC3plus retained allocation is not ready')
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    if (
      !(transaction.trialSpectra[channel] instanceof Int16Array) ||
      !(transaction.symbols[channel] instanceof Int16Array) ||
      transaction.symbols[channel].length <
        transaction.trialSpectra[channel].length
    ) {
      throw new RangeError('ATRAC3plus retained symbol storage is invalid')
    }
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    transaction.symbols[channel].set(transaction.trialSpectra[channel])
  }
  return transaction
}
