/** Candidate-invariant ATRAC3plus allocation measurement from detached MDCTs. */

import {
  QUANTIZATION_UNIT_OFFSETS,
  SCALE_FACTOR_VALUES,
} from '../core/tables.js'
import {
  QUANTIZATION_UNIT_COUNT,
  SCALE_FACTOR_TARGET,
} from '../core/constants.js'
import { CodingUnitAllocationTransaction } from '../state/allocation.js'
import { bitAllocationModeFromRatios } from '../coding/allocation-policy.js'

/**
 * Reference four-at-a-time float32 absolute sum.
 *
 * @param {Float32Array} source Spectrum samples.
 * @param {number} start First included sample.
 * @param {number} end End-exclusive sample.
 * @returns {number} Ordered absolute sum.
 */
export function alignedAbsoluteSum(source, start, end) {
  if (
    !(source instanceof Float32Array) ||
    start < 0 ||
    end < start ||
    end > source.length ||
    ((end - start) & 3) !== 0
  ) {
    throw new RangeError('ATRAC3plus aligned absolute sum is invalid')
  }
  let sum = Math.fround(0)
  for (let coefficient = start; coefficient < end; coefficient += 4) {
    sum = Math.fround(sum + Math.abs(source[coefficient]))
    sum = Math.fround(sum + Math.abs(source[coefficient + 1]))
    sum = Math.fround(sum + Math.abs(source[coefficient + 2]))
    sum = Math.fround(sum + Math.abs(source[coefficient + 3]))
  }
  return sum
}

/**
 * First strictly greater scale value, saturated to the six-bit table.
 *
 * @param {number} peak Measured absolute peak.
 * @returns {number} Quantized scale-factor index.
 */
export function scaleFactorIndexForPeak(peak) {
  const target = Math.fround(Math.fround(peak) * SCALE_FACTOR_TARGET)
  if (Number.isNaN(target)) return SCALE_FACTOR_VALUES.length - 1
  let index = 0
  while (
    index < SCALE_FACTOR_VALUES.length &&
    SCALE_FACTOR_VALUES[index] <= target
  ) {
    index++
  }
  return Math.min(index, SCALE_FACTOR_VALUES.length - 1)
}

/**
 * Scan one quantization band and return its largest absolute sample magnitude.
 *
 * @param {Float32Array} source
 * @param {number} band
 * @returns {number}
 */
function bandPeak(source, band) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  let maximum = Math.abs(source[start])
  for (let coefficient = start + 1; coefficient < end; coefficient++) {
    maximum = Math.max(maximum, Math.abs(source[coefficient]))
  }
  return Math.fround(maximum)
}

/**
 * Measure the peak magnitude of the left-minus-right signal without materializing a difference buffer.
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} band
 * @returns {number}
 */
function differenceBandPeak(left, right, band) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  let maximum = Math.abs(Math.fround(left[start] - right[start]))
  for (let coefficient = start + 1; coefficient < end; coefficient++) {
    maximum = Math.max(
      maximum,
      Math.abs(Math.fround(left[coefficient] - right[coefficient]))
    )
  }
  return Math.fround(maximum)
}

/**
 * Verify that measured spectra and destination channels cover the complete coding-unit geometry before copying analysis evidence.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {number} groupCount
 */
function validateMeasurementInputs(transaction, groupCount) {
  if (
    !(transaction instanceof CodingUnitAllocationTransaction) ||
    !transaction.bindingComplete ||
    !Number.isInteger(groupCount) ||
    groupCount < 1 ||
    groupCount > QUANTIZATION_UNIT_COUNT
  ) {
    throw new RangeError(
      'ATRAC3plus allocation measurement geometry is invalid'
    )
  }
}

/**
 * Measure a complete coding unit and publish its completed scale-history epoch.
 *
 * @param {CodingUnitAllocationTransaction} transaction Destination transaction.
 * @param {number} groupCount Active quantization groups.
 * @param {number} channelMode Coding-unit channel mode.
 * @returns {number} Largest measured quantization-unit value for seed scaling.
 */
