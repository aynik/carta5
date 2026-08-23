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

/**
 * Validate one complete internal ATRAC3plus frame before state capture.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Frame validation stage.
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
 * @param {object} context Pipeline ownership context.
 * @returns {Function} PCM detachment protocol.
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
 * @param {object} options
 * @param {BufferPool} bufferPool
 * @returns {object}
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
 * @param {object} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {Function} One-frame normalized planar decoder.
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
