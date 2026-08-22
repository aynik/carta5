/** ATRAC3plus spectral dequantization stage. */

import { reconstructCodingUnitSpectra } from './spectrum.js'

/** @import {DecoderContext, DecoderFrame} from '../pipeline/decoder.js' */

/**
 * Reconstruct every detached coding unit into fixed decoder spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Dequantization stage.
 */
export function dequantize(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      reconstructCodingUnitSpectra(
        frame.channelBlocks,
        topology.codingUnitChannels[unit],
        frame.sharedCodingUnits[unit],
        decoder.frame.spectra,
        decoder.scratch.spectralReconstruction
      )
    }
    frame.spectra = decoder.frame.spectra
    return frame
  }
}
