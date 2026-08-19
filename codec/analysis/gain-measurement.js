/** Numeric measurement primitives for ATRAC3plus gain-point detection. */

import { magnitudeSpectrum16LowBins } from '../transforms/dft.js'
import {
  GAIN_WINDOW_BLOCKS,
  GAIN_WINDOW_FLOATS_PER_BLOCK,
  GAIN_CONTROL_EPSILON,
  GAIN_CONTROL_INITIAL_BITS_LOG2_E,
  GAIN_CONTROL_INVERSE_7,
  GAIN_CONTROL_SCALE,
} from '../core/constants.js'
import { float32Round } from '../utils.js'

import { HALF_HANN_WINDOW } from '../core/tables.js'

/**
 * Whether a four-sample detector block contains a nonzero value or NaN.
 *
 * @param {Float32Array} source Detector samples.
 * @param {number} [offset=0] First sample index.
 * @returns {boolean} Whether the block is active.
 */
export function gainBlock4IsActive(source, offset = 0) {
  for (let index = 0; index < 4; index++) {
    const value = source[offset + index]
    if (value !== 0 || Number.isNaN(value)) return true
  }
  return false
}

/**
 * Measure 32 absolute four-sample peaks and their activity mask.
 *
 * @param {Float32Array} source Detector samples.
 * @param {Float32Array} blockPeaks Caller-owned peak output.
 * @param {GainMeasurementScratch} result Caller-owned aggregate result.
 * @param {number} [sourceOffset=0] First detector sample.
 * @returns {GainMeasurementScratch} The supplied aggregate result.
 */
export function measureGainBlockPeaks(
  source,
  blockPeaks,
  result,
  sourceOffset = 0
) {
  if (
    !(source instanceof Float32Array) ||
    !Number.isInteger(sourceOffset) ||
    sourceOffset < 0 ||
    source.length < sourceOffset + 128 ||
    !(blockPeaks instanceof Float32Array) ||
    blockPeaks.length < GAIN_WINDOW_BLOCKS ||
    !result
  ) {
    throw new RangeError('ATRAC3plus gain peak buffers have invalid geometry')
  }
  let maximumIndex = 0
  let maximumValue = 0
  let activity = 0
  for (let block = 0; block < GAIN_WINDOW_BLOCKS; block++) {
    let blockPeak = 0
    let active = false
    const offset = sourceOffset + block * GAIN_WINDOW_FLOATS_PER_BLOCK
    for (let sample = 0; sample < 4; sample++) {
      const value = source[offset + sample]
      active ||= value !== 0 || Number.isNaN(value)
      const magnitude = float32Round(Math.abs(value))
      if (!Number.isNaN(magnitude) && magnitude > blockPeak) {
        blockPeak = magnitude
      }
    }
    blockPeaks[block] = blockPeak
    if (active) activity = (activity | (1 << block)) >>> 0
    if (blockPeak > maximumValue) {
      maximumIndex = block
      maximumValue = blockPeak
    }
  }
  result.maximumIndex = maximumIndex
  result.maximumValue = maximumValue
  result.activity = activity
  return result
}

/**
 * Return the clamped base/highest logarithmic range width.
 *
 * @param {number} baseLevel Smallest positive reference level.
 * @param {number} highestLevel Largest measured level.
 * @param {number} bitLimit Maximum returned width.
 * @returns {number} Required clamped range width.
 */
export function requiredGainRangeBits(baseLevel, highestLevel, bitLimit) {
  let bits = 0
  if (baseLevel > 0 && highestLevel > baseLevel) {
    if (highestLevel >= baseLevel * 2 ** bitLimit) return bitLimit
    const logarithmicRange = Math.log(highestLevel / baseLevel)
    bits = Math.trunc(logarithmicRange * GAIN_CONTROL_INITIAL_BITS_LOG2_E) + 1
  }
  return bits > bitLimit ? bitLimit : bits
}

/**
 * Convert a flatness measurement into the multiplier used by gain-envelope comparison.
 *
 * @param {number} firstTerm
 * @param {number} secondTerm
 * @returns {number}
 */
function gainFlatnessScale(firstTerm, secondTerm) {
  const chosen =
    !Number.isNaN(firstTerm) && firstTerm >= 0 && secondTerm > firstTerm
      ? secondTerm
      : firstTerm
  if (!(chosen > 1)) return 1
  const logarithm = float32Round(Math.log(chosen))
  return float32Round(logarithm * GAIN_CONTROL_SCALE + 1)
}

/**
 * Compute the detector's windowed 16-point spectral-flatness scale.
 *
 * @param {Float32Array} windowSamples At least 16 detector samples.
 * @param {GainMeasurementScratch} scratch Reusable DFT work.
 * @param {number} [sourceOffset=0] First window sample.
 * @returns {number} Spectral-flatness scale.
 */
