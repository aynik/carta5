/** Shared ATRAC3plus tone synthesis, crossfade, and residual primitives. */

import {
  TONE_AMPLITUDE_MULTIPLIERS,
  TONE_SCALE_FACTOR_VALUES,
  TONE_SYNTHESIS_CROSSFADE,
  TONE_SYNTHESIS_SINE,
} from '../core/tables.js'

import { float32Negate } from '../utils.js'
import {
  TRANSFORMS_TONE_SAMPLES,
  TONE_ACCUMULATE_SEPARATE,
  TONE_CROSSFADE_DECODER_RECONSTRUCTION,
  TONE_CROSSFADE_ENCODER_RESIDUAL,
  WINDOW_EDGE_1,
  WINDOW_EDGE_2,
  WINDOW_EDGE_3,
  TONE_HEADER_ENABLE_WORD,
  TONE_HEADER_FREQUENCY_ARRAY_WORD,
  TONE_HEADER_MODE_WORD,
} from '../core/constants.js'

/**
 * Validate one tone record and determine the synthesis span needed before samples are changed.
 *
 * @param {ToneSynthesisRecord} record
 * @returns {number}
 */
function preflightRecord(record) {
  const entryCount = record?.entryCount
  if (
    !Number.isInteger(entryCount) ||
    entryCount < 0 ||
    entryCount > 16 ||
    record.scaleFactorIndices?.length < entryCount ||
    record.amplitudeIndices?.length < entryCount ||
    record.phaseBases?.length < entryCount ||
    record.steps?.length < entryCount
  ) {
    throw new RangeError('ATRAC3plus tone record geometry is invalid')
  }
  for (let entry = 0; entry < entryCount; entry++) {
    if (
      record.scaleFactorIndices[entry] < 0 ||
      record.scaleFactorIndices[entry] >= TONE_SCALE_FACTOR_VALUES.length ||
      record.amplitudeIndices[entry] < 0 ||
      record.amplitudeIndices[entry] >= TONE_AMPLITUDE_MULTIPLIERS.length ||
      record.phaseBases[entry] < 0 ||
      record.phaseBases[entry] > 0x1f ||
      record.steps[entry] < 0 ||
      record.steps[entry] > 0x3ff
    ) {
      throw new RangeError('ATRAC3plus tone entry exceeds its packed range')
    }
  }
  return entryCount
}

/**
 * Add one decoded tone record to the synthesis buffer with phase-continuous windowing.
 *
 * @param {ToneSynthesisRecord} record
 * @param {Float32Array} output
 * @param {number} offset
 * @param {number} amplitudeMode
 * @param {boolean} polarityFlip
 * @param {number} polarityMode
 * @param {number} accumulation
 * @param {ArrayLike<number>} window
 */
function synthesizeRecord(
  record,
  output,
  offset,
  amplitudeMode,
  polarityFlip,
  polarityMode,
  accumulation,
  window
) {
  const entryCount = preflightRecord(record)
  if (
    (record.hasLeftFade && (record.leftIndex < 0 || record.leftIndex > 252)) ||
    (record.hasRightFade && (record.rightIndex < 4 || record.rightIndex > 256))
  ) {
    throw new RangeError('ATRAC3plus tone fade exceeds its synthesis window')
  }
  output.fill(0)
  const baseOffset = offset - TRANSFORMS_TONE_SAMPLES
  for (let entry = 0; entry < entryCount; entry++) {
    const scale = TONE_SCALE_FACTOR_VALUES[record.scaleFactorIndices[entry]]
    const amplitude =
      amplitudeMode === 0
        ? Math.fround(
            TONE_AMPLITUDE_MULTIPLIERS[record.amplitudeIndices[entry]] * scale
          )
        : scale
    const step = record.steps[entry]
    let phase =
      (((record.phaseBases[entry] & 0x1f) << 6) + baseOffset * step) & 0x7ff
    for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
      const sine = TONE_SYNTHESIS_SINE[phase]
      output[sample] =
        accumulation === TONE_ACCUMULATE_SEPARATE
          ? Math.fround(output[sample] + Math.fround(amplitude * sine))
          : Math.fround(amplitude * sine + output[sample])
      phase = (phase + step) & 0x7ff
    }
  }
  if (polarityFlip !== 0 && polarityMode === 1) {
    for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
      output[sample] = float32Negate(output[sample])
    }
  }

  window.fill(1)
  if (record.hasLeftFade !== 0) {
    window.fill(0, 0, record.leftIndex)
    window[record.leftIndex] = 0
    window[record.leftIndex + 1] = WINDOW_EDGE_1
    window[record.leftIndex + 2] = WINDOW_EDGE_2
    window[record.leftIndex + 3] = WINDOW_EDGE_3
  }
  if (record.hasRightFade !== 0) {
    window[record.rightIndex - 4] = WINDOW_EDGE_3
    window[record.rightIndex - 3] = WINDOW_EDGE_2
    window[record.rightIndex - 2] = WINDOW_EDGE_1
    window[record.rightIndex - 1] = 0
    window.fill(0, record.rightIndex)
  }
  for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
    output[sample] = Math.fround(output[sample] * window[offset + sample])
  }
}

