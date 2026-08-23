/** Iterable ATRACX WAVE reader over an in-memory byte image. */

import { STREAM_PRIMING_SAMPLES } from '../core/constants.js'
import { parseWave } from './container.js'

/**
 * Normalize supported in-memory binary inputs without unnecessary copying.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {Uint8Array}
 */
function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new TypeError('ATRACX WAVE reader requires bytes')
}

/**
 * Incremental reader for framed codec WAVE data.
 */
export class WaveReader {
  /**
   * Parse an ATRACX WAVE image and expose stable stream metadata.
   *
   * @param {ArrayBuffer|ArrayBufferView} input Complete in-memory WAVE image.
   */
  constructor(input) {
    this.input = asBytes(input)
    this.parsed = parseWave(this.input)
    this.metadata = {
      bitrateKbps: this.parsed.profile.bitrateKbps,
      channels: this.parsed.profile.channels,
      sampleRate: this.parsed.profile.sampleRate,
      bytesPerFrame: this.parsed.profile.bytesPerFrame,
      frameCount: this.parsed.frameCount,
      sampleCount: this.parsed.fact?.sampleCount ?? null,
      primingSampleCount:
        this.parsed.fact?.primingSampleCount ?? STREAM_PRIMING_SAMPLES,
    }
  }

  /**
   * Iterate the retained frame views synchronously without copying their bytes.
   *
   * @returns {Generator<Uint8Array>} Complete encoded frames.
   */
  *[Symbol.iterator]() {
    yield* this.parsed.frames()
  }

  /**
   * Expose the same retained frame views through the asynchronous iterator contract.
   *
   * @returns {AsyncGenerator<Uint8Array>} Complete encoded frames.
   */
  async *[Symbol.asyncIterator]() {
    yield* this.parsed.frames()
  }
}
