/** Exact ATRAC3plus intensity-stereo analysis and staged QMF-row processing. */

import { intensityCorrelationDb } from './perceptual.js'
import {
  ANTI_PHASE_RATIO,
  ANALYSIS_INTENSITY_BAND_COUNT,
  IN_PHASE_RATIO,
  MAX_CROSS_MIX,
  MIX_CURVE_SCALE,
  MIX_CURVE_STEEPNESS,
  MIX_SLOT,
  NEWEST_SLOT,
  POWER_SLOT,
  ANALYSIS_INTENSITY_SAMPLES,
  WEIGHT_FLOOR,
} from '../core/constants.js'
import {
  INTENSITY_RAMP_16,
  INTENSITY_RAMP_32,
  INTENSITY_RAMP_64,
  INTENSITY_RAMP_8,
  NOISE_FLOOR_44100,
  NOISE_FLOOR_48000,
} from '../core/tables.js'

/**
 * Accumulate channel power together with left-minus-right power in one pass.
 *
 * @param {Float32Array} first
 * @param {Float32Array} second
 * @param {Float32Array} destination
 */
function channelAndDifferencePower(first, second, destination) {
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
  for (let index = 0; index < ANALYSIS_INTENSITY_SAMPLES; index += 4) {
    const a0 = first[index]
    const a2 = first[index + 2]
    const a1 = first[index + 1]
    const a3 = first[index + 3]
    const b0 = second[index]
    const b2 = second[index + 2]
    const b1 = second[index + 1]
    const b3 = second[index + 3]
    const d0 = Math.fround(a0 - b0)
    const d2 = Math.fround(a2 - b2)
    const d1 = Math.fround(a1 - b1)
    const d3 = Math.fround(a3 - b3)
    first0 = Math.fround(first0 + Math.fround(a0 * a0))
    first2 = Math.fround(first2 + Math.fround(a2 * a2))
    first1 = Math.fround(first1 + Math.fround(a1 * a1))
    first3 = Math.fround(first3 + Math.fround(a3 * a3))
    second0 = Math.fround(second0 + Math.fround(b0 * b0))
    second2 = Math.fround(second2 + Math.fround(b2 * b2))
    second1 = Math.fround(second1 + Math.fround(b1 * b1))
    second3 = Math.fround(second3 + Math.fround(b3 * b3))
    difference0 = Math.fround(difference0 + Math.fround(d0 * d0))
    difference2 = Math.fround(difference2 + Math.fround(d2 * d2))
    difference1 = Math.fround(difference1 + Math.fround(d1 * d1))
    difference3 = Math.fround(difference3 + Math.fround(d3 * d3))
  }
  destination[0] = Math.fround(
    Math.fround(Math.fround(first0 + first1) + first2) + first3
  )
  destination[1] = Math.fround(
    Math.fround(Math.fround(second1 + second0) + second2) + second3
  )
  destination[2] = Math.fround(
    Math.fround(Math.fround(difference0 + difference1) + difference2) +
      difference3
  )
}

/**
 * Compute the two self-dot products needed for a stereo reconstruction comparison.
 *
 * @param {Float32Array} first
 * @param {Float32Array} second
 * @param {Float32Array} destination
 */
function dualSelfDot(first, second, destination) {
  let first0 = 0
  let first1 = 0
  let first2 = 0
  let first3 = 0
  let second0 = 0
  let second1 = 0
  let second2 = 0
  let second3 = 0
  for (let index = 0; index < ANALYSIS_INTENSITY_SAMPLES; index += 4) {
    first0 = Math.fround(first0 + Math.fround(first[index] * first[index]))
    first2 = Math.fround(
      first2 + Math.fround(first[index + 2] * first[index + 2])
    )
    first1 = Math.fround(
      first1 + Math.fround(first[index + 1] * first[index + 1])
    )
    first3 = Math.fround(
      first3 + Math.fround(first[index + 3] * first[index + 3])
    )
    second0 = Math.fround(second0 + Math.fround(second[index] * second[index]))
    second2 = Math.fround(
      second2 + Math.fround(second[index + 2] * second[index + 2])
    )
    second1 = Math.fround(
      second1 + Math.fround(second[index + 1] * second[index + 1])
    )
    second3 = Math.fround(
      second3 + Math.fround(second[index + 3] * second[index + 3])
    )
  }
  destination[0] = Math.fround(
    Math.fround(Math.fround(first1 + first0) + first2) + first3
  )
  destination[1] = Math.fround(
    Math.fround(Math.fround(second2 + second1) + second0) + second3
  )
}

