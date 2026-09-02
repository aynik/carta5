/** ATRAC3plus QMF synthesis state application. */

import { synthesizeQmf } from '../signal/qmf.js'

/**
 * Synthesize one channel and commit its next QMF delay-ring position.
 *
 * @param {Float32Array[]} bands Chronological subband rows.
 * @param {SynthesisState} state Detached channel synthesis state.
 * @param {Float32Array} output Caller-owned PCM output.
 * @param {QmfScratch} scratch Reusable QMF work.
 * @returns {Float32Array} The completed output PCM.
 */
export function synthesizeQmfChannel(bands, state, output, scratch) {
  if (!state) {
    throw new RangeError('ATRAC3plus QMF synthesis state is invalid')
  }
  state.qmfDelayRow = synthesizeQmf(
    bands,
    state.qmfDelay,
    state.qmfDelayRow,
    output,
    scratch
  )
  return output
}
