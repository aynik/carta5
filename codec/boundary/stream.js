/** Arbitrary-chunk and flush-tail owner for the detached ATRAC3plus encoder. */

import { BufferPool } from '../state/storage.js'
import {
  ANALYSIS_RESIDUAL_OVERLAP_SAMPLES,
  ANALYSIS_TO_STREAM_DELAY_FRAMES,
  DELAY_SAMPLES,
  DONE,
  DRAINING,
  FEEDING,
  FRAME_SAMPLES,
  FULL_FRAME_FLUSH_TAIL_FRAMES,
  WAVE_DEFAULT_ALIGNMENT_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { createWave, parseWave } from './container.js'
import { decode } from '../pipeline/decoder.js'
import { encode } from '../pipeline/encoder.js'

// The first QMF evaluation skips 16 samples of the persisted 384-sample carry.

/**
 * Return the silent frames required after one successful nonempty submission.
 * A full or late partial frame needs nine; an early partial frame needs eight.
 *
 * @param {number} sampleCount Valid PCM samples in the submitted frame.
 * @returns {number|null} Required silent tail frames, or `null` when empty.
 */
export function flushTailFramesForSampleCount(sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount > FRAME_SAMPLES) {
    throw new RangeError('ATRAC3plus flush-tail sample count is invalid')
  }
  if (sampleCount <= 0) return null
  const analysisTailSamples = sampleCount + ANALYSIS_RESIDUAL_OVERLAP_SAMPLES
  const analysisTailFrames = Math.ceil(analysisTailSamples / FRAME_SAMPLES)
  const frames = ANALYSIS_TO_STREAM_DELAY_FRAMES + analysisTailFrames
  if (frames > FULL_FRAME_FLUSH_TAIL_FRAMES) {
    throw new RangeError('ATRAC3plus flush tail exceeds its fixed bound')
  }
  return frames
}

/**
 * Validate planar PCM channel count and equal lengths, returning the chunk's sample count.
 *
 * @param {Float32Array[]} channels
 * @param {number} channelCount
 * @returns {number}
 */
function validateChunk(channels, channelCount) {
  if (!Array.isArray(channels) || channels.length !== channelCount) {
    throw new RangeError('ATRAC3plus PCM chunk geometry is invalid')
  }
  let length = -1
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new RangeError('ATRAC3plus PCM chunks require Float32 channels')
    }
    if (length < 0) length = channel.length
    else if (channel.length !== length) {
      throw new RangeError('ATRAC3plus PCM chunk lengths do not match')
    }
  }
  return Math.max(length, 0)
}

/**
 * Preserve chunking, delay, and drain outside the per-frame codec path.
 */
