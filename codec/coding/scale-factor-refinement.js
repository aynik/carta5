/** Post-quantization ATRAC3plus scale-factor refinement and exact publication. */

import {
  BAND_INDEX_BY_QUANTIZATION_UNIT,
  INVERSE_QUANTIZER_SCALES,
  QUANTIZATION_UNIT_OFFSETS,
  SCALE_FACTOR_ADJUSTMENT_START_BAND_BY_MODE,
  SCALE_FACTOR_VALUES,
  SPECTRUM_BAND_LIMITS,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  DECREASE_ENERGY_RATIO,
  INCREASE_ENERGY_RATIO,
  NARROW_OVERSHOOT,
  NARROW_UNDERSHOOT,
  ROW_LENGTH,
  WIDE_OVERSHOOT,
  WIDE_UNDERSHOOT,
} from '../core/constants.js'
import { planScaleFactorSection } from '../io/scale-factor-syntax.js'
import { ScaleFactorCodingPlan } from '../state/scale-factor.js'
import {
  fillSpectralNoise,
  quantizedSpectralNoiseScale,
} from '../transforms/spectral-reconstruction.js'
import {
  prepareReconstructionNoiseSeeds,
  ReconstructionRefinementScratch,
} from './reconstruction-noise.js'

/**
 * Perform a less-than-or-equal comparison that treats NaN as an already satisfied bound.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function unorderedOrLe(left, right) {
  return Number.isNaN(left) || Number.isNaN(right) || left <= right
}

/**
 * Verify that quantized spectra, syntax plans, and reusable energy work are ready for scale-factor refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 */
function validateRefinement(transaction, shared, plan) {
  const channelCount = transaction.channelCount
  const bandCount = transaction.bandCount
  const coreMode = transaction.coreMode
  const required = QUANTIZATION_UNIT_OFFSETS[bandCount]
  const scaleFactorCount = shared?.scaleFactorCount
  const shapeCount = shared?.shapeCount
  const mapCount = shared?.mapCount
  if (
    !(plan instanceof ReconstructionRefinementScratch) ||
    !(transaction.scaleFactorPlan instanceof ScaleFactorCodingPlan) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT ||
    coreMode < 0 ||
    coreMode >= SCALE_FACTOR_ADJUSTMENT_START_BAND_BY_MODE.length ||
    !Number.isInteger(scaleFactorCount) ||
    scaleFactorCount < 0 ||
    scaleFactorCount > ROW_LENGTH ||
    (scaleFactorCount > 0 &&
      (!Number.isInteger(shapeCount) || shapeCount < 1 || shapeCount > 16)) ||
    !Number.isInteger(mapCount) ||
    mapCount < 0 ||
    mapCount > plan.seeds.length ||
    transaction.quantizationDirty
  ) {
    throw new RangeError('ATRAC3plus scale-factor refinement is not ready')
  }
  for (let channel = 0; channel < channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    if (
      !block?.syntax ||
      !(block.quantizedSpectrum instanceof Int16Array) ||
      !(transaction.normalizedSpectra[channel] instanceof Float32Array) ||
      required === undefined ||
      required > block.quantizedSpectrum.length ||
      required > transaction.normalizedSpectra[channel].length
    ) {
      throw new RangeError(
        'ATRAC3plus scale-factor refinement channel binding is invalid'
      )
    }
    for (let band = 0; band < bandCount; band++) {
      const mode = block.syntax.wordLengths[band]
      const scaleFactor = block.syntax.scaleFactors[band]
      if (
        mode < 0 ||
        mode >= INVERSE_QUANTIZER_SCALES.length ||
        (mode > 0 && (scaleFactor < 0 || scaleFactor >= 64))
      ) {
        throw new RangeError(
          'ATRAC3plus scale-factor refinement syntax is invalid'
        )
      }
    }
  }
}

/**
 * Generate and scale the deterministic noise row used to measure one reconstructed band.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 * @param {number} band
 * @param {number} mode
 * @returns {boolean}
 */
