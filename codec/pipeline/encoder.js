/**
 * Streaming ATRAC3plus encoder pipeline.
 *
 * PCM passes through analysis, allocation, quantization, and packing.
 * Validation, detached state, retry, delay, commit, and output detachment
 * surround that semantic recipe.
 */

import { allocate } from '../allocation/stage.js'
import { BufferPool } from '../state/storage.js'
import { resolveProfile } from '../core/profiles.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { initializeEncoderStream } from '../state/encoder.js'
import { createPcmScaler } from '../io/pcm.js'
import { analyze } from '../analysis/stage.js'
import {
  beginEncoderFrame,
  commitEncoderFrame,
  delayEncoderFrame,
} from '../state/stream.js'
import { pack } from '../packing.js'
import { quantize } from '../quantization/stage.js'
import { pipe } from '../utils.js'

/**
 * Validate and zero-pad one complete ATRAC3plus frame before state capture.
 * This preparatory stage accepts arbitrary valid sample counts while keeping
 * chunk/timeline adaptation outside the transform transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): EncoderFrame} Validation stage.
 */
export function validateFrame(context) {
  const { profile } = context
  const pcmChannels = context.bufferPool.encoder.frame.pcmChannels
  return (input) => {
    const channels = Array.isArray(input) ? input : input?.channels
    const sampleCount = Array.isArray(input)
      ? FRAME_SAMPLES
      : (input?.sampleCount ?? FRAME_SAMPLES)
    if (
      !Array.isArray(channels) ||
      channels.length !== profile.channels ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 0 ||
      sampleCount > FRAME_SAMPLES
    ) {
      throw new RangeError('ATRAC3plus PCM frame geometry is invalid')
    }
    for (let channel = 0; channel < channels.length; channel++) {
      const source = channels[channel]
      if (
        !(source instanceof Float32Array) ||
        source.length !== FRAME_SAMPLES
      ) {
        throw new RangeError(
          `Each ATRAC3plus PCM channel must contain ${FRAME_SAMPLES} float samples`
        )
      }
      pcmChannels[channel].set(source)
      pcmChannels[channel].fill(0, sampleCount)
    }
    return {
      channels:
        context.bufferPool.encoder.frame.pcmChannelViews[channels.length],
      channelCount: channels.length,
      sampleCount,
    }
  }
}

/**
 * Detach a packed frame; analysis-delay frames intentionally emit none.
 *
 * @returns {function(EncoderFrame): (Uint8Array|null)} Output stage.
 */
export function detachOutput() {
  return (frame) => (frame.output === null ? null : frame.output.slice())
}

/**
 * Allocate stream state and stable construction context.
 *
 * @param {CodecProfileOptions} options Maintained profile options.
 * @param {BufferPool} bufferPool Reusable codec storage.
 * @returns {EncoderContext} Pipeline ownership context.
 */
function createEncoderContext(options, bufferPool) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3plus encoder profile')
  initializeEncoderStream(profile, bufferPool.encoder)
  return { profile, bufferPool }
}

/**
 * Compose one persistent encoder accepting normalized Web Audio PCM.
 *
 * The adapter reuses one codec-domain frame for the lifetime of the closure.
 * Initial analysis-delay frames return `null`.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): (Uint8Array|null)} One-frame encoder.
 */
export function encode(options = {}, bufferPool = new BufferPool()) {
  const context = createEncoderContext(options, bufferPool)
  const encodeFrame = pipe(
    context,
    validateFrame,
    beginEncoderFrame,
    analyze,
    allocate,
    quantize,
    delayEncoderFrame,
    pack,
    commitEncoderFrame,
    detachOutput
  )
  const scale = createPcmScaler(context.profile.channels)
  return (input) => encodeFrame(scale(input))
}
