/** ATRAC3plus synthesis stage. */

import { inverseMdctFrame } from './signal/spectrum.js'
import { synthesizeQmfChannel } from './transforms/qmf.js'
import { addDecodedTones } from './transforms/tone.js'
import { addSubbandNoise } from './transforms/subband-noise.js'
import { pipe } from './utils.js'

/**
 * Synthesize subbands through inverse MDCT, inverse gain, and frame overlap.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Spectrum synthesis application.
 */
function synthesizeSpectrum(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const shared = frame.sharedCodingUnits[unit]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        const channel = frame.channelBlocks[channelIndex]
        const synthesis = decoder.frame.synthesisCodingUnits[unit][ordinal]
        if (
          inverseMdctFrame(
            frame.spectra[channelIndex],
            decoder.frame.subbandSamples[channelIndex],
            channel.previousGainRecords,
            channel.gain.records,
            channel.previousGainWindowFlags,
            channel.gain.windowFlags,
            shared.codedSubbandCount,
            synthesis.inverseTransformOverlap,
            decoder.scratch.inverseMdct
          ) === null
        ) {
          throw new RangeError('ATRAC3plus inverse gain syntax is invalid')
        }
      }
    }
    frame.subbandSamples = decoder.frame.subbandSamples
    return frame
  }
}

/**
 * Add decoded tone and broadband-noise components to synthesized subbands.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Component synthesis application.
 */
function synthesizeComponents(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const shared = frame.sharedCodingUnits[unit]
      const primary = frame.channelBlocks[channels.at(0)]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        const subbands = frame.subbandSamples[channelIndex]
        addDecodedTones(
          frame.channelBlocks[channelIndex],
          primary,
          subbands,
          ordinal,
          decoder.scratch.toneSynthesis
        )
        addSubbandNoise(shared, subbands)
      }
    }
    return frame
  }
}

/**
 * Fold every detached channel's subbands into pool-owned PCM.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} PCM synthesis application.
 */
function synthesizePcm(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        synthesizeQmfChannel(
          frame.subbandSamples[channelIndex],
          decoder.frame.synthesisCodingUnits[unit][ordinal],
          decoder.frame.outputChannels[channelIndex]
        )
      }
    }
    frame.outputChannels = decoder.frame.outputChannels
    return frame
  }
}

/**
 * Reconstruct PCM from the dequantized coding-unit spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Synthesis stage.
 */
export function synthesize(context) {
  return pipe(context, synthesizeSpectrum, synthesizeComponents, synthesizePcm)
}
