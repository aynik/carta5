/** ATRAC3plus QMF analysis state application. */

import {
  ANALYSIS_BANDS,
  ANALYSIS_TAIL_SAMPLES,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  QMF_WINDOW_SAMPLES,
} from '../core/constants.js'
import { analyzeQmf } from '../signal/qmf.js'

/**
 * Stage one channel window, transform it, and publish chronological history.
 *
 * @param {EncodeAnalysisState} analysisState Detached channel analysis state.
 * @param {Float32Array} pcm One frame of PCM samples.
 * @param {QmfScratch} scratch Reusable QMF work.
 * @returns {EncodeAnalysisState} The updated analysis state.
 */
export function analyzeQmfChannel(analysisState, pcm, scratch) {
  if (!(pcm instanceof Float32Array) || pcm.length < FRAME_SAMPLES) {
    throw new RangeError(`ATRAC3plus QMF requires ${FRAME_SAMPLES} PCM samples`)
  }
  if (
    !analysisState ||
    analysisState.bandSlots?.length !== ANALYSIS_BANDS ||
    analysisState.tail?.length !== ANALYSIS_TAIL_SAMPLES ||
    analysisState.newestBands?.length !== ANALYSIS_BANDS
  ) {
    throw new RangeError('ATRAC3plus QMF analysis state geometry is invalid')
  }
  if (!(scratch?.window instanceof Float32Array)) {
    throw new RangeError('ATRAC3plus QMF analysis scratch is invalid')
  }

  const { window } = scratch
  if (window.length < QMF_WINDOW_SAMPLES) {
    throw new RangeError('ATRAC3plus QMF analysis scratch is invalid')
  }
  window.set(analysisState.tail, 0)
  window.set(pcm.subarray(0, FRAME_SAMPLES), ANALYSIS_TAIL_SAMPLES)
  analyzeQmf(window, analysisState.newestBands, scratch)
  analysisState.tail.set(
    pcm.subarray(FRAME_SAMPLES - ANALYSIS_TAIL_SAMPLES, FRAME_SAMPLES)
  )
  return analysisState
}

/**
 * Advance and analyze every active stream channel with one shared scratch.
 *
 * @param {Float32Array[]} pcmChannels Active planar PCM frame.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {number} channelCount Active stream channel count.
 * @param {QmfScratch} scratch Reusable QMF work.
 * @returns {EncodeAnalysisState[]} The updated analysis states.
 */
export function analyzeQmfFrame(
  pcmChannels,
  analysisStates,
  channelCount,
  scratch
) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > MAX_CHANNELS ||
    pcmChannels.length < channelCount ||
    analysisStates.length < channelCount
  ) {
    throw new RangeError('ATRAC3plus QMF frame channel geometry is invalid')
  }
  for (let channel = 0; channel < channelCount; channel++) {
    analysisStates[channel].shiftBandSlots()
    analyzeQmfChannel(analysisStates[channel], pcmChannels[channel], scratch)
  }
  return analysisStates
}
