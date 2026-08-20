/** Streaming ATRAC3plus decoder composed from explicit transactional stages. */

import { BufferPool } from '../core/buffers.js'
import { resolveProfile } from '../core/profiles.js'
import { copyDecoderState, initializeDecoderStream } from '../state/decoder.js'
import {
  FrameDecodeScratch,
  unpackFrameSyntax,
  validateFrameSource,
} from '../io/frame-decoder.js'
import { inverseMdctFrame } from '../transforms/mdct.js'
import { synthesizeQmfChannel } from '../transforms/qmf.js'
import { reconstructCodingUnitSpectra } from '../transforms/spectral-reconstruction.js'
import { addDecodedTones } from '../transforms/tone.js'
import { addSubbandNoise } from '../transforms/subband-noise.js'
import { pipe } from '../utils.js'
import { normalizePcm } from '../io/pcm.js'

/**
 * Validate one complete internal ATRAC3plus frame before state capture.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): DecoderFrame} Frame validation stage.
 */
function validateDecodeFrameStage(context) {
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
function decodeTransactionStage(context) {
  return (frame) => {
    copyDecoderState(
      context.bufferPool.decoder.state,
      context.bufferPool.decoder.frame
    )
    return frame
  }
}

/**
 * Traverse every configured coding unit into detached decoder blocks.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Syntax traversal stage.
 */
function frameSyntaxStage(context) {
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

/**
 * Reconstruct every detached coding unit into fixed decoder spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Spectrum stage.
 */
function spectrumReconstructionStage(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      reconstructCodingUnitSpectra(
        decoder.frame.channelBlocks,
        topology.codingUnitChannels[unit],
        decoder.frame.sharedCodingUnits[unit],
        decoder.frame.spectra,
        decoder.scratch.spectralReconstruction
      )
    }
    frame.spectra = decoder.frame.spectra
    return frame
  }
}

/**
 * Apply inverse MDCT, inverse gain, and frame overlap per decoded channel.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Inverse MDCT stage.
 */
function inverseMdctStage(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const shared = decoder.frame.sharedCodingUnits[unit]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        const channel = decoder.frame.channelBlocks[channelIndex]
        const synthesis = decoder.frame.synthesisCodingUnits[unit][ordinal]
        if (
          inverseMdctFrame(
            decoder.frame.spectra[channelIndex],
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
 * Add decoded tones and broadband noise after inverse MDCT/gain.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Post-MDCT signal stage.
 */
function postMdctStage(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const shared = decoder.frame.sharedCodingUnits[unit]
      const primary = decoder.frame.channelBlocks[channels.at(0)]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        const subbands = decoder.frame.subbandSamples[channelIndex]
        addDecodedTones(
          decoder.frame.channelBlocks[channelIndex],
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
 * @returns {function(DecoderFrame): DecoderFrame} QMF synthesis stage.
 */
function qmfSynthesisStage(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      for (let ordinal = 0; ordinal < channels.length; ordinal++) {
        const channelIndex = channels.at(ordinal)
        synthesizeQmfChannel(
          decoder.frame.subbandSamples[channelIndex],
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
function historyRotationStage(context) {
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
function decodeCommitStage(context) {
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
 * Compose the detached ATRAC3plus syntax prefix of the eventual frame decoder.
 * No persistent state or PCM is published until reconstruction stages land.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Uint8Array): DecoderFrame} Syntax-only decoder.
 */
export function createFrameSyntaxDecoder(
  options = {},
  bufferPool = new BufferPool()
) {
  const context = createDecoderContext(options, bufferPool)
  return pipe(
    context,
    validateDecodeFrameStage,
    decodeTransactionStage,
    frameSyntaxStage
  )
}

/**
 * Compose complete detached signal reconstruction without committing state.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Uint8Array): DecoderFrame} Detached PCM decoder.
 */
export function createPcmFrameDecoder(
  options = {},
  bufferPool = new BufferPool()
) {
  const context = createDecoderContext(options, bufferPool)
  return pipe(
    context,
    validateDecodeFrameStage,
    decodeTransactionStage,
    frameSyntaxStage,
    spectrumReconstructionStage,
    inverseMdctStage,
    postMdctStage,
    qmfSynthesisStage
  )
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
    validateDecodeFrameStage,
    decodeTransactionStage,
    frameSyntaxStage,
    spectrumReconstructionStage,
    inverseMdctStage,
    postMdctStage,
    qmfSynthesisStage,
    historyRotationStage,
    decodeCommitStage
  )
  return (frame) => normalizePcm(decodeFrame(frame))
}