export function computeGainFlatnessScale(
  windowSamples,
  scratch,
  sourceOffset = 0
) {
  if (
    !(windowSamples instanceof Float32Array) ||
    !Number.isInteger(sourceOffset) ||
    sourceOffset < 0 ||
    windowSamples.length < sourceOffset + 16 ||
    !scratch
  ) {
    throw new RangeError('ATRAC3plus gain flatness requires 16 samples')
  }
  const spectrum = scratch.spectrum
  for (let sample = 0; sample < 8; sample++) {
    const coefficient = HALF_HANN_WINDOW[sample]
    spectrum[sample] = float32Round(
      windowSamples[sourceOffset + sample] * coefficient
    )
    spectrum[15 - sample] = float32Round(
      windowSamples[sourceOffset + 15 - sample] * coefficient
    )
  }
  const magnitudes = magnitudeSpectrum16LowBins(
    spectrum,
    scratch.magnitudes,
    spectrum
  )

  let interiorProduct = 1
  let squaredMagnitudeSum = float32Round(
    float32Round(magnitudes[0] * magnitudes[0]) +
      float32Round(magnitudes[7] * magnitudes[7])
  )
  for (let bin = 1; bin < 7; bin++) {
    const value = magnitudes[bin]
    interiorProduct *= float32Round(value + GAIN_CONTROL_EPSILON)
    squaredMagnitudeSum = float32Round(
      squaredMagnitudeSum + float32Round(value * value)
    )
  }
  const interiorLogSum = float32Round(Math.log(interiorProduct))
  const preciseRoot = float32Round(Math.sqrt(squaredMagnitudeSum))
  const rootLogarithm = float32Round(
    Math.log(float32Round(preciseRoot + GAIN_CONTROL_EPSILON))
  )
  const firstBinLogarithm = float32Round(
    Math.log(float32Round(magnitudes[0] + GAIN_CONTROL_EPSILON))
  )
  const lastBinLogarithm = float32Round(
    Math.log(float32Round(magnitudes[7] + GAIN_CONTROL_EPSILON))
  )

  const lastAndInterior = float32Round(lastBinLogarithm + interiorLogSum)
  const firstNumerator = float32Round(
    rootLogarithm - float32Round(lastAndInterior * GAIN_CONTROL_INVERSE_7)
  )
  const firstDenominator = float32Round(
    float32Round(rootLogarithm - firstBinLogarithm) + GAIN_CONTROL_EPSILON
  )
  const firstTerm = float32Round(
    float32Round(firstNumerator / firstDenominator) + GAIN_CONTROL_EPSILON
  )
  const leadingLogSum = float32Round(interiorLogSum + firstBinLogarithm)
  const secondNumerator = float32Round(
    rootLogarithm - float32Round(leadingLogSum * GAIN_CONTROL_INVERSE_7)
  )
  const secondDenominator = float32Round(
    float32Round(rootLogarithm - lastBinLogarithm) + GAIN_CONTROL_EPSILON
  )
  const secondTerm = float32Round(
    float32Round(secondNumerator / secondDenominator) + GAIN_CONTROL_EPSILON
  )
  return gainFlatnessScale(firstTerm, secondTerm)
}

/**
 * Insert one index into the descending measurement order without allocating or resorting the full row.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} indices
 * @param {number} length
 * @param {number} index
 * @returns {number}
 */
function insertSortedIndex(values, indices, length, index) {
  const value = values[index]
  let position = 1
  while (position < length) {
    const existingIndex = indices[position]
    const existing = values[existingIndex]
    if (!Number.isNaN(value) && !Number.isNaN(existing) && value > existing) {
      break
    }
    if (value === existing && index < existingIndex) break
    position++
  }
  for (let cursor = length; cursor > position; cursor--) {
    indices[cursor] = indices[cursor - 1]
  }
  indices[position] = index
  return length + 1
}

/**
 * Build the detector's head-prefixed descending index traversal.
 *
 * @param {Float32Array} values Values used for descending ordering.
 * @param {number} headIndex Unconditionally prefixed index.
 * @param {number} startInclusive First sortable index.
 * @param {number} endExclusive End-exclusive sortable index.
 * @param {ArrayLike<number>} order Caller-owned index vector and length.
 * @returns {ArrayLike<number>} The supplied ordering storage.
 */
export function buildSortedIndexOrder(
  values,
  headIndex,
  startInclusive,
  endExclusive,
  order
) {
  if (
    !(values instanceof Float32Array) ||
    !(order?.indices instanceof Int32Array) ||
    startInclusive < 0 ||
    endExclusive < startInclusive ||
    endExclusive > values.length ||
    endExclusive - startInclusive + 1 > order.indices.length
  ) {
    throw new RangeError('ATRAC3plus sorted gain traversal is invalid')
  }
  order.indices[0] = headIndex
  order.length = 1
  for (let index = startInclusive; index < endExclusive; index++) {
    order.length = insertSortedIndex(values, order.indices, order.length, index)
  }
  return order
}