function prepareBandNoise(transaction, shared, plan, channel, band, mode) {
  const map = BAND_INDEX_BY_QUANTIZATION_UNIT[band + 1]
  let sourceChannel = channel
  if (transaction.channelCount === 2 && shared.presenceFlags[1][map] !== 0) {
    sourceChannel = 1 - channel
  }
  const source = transaction.channelBlocks[sourceChannel]
  const slot = SPECTRUM_BAND_LIMITS[map]
  const levelIndex = source.syntax.spectralNoiseLevelIndices[slot]
  if (band < 2) return false
  const scale = quantizedSpectralNoiseScale(
    levelIndex,
    source.currentGainRecords[map],
    source.previousGainRecords[map],
    mode
  )
  if (scale === null) return false
  const count =
    QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
  if (plan.expandedMapIndex !== map) {
    fillSpectralNoise(plan.seeds[map], count, plan.randomSamples)
    plan.expandedMapIndex = map
  }
  plan.noiseSampleCount = count
  plan.noiseScale = scale
  return true
}

/**
 * Reconstruct one coefficient value from its quantized sample, scale factor, and mode.
 *
 * @param {ArrayLike<number>} symbols
 * @param {number} start
 * @param {number} offset
 * @param {ReconstructionRefinementScratch} plan
 * @param {boolean} noiseActive
 * @returns {number}
 */
function reconstructedValue(symbols, start, offset, plan, noiseActive) {
  let value = Math.fround(symbols[start + offset])
  if (noiseActive && offset < plan.noiseSampleCount) {
    value = Math.fround(
      value +
        Math.fround(plan.noiseScale * Math.fround(plan.randomSamples[offset]))
    )
  }
  return value
}

/**
 * Reconstruct one band with the candidate scale factor and retain its energy and absolute-error metrics.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 * @param {number} sourceChannel
 * @param {number} start
 * @param {number} length
 * @param {boolean} noiseActive
 */
function measureBand(
  transaction,
  plan,
  channel,
  sourceChannel,
  start,
  length,
  noiseActive
) {
  const symbols = transaction.channelBlocks[sourceChannel].quantizedSpectrum
  const reference = transaction.normalizedSpectra[channel]
  let reconstructedEnergy = 0
  let referenceEnergy = 0
  for (let offset = length - 1; offset >= 0; offset--) {
    const reconstructed = reconstructedValue(
      symbols,
      start,
      offset,
      plan,
      noiseActive
    )
    const source = reference[start + offset]
    reconstructedEnergy += reconstructed * reconstructed
    referenceEnergy += source * source
  }
  let absoluteSum = 0
  const quarter = length >> 2
  for (let offset = 0; offset < quarter; offset++) {
    absoluteSum +=
      Math.abs(reconstructedValue(symbols, start, offset, plan, noiseActive)) +
      Math.abs(
        reconstructedValue(symbols, start, quarter + offset, plan, noiseActive)
      ) +
      Math.abs(
        reconstructedValue(
          symbols,
          start,
          quarter * 2 + offset,
          plan,
          noiseActive
        )
      ) +
      Math.abs(
        reconstructedValue(
          symbols,
          start,
          quarter * 3 + offset,
          plan,
          noiseActive
        )
      )
  }
  plan.reconstructedEnergySum = reconstructedEnergy
  plan.referenceEnergySum = referenceEnergy
  plan.reconstructedAbsoluteSum = Math.fround(absoluteSum)
}

/**
 * Increase a scale-factor index until reconstructed energy reaches the reference without excessive overshoot.
 *
 * @param {number} index
 * @param {number} maximum
 * @param {number} reconstructed
 * @param {number} reference
 * @param {number} overshoot
 * @returns {number}
 */
function raiseToReference(index, maximum, reconstructed, reference, overshoot) {
  let energy = reconstructed
  if (reference > energy) {
    while (index < maximum) {
      index++
      energy = Math.fround(energy * INCREASE_ENERGY_RATIO)
      if (unorderedOrLe(reference, energy)) break
    }
  }
  if (energy > Math.fround(reference * overshoot)) index--
  return index
}

/**
 * Decrease a scale-factor index until reconstructed energy approaches the reference without excessive undershoot.
 *
 * @param {number} index
 * @param {number} reconstructed
 * @param {number} reference
 * @param {number} undershoot
 * @returns {number}
 */
function lowerToReference(index, reconstructed, reference, undershoot) {
  let energy = reconstructed
  if (energy > reference) {
    while (index > 0) {
      index--
      energy = Math.fround(energy * DECREASE_ENERGY_RATIO)
      if (unorderedOrLe(energy, reference)) break
    }
  }
  if (Math.fround(reference * undershoot) > energy) index++
  return index
}

/**
 * Choose the bounded scale-factor adjustment that best matches reconstructed and reference energy.
 *
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} base
 * @param {number} reconstructed
 * @param {number} reference
 * @param {number} bandLevel
 * @param {number} ratio
 * @returns {number}
 */
