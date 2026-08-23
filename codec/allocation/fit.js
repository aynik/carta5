/** ATRAC3plus bounded exact-frame fitting. */

import {
  BUDGET_RETRY_LIMIT,
  BUDGET_RETRY_STEP_BITS,
} from '../core/constants.js'
import { framePayloadCapacityBits } from '../core/geometry.js'

/**
 * Build exact frame-ledger fitting while preserving suppressed delay frames.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Frame fit predicate.
 */
function fits(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const capacity = framePayloadCapacityBits(
    context.profile.bytesPerFrame,
    topology.codingUnitCount
  )
  return (frame) => {
    if (encoder.state.analysisToStreamDelay.remainingFrames !== 0) return true
    let payloadBits = 0
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      payloadBits += frame.allocationTransactions[unit].bitsTotal
    }
    return payloadBits <= capacity
  }
}

/**
 * Protect one allocation attempt and exact measurement with bounded retry.
 *
 * @param {object} context Pipeline ownership context.
 * @param {Function} solve One frame solve.
 * @param {Function} fits Exact ledger fit.
 * @returns {Function} Retrying allocation protocol.
 */
function retryFit(context, solve, fits) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const checkpoint = encoder.frame.allocationCheckpoint
  return (frame) => {
    checkpoint.capture(encoder.frame, topology)
    for (let attempt = 0; attempt < BUDGET_RETRY_LIMIT; attempt++) {
      if (attempt > 0) checkpoint.restore(encoder.frame, topology)
      try {
        solve(frame, attempt * BUDGET_RETRY_STEP_BITS)
      } catch (error) {
        checkpoint.restore(encoder.frame, topology)
        throw error
      }
      if (fits(frame)) {
        frame.allocationAttempts = attempt + 1
        return frame
      }
    }
    checkpoint.restore(encoder.frame, topology)
    throw new RangeError('ATRAC3plus frame packing retry limit was exhausted')
  }
}

/**
 * Fit one solved frame to its exact serialized capacity.
 *
 * @param {object} context Pipeline ownership context.
 * @param {Function} solve Frame solver.
 * @returns {Function} Bounded fitting operation.
 */
export function fit(context, solve) {
  return retryFit(context, solve, fits(context))
}
