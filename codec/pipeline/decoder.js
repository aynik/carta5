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
import { dequantize } from '../dequantization/stage.js'
import { unpack } from '../unpacking.js'
import { synthesize } from '../synthesis.js'
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
