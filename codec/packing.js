/** ATRAC3plus frame packing stage. */

import { packFrame } from './io/frame.js'

/**
 * Serialize the detached frame into bounded scratch without publishing state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function pack(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (frame.analysisDelayed) {
      frame.packedPayloadBits = 0
      frame.output = null
      return frame
    }
    const payloadBits = packFrame(
      frame.allocationTransactions,
      frame.sharedCodingUnits,
      encoder.state.topology.codingUnitCount,
      context.profile.bytesPerFrame,
      encoder.scratch.packedFrame,
      encoder.scratch.spectrumSyntax
    )
    frame.packedPayloadBits = payloadBits
    frame.output = encoder.scratch.packedFrame.subarray(
      0,
      context.profile.bytesPerFrame
    )
    return frame
  }
}
