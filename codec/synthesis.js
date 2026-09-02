/** ATRAC3plus synthesis stage. */

import { inverseMdctFrame } from './synthesis/spectrum.js'
import { synthesizeQmfChannel } from './signal/bands.js'
import { addDecodedTones } from './signal/tone.js'
import { addSubbandNoise } from './signal/noise.js'
import { pipe } from './utils.js'

/**
 * Synthesize subbands through inverse MDCT, inverse gain, and frame overlap.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Spectrum synthesis application.
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
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Component synthesis application.
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
 * @param {object} context Pipeline ownership context.
 * @returns {Function} PCM synthesis application.
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
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Synthesis stage.
 */
export function synthesize(context) {
  return pipe(context, synthesizeSpectrum, synthesizeComponents, synthesizePcm)
}
