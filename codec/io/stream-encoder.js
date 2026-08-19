/** Arbitrary-chunk and flush-tail owner for the detached ATRAC3plus encoder. */

import { BufferPool } from '../core/buffers.js'
import { FRAME_SAMPLES, DONE, DRAINING, FEEDING } from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { flushTailFramesForSampleCount } from '../core/timing.js'
import { createFrameEncoder } from '../pipeline/encoder.js'

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
    this.encodeFrame = createFrameEncoder(profile, bufferPool)
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
   * @param {Float32Array[]} channels Encoder-domain planar PCM.
   * @returns {Uint8Array[]} Newly visible complete encoded frames.
   */
  write(channels) {
    return [...this.frames(channels)]
  }

  /**
   * Lazily consume one arbitrary equally sized planar chunk.
   *
   * @param {Float32Array[]} channels Encoder-domain planar PCM.
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
 * Create a persistent arbitrary-chunk ATRAC3plus encoder.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Explicit codec storage owner.
 * @returns {StreamingEncoder} Stateful chunk adapter.
 */
export function createStreamingEncoder(options, bufferPool) {
  return new StreamingEncoder(options, bufferPool)
}
