/** ATRAC3plus gain-window reconstruction and sample application. */

import { GAIN_SCALE_VALUES } from '../core/tables.js'
import {
  GAIN_SLOT_COUNT,
  GAIN_MINIMUM,
  GAIN_SAMPLES_PER_STEP,
  GAIN_SCALE_SAMPLES,
  GAIN_STEP_COUNT,
} from '../core/constants.js'

/**
 * Test whether either half of an adjacent gain-record pair is active.
 *
 * @param {GainRecord} previous Previous-frame record.
 * @param {GainRecord} current Current-frame record.
 * @returns {boolean} Whether either record carries gain points.
 */
export function gainPairIsActive(previous, current) {
  return previous.entries !== 0 || current.entries !== 0
}

/**
 * Expand one ATRAC3plus record onto its local half of the shared 64-step axis.
 *
 * @param {ArrayLike<number>} destination
 * @param {GainRecord} record
 * @param {number} endBias
 * @param {boolean} add Whether to add to an existing previous-frame envelope.
 * @returns {boolean}
 */
function applyRecordSteps(destination, record, endBias, add) {
  let cursor = 0
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  for (let entry = 0; entry < count; entry++) {
    const level = record.levels[entry]
    if (level > 15) return false
    const gain = GAIN_MINIMUM + level
    const end = record.locations[entry] + endBias
    while (cursor <= end && cursor < GAIN_STEP_COUNT) {
      destination[cursor] = add ? destination[cursor] + gain : gain
      cursor++
    }
  }
  return true
}

/**
 * Reconstruct reference's table-interpolated 256-sample ATRAC3plus forward envelope.
 *
 * @param {GainRecord} previous Previous-frame gain record.
 * @param {GainRecord} current Current-frame gain record.
 * @param {Float32Array} output Caller-owned sample envelope.
 * @param {Int32Array} steps Caller-owned step envelope.
 * @returns {number|null} Inclusive end of the first changed reverse group.
 */
export function reconstructForwardGainScale(previous, current, output, steps) {
  if (
    !(output instanceof Float32Array) ||
    output.length < GAIN_SCALE_SAMPLES ||
    !(steps instanceof Int32Array) ||
    steps.length < GAIN_STEP_COUNT
  ) {
    throw new RangeError('ATRAC3plus gain scale buffers have invalid geometry')
  }
  steps.fill(0)
  if (
    !applyRecordSteps(steps, current, 32, false) ||
    !applyRecordSteps(steps, previous, 0, true)
  ) {
    return null
  }

  let previousBase = 1
  let previousGain = 0
  let outputPosition = GAIN_SCALE_SAMPLES - 1
  let firstChange = GAIN_SCALE_SAMPLES
  for (let step = GAIN_STEP_COUNT - 1; step >= 0; step--) {
    const gain = steps[step]
    if (gain !== previousGain && firstChange === GAIN_SCALE_SAMPLES) {
      firstChange = outputPosition
    }
    if (gain === previousGain) {
      output.fill(
        Math.fround(previousBase),
        outputPosition + 1 - GAIN_SAMPLES_PER_STEP,
        outputPosition + 1
      )
    } else {
      const delta = gain - previousGain
      const tableIndex = (Math.abs(delta) - 1) * 3
      if (tableIndex + 2 >= GAIN_SCALE_VALUES.length) return null
      if (delta > 0) {
        const base = 2 ** gain
        output[outputPosition - 3] = base
        output[outputPosition - 2] = base * GAIN_SCALE_VALUES[tableIndex + 2]
        output[outputPosition - 1] = base * GAIN_SCALE_VALUES[tableIndex + 1]
        output[outputPosition] = base * GAIN_SCALE_VALUES[tableIndex]
        previousBase = base
      } else {
        const base = previousBase
        const currentBase = 2 ** gain
        output[outputPosition - 3] = currentBase
        output[outputPosition - 2] = base * GAIN_SCALE_VALUES[tableIndex]
        output[outputPosition - 1] = base * GAIN_SCALE_VALUES[tableIndex + 1]
        output[outputPosition] = base * GAIN_SCALE_VALUES[tableIndex + 2]
        previousBase = currentBase
      }
    }
    previousGain = gain
    if (step !== 0) outputPosition -= GAIN_SAMPLES_PER_STEP
  }
  return firstChange
}

/**
 * Apply the forward envelope through its first changed group.
 *
 * @param {GainRecord} previous Previous-frame gain record.
 * @param {GainRecord} current Current-frame gain record.
 * @param {Float32Array} samples Mutable time-domain samples.
 * @param {GainScaleScratch} scratch Reusable gain-scale work.
 * @returns {number|null} Inclusive final scaled sample, or `null` if invalid.
 */
