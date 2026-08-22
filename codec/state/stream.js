/** Directional ATRAC3plus frame-state publication. */

import { copyDecoderState } from './decoder/image.js'
import { copyEncoderState } from './encoder.js'

/**
 * Rotate accepted frame syntax histories after all signal kernels succeed.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} History rotation stage.
 */
function rotateDecoderHistory(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        decoder.frame.channelBlocks[channels.at(ordinal)].rotateAfterSynthesis()
      }
    }
    return frame
  }
}

/**
 * Capture all ported ATRAC3plus state into detached storage before analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction capture stage.
 */
export function beginEncoderFrame(context) {
  return (frame) => {
    copyEncoderState(
      context.bufferPool.encoder.state,
      context.bufferPool.encoder.frame,
      context.bufferPool.encoder.state.topology
    )
    frame.analysisStates = context.bufferPool.encoder.frame.analysisChannels
    frame.channelBlocks = context.bufferPool.encoder.frame.channelBlocks
    frame.sharedCodingUnits = context.bufferPool.encoder.frame.sharedCodingUnits
    frame.intensityCodingUnits =
      context.bufferPool.encoder.frame.intensityCodingUnits
    return frame
  }
}

/**
 * Consume one successful analyzed frame before stream output becomes visible.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis delay stage.
 */
export function delayEncoderFrame(context) {
  const delay = context.bufferPool.encoder.state.analysisToStreamDelay
  return (frame) => {
    frame.analysisDelayed = delay.consumeAfterAllocation()
    return frame
  }
}

/**
 * Publish frame histories only after delay acceptance or successful packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Atomic commit stage.
 */
export function commitEncoderFrame(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (!frame.analysisDelayed && !(frame.output instanceof Uint8Array)) {
      throw new Error(
        'ATRAC3plus frame cannot commit before successful packing'
      )
    }
    copyEncoderState(encoder.frame, encoder.state, encoder.state.topology)
    encoder.state.lastAllocationAttempts = frame.allocationAttempts
    frame.committed = true
    return frame
  }
}

/**
 * Capture persistent syntax and history into the detached transaction.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Transaction capture stage.
 */
export function beginDecoderFrame(context) {
  return (frame) => {
    copyDecoderState(
      context.bufferPool.decoder.state,
      context.bufferPool.decoder.frame
    )
    return frame
  }
}

/**
 * Atomically publish the accepted decoder frame into persistent state.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} State publication stage.
 */
export function commitDecoderFrame(context) {
  const decoder = context.bufferPool.decoder
  const rotateHistory = rotateDecoderHistory(context)
  return (frame) => {
    rotateHistory(frame)
    copyDecoderState(decoder.frame, decoder.state)
    return frame
  }
}
