/** ATRAC3plus decoded broadband noise in the post-MDCT subband domain. */

import {
  NOISE_TABLE_OFFSETS,
  NOISE_VALUES,
  SPECTRAL_NOISE_LEVEL_SCALES,
} from '../core/tables.js'
import {
  FRAME_SAMPLES,
  NOISE_INDEX_MASK,
  TRANSFORMS_SPECTRAL_RECONSTRUCTION_NOISE_SCALE,
  TRANSFORMS_SUBBAND_NOISE_NOISE_SCALE,
  TRANSFORMS_SUBBAND_NOISE_SUBBAND_SAMPLES,
  SUBBANDS,
} from '../core/constants.js'

/**
 * Add one decoded noise payload and advance its staged table index.
 *
 * @param {SharedState} shared Staged shared coding-unit state.
 * @param {Float32Array} subbandSamples Mutable subband samples.
 * @returns {Float32Array} The updated subband samples.
 */
export function addSubbandNoise(shared, subbandSamples) {
  if (
    !shared ||
    !(subbandSamples instanceof Float32Array) ||
    subbandSamples.length < FRAME_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus subband-noise storage is invalid')
  }
  if (shared.noisePresent === 0) return subbandSamples
  if (
    !Number.isInteger(shared.noiseLevelIndex) ||
    shared.noiseLevelIndex < 0 ||
    shared.noiseLevelIndex > 31 ||
    !Number.isInteger(shared.noiseTableIndex) ||
    shared.noiseTableIndex < 0 ||
    shared.noiseTableIndex + SUBBANDS > NOISE_TABLE_OFFSETS.length
  ) {
    throw new RangeError('ATRAC3plus subband-noise syntax is invalid')
  }
  const scale = Math.fround(
    Math.fround(2 ** (shared.noiseLevelIndex & 31)) *
      TRANSFORMS_SUBBAND_NOISE_NOISE_SCALE
  )
  let tableIndex = shared.noiseTableIndex
  for (let subband = 0; subband < SUBBANDS; subband++) {
    const tablePosition = NOISE_TABLE_OFFSETS[tableIndex++]
    const offset = subband * TRANSFORMS_SUBBAND_NOISE_SUBBAND_SAMPLES
    for (
      let sample = 0;
      sample < TRANSFORMS_SUBBAND_NOISE_SUBBAND_SAMPLES;
      sample++
    ) {
      subbandSamples[offset + sample] = Math.fround(
        subbandSamples[offset + sample] +
          Math.fround(NOISE_VALUES[tablePosition + sample] * scale)
      )
    }
  }
  shared.noiseTableIndex = tableIndex
  return subbandSamples
}

/**
 * Select the gain exponent that best aligns reconstructed noise with the target scale.
 *
 * @param {object} current
 * @param {object} previous
 * @returns {number}
 */
function bestGainShift(current, previous) {
  const currentCount = current?.entries
  const previousCount = previous?.entries
  if (
    !Number.isInteger(currentCount) ||
    !Number.isInteger(previousCount) ||
    currentCount < 0 ||
    previousCount < 0 ||
    currentCount > current.levels.length ||
    previousCount > previous.levels.length
  ) {
    return null
  }
  const initialLevel = currentCount > 0 ? current.levels[0] : 6
  if (initialLevel < 0 || initialLevel >= 16) return null
  const base = 6 - initialLevel
  let best = 0
  for (let index = 0; index < previousCount; index++) {
    const level = previous.levels[index]
    if (level < 0 || level >= 16) return null
    best = Math.max(best, 6 - level + base)
  }
  for (let index = 0; index < currentCount; index++) {
    const level = current.levels[index]
    if (level < 0 || level >= 16) return null
    best = Math.max(best, 6 - level)
  }
  return best
}

/**
 * Return the power-of-two denominator associated with a gain shift.
 *
 * @param {number} shift
 * @returns {number}
 */
function shiftDenominator(shift) {
  return Math.fround(2 ** (shift & 31))
}

/**
 * Expand one deterministic 10-bit spectral-noise seed.
 *
 * @param {number} seed Ten-bit noise-table seed.
 * @param {number} count Requested sample count.
 * @param {Float32Array} output Caller-owned noise output.
 * @returns {Float32Array} The noise output.
 */
export function fillSpectralNoise(seed, count, output) {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > NOISE_INDEX_MASK ||
    !Number.isInteger(count) ||
    count < 0 ||
    !(output instanceof Float32Array) ||
    count > output.length
  ) {
    throw new RangeError('ATRAC3plus spectral-noise expansion is invalid')
  }
  for (let sample = 0; sample < count; sample++) {
    output[sample] = Math.fround(
      Math.fround(NOISE_VALUES[(seed + sample) & NOISE_INDEX_MASK]) *
        TRANSFORMS_SPECTRAL_RECONSTRUCTION_NOISE_SCALE
    )
  }
  return count
}

/**
 * Derive the deterministic reconstruction-noise amplitude for one band.
 *
 * @param {number} level
 * @param {number} gainShift
 * @param {number} scaleFactor
 * @param {number} inverseQuantizer
 * @param {number} wordLength
 * @returns {number}
 */
export function spectralNoiseScale(
  level,
  currentGain,
  previousGain,
  scaleFactor,
  inverseQuantizer,
  wordLength
) {
  const gainShift = bestGainShift(currentGain, previousGain)
  if (!(level > 0) || gainShift === null) return null
  let scale = Math.fround(level / shiftDenominator(gainShift))
  scale = Math.fround(scale * scaleFactor)
  scale = Math.fround(scale * inverseQuantizer)
  return Math.fround(scale / shiftDenominator(wordLength))
}

/**
 * Noise scale in the quantized-coefficient domain, or null when disabled.
 *
 * @param {number} levelIndex Spectral-noise level index.
 * @param {object} currentGain Current-frame gain record.
 * @param {object} previousGain Previous-frame gain record.
 * @param {number} quantizationMode Spectrum quantization mode.
 * @returns {number|null} Quantized noise scale, or `null` when disabled.
 */
export function quantizedSpectralNoiseScale(
  levelIndex,
  currentGain,
  previousGain,
  quantizationMode
) {
  const level = SPECTRAL_NOISE_LEVEL_SCALES[levelIndex]
  const gainShift = bestGainShift(currentGain, previousGain)
  if (
    !(level > 0) ||
    gainShift === null ||
    !Number.isInteger(quantizationMode)
  ) {
    return null
  }
  const denominator = shiftDenominator(gainShift + quantizationMode)
  return Math.fround(Math.fround(level) / denominator)
}