export class StreamingEncoder {
  /**
   * Create an arbitrary-chunk adapter around one persistent frame encoder.
   *
   * @param {CodecProfileOptions} [options] Maintained profile options.
   * @param {BufferPool} [bufferPool] Explicit codec storage owner.
   */
  constructor(options = {}, bufferPool = new BufferPool()) {
    const profile = resolveProfile(options)
    if (!profile) throw new RangeError('Unsupported ATRAC3plus encoder profile')
    this.profile = profile
    this.bufferPool = bufferPool
    this.encodeFrame = encode(profile, bufferPool)
    this.inputFrame = Array.from(
      { length: profile.channels },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.inputFill = 0
    this.flushTailRemaining = 0
    this.sampleCount = 0
    this.lifecycle = FEEDING
  }

  /**
   * Submit the current input frame and update the exact flush-tail length.
   *
   * @param {number} sampleCount
   * @param {boolean} flushing
   * @returns {Uint8Array|null}
   */
  submit(sampleCount, flushing) {
    const output = this.encodeFrame({
      channels: this.inputFrame,
      sampleCount,
    })
    if (!flushing) {
      const tail = flushTailFramesForSampleCount(sampleCount)
      if (tail !== null) this.flushTailRemaining = tail
    }
    return output
  }

  /**
   * Clear the adapter-owned partial input without replacing its storage.
   */
  clearInputFrame() {
    for (const channel of this.inputFrame) channel.fill(0)
    this.inputFill = 0
  }

  /**
   * Consume one arbitrary equally sized planar chunk and collect its output.
   *
   * @param {Float32Array[]} channels Normalized planar PCM.
   * @returns {Uint8Array[]} Newly visible complete encoded frames.
   */
  write(channels) {
    return [...this.frames(channels)]
  }

  /**
   * Lazily consume one arbitrary equally sized planar chunk.
   *
   * @param {Float32Array[]} channels Normalized planar PCM.
   * @returns {Generator<Uint8Array>} Newly visible complete encoded frames.
   */
  *frames(channels) {
    if (this.lifecycle !== FEEDING) {
      throw new Error('ATRAC3plus encoder is no longer accepting input')
    }
    const inputLength = validateChunk(channels, this.profile.channels)
    if (inputLength === 0) return
    let inputOffset = 0
    while (inputOffset < inputLength) {
      const count = Math.min(
        inputLength - inputOffset,
        FRAME_SAMPLES - this.inputFill
      )
      for (let channel = 0; channel < this.profile.channels; channel++) {
        this.inputFrame[channel].set(
          channels[channel].subarray(inputOffset, inputOffset + count),
          this.inputFill
        )
      }
      this.inputFill += count
      inputOffset += count
      this.sampleCount += count
      if (this.inputFill === FRAME_SAMPLES) {
        const frame = this.submit(FRAME_SAMPLES, false)
        this.clearInputFrame()
        if (frame !== null) yield frame
      }
    }
  }

  /**
   * Flush the partial input and exact analysis tail once.
   *
   * @returns {Uint8Array[]} Remaining visible encoded frames.
   */
  finish() {
    if (this.lifecycle === DONE) return []
    this.lifecycle = DRAINING
    const output = []
    if (this.inputFill !== 0) {
      const frame = this.submit(this.inputFill, false)
      this.clearInputFrame()
      if (frame !== null) output.push(frame)
    }
    while (this.flushTailRemaining > 0) {
      const frame = this.submit(0, true)
      this.flushTailRemaining--
      if (frame !== null) output.push(frame)
    }
    this.lifecycle = DONE
    return output
  }
}

/**
 * Container timeline owner around the arbitrary-chunk ATRAC3plus runtime.
 */
export class WaveStreamingEncoder {
  /**
   * Create a WAVE timeline adapter around one persistent chunk encoder.
   *
   * @param {WaveCodecOptions} [options] Maintained profile and timeline options.
   * @param {import('../state/storage.js').BufferPool} bufferPool
   * Explicit reusable codec storage.
   */
  constructor(options = {}, bufferPool) {
    this.encoder = new StreamingEncoder(options, bufferPool)
    this.profile = this.encoder.profile
  }

  /**
   * Return the number of source PCM samples accepted per channel by the streaming encoder.
   *
   * @returns {number} Number of source PCM samples accepted per channel.
   */
  get sampleCount() {
    return this.encoder.sampleCount
  }

  /**
   * Consume one equally sized normalized planar PCM chunk.
   *
   * @param {Float32Array[]} channels One channel per profile channel.
   * @returns {Uint8Array[]} Newly visible complete encoded frames.
   */
  write(channels) {
    return this.encoder.write(channels)
  }

  /**
   * Lazily consume one equally sized normalized planar PCM chunk.
   *
   * @param {Float32Array[]} channels One channel per profile channel.
   * @returns {Generator<Uint8Array>} Newly visible complete encoded frames.
   */
  *frames(channels) {
    yield* this.encoder.frames(channels)
  }

