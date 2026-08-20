/** High-level streaming boundaries for ATRAC3plus/ATRACX encode and decode. */

import {
  FRAME_SAMPLES,
  STREAM_CHANNEL_MODE,
  WAVE_DEFAULT_ALIGNMENT_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { decode } from '../pipeline/decoder.js'
import { createWaveStreamingDecoder, decodeWavePcm } from './wave-decoder.js'
import { createWaveStreamingEncoder, encodeWavePcm } from './wave-encoder.js'
import { createWaveHeader, parseWave } from './wave.js'
import { createPcmWave } from './serialization.js'

/**
 * High-level streaming audio processor facade.
 */
export class AudioProcessor {
  /**
   * Adapt arbitrary normalized planar PCM chunks to complete ATRAC3plus frames.
   *
   * @param {AsyncIterable<Float32Array[]>|Iterable<Float32Array[]>} pcmChunks
   * Planar normalized PCM chunks.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] Encoder profile and progress options.
   * @returns {AsyncGenerator<Uint8Array>} Encoded frame stream.
   */
  static async *encodeStream(pcmChunks, options = {}) {
    const encoder = createWaveStreamingEncoder(options)
    let frameIndex = 0
    for await (const chunk of pcmChunks) {
      for (const frame of encoder.frames(chunk)) {
        yield frame
        options.onProgress?.(frameIndex++)
      }
    }
    for (const frame of encoder.finish()) {
      yield frame
      options.onProgress?.(frameIndex++)
    }
  }

  /**
   * Decode complete ATRAC3plus frames without applying container timeline trim.
   *
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} encodedFrames
   * Complete encoded frames.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] Decoder profile and progress options.
   * @returns {AsyncGenerator<Float32Array[]>} Decoded normalized planar frames.
   */
  static async *decodeStream(encodedFrames, options = {}) {
    const decodeFrame = decode(options)
    let frameIndex = 0
    for await (const frame of encodedFrames) {
      yield decodeFrame(frame)
      options.onProgress?.(frameIndex++)
    }
  }

  /**
   * Decode frames while applying the WAVE fact/alignment timeline.
   *
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} encodedFrames
   * Complete encoded frames.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] Timeline, profile, and progress options.
   * @returns {AsyncGenerator<Float32Array[]>} Timeline-trimmed normalized planar chunks.
   */
  static async *decodeWaveStream(encodedFrames, options = {}) {
    const decoder = createWaveStreamingDecoder(options)
    let frameIndex = 0
    for await (const frame of encodedFrames) {
      const chunk = decoder.write(frame)
      if (chunk[0].length !== 0) yield chunk
      options.onProgress?.(frameIndex++)
    }
    decoder.finish()
  }

  /**
   * Fold complete equally sized planar buffers into zero-padded coding frames.
   *
   * @param {Float32Array[]} buffers Complete normalized planar PCM.
   * @param {number} [frameSize] Samples per emitted channel frame.
   * @returns {Generator<Float32Array[]>} Zero-padded planar frames.
   */
  static *frameBufferToFrames(buffers, frameSize = FRAME_SAMPLES) {
    if (
      !Array.isArray(buffers) ||
      buffers.length < 1 ||
      STREAM_CHANNEL_MODE[buffers.length] === undefined ||
      !buffers.every(
        (buffer) =>
          buffer instanceof Float32Array && buffer.length === buffers[0].length
      ) ||
      !Number.isInteger(frameSize) ||
      frameSize < 1
    ) {
      throw new RangeError(
        'ATRAC3plus framing requires a maintained topology of equally sized Float32 channels and a positive integer frame size'
      )
    }
    const sampleCount = buffers[0].length
    for (let offset = 0; offset < sampleCount; offset += frameSize) {
      const frame = buffers.map(() => new Float32Array(frameSize))
      for (let channel = 0; channel < buffers.length; channel++) {
        frame[channel].set(
          buffers[channel].subarray(offset, offset + frameSize)
        )
      }
      yield frame
    }
  }

  /**
   * Encode complete normalized planar PCM buffers into an ATRACX WAVE image.
   *
   * @param {Float32Array[]} channels Complete maintained-topology normalized PCM.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] Encoder profile and WAVE options.
   * @returns {Uint8Array} Complete ATRACX WAVE image.
   */
  static encodeWavePcm(channels, options = {}) {
    return encodeWavePcm(channels, options)
  }

  /**
   * Decode an ATRACX WAVE image into complete normalized planar PCM buffers.
   *
   * @param {Uint8Array} input Complete ATRACX WAVE image.
   * @returns {Float32Array[]} Decoded normalized planar PCM.
   */
  static decodeWavePcm(input) {
    return decodeWavePcm(input)
  }

  /**
   * Collect encoded frames into a browser WAVE blob.
   *
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} encodedFrames
   * Complete encoded frames.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] Profile and WAVE timeline options.
   * @returns {Promise<Blob>} ATRACX WAVE blob.
   */
  static async createWaveBlob(encodedFrames, options = {}) {
    const profile = resolveProfile(options)
    if (!profile) throw new RangeError('Unsupported ATRACX WAVE profile')
    const frames = []
    for await (const frame of encodedFrames) {
      if (
        !(frame instanceof Uint8Array) ||
        frame.length !== profile.bytesPerFrame
      ) {
        throw new RangeError('ATRACX WAVE frame has the wrong block alignment')
      }
      frames.push(frame)
    }
    const header = createWaveHeader(
      profile,
      frames.length * profile.bytesPerFrame,
      options.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES,
      options.sampleCount ?? 0
    )
    return new Blob([header, ...frames], { type: 'audio/wav' })
  }

  /**
   * Parse a browser WAVE blob into metadata and a lazy frame iterable.
   *
   * @param {Blob} blob Complete ATRACX WAVE blob.
   * @returns {Promise<{profile: CodecProfile, fact: ParsedWave['fact'], frames: Generator<Uint8Array>, bytes: Uint8Array}>} Profile, fact metadata, frames, and source bytes.
   */
  static async parseWaveBlob(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const parsed = parseWave(bytes)
    return {
      profile: parsed.profile,
      fact: parsed.fact,
      frames: parsed.frames(),
      bytes,
    }
  }

  /**
   * Serialize normalized planar PCM into a browser-compatible PCM WAVE blob.
   *
   * @param {Float32Array[]} channels Complete normalized planar PCM channels.
   * @param {WaveCodecOptions & {onProgress?: function(number): void}} [options] PCM WAVE serialization options.
   * @returns {Blob} PCM WAVE blob.
   */
  static createPcmWaveBlob(channels, options = {}) {
    return new Blob([createPcmWave(channels, options)], { type: 'audio/wav' })
  }
}
