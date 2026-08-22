/** ATRAC3plus frame unpacking stage. */

import { unpackFrameSyntax } from './io/frame-decoder.js'

/**
 * Traverse every configured coding unit into detached decoder blocks.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Unpacking stage.
 */
export function unpack(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    frame.parsedBits = unpackFrameSyntax(
      frame.input,
      context.profile.bytesPerFrame,
      topology.codingUnitCount,
      topology.codingUnitChannels,
      decoder.frame,
      context.frameDecode
    )
    frame.channelBlocks = decoder.frame.channelBlocks
    frame.sharedCodingUnits = decoder.frame.sharedCodingUnits
    return frame
  }
}
