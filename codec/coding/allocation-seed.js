/** Candidate policy and initial ATRAC3plus allocation seed derivation. */

import { QUANTIZATION_UNIT_BOUNDARIES } from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'
import {
  initialBandLevelBonus,
  initialLowBandBump,
  intensityStereoSpreadThreshold,
  intensityStereoToneCorrelationThreshold,
  quantCapBandLevelBonus,
} from './allocation-policy.js'
import { planAllocationBandOrder } from './allocation-order.js'
import { codedSubbandCount, effectiveAllocationBand } from '../core/geometry.js'
import { measureCodingUnitAllocationSource } from '../analysis/allocation-input.js'
import { CodingUnitAllocationTransaction } from '../state/allocation.js'

/**
 * Enforce the mono-or-stereo channel limit used by allocation seed storage.
 *
 * @param {number} channelCount
 */
function validateChannelCount(channelCount) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus allocation seed channel count is invalid')
  }
}

/**
 * Derive the initial maximum quantization mode allowed by the profile and band.
 *
 * @param {number} coreMode
 * @param {number} channelCount
 * @returns {number}
 */
function baseMaximumQuantizationMode(coreMode, channelCount) {
  const steps =
    channelCount === 2 ? [4, 5, 0x0b, 0x0f, 0x13] : [4, 5, 7, 0x0d, 0x0f]
  let zone = 0
  while (zone < steps.length && Math.max(coreMode, 0) >= steps[zone]) zone++
  return 2 + zone
}

/**
 * Evaluate the profile weighting curve used to seed band priorities.
 *
 * @param {number} band
 * @param {number} coreMode
 * @param {number} channelCount
 * @returns {number}
 */
function allocationWeightCurve(band, coreMode, channelCount) {
  const low = channelCount === 2 ? 11 : 9
  const high = channelCount === 2 ? 27 : 23
  const interpolation = Math.max(
    0,
    Math.min(
      1,
      Math.fround(
        Math.fround(Math.fround(coreMode) - Math.fround(low)) /
          Math.fround(high - low)
      )
    )
  )
  const floorEnd = Math.fround(8 + Math.fround(interpolation * 16))
  const rolloffStart = Math.max(
    Math.fround(12 + Math.fround(interpolation * 13)),
    Math.fround(floorEnd + 1)
  )
  let denominator
  if (band >= 31) denominator = 28
  else if (band === 30) denominator = 24
  else if (band === 29) denominator = 20
  else if (band <= floorEnd) denominator = 10
  else if (band <= rolloffStart) denominator = 11
  else {
    const ratio = Math.max(
      0,
      Math.min(
        1,
        Math.fround(
          Math.fround(Math.fround(band) - rolloffStart) /
            Math.fround(28 - rolloffStart)
        )
      )
    )
    denominator = Math.fround(11 + Math.fround(8 * ratio))
  }
  return Math.fround(1 / Math.fround(denominator))
}

/**
 * Derive candidate mode caps, exact float32 base scores, and initial word lengths into fixed storage.
 *
 * @param {CodingUnitAllocationTransaction} transaction Prepared allocation transaction.
 * @param {number} averagePairCount Low-band pairs included by the seed average.
 * @param {number} maximumQuantizationUnits Largest measured quantization-unit value.
 * @returns {CodingUnitAllocationTransaction} The transaction with derived seed rows.
 */
