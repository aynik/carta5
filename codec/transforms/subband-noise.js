/** ATRAC3plus decoded broadband noise in the post-MDCT subband domain. */

import { NOISE_TABLE_OFFSETS, NOISE_VALUES } from '../core/tables.js'
import {
  FRAME_SAMPLES,
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
