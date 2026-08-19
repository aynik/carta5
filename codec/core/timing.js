/** ATRAC3plus frame-pipeline and flush-tail timing policy. */

import {
  ANALYSIS_TO_STREAM_DELAY_FRAMES,
  FRAME_SAMPLES,
  FULL_FRAME_FLUSH_TAIL_FRAMES,
  ANALYSIS_RESIDUAL_OVERLAP_SAMPLES,
} from './constants.js'

// The first QMF evaluation skips 16 samples of the persisted 384-sample carry.

/**
 * Return the silent frames required after one successful nonempty submission.
 * A full or late partial frame needs nine; an early partial frame needs eight.
 *
 * @param {number} sampleCount Valid PCM samples in the submitted frame.
 * @returns {number|null} Required silent tail frames, or `null` when empty.
 */
export function flushTailFramesForSampleCount(sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount > FRAME_SAMPLES) {
    throw new RangeError('ATRAC3plus flush-tail sample count is invalid')
  }
  if (sampleCount <= 0) return null
  const analysisTailSamples = sampleCount + ANALYSIS_RESIDUAL_OVERLAP_SAMPLES
  const analysisTailFrames = Math.ceil(analysisTailSamples / FRAME_SAMPLES)
  const frames = ANALYSIS_TO_STREAM_DELAY_FRAMES + analysisTailFrames
  if (frames > FULL_FRAME_FLUSH_TAIL_FRAMES) {
    throw new RangeError('ATRAC3plus flush tail exceeds its fixed bound')
  }
  return frames
}
