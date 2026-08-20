/** Streaming PCM-to-ATRACX WAVE timeline adapter. */

import { StreamingEncoder } from './stream-encoder.js'
import { createWave } from './wave.js'

/**
 * Container timeline owner around the arbitrary-chunk ATRAC3plus runtime.
 */
export class WaveStreamingEncoder {
  /**
   * Create a WAVE timeline adapter around one persistent chunk encoder.
   *
   * @param {WaveCodecOptions} [options] Maintained profile and timeline options.
   * @param {import('../core/buffers.js').BufferPool} bufferPool
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
 * @param {import('../core/buffers.js').BufferPool} bufferPool
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
