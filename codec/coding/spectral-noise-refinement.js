/** Post-quantization ATRAC3plus spectral-noise level evidence and lowering. */

import {
  BAND_INDEX_BY_QUANTIZATION_UNIT,
  INVERSE_QUANTIZER_SCALES,
  QUANTIZATION_UNIT_OFFSETS,
  SCALE_FACTOR_VALUES,
  SPECTRAL_NOISE_GROUP_BY_QUANTIZATION_UNIT,
  SPECTRAL_NOISE_GROUP_SCALE_BY_OFFSET,
  SPECTRAL_NOISE_GROUP_START_BY_BAND,
  SPECTRAL_NOISE_LEVEL_SCALES,
  SPECTRAL_NOISE_START_BAND_BY_MODE,
  SPECTRUM_BAND_LIMITS,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  DISABLED_LEVEL,
  GROUP_COUNT,
  INITIAL_LEVEL,
  SLOT_COUNT,
} from '../core/constants.js'
import {
  fillSpectralNoise,
  quantizedSpectralNoiseScale,
} from '../transforms/spectral-reconstruction.js'
import { float32Add } from '../utils.js'
import {
  prepareReconstructionNoiseSeeds,
  ReconstructionRefinementScratch,
} from './reconstruction-noise.js'

/**
 * Index flat spectral-noise evidence storage by channel and quantization band.
 *
 * @param {number} channel
 * @returns {number}
 */
function rowOffset(channel) {
  return channel * SLOT_COUNT
}

/**
 * Translate channel, band, and evidence kind into flat observation storage.
 *
 * @param {number} channel
 * @param {number} group
 * @returns {number}
 */
function evidenceOffset(channel, group) {
  return channel * GROUP_COUNT + group
}

/**
 * Seed one spectral-noise row from the channel's current scale factors and active bands.
 *
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 */
function initializeRow(plan, channel) {
  const start = rowOffset(channel)
  plan.levels.fill(DISABLED_LEVEL, start, start + SLOT_COUNT)
  plan.levels.fill(INITIAL_LEVEL, start + plan.slotStart, start + plan.slotEnd)
}

/**
 * Validate finalized quantization syntax and derive the number of spectral-noise map groups available for refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 * @returns {number} Number of active spectral-noise map groups.
 */
function validatePlan(transaction, shared, plan) {
  const channelCount = transaction.channelCount
  const scaleFactorCount = shared.scaleFactorCount
  const coreMode = transaction.coreMode
  const mapCount = shared.mapCount
  if (
    !(plan instanceof ReconstructionRefinementScratch) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    !Number.isInteger(scaleFactorCount) ||
    scaleFactorCount < 0 ||
    scaleFactorCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(coreMode) ||
    coreMode < 0 ||
    coreMode >= SPECTRAL_NOISE_START_BAND_BY_MODE.length ||
    mapCount < 0 ||
    mapCount > SPECTRAL_NOISE_GROUP_BY_QUANTIZATION_UNIT.length - 0x20 ||
    transaction.quantizationDirty
  ) {
    throw new RangeError('ATRAC3plus spectral-noise refinement is not ready')
  }
  const required = QUANTIZATION_UNIT_OFFSETS[scaleFactorCount]
  for (let channel = 0; channel < channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    if (
      !block?.syntax ||
      !(block.syntax.spectralNoiseLevelIndices instanceof Int32Array) ||
      block.syntax.spectralNoiseLevelIndices.length < SLOT_COUNT ||
      !(block.quantizedSpectrum instanceof Int16Array) ||
      !(transaction.normalizedSpectra[channel] instanceof Float32Array) ||
      required === undefined ||
      required > transaction.normalizedSpectra[channel].length ||
      required > block.quantizedSpectrum.length
    ) {
      throw new RangeError(
        'ATRAC3plus spectral-noise channel binding is invalid'
      )
    }
    for (let band = 0; band < scaleFactorCount; band++) {
      const mode = block.syntax.wordLengths[band]
      const scaleFactor = block.syntax.scaleFactors[band]
      if (
        mode < 0 ||
        mode >= INVERSE_QUANTIZER_SCALES.length ||
        (mode > 0 && (scaleFactor < 0 || scaleFactor >= 64))
      ) {
        throw new RangeError('ATRAC3plus spectral-noise syntax is invalid')
      }
    }
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const level = block.syntax.spectralNoiseLevelIndices[slot]
      if (level < 0 || level >= SPECTRAL_NOISE_LEVEL_SCALES.length) {
        throw new RangeError('ATRAC3plus spectral-noise level index is invalid')
      }
    }
  }
  return mapCount
}