export function applyForwardGainScale(previous, current, samples, scratch) {
  if (!(samples instanceof Float32Array) || samples.length < 256) {
    throw new RangeError('ATRAC3plus forward gain requires 256 samples')
  }
  const firstChange = reconstructForwardGainScale(
    previous,
    current,
    scratch?.scale,
    scratch?.steps
  )
  if (firstChange === null) return null
  const end = Math.min(firstChange, GAIN_SCALE_SAMPLES - 1)
  for (let sample = 0; sample <= end; sample++) {
    samples[sample] = Math.fround(samples[sample] * scratch.scale[sample])
  }
  return firstChange
}

/**
 * Convert a coded gain level into the inverse power multiplier used for synthesis.
 *
 * @param {number} gain
 * @returns {number}
 */
function inverseGainPower(gain) {
  if (gain === 0) return 1
  if (gain > 0) return Math.fround(1 / 2 ** (gain & 31))
  return Math.fround(2 ** (-gain & 31))
}

/**
 * Reconstruct reference's inverse gain envelope.
 *
 * @param {GainRecord} previous Previous-frame gain record.
 * @param {GainRecord} current Current-frame gain record.
 * @param {Float32Array} output Caller-owned sample envelope.
 * @param {Int32Array} steps Caller-owned step envelope.
 * @returns {number|null} Inclusive end of the changed prefix, or `null`.
 */
export function reconstructInverseGainScale(previous, current, output, steps) {
  if (
    !(output instanceof Float32Array) ||
    output.length < GAIN_SCALE_SAMPLES ||
    !(steps instanceof Int32Array) ||
    steps.length < GAIN_STEP_COUNT
  ) {
    throw new RangeError('ATRAC3plus gain scale buffers have invalid geometry')
  }
  steps.fill(0)
  if (
    !applyRecordSteps(steps, current, 32, false) ||
    !applyRecordSteps(steps, previous, 0, true)
  ) {
    return null
  }

  let previousGain = 0
  let outputPosition = GAIN_SCALE_SAMPLES - 1
  let firstChange = GAIN_SCALE_SAMPLES
  for (let step = GAIN_STEP_COUNT - 1; step >= 0; step--) {
    const gain = steps[step]
    if (gain !== previousGain && firstChange === GAIN_SCALE_SAMPLES) {
      firstChange = outputPosition
    }
    if (gain === previousGain) {
      output.fill(
        inverseGainPower(gain),
        outputPosition + 1 - GAIN_SAMPLES_PER_STEP,
        outputPosition + 1
      )
    } else {
      const tableIndex = (Math.abs(gain - previousGain) - 1) * 3
      if (tableIndex + 2 >= GAIN_SCALE_VALUES.length) return null
      if (gain > previousGain) {
        const previousBase = inverseGainPower(previousGain)
        const currentBase = inverseGainPower(gain)
        output[outputPosition - 3] = currentBase
        output[outputPosition - 2] =
          previousBase * GAIN_SCALE_VALUES[tableIndex]
        output[outputPosition - 1] =
          previousBase * GAIN_SCALE_VALUES[tableIndex + 1]
        output[outputPosition] =
          previousBase * GAIN_SCALE_VALUES[tableIndex + 2]
      } else {
        const currentBase = inverseGainPower(gain)
        output[outputPosition - 3] = currentBase
        output[outputPosition - 2] =
          currentBase * GAIN_SCALE_VALUES[tableIndex + 2]
        output[outputPosition - 1] =
          currentBase * GAIN_SCALE_VALUES[tableIndex + 1]
        output[outputPosition] = currentBase * GAIN_SCALE_VALUES[tableIndex]
      }
    }
    previousGain = gain
    if (step !== 0) outputPosition -= GAIN_SAMPLES_PER_STEP
  }
  return firstChange
}

/**
 * Apply the inverse envelope through the overlap prefix and first change.
 *
 * @param {GainRecord} previous Previous-frame gain record.
 * @param {GainRecord} current Current-frame gain record.
 * @param {Float32Array} samples Mutable time-domain samples.
 * @param {GainScaleScratch} scratch Reusable gain-scale work.
 * @returns {number|null} Inclusive final scaled sample, or `null` if invalid.
 */
export function applyInverseGainScale(previous, current, samples, scratch) {
  if (!(samples instanceof Float32Array) || samples.length < 256) {
    throw new RangeError('ATRAC3plus inverse gain requires 256 samples')
  }
  const firstChange = reconstructInverseGainScale(
    previous,
    current,
    scratch?.scale,
    scratch?.steps
  )
  if (firstChange === null) return null
  const end = Math.min(Math.max(firstChange, 127), GAIN_SCALE_SAMPLES - 1)
  for (let sample = 0; sample <= end; sample++) {
    samples[sample] = Math.fround(samples[sample] * scratch.scale[sample])
  }
  return firstChange
}
