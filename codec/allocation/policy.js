/** Deterministic, state-free ATRAC3plus allocation policy primitives. */

import {
  SECOND_PASS_NEGATIVE_WEIGHTS,
  SECOND_PASS_POSITIVE_WEIGHTS,
  SECOND_PASS_WEIGHT_LIMITS,
} from '../core/tables.js'

/**
 * Map a quantization band to its profile allocation zone.
 *
 * @param {number} value
 * @param {ArrayLike<number>} limits
 * @returns {number}
 */
function zoneIndex(value, limits) {
  let zone = 0
  while (zone < limits.length && value >= limits[zone]) zone++
  return zone
}

/**
 * Read the profile policy value that applies to one allocation zone.
 *
 * @param {number} value
 * @param {ArrayLike<number>} limits
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
function zoneValue(value, limits, values) {
  return values[zoneIndex(value, limits)]
}

/**
 * Select the minimum-word-length policy from low-band energy ratios.
 *
 * @param {number} lowHighRatio Low-to-high band energy ratio.
 * @param {number} lowMidRatio Low-to-mid band energy ratio.
 * @param {boolean} lowRateMode Whether low-rate allocation rules apply.
 * @returns {number} Reference bit-allocation mode.
 */
export function bitAllocationModeFromRatios(
  lowHighRatio,
  lowMidRatio,
  lowRateMode
) {
  if (lowRateMode) {
    let mode = 1 + Number(lowMidRatio > 4) + zoneIndex(lowHighRatio, [4, 8])
    if (mode < 2 && lowHighRatio > 1) mode = 2
    return mode
  }
  return 1 + zoneIndex(lowHighRatio, [1, 4, 8])
}

/**
 * Return the low-rate base offset bump for one active-band count.
 *
 * @param {number} quantUnits Active quantization-unit count.
 * @returns {number} Integer base offset bump.
 */
export function quantOffsetLowRateBaseBump(quantUnits) {
  return zoneValue(quantUnits, [7, 10, 13, 16, 19], [9, 4, 3, 2, 1, 0])
}

/**
 * Return the conditional high-band low-rate offset bump.
 *
 * @param {number} band Quantization-band index.
 * @param {number} quantUnits Active quantization-unit count.
 * @param {number} cost Current band cost measure.
 * @returns {number} Zero, one, or two offset steps.
 */
export function quantOffsetLowRateHighBandBump(band, quantUnits, cost) {
  const bandLimit = zoneValue(band, [0x16, 0x18], [12, 15, 18])
  return (
    Number(quantUnits <= bandLimit) + Number(quantUnits <= 12 && cost > 0x3c)
  )
}

/**
 * Convert a band level into the quantization-cap bonus.
 *
 * @param {number} level Measured band level.
 * @returns {number} Integer cap bonus.
 */
export function quantCapBandLevelBonus(level) {
  return zoneValue(level, [3.5, 6], [0, 1, 2])
}

/**
 * Convert a band level into the initial allocation bonus.
 *
 * @param {number} level Measured band level.
 * @returns {number} Initial whole or half-step bonus.
 */
export function initialBandLevelBonus(level) {
  return zoneValue(level, [3.5, 6, 10], [0, 0.5, 1, 2])
}

/**
 * Return the exact signed-offset weight for the second allocation pass.
 *
 * @param {number} band Quantization-band index.
 * @param {boolean} positiveOffset Whether the candidate raises allocation.
 * @returns {number} Float32-rounded directional weight.
 */
export function secondPassOffsetWeight(band, positiveOffset) {
  return Math.fround(
    positiveOffset
      ? zoneValue(band, SECOND_PASS_WEIGHT_LIMITS, SECOND_PASS_POSITIVE_WEIGHTS)
      : zoneValue(band, SECOND_PASS_WEIGHT_LIMITS, SECOND_PASS_NEGATIVE_WEIGHTS)
  )
}

/**
 * Whether a profile defers its only budget fill until after refinement.
 *
 * @param {number} channelMode Coding-unit channel mode.
 * @param {number} bitrateKbps Stream bitrate in kilobits per second.
 * @returns {boolean} Whether post-scale-factor fill is the sole fill pass.
 */
export function usesSinglePostScaleFactorFill(channelMode, bitrateKbps) {
  return channelMode !== 4 && bitrateKbps >= 96 && bitrateKbps <= 256
}

/**
 * Return the exact low-band seed bump with finite-history filtering.
 *
 * @param {number} coreMode Profile core-mode selector.
 * @param {number} sampleRateHz Stream sample rate.
 * @param {number} bitAllocationMode Selected allocation mode.
 * @param {number} averageBandLevel Prior finite average, or non-finite input.
 * @returns {number} Float32-rounded seed bump.
 */
export function initialLowBandBump(
  coreMode,
  sampleRateHz,
  bitAllocationMode,
  averageBandLevel
) {
  if (
    !(
      (coreMode < 0x19 && sampleRateHz === 44100) ||
      (coreMode < 0x1a && sampleRateHz === 48000)
    )
  ) {
    return 0
  }
  const mode = Math.fround(bitAllocationMode)
  const modeAdd =
    mode < 3
      ? Math.fround(mode * Math.fround(0.25))
      : Math.fround(Math.fround(mode * Math.fround(0.125)) + Math.fround(0.75))
  const rateExtra =
    coreMode < 0x0e ? 0.7 : coreMode < 0x10 ? 1 : coreMode < 0x18 ? 0.5 : 0
  let averageExtra = 0
  if (Number.isFinite(averageBandLevel)) {
    averageExtra = Math.fround(
      Math.fround(Math.fround(averageBandLevel - Math.fround(3.1)) * 2.5)
    )
    averageExtra = Math.max(-0.75, Math.min(0.5, averageExtra))
  }
  return Math.fround(
    Math.fround(modeAdd + Math.fround(rateExtra)) + Math.fround(averageExtra)
  )
}

/**
 * Return the intensity-stereo spread threshold for one band.
 *
 * @param {number} coreMode Profile core-mode selector.
 * @param {number} band Quantization-band index.
 * @returns {number} Required channel spread threshold.
 */
export function intensityStereoSpreadThreshold(coreMode, band) {
  if (coreMode < 0x0d) return zoneValue(band, [8], [6, 3])
  if (coreMode < 0x13) {
    return zoneValue(band, [8, 12, 16, 18], [10, 6, 5, 4, 3])
  }
  return zoneValue(
    band,
    [8, 12, 16, 18, 20, 21, 22, 28],
    [30, 27, 24, 21, 18, 15, 12, 9, 6]
  )
}

/**
 * Return the tone-correlation threshold for an intensity decision.
 *
 * @param {number} coreMode Profile core-mode selector.
 * @param {number} record Tone-record index.
 * @returns {number} Required correlation threshold.
 */
export function intensityStereoToneCorrelationThreshold(coreMode, record) {
  const clamped = Math.min(record, 32)
  if (coreMode < 0x0d) return zoneValue(clamped, [1, 2], [40, 30, 20])
  if (coreMode < 0x13) {
    return zoneValue(clamped, [1, 2, 3], [50, 40, 30, 20])
  }
  return zoneValue(clamped, [1, 4, 8, 12], [60, 50, 40, 30, 20])
}