export function measureCodingUnitAllocationSource(
  transaction,
  groupCount,
  channelMode
) {
  validateMeasurementInputs(transaction, groupCount)
  const {
    channelBlocks,
    gainScaledSpectra,
    gainUnscaledSpectra,
    channelCount,
    coreMode,
  } = transaction
  const { sourceChannels } = transaction
  // These seed rows are overwritten only after measured scale history is
  // published, so they also provide the pre-seed scale-index and gain work.
  const unscaledScaleFactorIndices = transaction.initialWordLengths
  const gainWork = transaction.baseAllocationScores
  transaction.bandCount = groupCount
  let maximumQuantizationUnits = 1
  const lowRateRatios = coreMode < 0x10

  for (let channel = 0; channel < channelCount; channel++) {
    const scaled = gainScaledSpectra[channel]
    const unscaled = gainUnscaledSpectra[channel]
    const output = sourceChannels[channel]
    const row = channel * QUANTIZATION_UNIT_COUNT
    const lowSum = alignedAbsoluteSum(unscaled, 0, 0x10)
    const highAverage = Math.fround(
      alignedAbsoluteSum(unscaled, 0x80, 0x100) * Math.fround(0.0078125)
    )
    const lowHighRatio =
      highAverage > 0
        ? Math.fround(Math.fround(lowSum * Math.fround(0.0625)) / highAverage)
        : Math.fround(1)
    let lowMidRatio = Math.fround(1)
    if (lowRateRatios) {
      const middleAverage = Math.fround(
        alignedAbsoluteSum(unscaled, 0x10, 0x80) / Math.fround(112)
      )
      lowMidRatio =
        middleAverage > 0
          ? Math.fround(
              Math.fround(lowSum * Math.fround(0.0625)) / middleAverage
            )
          : Math.fround(1)
    }
    output.bitAllocationMode = bitAllocationModeFromRatios(
      lowHighRatio,
      lowMidRatio,
      lowRateRatios
    )

    for (let band = 0; band < groupCount; band++) {
      const scaledPeak = bandPeak(scaled, band)
      const unscaledPeak = bandPeak(unscaled, band)
      const scaledIndex = scaleFactorIndexForPeak(scaledPeak)
      const unscaledIndex = scaleFactorIndexForPeak(unscaledPeak)
      channelBlocks[channel].syntax.scaleFactors[band] = scaledIndex
      gainWork[row + band] = scaledPeak
      unscaledScaleFactorIndices[row + band] = unscaledIndex
      output.quantizationThresholdScales[band] = Math.fround(
        scaledPeak / SCALE_FACTOR_VALUES[scaledIndex]
      )
    }

    for (let band = 0; band < groupCount; band++) {
      const start = QUANTIZATION_UNIT_OFFSETS[band]
      const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
      const peak = gainWork[row + band]
      let gainScale = Math.fround(1)
      if (peak > 0) {
        const sum = alignedAbsoluteSum(scaled, start, end)
        gainScale = Math.fround(
          Math.fround(Math.fround(end - start) * Math.fround(peak)) / sum
        )
      }
      const previousScaleFactor =
        channelBlocks[channel].previousScaleHistory.scaleFactors[band]
      const unscaledIndex = unscaledScaleFactorIndices[row + band]
      const quantizationUnits = Math.trunc(
        Math.fround((previousScaleFactor + unscaledIndex) * 0.5 + 0.5)
      )
      transaction.quantizationUnits[row + band] = quantizationUnits
      maximumQuantizationUnits = Math.max(
        maximumQuantizationUnits,
        quantizationUnits
      )
      output.bandLevels[band] = Math.fround(
        Math.fround(
          gainScale + channelBlocks[channel].previousScaleHistory.scales[band]
        ) * Math.fround(0.5)
      )
      gainWork[row + band] = gainScale
    }
  }

  for (let channel = 0; channel < channelCount; channel++) {
    const row = channel * QUANTIZATION_UNIT_COUNT
    const block = channelBlocks[channel]
    for (let band = 0; band < groupCount; band++) {
      block.currentScaleHistory.scaleFactors[band] =
        unscaledScaleFactorIndices[row + band]
      block.currentScaleHistory.scales[band] = gainWork[row + band]
    }
  }
  if (channelMode === 3 && channelCount === 2) {
    for (let band = 0; band < QUANTIZATION_UNIT_COUNT; band++) {
      unscaledScaleFactorIndices[band] = scaleFactorIndexForPeak(
        differenceBandPeak(gainScaledSpectra[0], gainScaledSpectra[1], band)
      )
    }
  }
  return maximumQuantizationUnits
}