/**
 * Crossfade paired-channel tone synthesis where tone ownership changes between frames.
 *
 * @param {ToneSynthesisRecord} previousRecord
 * @param {ToneSynthesisRecord} currentRecord
 * @param {number} policy
 * @param {ToneSynthesisScratch} scratch
 */
function applyPairCrossfade(previousRecord, currentRecord, policy, scratch) {
  const previousCount = previousRecord?.entryCount ?? 0
  const currentCount = currentRecord?.entryCount ?? 0
  const separationBias = policy === TONE_CROSSFADE_ENCODER_RESIDUAL ? 128 : 32
  const separated =
    previousCount < 1 ||
    currentCount < 1 ||
    (previousRecord?.rightIndex ?? 0) - separationBias <
      (currentRecord?.leftIndex ?? 0)
  const applyPrevious =
    !separated || (previousCount > 0 && previousRecord?.hasRightFade === 0)
  const applyCurrent =
    !separated || (currentCount > 0 && currentRecord?.hasLeftFade === 0)
  if (applyPrevious) {
    for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
      scratch.previous[sample] = Math.fround(
        scratch.previous[sample] *
          TONE_SYNTHESIS_CROSSFADE[TRANSFORMS_TONE_SAMPLES + sample]
      )
    }
  }
  if (applyCurrent) {
    for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
      scratch.current[sample] = Math.fround(
        scratch.current[sample] * TONE_SYNTHESIS_CROSSFADE[sample]
      )
    }
  }
}

/**
 * Reconstruct one previous/current tone pair into caller-owned output.
 *
 * @param {ToneSynthesisRecord} previousRecord Previous tone syntax record.
 * @param {ToneSynthesisRecord} currentRecord Current tone syntax record.
 * @param {number} previousAmplitudeMode Previous amplitude mode.
 * @param {number} previousPolarityFlip Previous polarity flag.
 * @param {number} currentAmplitudeMode Current amplitude mode.
 * @param {number} currentPolarityFlip Current polarity flag.
 * @param {number} tonePolarityMode Coding-unit polarity mode.
 * @param {number} crossfadePolicy Crossfade policy selector.
 * @param {number} accumulation Accumulation policy selector.
 * @param {ToneSynthesisScratch} scratch Reusable synthesis work.
 * @param {Float32Array} [destination] Caller-owned output row.
 * @returns {Float32Array} The destination tone contribution.
 */
export function synthesizeTonePair(
  previousRecord,
  currentRecord,
  previousAmplitudeMode,
  previousPolarityFlip,
  currentAmplitudeMode,
  currentPolarityFlip,
  tonePolarityMode,
  crossfadePolicy,
  accumulation,
  scratch,
  destination = scratch?.output
) {
  if (
    !(scratch?.previous instanceof Float32Array) ||
    !(scratch?.current instanceof Float32Array) ||
    !(scratch?.window instanceof Float32Array) ||
    !(destination instanceof Float32Array) ||
    destination.length < TRANSFORMS_TONE_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus tone synthesis scratch is invalid')
  }
  scratch.previous.fill(0)
  scratch.current.fill(0)
  if (previousRecord) {
    synthesizeRecord(
      previousRecord,
      scratch.previous,
      TRANSFORMS_TONE_SAMPLES,
      previousAmplitudeMode,
      previousPolarityFlip,
      tonePolarityMode,
      accumulation,
      scratch.window
    )
  }
  if (currentRecord) {
    synthesizeRecord(
      currentRecord,
      scratch.current,
      0,
      currentAmplitudeMode,
      currentPolarityFlip,
      tonePolarityMode,
      accumulation,
      scratch.window
    )
  }
  applyPairCrossfade(previousRecord, currentRecord, crossfadePolicy, scratch)
  for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
    destination[sample] = Math.fround(
      scratch.previous[sample] + scratch.current[sample]
    )
  }
  return destination
}

