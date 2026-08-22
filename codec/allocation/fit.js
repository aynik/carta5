/** ATRAC3plus bounded exact-frame fitting. */

import {
  BUDGET_RETRY_LIMIT,
  BUDGET_RETRY_STEP_BITS,
} from '../core/constants.js'
import { FramePackError, measureFrame } from '../syntax/frame/writer.js'

/**
 * Build exact frame measurement while preserving suppressed delay frames.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Frame measurement operation.
 */
function measure(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const frameBytes = context.profile.bytesPerFrame
  return (frame) => {
    if (encoder.state.analysisToStreamDelay.remainingFrames !== 0) return frame
    measureFrame(
      frame.allocationTransactions,
      frame.sharedCodingUnits,
      topology.codingUnitCount,
      frameBytes,
      encoder.scratch.spectrumSyntax
    )
    return frame
  }
}

/**
 * Protect one allocation attempt and exact measurement with bounded retry.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @param {function(EncoderFrame, number): EncoderFrame} solve One frame solve.
 * @param {function(EncoderFrame): EncoderFrame} measure Exact measurement.
 * @returns {function(EncoderFrame): EncoderFrame} Retrying allocation protocol.
 */
function retryFit(context, solve, measure) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const checkpoint = encoder.frame.allocationCheckpoint
  return (frame) => {
    checkpoint.capture(encoder.frame, topology)
    for (let attempt = 0; attempt < BUDGET_RETRY_LIMIT; attempt++) {
      if (attempt > 0) checkpoint.restore(encoder.frame, topology)
      try {
        solve(frame, attempt * BUDGET_RETRY_STEP_BITS)
        measure(frame)
        frame.allocationAttempts = attempt + 1
        return frame
      } catch (error) {
        if (!(error instanceof FramePackError)) {
          checkpoint.restore(encoder.frame, topology)
          throw error
        }
      }
    }
    checkpoint.restore(encoder.frame, topology)
    throw new RangeError('ATRAC3plus frame packing retry limit was exhausted')
  }
}

/**
 * Fit one solved frame to its exact serialized capacity.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @param {function(EncoderFrame, number): EncoderFrame} solve Frame solver.
 * @returns {function(EncoderFrame): EncoderFrame} Bounded fitting operation.
 */
export function fit(context, solve) {
  return retryFit(context, solve, measure(context))
}