/**
 * Accumulate absolute coefficient magnitude using the codec's four-sample grouping.
 *
 * @param {ArrayLike<number>} values
 * @param {number} start
 * @param {number} quarterLength
 * @param {number} [scale]
 * @returns {number}
 */
function quarterAbsoluteSum(values, start, quarterLength, scale = 1) {
  let accumulator = Math.fround(0)
  const scaleF32 = Math.fround(scale)
  for (let offset = 0; offset < quarterLength; offset++) {
    const first = Math.abs(
      Math.fround(scaleF32 * Math.fround(values[start + offset]))
    )
    const second = Math.abs(
      Math.fround(
        scaleF32 * Math.fround(values[start + quarterLength + offset])
      )
    )
    const third = Math.abs(
      Math.fround(
        scaleF32 * Math.fround(values[start + quarterLength * 2 + offset])
      )
    )
    const fourth = Math.abs(
      Math.fround(
        scaleF32 * Math.fround(values[start + quarterLength * 3 + offset])
      )
    )
    const firstThree = Math.fround(third + second + first)
    accumulator = float32Add(accumulator, Math.fround(fourth + firstThree))
  }
  return accumulator
}

/**
 * Measure the absolute magnitude of the deterministic reconstruction-noise sequence.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 * @param {number} band
 * @param {number} mode
 * @param {number} quarterLength
 * @returns {number}
 */
function noiseAbsoluteSum(
  transaction,
  shared,
  plan,
  channel,
  band,
  mode,
  quarterLength
) {
  const map = BAND_INDEX_BY_QUANTIZATION_UNIT[band + 1]
  let sourceChannel = channel
  if (transaction.channelCount === 2 && shared.presenceFlags[1][map] !== 0) {
    sourceChannel = 1 - channel
  }
  const bandId = SPECTRUM_BAND_LIMITS[map]
  const levelIndex = plan.levels[rowOffset(sourceChannel) + bandId]
  const level = SPECTRAL_NOISE_LEVEL_SCALES[levelIndex]
  if (band < 2 || !(level > 0)) return 0
  const count =
    QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
  if (plan.expandedMapIndex !== map) {
    fillSpectralNoise(plan.seeds[map], count, plan.randomSamples)
    plan.expandedMapIndex = map
  }
  const block = transaction.channelBlocks[sourceChannel]
  const scale = quantizedSpectralNoiseScale(
    levelIndex,
    block.currentGainRecords[map],
    block.previousGainRecords[map],
    mode
  )
  if (scale === null) return 0
  return quarterAbsoluteSum(plan.randomSamples, 0, quarterLength, scale)
}

/**
 * Accumulate level and scale-factor evidence from one reconstructed spectral-noise band.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 * @param {number} band
 */
