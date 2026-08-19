/** ATRAC3plus quantization-offset initialization. */

import {
  MONO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND,
  MONO_QUANTIZATION_OFFSET_ITERATION_LIMIT_BY_MODE,
  MONO_QUANTIZATION_OFFSET_START_BAND_BY_MODE,
  STEREO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND,
  STEREO_QUANTIZATION_OFFSET_ITERATION_LIMIT_BY_MODE,
  STEREO_QUANTIZATION_OFFSET_START_BAND_BY_MODE,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'
import {
  quantOffsetLowRateBaseBump,
  quantOffsetLowRateHighBandBump,
} from './allocation-policy.js'
import { effectiveAllocationBand } from '../core/geometry.js'

/**
 * Initialize live quantization offsets from the coding-unit policy and measured spectrum costs.
 *
 * @param {CodingUnitAllocationTransaction} transaction Prepared allocation transaction.
 * @returns {Int32Array[]} Initialized per-channel offset rows.
 */
export function initializeQuantizationOffsets(transaction) {
  const { channelCount, bandCount, coreMode, sampleRateHz, quantizationUnits } =
    transaction
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    !Number.isInteger(bandCount) ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(coreMode) ||
    coreMode < 0 ||
    coreMode >= 32 ||
    !(quantizationUnits instanceof Int32Array) ||
    quantizationUnits.length <
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT ||
    !(transaction.intensityStereoBandMask instanceof Uint16Array) ||
    !Array.isArray(transaction.channelBlocks) ||
    !Array.isArray(transaction.spectrumPricingStates) ||
    !Array.isArray(transaction.quantizationOffsets)
  ) {
    throw new RangeError('ATRAC3plus quantization offsets are invalid')
  }
  const stereo = channelCount === 2
  const baseTable = stereo
    ? STEREO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND
    : MONO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND
  const startTable = stereo
    ? STEREO_QUANTIZATION_OFFSET_START_BAND_BY_MODE
    : MONO_QUANTIZATION_OFFSET_START_BAND_BY_MODE
  const iterationTable = stereo
    ? STEREO_QUANTIZATION_OFFSET_ITERATION_LIMIT_BY_MODE
    : MONO_QUANTIZATION_OFFSET_ITERATION_LIMIT_BY_MODE
  const startBand = startTable[coreMode]
  transaction.cbStartBand = startBand
  transaction.cbIterationLimit = iterationTable[coreMode]
  const tableRow = coreMode * QUANTIZATION_UNIT_COUNT
  for (let band = 0; band < bandCount; band++) {
    const base =
      baseTable[
        tableRow + effectiveAllocationBand(band, sampleRateHz, bandCount)
      ]
    for (let channel = 0; channel < channelCount; channel++) {
      transaction.quantizationOffsets[channel][band] = base
    }
  }
  if (coreMode < 0x10 && startBand < bandCount) {
    for (let channel = 0; channel < channelCount; channel++) {
      const row = channel * QUANTIZATION_UNIT_COUNT
      for (let band = startBand; band < bandCount; band++) {
        if (transaction.channelBlocks[channel].syntax.wordLengths[band] === 1) {
          transaction.quantizationOffsets[channel][band] +=
            quantOffsetLowRateBaseBump(quantizationUnits[row + band])
        }
      }
    }
    if (bandCount > 0x12) {
      for (let channel = 0; channel < channelCount; channel++) {
        const row = channel * QUANTIZATION_UNIT_COUNT
        const context =
          transaction.channelBlocks[channel].syntax.codeTableContext & 1
        const pricing = transaction.spectrumPricingStates[channel]
        for (let band = 0x12; band < bandCount; band++) {
          if (transaction.channelBlocks[channel].syntax.wordLengths[band] !== 1)
            continue
          const cost = pricing.selectedCost(context, band)
          transaction.quantizationOffsets[channel][band] +=
            quantOffsetLowRateHighBandBump(
              band,
              quantizationUnits[row + band],
              cost
            )
        }
      }
    }
  }
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < bandCount; band++) {
      transaction.quantizationOffsets[channel][band] = Math.min(
        transaction.quantizationOffsets[channel][band],
        0x0f
      )
    }
  }
  return transaction.quantizationOffsets
}