export function deriveAllocationSeed(
  transaction,
  averagePairCount,
  maximumQuantizationUnits
) {
  if (!(transaction instanceof CodingUnitAllocationTransaction)) {
    throw new TypeError('ATRAC3plus base seed requires a transaction')
  }
  const {
    sourceChannels,
    quantizationUnits,
    channelCount,
    bandCount,
    sampleRateHz,
    coreMode,
    baseAllocationScores,
    initialWordLengths,
  } = transaction
  if (
    !Array.isArray(sourceChannels) ||
    sourceChannels.length < CODING_UNIT_MAX_CHANNELS ||
    !(baseAllocationScores instanceof Float32Array) ||
    baseAllocationScores.length <
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT ||
    !(initialWordLengths instanceof Int32Array) ||
    initialWordLengths.length <
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT ||
    !(quantizationUnits instanceof Int32Array) ||
    quantizationUnits.length <
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(bandCount) ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(sampleRateHz) ||
    sampleRateHz < 1 ||
    !Number.isInteger(averagePairCount) ||
    averagePairCount < 0 ||
    averagePairCount > bandCount ||
    !Number.isInteger(maximumQuantizationUnits) ||
    maximumQuantizationUnits < 1 ||
    !Number.isInteger(coreMode) ||
    coreMode < 0 ||
    coreMode >= 32
  ) {
    throw new RangeError('ATRAC3plus base allocation seed is invalid')
  }
  validateChannelCount(channelCount)
  const baseMode = baseMaximumQuantizationMode(coreMode, channelCount)
  const bitAllocationScale = Math.fround(
    Math.fround(Math.fround(baseMode) * 10) /
      Math.fround(maximumQuantizationUnits)
  )
  const inactiveLimit = channelCount === 2 ? 0x1b : 0x17
  for (let channel = 0; channel < channelCount; channel++) {
    const row = channel * QUANTIZATION_UNIT_COUNT
    const output = sourceChannels[channel]
    for (let band = 0; band < bandCount; band++) {
      output.maximumQuantizationModes[band] = Math.min(
        7,
        baseMode + quantCapBandLevelBonus(output.bandLevels[band])
      )
    }
    for (let band = 0; band < Math.min(8, bandCount); band++) {
      if (
        (output.maximumQuantizationModes[band] & 0xffff) <
        (output.bitAllocationMode & 0xffff)
      ) {
        output.maximumQuantizationModes[band] = output.bitAllocationMode
      }
    }
    for (let band = 0; band < bandCount; band++) {
      const effectiveBand = effectiveAllocationBand(
        band,
        sampleRateHz,
        bandCount
      )
      const product = Math.fround(
        Math.fround(quantizationUnits[row + band]) *
          Math.fround(bitAllocationScale)
      )
      baseAllocationScores[row + band] = Math.fround(
        product * allocationWeightCurve(effectiveBand, coreMode, channelCount)
      )
    }

    let average = null
    if (averagePairCount > 0) {
      let sum = Math.fround(0)
      for (let band = 0; band < averagePairCount; band++) {
        sum = Math.fround(sum + sourceChannels[channel].bandLevels[band])
      }
      average = Math.fround(sum / Math.fround(averagePairCount))
    }
    const bump = initialLowBandBump(
      coreMode,
      sampleRateHz,
      sourceChannels[channel].bitAllocationMode,
      average
    )
    if (bump !== 0) {
      for (let band = 0; band < 8; band++) {
        baseAllocationScores[row + band] = Math.fround(
          baseAllocationScores[row + band] + bump
        )
      }
    }

    for (let band = 0; band < bandCount; band++) {
      const index = row + band
      baseAllocationScores[index] = Math.fround(
        baseAllocationScores[index] +
          Math.fround(
            initialBandLevelBonus(sourceChannels[channel].bandLevels[band])
          )
      )
      const desired = Math.trunc(Math.fround(baseAllocationScores[index] + 0.5))
      const maximum = sourceChannels[channel].maximumQuantizationModes[band]
      initialWordLengths[index] = Math.max(1, Math.min(desired, maximum))
      if (coreMode < inactiveLimit && quantizationUnits[index] === 0) {
        initialWordLengths[index] = 0
      }
    }
  }
  return transaction
}

/**
 * Compare the active gain points of two records for exact syntax equality.
 *
 * @param {GainRecord} left
 * @param {GainRecord} right
 * @returns {boolean}
 */
function gainRecordsEqual(left, right) {
  if (!left || !right || left.entries !== right.entries) return false
  const count = Math.min(
    left.entries,
    left.locations.length,
    left.levels.length
  )
  for (let index = 0; index < count; index++) {
    if (
      left.locations[index] !== right.locations[index] ||
      left.levels[index] !== right.levels[index]
    ) {
      return false
    }
  }
  return true
}

/**
 * Prepare the exact stereo reuse mask without publishing it to the transaction.
 *
 * @param {EncodeChannelState[]} channelBlocks Detached stereo channel blocks.
 * @param {import('../state/allocation.js').AllocationSourceChannel[]} sourceChannels Measured allocation source rows.
 * @param {Int32Array} jointScaleFactorIndices Measured left-minus-right scale indices.
 * @param {number} coreMode Profile core-mode selector.
 * @param {number} bandCount Active quantization bands.
 * @param {number} recordCount Active tone records.
 * @param {Uint16Array} destination Reuse mask to overwrite.
 * @returns {Uint16Array} The destination reuse mask.
 */