/**
 * Interpolate the intensity-stereo reconstruction weight at one sample position.
 *
 * @param {number} current
 * @param {number} next
 * @returns {Float32Array}
 */
function reconstructionRamp(current, next) {
  const ratio =
    current === 0 || next === 0
      ? 32
      : next > current
        ? next / current
        : current / next
  if (ratio > 16) return INTENSITY_RAMP_8
  if (ratio > 8) return INTENSITY_RAMP_16
  if (ratio > 4) return INTENSITY_RAMP_32
  return INTENSITY_RAMP_64
}

/**
 * Estimate reconstructed stereo power for a proposed intensity transition.
 *
 * @param {number} previous
 * @param {number} current
 * @param {number} next
 * @param {ArrayLike<number>} input
 * @param {Float32Array} output
 */
function reconstructIntensityPower(previous, current, next, input, output) {
  const headTable = reconstructionRamp(previous, current)
  const tailTable = reconstructionRamp(current, next)
  const headLength = headTable.length - 1
  const tailLength = tailTable.length - 1
  const headDelta = current - previous
  const headSum = current + previous
  const tailDelta = current - next
  const tailSum = current + next
  const middleScale = headDelta * headTable[headLength] + headSum
  let sample = 0
  while (sample < headLength) {
    const scale = headDelta * headTable[sample] + headSum
    output[sample] = Math.fround(scale * input[sample])
    sample++
  }
  const middleEnd = ANALYSIS_INTENSITY_SAMPLES - tailLength
  while (sample < middleEnd) {
    output[sample] = Math.fround(middleScale * input[sample])
    sample++
  }
  for (
    let offset = 0;
    sample < ANALYSIS_INTENSITY_SAMPLES;
    offset++, sample++
  ) {
    const scale = tailDelta * tailTable[tailLength - offset] + tailSum
    output[sample] = Math.fround(scale * input[sample])
  }
}

/**
 * Accumulate paired-channel and unpaired-tail power over the comparison window.
 *
 * @param {Float32Array} leftHead
 * @param {Float32Array} rightHead
 * @param {Float32Array} leftTail
 * @param {Float32Array} rightTail
 * @param {Float32Array} output
 * @returns {number}
 */
function sumPairAndTailPower(leftHead, rightHead, leftTail, rightTail, output) {
  for (let sample = 0; sample < ANALYSIS_INTENSITY_SAMPLES; sample++) {
    output[sample] = Math.fround(leftHead[sample] + rightHead[sample])
  }
  let lane0 = 0
  let lane1 = 0
  let lane2 = 0
  let lane3 = 0
  for (let sample = 0; sample < ANALYSIS_INTENSITY_SAMPLES; sample += 4) {
    const value0 = Math.fround(leftTail[sample] + rightTail[sample])
    const value1 = Math.fround(leftTail[sample + 1] + rightTail[sample + 1])
    const value2 = Math.fround(leftTail[sample + 2] + rightTail[sample + 2])
    const value3 = Math.fround(leftTail[sample + 3] + rightTail[sample + 3])
    output[ANALYSIS_INTENSITY_SAMPLES + sample] = value0
    output[ANALYSIS_INTENSITY_SAMPLES + sample + 1] = value1
    output[ANALYSIS_INTENSITY_SAMPLES + sample + 2] = value2
    output[ANALYSIS_INTENSITY_SAMPLES + sample + 3] = value3
    lane0 += value0 * value0
    lane1 += value1 * value1
    lane2 += value2 * value2
    lane3 += value3 * value3
  }
  return lane0 + lane1 + lane2 + lane3
}

