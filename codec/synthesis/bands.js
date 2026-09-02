/** ATRAC3plus QMF synthesis state application. */

import { synthesizeQmf } from '../signal/bands.js'

/**
 * Synthesize one channel and commit its next QMF delay-ring position.
 *
 * @param {Float32Array} subbands Contiguous subband samples.
 * @param {SynthesisState} state Detached channel synthesis state.
 * @param {Float32Array} output Caller-owned PCM output.
 * @returns {Float32Array} The completed output PCM.
 */
export function synthesizeQmfChannel(subbands, state, output) {
  if (!state) {
    throw new RangeError('ATRAC3plus QMF synthesis state is invalid')
  }
  state.delayRingIndex = synthesizeQmf(
    subbands,
    state.firstPhaseDelay,
    state.secondPhaseDelay,
    state.delayRingIndex,
    output
  )
  return output
}