export function prepareIntensityStereoMask(
  channelBlocks,
  sourceChannels,
  jointScaleFactorIndices,
  coreMode,
  bandCount,
  recordCount,
  destination
) {
  if (
    !Array.isArray(channelBlocks) ||
    channelBlocks.length < 2 ||
    !Array.isArray(sourceChannels) ||
    sourceChannels.length < CODING_UNIT_MAX_CHANNELS ||
    !(jointScaleFactorIndices instanceof Int32Array) ||
    jointScaleFactorIndices.length < QUANTIZATION_UNIT_COUNT ||
    !(destination instanceof Uint16Array) ||
    destination.length < QUANTIZATION_UNIT_COUNT
  ) {
    throw new RangeError('ATRAC3plus intensity allocation mask is invalid')
  }
  destination.fill(0)
  const primary = channelBlocks[0]
  const secondary = channelBlocks[1]
  const toneCount = Math.min(
    primary.intensityHistory.intensityBandLimit,
    recordCount,
    16
  )
  const cutoff = QUANTIZATION_UNIT_BOUNDARIES[toneCount]
  destination.fill(1, Math.min(cutoff, bandCount), bandCount)
  for (let record = 0; record < toneCount; record++) {
    const correlation = primary.intensityHistory.correlation(1, record)
    const equal = gainRecordsEqual(
      primary.currentGainRecords[record],
      secondary.currentGainRecords[record]
    )
    const start = QUANTIZATION_UNIT_BOUNDARIES[record]
    const end = Math.min(QUANTIZATION_UNIT_BOUNDARIES[record + 1], bandCount)
    for (let band = start; band < end; band++) {
      const left = primary.syntax.scaleFactors[band]
      const right = secondary.syntax.scaleFactors[band]
      const level = Math.max(
        sourceChannels[0].bandLevels[band],
        sourceChannels[1].bandLevels[band]
      )
      const spread = Math.max(left, right) - jointScaleFactorIndices[band]
      const threshold = Math.max(
        3,
        Math.trunc(level / 3) +
          intensityStereoSpreadThreshold(coreMode, band) -
          Math.trunc(Math.fround(correlation * Math.fround(0.125)))
      )
      const toneMatch =
        record > 0 &&
        correlation >=
          intensityStereoToneCorrelationThreshold(coreMode, record) &&
        left === right &&
        left >= jointScaleFactorIndices[band]
      const spreadMatch = equal && spread >= threshold
      const strongTone = correlation <= 40 && Math.trunc(level) > 6
      destination[band] = Number((toneMatch || spreadMatch) && !strongTone)
    }
  }
  return destination
}

/**
 * Measure one bound coding unit and derive every candidate-invariant policy object consumed by allocation.
 *
 * @param {CodingUnitAllocationTransaction} transaction Bound allocation transaction.
 * @param {number} bandCount Active quantization bands.
 * @param {number} channelMode Coding-unit channel mode.
 * @param {number} sampleRateHz Stream sample rate.
 */
export function prepareAllocationSource(
  transaction,
  bandCount,
  channelMode,
  sampleRateHz
) {
  const maximumQuantizationUnits = measureCodingUnitAllocationSource(
    transaction,
    bandCount,
    channelMode
  )
  const intensityBandLimit =
    transaction.channelBlocks[0]?.intensityHistory?.intensityBandLimit
  if (
    !(transaction instanceof CodingUnitAllocationTransaction) ||
    !transaction.bindingComplete ||
    !Number.isInteger(transaction.bandCount) ||
    transaction.bandCount < 1 ||
    transaction.bandCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(sampleRateHz) ||
    sampleRateHz < 1 ||
    !Number.isInteger(intensityBandLimit) ||
    intensityBandLimit < 0 ||
    intensityBandLimit >= QUANTIZATION_UNIT_BOUNDARIES.length
  ) {
    throw new RangeError('ATRAC3plus allocation seed preparation is invalid')
  }
  const { channelCount, coreMode } = transaction
  transaction.sampleRateHz = sampleRateHz
  planAllocationBandOrder(
    transaction.channelBlocks,
    transaction.sourceChannels,
    bandCount,
    transaction.allocationBandOrder
  )
  if (channelMode === 3 && channelCount === 2) {
    prepareIntensityStereoMask(
      transaction.channelBlocks,
      transaction.sourceChannels,
      transaction.initialWordLengths,
      coreMode,
      bandCount,
      codedSubbandCount(bandCount),
      transaction.intensityStereoBandMask
    )
  }
  deriveAllocationSeed(
    transaction,
    Math.min(QUANTIZATION_UNIT_BOUNDARIES[intensityBandLimit], bandCount),
    maximumQuantizationUnits
  )
}
