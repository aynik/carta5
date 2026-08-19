/** Streaming ATRACX WAVE timeline adapter around the staged ATRAC3plus decoder. */

import {
  DELAY_SAMPLES,
  FRAME_SAMPLES,
  WAVE_DEFAULT_ALIGNMENT_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { decode } from '../pipeline/decoder.js'
import { parseWave } from './wave.js'

/** Apply ATRACX fact alignment and visible sample-count trimming per frame. */

/**
 * Apply ATRACX fact alignment and visible sample-count trimming per frame.
 */
export class WaveStreamingDecoder {
  /**
   * Create a frame decoder with WAVE timeline trimming.
   *
   * @param {WaveCodecOptions} [options] Profile and `fact` timeline options.
   * @param {import('../core/buffers.js').BufferPool} bufferPool
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
   * @returns {Float32Array[]} Timeline-trimmed planar PCM.
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
 * @param {import('../core/buffers.js').BufferPool} bufferPool
 * Explicit reusable codec storage.
 * @returns {WaveStreamingDecoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingDecoder(options, bufferPool) {
  return new WaveStreamingDecoder(options, bufferPool)
}

/**
 * Decode a complete ATRACX WAVE byte image into planar signed-sample PCM.
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
