/**
 * Streaming ATRAC3plus decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis.
 * Validation, detached state, history rotation, commit, and PCM normalization
 * surround that semantic recipe.
 */

import { BufferPool } from '../core/buffers.js'
import { resolveProfile } from '../core/profiles.js'
import { copyDecoderState, initializeDecoderStream } from '../state/decoder.js'
import { FrameDecodeScratch, validateFrameSource } from '../io/frame-decoder.js'
import { inverseMdctFrame } from '../transforms/mdct.js'
import { synthesizeQmfChannel } from '../transforms/qmf.js'
import { addDecodedTones } from '../transforms/tone.js'
import { addSubbandNoise } from '../transforms/subband-noise.js'
import { dequantize } from '../dequantization/stage.js'
import { unpack } from '../unpacking.js'
import { pipe } from '../utils.js'
import { normalizePcm } from '../io/pcm.js'

/**
 * Validate one complete internal ATRAC3plus frame before state capture.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): DecoderFrame} Frame validation stage.
 */
export function validateFrame(context) {
  const bytes = context.profile.bytesPerFrame
  return (input) => {
    if (!(input instanceof Uint8Array) || input.length !== bytes) {
      throw new RangeError(
        `ATRAC3plus decoder requires one ${bytes}-byte frame`
      )
    }
    validateFrameSource(input, bytes)
    return { input, parsedBits: 0 }
  }
}

/**
 * Capture persistent syntax and history into the detached transaction.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Transaction capture stage.
 */
export function beginTransaction(context) {
  return (frame) => {
    copyDecoderState(
      context.bufferPool.decoder.state,
      context.bufferPool.decoder.frame
    )
    return frame
  }
}

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
 * Rotate accepted frame syntax histories after all signal kernels succeed.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} History rotation stage.
 */
function rotateHistory(context) {
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
 * Atomically publish frame history and detach planar PCM.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): Float32Array[]} Atomic commit stage.
 */
function commitFrame(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return () => {
    copyDecoderState(decoder.frame, decoder.state)
    return Array.from({ length: topology.channelCount }, (_, channel) =>
      decoder.frame.outputChannels[channel].slice()
    )
  }
}

/**
 * Allocate the decoder pool, committed history, and detached transaction for one stream.
 *
 * @param {CodecProfileOptions} options
 * @param {BufferPool} bufferPool
 * @returns {DecoderContext}
 */
function createDecoderContext(options, bufferPool) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3plus decoder profile')
  initializeDecoderStream(profile, bufferPool.decoder)
  return {
    profile,
    bufferPool,
    frameDecode: new FrameDecodeScratch(bufferPool.decoder.scratch.syntax),
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

/**
 * Compose one persistent ATRAC3plus frame decoder with atomic publication.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Uint8Array): Float32Array[]} One-frame normalized planar decoder.
 */
export function decode(options = {}, bufferPool = new BufferPool()) {
  const context = createDecoderContext(options, bufferPool)
  const decodeFrame = pipe(
    context,
    validateFrame,
    beginTransaction,
    unpack,
    dequantize,
    synthesize,
    rotateHistory,
    commitFrame
  )
  return (frame) => normalizePcm(decodeFrame(frame))
}