function observeBand(transaction, shared, plan, channel, band) {
  const intensitySource =
    channel === 1 && transaction.intensityStereoBandMask[band] === 1
      ? 0
      : channel
  const sourceBlock = transaction.channelBlocks[intensitySource]
  const mode = sourceBlock.syntax.wordLengths[band]
  if (mode === 0) return
  const group = SPECTRAL_NOISE_GROUP_BY_QUANTIZATION_UNIT[band]
  const bandLevel = transaction.sourceChannels[intensitySource].bandLevels[band]
  let inverseBandLevel = Math.fround(1 / Math.fround(bandLevel))
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const length = QUANTIZATION_UNIT_OFFSETS[band + 1] - start
  const quarterLength = length >> 2
  const quantizedSum = quarterAbsoluteSum(
    sourceBlock.quantizedSpectrum,
    start,
    quarterLength
  )
  const scaleFactorIndex =
    transaction.channelBlocks[channel].syntax.scaleFactors[band]
  const scaleFactorValue = SCALE_FACTOR_VALUES[scaleFactorIndex]
  const denominator = Math.fround(
    INVERSE_QUANTIZER_SCALES[mode] * scaleFactorValue
  )
  if (quantizedSum > 0) {
    const normalizedSum = Math.fround(
      Math.fround(Math.fround(length) * scaleFactorValue) / quantizedSum
    )
    inverseBandLevel = Math.fround(
      inverseBandLevel - Math.fround(denominator / normalizedSum)
    )
  }
  const noiseSum = noiseAbsoluteSum(
    transaction,
    shared,
    plan,
    channel,
    band,
    mode,
    quarterLength
  )
  let scale = Math.fround(0)
  if (noiseSum > 0) {
    scale = Math.fround(
      Math.fround(Math.fround(length) * scaleFactorValue) / noiseSum
    )
  }
  const groupScale =
    SPECTRAL_NOISE_GROUP_SCALE_BY_OFFSET[
      band - SPECTRAL_NOISE_GROUP_START_BY_BAND[band]
    ]
  const groupScaleF32 = Math.fround(groupScale)
  let noiseEvidence = Math.fround(scale / denominator)
  noiseEvidence = Math.fround(noiseEvidence * inverseBandLevel)
  noiseEvidence = Math.fround(noiseEvidence * Math.fround(scaleFactorIndex))
  noiseEvidence = Math.fround(noiseEvidence * groupScaleF32)
  let levelEvidence = Math.fround(
    Math.fround(scaleFactorIndex) * Math.fround(bandLevel)
  )
  levelEvidence = Math.fround(levelEvidence * groupScaleF32)
  const offset = evidenceOffset(channel, group)
  plan.noiseEvidence[offset] = float32Add(
    plan.noiseEvidence[offset],
    noiseEvidence
  )
  plan.levelEvidence[offset] = float32Add(
    plan.levelEvidence[offset],
    levelEvidence
  )
  plan.weights[offset] += groupScale * scaleFactorIndex
}

/**
 * Select the strongest spectral-noise level supported by accumulated evidence.
 *
 * @param {number} accumulator
 * @returns {number}
 */
function baseNoiseLevel(accumulator) {
  let level = DISABLED_LEVEL
  for (let index = 14; index >= 0; index--) {
    if (accumulator > SPECTRAL_NOISE_LEVEL_SCALES[index]) level = index
    else break
  }
  return level
}

/**
 * Reduce unsupported spectral-noise levels for one channel while retaining valid band evidence.
 *
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 */
function lowerChannel(plan, channel) {
  for (let slot = plan.slotStart; slot < plan.slotEnd; slot++) {
    const offset = evidenceOffset(channel, slot)
    let noise = plan.noiseEvidence[offset]
    let level = plan.levelEvidence[offset]
    if (noise > 0) {
      const weight = Math.fround(plan.weights[offset])
      noise = Math.fround(noise / weight)
      level = Math.fround(level / weight)
    }
    const bonus = Number(level > 3) + Number(level > 6)
    plan.levels[rowOffset(channel) + slot] = Math.min(
      baseNoiseLevel(noise) + 4 + bonus,
      DISABLED_LEVEL
    )
  }
}

/**
 * Refine and publish the complete five-level spectral-noise rows.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {ReconstructionRefinementScratch} destination Reusable refinement storage.
 * @returns {ReconstructionRefinementScratch} The published refinement state.
 */
export function refineSpectralNoiseLevels(transaction, shared, destination) {
  const mapCount = validatePlan(transaction, shared, destination)
  const plan = destination.clearSpectralNoise()
  const startBand = SPECTRAL_NOISE_START_BAND_BY_MODE[transaction.coreMode]
  plan.slotStart = Math.min(
    SPECTRAL_NOISE_GROUP_BY_QUANTIZATION_UNIT[startBand],
    SLOT_COUNT
  )
  plan.slotEnd = Math.min(
    SPECTRAL_NOISE_GROUP_BY_QUANTIZATION_UNIT[mapCount + 0x1f] + 1,
    SLOT_COUNT
  )
  prepareReconstructionNoiseSeeds(transaction, shared, plan.seeds)
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const start = rowOffset(channel)
    const source =
      transaction.channelBlocks[channel].syntax.spectralNoiseLevelIndices
    plan.levels.set(source.subarray(0, SLOT_COUNT), start)
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    initializeRow(plan, channel)
    plan.expandedMapIndex = -1
    for (let band = startBand; band < shared.scaleFactorCount; band++) {
      observeBand(transaction, shared, plan, channel, band)
    }
    lowerChannel(plan, channel)
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const output =
      transaction.channelBlocks[channel].syntax.spectralNoiseLevelIndices
    const start = rowOffset(channel)
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      output[slot] = plan.levels[start + slot]
    }
  }
  return plan
}