function selectIndex(plan, base, reconstructed, reference, bandLevel, ratio) {
  const stepLimit = plan.wide ? 10 : 5
  if (reconstructed < reference) {
    let selected = raiseToReference(
      base,
      63,
      reconstructed,
      reference,
      plan.wide ? WIDE_OVERSHOOT : NARROW_OVERSHOOT
    )
    if (bandLevel > 3) {
      if (!(ratio >= 0.75 && ratio <= 1.5)) selected--
    } else if (ratio > 3) selected--
    if (selected < base) selected = base
    else if (selected - base > stepLimit) selected = base + stepLimit
    return selected
  }
  if (unorderedOrLe(6, bandLevel) && unorderedOrLe(0.5, ratio)) {
    return base
  }
  return lowerToReference(
    base,
    reconstructed,
    reference,
    plan.wide ? WIDE_UNDERSHOOT : NARROW_UNDERSHOOT
  )
}

/**
 * Index one channel-band value in the flat committed-refinement row.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 * @param {ReconstructionRefinementScratch} plan
 * @param {number} channel
 * @param {number} band
 * @param {number} base
 * @returns {number}
 */
function refinedIndex(transaction, shared, plan, channel, band, base) {
  const sourceChannel =
    channel === 1 && transaction.intensityStereoBandMask[band] === 1
      ? 0
      : channel
  const mode = transaction.channelBlocks[sourceChannel].syntax.wordLengths[band]
  if (mode <= 0 || base <= 0) return base
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const length = QUANTIZATION_UNIT_OFFSETS[band + 1] - start
  const noiseActive = prepareBandNoise(
    transaction,
    shared,
    plan,
    channel,
    band,
    mode
  )
  const scaleFactor = SCALE_FACTOR_VALUES[base]
  const factor = Math.fround(INVERSE_QUANTIZER_SCALES[mode] * scaleFactor)
  measureBand(
    transaction,
    plan,
    channel,
    sourceChannel,
    start,
    length,
    noiseActive
  )
  const referenceEnergy = Math.fround(
    plan.referenceEnergySum * scaleFactor * scaleFactor
  )
  const reconstructedEnergy = Math.fround(
    plan.reconstructedEnergySum * factor * factor
  )
  if (!(referenceEnergy > 0) || !(reconstructedEnergy > 0)) return base
  const ratioNumber = unorderedOrLe(plan.reconstructedAbsoluteSum, 0)
    ? Math.fround(0)
    : Math.fround((length * scaleFactor) / plan.reconstructedAbsoluteSum)
  const bandLevel = transaction.sourceChannels[sourceChannel].bandLevels[band]
  const ratio = ratioNumber / (bandLevel * factor)
  return selectIndex(
    plan,
    base,
    reconstructedEnergy,
    referenceEnergy,
    bandLevel,
    ratio
  )
}

/**
 * Refine reconstruction scale factors in pooled scratch and publish their exact sidechain once.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {ReconstructionRefinementScratch} scratch Reusable refinement storage.
 * @returns {number} Resulting exact allocation width.
 */
export function refineScaleFactors(transaction, shared, scratch) {
  validateRefinement(transaction, shared, scratch)
  const plan = scratch.clearScaleFactors()
  plan.wide =
    (transaction.channelCount === 2 && transaction.coreMode <= 0x1b) ||
    (transaction.channelCount === 1 && transaction.coreMode === 0x09)
  prepareReconstructionNoiseSeeds(transaction, shared, plan.seeds)
  const startBand =
    SCALE_FACTOR_ADJUSTMENT_START_BAND_BY_MODE[transaction.coreMode]
  for (let band = startBand; band < transaction.bandCount; band++) {
    for (let channel = 0; channel < transaction.channelCount; channel++) {
      const factors = transaction.channelBlocks[channel].syntax.scaleFactors
      factors[band] = refinedIndex(
        transaction,
        shared,
        plan,
        channel,
        band,
        factors[band]
      )
    }
  }
  if (shared.scaleFactorCount > 0) {
    planScaleFactorSection(
      transaction.channelBlocks,
      shared,
      transaction.scaleFactorPlan
    )
  } else {
    transaction.scaleFactorPlan.clear(transaction.channelCount)
  }
  transaction.replaceScaleFactorBits(
    shared.scaleFactorCount > 0 ? transaction.scaleFactorPlan.bits : 0
  )
  return transaction.bitsTotal
}
