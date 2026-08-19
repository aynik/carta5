/** Atomic publication of pack-visible symbols for the active ATRAC3plus allocation. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { quantizeSpectrumBand } from './spectrum-quantization.js'

import { SpectrumPricingState } from '../state/spectrum-pricing.js'

/**
 * Verify that each active band has normalized samples, thresholds, syntax, and pricing storage before quantization.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 */
function validateActiveQuantization(transaction) {
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
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    if (
      !block?.syntax ||
      !(block.quantizedSpectrum instanceof Int16Array) ||
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
        required > block.quantizedSpectrum.length
      ) {
        throw new RangeError('ATRAC3plus active quantization input is invalid')
      }
    }
  }
}

/**
 * Quantize every active band and mark the allocation symbols current.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @returns {CodingUnitAllocationTransaction} The updated transaction.
 */
export function quantizeActiveAllocation(transaction) {
  validateActiveQuantization(transaction)
  const bandCount = transaction.bandCount
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    const spectrum = transaction.normalizedSpectra[channel]
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    const pricing = transaction.spectrumPricingStates[channel]
    for (let band = 0; band < bandCount; band++) {
      const mode = block.syntax.wordLengths[band]
      if (mode < 1) continue
      const offset = transaction.quantizationOffsets[channel][band]
      if (
        pricing.writeCachedQuantizedBand(
          band,
          mode,
          offset,
          block.quantizedSpectrum
        )
      ) {
        continue
      }
      quantizeSpectrumBand(
        spectrum,
        thresholds,
        band,
        mode,
        offset,
        block.quantizedSpectrum
      )
    }
  }
  transaction.quantizationDirty = false
  return transaction
}
