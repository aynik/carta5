/**
 * Streaming ATRAC3plus encoder pipeline.
 *
 * PCM passes through analysis, allocation, quantization, and packing.
 * Validation, detached state, retry, delay, commit, and output detachment
 * surround that semantic recipe.
 */

import { createAllocation } from '../coding/allocation.js'
import { quantizeSymbols } from '../coding/active-quantization.js'
import { BufferPool } from '../core/buffers.js'
import { resolveProfile } from '../core/profiles.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { copyEncoderState, initializeEncoderStream } from '../state/encoder.js'
import { packFrame } from '../io/frame.js'
import { createPcmScaler } from '../io/pcm.js'
import { analyze } from '../analysis/stage.js'
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
 * Capture all ported ATRAC3plus state into detached storage before analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction capture stage.
 */
export function beginTransaction(context) {
  return (frame) => {
    copyEncoderState(
      context.bufferPool.encoder.state,
      context.bufferPool.encoder.frame,
      context.bufferPool.encoder.state.topology
    )
    frame.analysisStates = context.bufferPool.encoder.frame.analysisChannels
    frame.channelBlocks = context.bufferPool.encoder.frame.channelBlocks
    frame.sharedCodingUnits = context.bufferPool.encoder.frame.sharedCodingUnits
    frame.intensityCodingUnits =
      context.bufferPool.encoder.frame.intensityCodingUnits
    return frame
  }
}

/**
 * Consume one successful analyzed frame before stream output becomes visible.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis delay stage.
 */
export function applyDelay(context) {
  const delay = context.bufferPool.encoder.state.analysisToStreamDelay
  return (frame) => {
    frame.analysisDelayed = delay.consumeAfterAllocation()
    return frame
  }
}

/**
 * Serialize the detached frame into bounded scratch without publishing state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function pack(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (frame.analysisDelayed) {
      frame.packedPayloadBits = 0
      frame.output = null
      return frame
    }
    const payloadBits = packFrame(
      frame.allocationTransactions,
      frame.sharedCodingUnits,
      encoder.state.topology.codingUnitCount,
      context.profile.bytesPerFrame,
      encoder.scratch.packedFrame,
      encoder.scratch.spectrumSyntax
    )
    frame.packedPayloadBits = payloadBits
    frame.output = encoder.scratch.packedFrame.subarray(
      0,
      context.profile.bytesPerFrame
    )
    return frame
  }
}

/**
 * Publish frame histories only after delay acceptance or successful packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Atomic commit stage.
 */
export function commitFrame(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (!frame.analysisDelayed && !(frame.output instanceof Uint8Array)) {
      throw new Error(
        'ATRAC3plus frame cannot commit before successful packing'
      )
    }
    copyEncoderState(encoder.frame, encoder.state, encoder.state.topology)
    encoder.state.lastAllocationAttempts = frame.allocationAttempts
    frame.committed = true
    return frame
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
 * Compose retained allocation and exact frame fitting.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocate(context) {
  return createAllocation(context)
}

/**
 * Materialize final symbols for every retained coding unit.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization stage.
 */
export function quantize(context) {
  const { codingUnitCount } = context.bufferPool.encoder.state.topology
  return (frame) => {
    for (let unit = 0; unit < codingUnitCount; unit++) {
      quantizeSymbols(frame.allocationTransactions[unit])
    }
    return frame
  }
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
    beginTransaction,
    analyze,
    allocate,
    quantize,
    applyDelay,
    pack,
    commitFrame,
    detachOutput
  )
  const scale = createPcmScaler(context.profile.channels)
  return (input) => encodeFrame(scale(input))
}