/**
 * Subtract a reconstructed tone contribution from its untouched QMF row.
 *
 * @param {Float32Array} source Untouched QMF samples.
 * @param {Float32Array} contribution Reconstructed tone contribution.
 * @param {Float32Array} destination Caller-owned residual output.
 * @returns {Float32Array} The destination residual.
 */
export function writeToneResidual(source, contribution, destination) {
  if (
    !(source instanceof Float32Array) ||
    !(contribution instanceof Float32Array) ||
    !(destination instanceof Float32Array) ||
    source.length < TRANSFORMS_TONE_SAMPLES ||
    contribution.length < TRANSFORMS_TONE_SAMPLES ||
    destination.length < TRANSFORMS_TONE_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus tone residual geometry is invalid')
  }
  for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
    destination[sample] = Math.fround(source[sample] - contribution[sample])
  }
  return destination
}

/**
 * Prepare decoder fade bounds and add both adjacent tone slots to subbands.
 *
 * @param {DecodeChannelState} channel Current decoder channel state.
 * @param {DecodeChannelState} primaryChannel Primary-channel state for joint syntax.
 * @param {Float32Array} subbandSamples Mutable subband samples.
 * @param {number} tonePolarityMode Coding-unit polarity mode.
 * @param {ToneSynthesisScratch} scratch Reusable synthesis work.
 * @returns {Float32Array} The updated subband samples.
 */
export function addDecodedTones(
  channel,
  primaryChannel,
  subbandSamples,
  tonePolarityMode,
  scratch
) {
  if (
    !channel?.toneSlots ||
    !primaryChannel?.toneSlots ||
    !(subbandSamples instanceof Float32Array) ||
    subbandSamples.length < 16 * TRANSFORMS_TONE_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus decoded tone storage is invalid')
  }
  const previousSlot = channel.toneSlots[0]
  const currentSlot = channel.toneSlots[1]
  const previousHeader = primaryChannel.toneSlots[0]?.shared
  const currentHeader = primaryChannel.toneSlots[1]?.shared
  const previousEnabled =
    previousSlot?.active && previousHeader?.[TONE_HEADER_ENABLE_WORD] !== 0
  const currentEnabled =
    currentSlot?.active && currentHeader?.[TONE_HEADER_ENABLE_WORD] !== 0
  if (!previousEnabled && !currentEnabled) return subbandSamples

  const previousAmplitudeMode = previousHeader?.[TONE_HEADER_MODE_WORD] ?? 0
  const currentAmplitudeMode = currentHeader?.[TONE_HEADER_MODE_WORD] ?? 0
  for (let band = 0; band < 16; band++) {
    const previous = previousSlot.records[band]
    const current = currentSlot.records[band]
    if (
      current.gateStartValid === 0 ||
      current.gateEndIndex <= current.gateStartIndex
    ) {
      if (previous.gateStartValid === 0) {
        current.leftIndex = 0
        current.hasLeftFade = 0
      } else {
        current.leftIndex = previous.gateStartIndex << 2
        current.hasLeftFade = 1
      }
    } else {
      current.hasLeftFade = 1
      current.leftIndex = current.gateStartIndex * 4 + 128
    }

    if (
      previous.gateEndValid === 0 ||
      previous.gateEndIndex * 4 < current.leftIndex
    ) {
      if (current.gateEndValid === 0) {
        current.rightIndex = 256
        current.hasRightFade = 0
      } else {
        current.hasRightFade = 1
        current.rightIndex = current.gateEndIndex * 4 + 128
      }
    } else {
      current.rightIndex = previous.gateEndIndex * 4
      current.hasRightFade = 1
    }
    current.rightIndex =
      current.rightIndex + 4 < 257 ? current.rightIndex + 4 : 256

    if (previous.entryCount === 0 && current.entryCount === 0) continue
    synthesizeTonePair(
      previous,
      current,
      previousAmplitudeMode,
      previousHeader?.[TONE_HEADER_FREQUENCY_ARRAY_WORD + band] ?? 0,
      currentAmplitudeMode,
      currentHeader?.[TONE_HEADER_FREQUENCY_ARRAY_WORD + band] ?? 0,
      tonePolarityMode,
      TONE_CROSSFADE_DECODER_RECONSTRUCTION,
      TONE_ACCUMULATE_SEPARATE,
      scratch
    )
    const offset = band * TRANSFORMS_TONE_SAMPLES
    for (let sample = 0; sample < TRANSFORMS_TONE_SAMPLES; sample++) {
      subbandSamples[offset + sample] = Math.fround(
        subbandSamples[offset + sample] + scratch.output[sample]
      )
    }
  }
  return subbandSamples
}