/**
 * Apply intensity analysis and reconstruction to one detached stereo pair.
 *
 * @param {IntensityStereoState} state Persistent intensity history.
 * @param {number} coreMode Profile core-mode selector.
 * @param {boolean} uses48000HzProfile Whether the 48 kHz floor table applies.
 * @param {EncodeAnalysisState} leftState Detached left-channel analysis state.
 * @param {EncodeAnalysisState} rightState Detached right-channel analysis state.
 * @param {IntensityScratch} scratch Reusable intensity work.
 * @returns {IntensityStereoState} Updated persistent intensity state.
 */
export function applyIntensityStereo(
  state,
  coreMode,
  uses48000HzProfile,
  leftState,
  rightState,
  scratch
) {
  if (
    !Number.isInteger(coreMode) ||
    coreMode < 0 ||
    coreMode >= 32 ||
    !state?.correlationDecibels ||
    !leftState?.bandSlots ||
    !rightState?.bandSlots ||
    !(scratch?.combinedSamples instanceof Float32Array)
  ) {
    throw new RangeError('ATRAC3plus intensity-stereo geometry is invalid')
  }

  for (let band = 0; band < ANALYSIS_INTENSITY_BAND_COUNT; band++) {
    channelAndDifferencePower(
      leftState.bandSlots[band][POWER_SLOT],
      rightState.bandSlots[band][POWER_SLOT],
      scratch.powers
    )
    state.correlationDecibels[band] = intensityCorrelationDb(
      scratch.powers[0],
      scratch.powers[1],
      scratch.powers[2]
    )
  }

  const noiseFloor = uses48000HzProfile ? NOISE_FLOOR_48000 : NOISE_FLOOR_44100
  state.intensityBandLimit = noiseFloor[coreMode]
  scratch.weights.fill(1)
  let bandWeight = 1
  for (let band = state.intensityBandLimit; band >= 0; band--) {
    if (Number.isNaN(bandWeight) || bandWeight <= WEIGHT_FLOOR) bandWeight = 0
    scratch.weights[band] = bandWeight
    bandWeight = Math.fround(bandWeight * 0.5)
  }
  let firstBand = 0
  while (
    firstBand < ANALYSIS_INTENSITY_BAND_COUNT &&
    !Number.isNaN(scratch.weights[firstBand]) &&
    scratch.weights[firstBand] <= WEIGHT_FLOOR
  ) {
    firstBand++
  }
  if (firstBand >= ANALYSIS_INTENSITY_BAND_COUNT) return state

  for (let band = firstBand; band < ANALYSIS_INTENSITY_BAND_COUNT; band++) {
    let leftAbsolute = 0
    let rightAbsolute = 0
    let differenceAbsolute = 0
    for (let slotIndex = 0; slotIndex < 2; slotIndex++) {
      const slot = slotIndex === 0 ? MIX_SLOT : NEWEST_SLOT
      const left = leftState.bandSlots[band][slot]
      const right = rightState.bandSlots[band][slot]
      for (let sample = 0; sample < ANALYSIS_INTENSITY_SAMPLES; sample++) {
        leftAbsolute = Math.fround(leftAbsolute + Math.abs(left[sample]))
        rightAbsolute = Math.fround(rightAbsolute + Math.abs(right[sample]))
        const difference = Math.fround(left[sample] - right[sample])
        differenceAbsolute = Math.fround(
          differenceAbsolute + Math.abs(difference)
        )
      }
    }
    let ratio = 0
    if (leftAbsolute !== 0 || rightAbsolute !== 0) {
      ratio = differenceAbsolute / (leftAbsolute + rightAbsolute)
    }
    if (leftAbsolute === 0 && rightAbsolute === 0 && differenceAbsolute === 0) {
      ratio = 1
    }
    let mix
    if (ratio > ANTI_PHASE_RATIO) mix = 0
    else if (ratio < IN_PHASE_RATIO) mix = 1
    else {
      mix = Math.fround(
        Math.atan((0.5 - ratio) * MIX_CURVE_STEEPNESS) * MIX_CURVE_SCALE + 0.5
      )
    }
    mix = Number.isNaN(mix) ? MAX_CROSS_MIX : Math.min(mix, MAX_CROSS_MIX)

    const weight = Math.fround(scratch.weights[band] * 0.5)
    const previousMix = Math.fround(
      weight * state.mixHistory[2 * ANALYSIS_INTENSITY_BAND_COUNT + band]
    )
    const currentMix = Math.fround(
      weight * state.mixHistory[3 * ANALYSIS_INTENSITY_BAND_COUNT + band]
    )
    const nextMix = Math.fround(weight * mix)
    const headDelta = Math.fround(currentMix - previousMix)
    const headSum = Math.fround(previousMix + currentMix)
    const tailDelta = Math.fround(currentMix - nextMix)
    const tailSum = Math.fround(nextMix + currentMix)
    const left = leftState.bandSlots[band][MIX_SLOT]
    const right = rightState.bandSlots[band][MIX_SLOT]
    for (let sample = 0; sample < 64; sample++) {
      const mixFactor = headDelta * INTENSITY_RAMP_64[sample] + headSum
      const directFactor = 1 - mixFactor
      const leftSample = left[sample]
      const rightSample = right[sample]
      left[sample] = Math.fround(
        directFactor * leftSample + mixFactor * rightSample
      )
      right[sample] = Math.fround(
        mixFactor * leftSample + directFactor * rightSample
      )
    }
    let tableIndex = 64
    for (
      let sample = 64;
      sample < ANALYSIS_INTENSITY_SAMPLES;
      sample++, tableIndex--
    ) {
      const mixFactor = tailDelta * INTENSITY_RAMP_64[tableIndex] + tailSum
      const directFactor = 1 - mixFactor
      const leftSample = left[sample]
      const rightSample = right[sample]
      left[sample] = Math.fround(
        directFactor * leftSample + mixFactor * rightSample
      )
      right[sample] = Math.fround(
        mixFactor * leftSample + directFactor * rightSample
      )
    }
    state.mixHistory[4 * ANALYSIS_INTENSITY_BAND_COUNT + band] = mix
  }
  state.mixHistory.copyWithin(
    0,
    ANALYSIS_INTENSITY_BAND_COUNT,
    5 * ANALYSIS_INTENSITY_BAND_COUNT
  )

  scratch.nextScales[0].fill(0.25)
  scratch.nextScales[1].fill(0.25)
  for (
    let band = state.intensityBandLimit;
    band < ANALYSIS_INTENSITY_BAND_COUNT;
    band++
  ) {
    const correlation = state.correlationDecibels[band]
    if (Number.isNaN(correlation) || correlation < -11) continue
    const leftMix = leftState.bandSlots[band][MIX_SLOT]
    const rightMix = rightState.bandSlots[band][MIX_SLOT]
    dualSelfDot(leftMix, rightMix, scratch.powers)
    let sumPower =
      sumPairAndTailPower(
        leftState.bandSlots[band][POWER_SLOT],
        rightState.bandSlots[band][POWER_SLOT],
        leftMix,
        rightMix,
        scratch.combinedSamples
      ) * 0.25
    for (let channel = 0; channel < 2; channel++) {
      if (Number.isNaN(sumPower) || sumPower <= 0) {
        scratch.nextScales[channel][band] = 0.25
        continue
      }
      const ratio = scratch.powers[channel] / sumPower
      let scale = Math.sqrt(ratio)
      if (Number.isNaN(scale)) {
        scale = Math.sqrt(ratio)
        sumPower = Math.fround(sumPower)
      }
      scratch.nextScales[channel][band] = Math.fround(scale * 0.25)
    }
    for (let channel = 0; channel < 2; channel++) {
      const offset = channel * ANALYSIS_INTENSITY_BAND_COUNT + band
      reconstructIntensityPower(
        state.previousScales[offset],
        state.currentScales[offset],
        scratch.nextScales[channel][band],
        scratch.combinedSamples,
        (channel === 0 ? leftState : rightState).bandSlots[band][POWER_SLOT]
      )
    }
  }
  state.previousScales.set(state.currentScales)
  state.currentScales.set(scratch.nextScales[0], 0)
  state.currentScales.set(scratch.nextScales[1], ANALYSIS_INTENSITY_BAND_COUNT)
  return state
}
