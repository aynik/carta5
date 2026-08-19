/** ATRAC3plus correlation and low-rate signal comparison helpers. */

import { PeakEnvelopeComparison, SignalComparison } from '../state/analysis.js'
import {
  CORRELATION_CAP,
  CORRELATION_LOG_FALLBACK,
  CORRELATION_LOG_SCALE,
  CORRELATION_LOW,
  CORRELATION_LOW_DB,
} from '../core/constants.js'

/**
 * Convert the weaker normalized channel correlation into decibels.
 *
 * @param {string} kind
 * @param {number} [ratio]
 * @returns {number}
 */
function lowerCorrelationDb(kind, ratio = 0) {
  if (kind === 0) return CORRELATION_LOW_DB
  let scaledLog = 0
  if (kind === 2) {
    scaledLog = Math.fround(Math.log(ratio) * CORRELATION_LOG_SCALE)
  } else if (kind === 3) {
    scaledLog = CORRELATION_LOG_FALLBACK
  }
  const correlation = Math.fround(-scaledLog)
  return correlation > CORRELATION_CAP ? CORRELATION_CAP : correlation
}

/**
 * Lower generic channel/difference powers to ATRAC3plus correlation decibels.
 *
 * @param {number} first First-channel power.
 * @param {number} second Second-channel power.
 * @param {number} difference Difference-channel power.
 * @returns {number} Correlation in decibels.
 */
export function channelCorrelationDb(first, second, difference) {
  let ratio
  if (first === 0) {
    ratio = second === 0 || difference === 0 ? CORRELATION_LOW : 1
  } else if (difference === 0) {
    ratio = CORRELATION_LOW
  } else if (second === 0) {
    ratio = 1
  } else {
    ratio = difference / (second > first ? second : first)
  }
  if (ratio === CORRELATION_LOW) return lowerCorrelationDb(0)
  if (ratio === 1) return lowerCorrelationDb(1)
  return ratio > 0 ? lowerCorrelationDb(2, ratio) : lowerCorrelationDb(3)
}

/**
 * Lower intensity-stereo channel/difference powers to reference decibels.
 *
 * @param {number} first First-channel power.
 * @param {number} second Second-channel power.
 * @param {number} difference Difference-channel power.
 * @returns {number} Intensity correlation in decibels.
 */
export function intensityCorrelationDb(first, second, difference) {
  /**
   * Report whether a floating-point measurement is non-finite and therefore unusable.
   *
   * @param {number} value
   * @returns {boolean}
   */
  const bad = (value) => value < 0 || Number.isNaN(value) || value === 0
  if ((bad(first) && bad(second)) || bad(difference)) {
    return lowerCorrelationDb(0)
  }
  if (bad(first) || bad(second)) return lowerCorrelationDb(1)
  const denominator = second > first ? second : first
  const ratioF32 = Math.fround(difference / denominator)
  const ratioF64 = difference / denominator
  if (ratioF32 === CORRELATION_LOW) return lowerCorrelationDb(0)
  if (ratioF32 === 1) return lowerCorrelationDb(1)
  return ratioF32 >= 0 ? lowerCorrelationDb(2, ratioF64) : lowerCorrelationDb(3)
}

/**
 * Exact two-row channel-correlation measurement used by intensity history.
 *
 * @param {Float32Array} firstLeft First left-channel segment.
 * @param {Float32Array} firstRight First right-channel segment.
 * @param {Float32Array} secondLeft Second left-channel segment.
 * @param {Float32Array} secondRight Second right-channel segment.
 * @returns {number} Combined correlation in decibels.
 */
export function channelCorrelationTwoSegments(
  firstLeft,
  firstRight,
  secondLeft,
  secondRight
) {
  let first0 = 0
  let first1 = 0
  let first2 = 0
  let first3 = 0
  let second0 = 0
  let second1 = 0
  let second2 = 0
  let second3 = 0
  let difference0 = 0
  let difference1 = 0
  let difference2 = 0
  let difference3 = 0
  const segmentLength = firstLeft.length
  for (let index = 0; index < segmentLength * 2; index += 4) {
    const offset = index < segmentLength ? index : index - segmentLength
    const left = index < segmentLength ? firstLeft : secondLeft
    const right = index < segmentLength ? firstRight : secondRight
    const left0 = left[offset]
    const left2 = left[offset + 2]
    const left1 = left[offset + 1]
    const left3 = left[offset + 3]
    const right0 = right[offset]
    const right2 = right[offset + 2]
    const right1 = right[offset + 1]
    const right3 = right[offset + 3]
    const delta0 = Math.fround(left0 - right0)
    const delta2 = Math.fround(left2 - right2)
    const delta1 = Math.fround(left1 - right1)
    const delta3 = Math.fround(left3 - right3)
    first0 = Math.fround(first0 + Math.fround(left0 * left0))
    first2 = Math.fround(first2 + Math.fround(left2 * left2))
    first1 = Math.fround(first1 + Math.fround(left1 * left1))
    first3 = Math.fround(first3 + Math.fround(left3 * left3))
    second0 = Math.fround(second0 + Math.fround(right0 * right0))
    second2 = Math.fround(second2 + Math.fround(right2 * right2))
    second1 = Math.fround(second1 + Math.fround(right1 * right1))
    second3 = Math.fround(second3 + Math.fround(right3 * right3))
    difference0 = Math.fround(difference0 + Math.fround(delta0 * delta0))
    difference2 = Math.fround(difference2 + Math.fround(delta2 * delta2))
    difference1 = Math.fround(difference1 + Math.fround(delta1 * delta1))
    difference3 = Math.fround(difference3 + Math.fround(delta3 * delta3))
  }
  const firstPower = Math.fround(
    Math.fround(Math.fround(first0 + first1) + first2) + first3
  )
  const secondPower = Math.fround(
    Math.fround(Math.fround(second1 + second0) + second2) + second3
  )
  const differencePower = Math.fround(
    Math.fround(Math.fround(difference0 + difference1) + difference2) +
      difference3
  )

  return channelCorrelationDb(firstPower, secondPower, differencePower)
}