  /**
   * Flush the partial input and exact codec tail once.
   *
   * @returns {Uint8Array[]} Remaining visible encoded frames.
   */
  finish() {
    return this.encoder.finish()
  }
}

/**
 * Create a streaming encoder that owns ATRACX timeline accounting.
 *
 * @param {WaveCodecOptions} [options] Maintained profile and timeline options.
 * @param {import('../state/storage.js').BufferPool} bufferPool
 * Explicit reusable codec storage.
 * @returns {WaveStreamingEncoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingEncoder(options, bufferPool) {
  return new WaveStreamingEncoder(options, bufferPool)
}

/**
 * Encode complete planar normalized PCM into an ATRACX WAVE image.
 *
 * @param {Float32Array[]} channels Equal-length normalized PCM channels.
 * @param {WaveCodecOptions} [options] Maintained profile and alignment options.
 * @returns {Uint8Array} Complete ATRACX WAVE byte image.
 */
export function encodeWavePcm(channels, options = {}) {
  const encoder = new WaveStreamingEncoder(options)
  const frames = encoder.write(channels)
  frames.push(...encoder.finish())
  return createWave(frames, {
    bitrateKbps: encoder.profile.bitrateKbps,
    channels: encoder.profile.channels,
    sampleRate: encoder.profile.sampleRate,
    sampleCount: encoder.sampleCount,
    alignmentSampleCount: options.alignmentSampleCount,
  })
}

/**
 * Apply ATRACX fact alignment and visible sample-count trimming per frame.
 */
export class WaveStreamingDecoder {
  /**
   * Create a frame decoder with WAVE timeline trimming.
   *
   * @param {WaveCodecOptions} [options] Profile and `fact` timeline options.
   * @param {import('../state/storage.js').BufferPool} bufferPool
   * Explicit reusable codec storage.
   */
  constructor(options = {}, bufferPool) {
    this.profile = resolveProfile(options)
    if (!this.profile) {
      throw new RangeError('Unsupported ATRACX WAVE decoder profile')
    }
    this.decodeFrame = decode(this.profile, bufferPool)
    this.skipSamples =
      (options.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES) +
      DELAY_SAMPLES
    this.sampleCount = options.sampleCount ?? Number.POSITIVE_INFINITY
    this.timelinePosition = 0
    this.emittedSamples = 0
    this.finalized = false
    this.emptyChunk = Array.from(
      { length: this.profile.channels },
      () => new Float32Array(0)
    )
  }

  /**
   * Decode one complete frame and return its visible timeline interval.
   *
   * @param {Uint8Array} frame One profile-sized encoded frame.
   * @returns {Float32Array[]} Timeline-trimmed normalized planar PCM.
   */
  write(frame) {
    if (this.finalized) {
      throw new Error('ATRACX WAVE decoder has already been finalized')
    }
    const decoded = this.decodeFrame(frame)
    const start = Math.max(0, this.skipSamples - this.timelinePosition)
    const available = FRAME_SAMPLES - start
    const remaining = this.sampleCount - this.emittedSamples
    const count = Math.max(0, Math.min(available, remaining))
    this.timelinePosition += FRAME_SAMPLES
    if (count === 0) return this.emptyChunk
    this.emittedSamples += count
    return decoded.map((channel) => channel.slice(start, start + count))
  }

  /**
   * Finalize once and reject a truncated finite-length timeline.
   *
   * @returns {void}
   */
  finish() {
    if (this.finalized) return
    this.finalized = true
    if (
      Number.isFinite(this.sampleCount) &&
      this.emittedSamples !== this.sampleCount
    ) {
      throw new RangeError(
        `Truncated ATRACX WAVE timeline: decoded ${this.emittedSamples} of ${this.sampleCount} samples`
      )
    }
  }
}

/**
 * Create a streaming decoder that applies ATRACX timeline trimming.
 *
 * @param {WaveCodecOptions} [options] Profile and `fact` timeline options.
 * @param {import('../state/storage.js').BufferPool} bufferPool
 * Explicit reusable codec storage.
 * @returns {WaveStreamingDecoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingDecoder(options, bufferPool) {
  return new WaveStreamingDecoder(options, bufferPool)
}

/**
 * Decode a complete ATRACX WAVE byte image into planar normalized PCM.
 *
 * @param {Uint8Array} input Complete ATRACX WAVE byte image.
 * @returns {Float32Array[]} One equal-length PCM buffer per encoded channel.
 */
export function decodeWavePcm(input) {
  const parsed = parseWave(input)
  const alignmentSampleCount =
    parsed.fact?.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES
  const sampleCount =
    parsed.fact?.sampleCount ??
    Math.max(
      0,
      parsed.frameCount * FRAME_SAMPLES - alignmentSampleCount - DELAY_SAMPLES
    )
  const decoder = new WaveStreamingDecoder({
    bitrateKbps: parsed.profile.bitrateKbps,
    channels: parsed.profile.channels,
    sampleRate: parsed.profile.sampleRate,
    sampleCount,
    alignmentSampleCount,
  })
  const output = Array.from(
    { length: parsed.profile.channels },
    () => new Float32Array(sampleCount)
  )
  let outputOffset = 0
  for (const frame of parsed.frames()) {
    const chunk = decoder.write(frame)
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(chunk[channel], outputOffset)
    }
    outputOffset += chunk[0].length
  }
  decoder.finish()
  return output
}
