/**
 * Streaming ATRAC3plus decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis.
 * Validation, detached state, history rotation, commit, and PCM normalization
 * surround that semantic recipe.
 */

import { BufferPool } from '../state/storage.js'
import { resolveProfile } from '../core/profiles.js'
import { initializeDecoderStream } from '../state/decoder/image.js'
import {
  FrameDecodeScratch,
  validateFrameSource,
} from '../syntax/frame/reader.js'
import { dequantize } from '../dequantization/stage.js'
import { unpack } from '../unpacking.js'
import { synthesize } from '../synthesis.js'
import { beginDecoderFrame, commitDecoderFrame } from '../state/stream.js'
import { pipe } from '../utils.js'
import { normalizePcm } from '../boundary/pcm.js'

/** @import {CodecProfile, CodecProfileOptions} from '../core/profiles.js' */

/**
 * Stable ownership captured once by one frame-decoder closure.
 *
 * @typedef {object} DecoderContext
 * @property {CodecProfile} profile Resolved immutable stream profile.
 * @property {BufferPool} bufferPool Persistent, frame, and scratch storage.
 * @property {FrameDecodeScratch} frameDecode Reusable detached syntax reader.
 */

/**
 * Incrementally populated product passed through the decoder stages.
 *
 * @typedef {object} DecoderFrame
 * @property {Uint8Array} input Complete encoded frame bytes.
 * @property {number} parsedBits Number of syntax bits consumed.
 * @property {import('../state/decoder/image.js').DecodeChannelState[]} [channelBlocks] Detached decoded channel state.
 * @property {import('../state/shared.js').SharedState[]} [sharedCodingUnits] Detached coding-unit syntax.
 * @property {Float32Array[]} [spectra] Dequantized channel spectra.
 * @property {Float32Array[]} [subbandSamples] Synthesized subband samples by channel.
 * @property {Float32Array[]} [outputChannels] Pool-owned PCM by channel.
 */

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
 * Detach pool-owned PCM only after decoder history is published.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): Float32Array[]} PCM detachment protocol.
 */
function detachPcm(context) {
  const decoder = context.bufferPool.decoder
  const { topology } = decoder.state
  return () =>
    Array.from({ length: topology.channelCount }, (_, channel) =>
      decoder.frame.outputChannels[channel].slice()
    )
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
    beginDecoderFrame,
    unpack,
    dequantize,
    synthesize,
    commitDecoderFrame,
    detachPcm
  )
  return (frame) => normalizePcm(decodeFrame(frame))
}