/**
 * Create caller-owned storage for exact aligned-signal energy and shape metrics.
 *
 * @returns {SignalComparison} Mutable comparison result.
 */
export function createSignalComparison() {
  return new SignalComparison()
}

/**
 * Compare aligned float32 signals using widened accumulation order.
 *
 * @param {Float32Array} candidate Candidate samples.
 * @param {Float32Array} reference Reference samples.
 * @param {SignalComparison} result Caller-owned result.
 * @param {number} [sampleCount] Compared prefix length.
 * @returns {SignalComparison} The supplied result.
 */
export function compareSignalsExact(
  candidate,
  reference,
  result,
  sampleCount = candidate?.length
) {
  if (
    !(candidate instanceof Float32Array) ||
    !(reference instanceof Float32Array) ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    candidate.length < sampleCount ||
    reference.length < sampleCount ||
    !result
  ) {
    throw new RangeError('aligned signal comparison geometry is invalid')
  }
  let candidateEnergy = 0
  let referenceEnergy = 0
  let differenceEnergy = 0
  let correlation = 0
  for (let index = 0; index < sampleCount; index++) {
    const candidateValue = candidate[index]
    const referenceValue = reference[index]
    const difference = candidateValue - referenceValue
    candidateEnergy += candidateValue * candidateValue
    referenceEnergy += referenceValue * referenceValue
    differenceEnergy += difference * difference
    correlation += candidateValue * referenceValue
  }
  result.candidateEnergy = candidateEnergy
  result.referenceEnergy = referenceEnergy
  result.differenceEnergy = differenceEnergy
  result.relativeDifferenceEnergy =
    referenceEnergy > 0 ? differenceEnergy / referenceEnergy : 0
  let shapeError = 0
  if (candidateEnergy > 0 && referenceEnergy > 0) {
    correlation /= Math.sqrt(candidateEnergy * referenceEnergy)
    correlation = Math.max(-1, Math.min(1, correlation))
    shapeError = Math.max(0, 1 - correlation * correlation)
  } else if (candidateEnergy > 0 || referenceEnergy > 0) {
    shapeError = 1
  }
  result.shapeError = shapeError
  return result
}

/**
 * Allocate fixed peak-envelope storage for temporal merge comparisons.
 *
 * @param {number} blockCount Positive envelope block count.
 * @returns {PeakEnvelopeComparison} Reusable envelope comparison.
 */
export function createPeakEnvelopeComparison(blockCount) {
  return new PeakEnvelopeComparison(blockCount)
}

/**
 * Measure block peaks and store their indices in stable descending-magnitude order.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} sourceOffset
 * @param {number} chunkLength
 * @param {Float32Array} destination
 */
function fillOrderedPeakEnvelope(
  samples,
  sourceOffset,
  chunkLength,
  destination
) {
  if (
    !(samples instanceof Float32Array) ||
    !Number.isInteger(sourceOffset) ||
    sourceOffset < 0 ||
    !Number.isInteger(chunkLength) ||
    chunkLength < 1 ||
    samples.length < sourceOffset + destination.length * chunkLength
  ) {
    throw new RangeError('peak-envelope source geometry is invalid')
  }
  for (let chunk = 0; chunk < destination.length; chunk++) {
    let maximum = 0
    const start = sourceOffset + chunk * chunkLength
    for (let sample = 0; sample < chunkLength; sample++) {
      const magnitude = Math.fround(Math.abs(samples[start + sample]))
      if (!Number.isNaN(magnitude) && magnitude > maximum) maximum = magnitude
    }
    destination[chunk] = maximum
  }
}

/**
 * Load the immutable side of one peak-envelope comparison.
 *
 * @param {Float32Array} samples Reference signal.
 * @param {number} sourceOffset First reference sample.
 * @param {number} chunkLength Samples per peak block.
 * @param {PeakEnvelopeComparison} scratch Reusable comparison storage.
 * @returns {PeakEnvelopeComparison} The supplied storage.
 */
export function loadPeakEnvelopeReference(
  samples,
  sourceOffset,
  chunkLength,
  scratch
) {
  fillOrderedPeakEnvelope(samples, sourceOffset, chunkLength, scratch.reference)
  return scratch
}

/**
 * Compare a candidate peak envelope against the previously loaded reference.
 *
 * @param {Float32Array} samples Candidate signal.
 * @param {number} sourceOffset First candidate sample.
 * @param {number} chunkLength Samples per peak block.
 * @param {PeakEnvelopeComparison} scratch Loaded comparison storage.
 * @returns {SignalComparison} Exact envelope comparison result.
 */
export function comparePeakEnvelopeCandidate(
  samples,
  sourceOffset,
  chunkLength,
  scratch
) {
  fillOrderedPeakEnvelope(samples, sourceOffset, chunkLength, scratch.candidate)
  return compareSignalsExact(
    scratch.candidate,
    scratch.reference,
    scratch.result
  )
}
