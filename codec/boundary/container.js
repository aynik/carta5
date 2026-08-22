/** RIFF/WAVE_FORMAT_EXTENSIBLE ATRACX container ownership. */

import {
  DELAY_SAMPLES,
  WAVE_FORMAT_TAG,
  WAVE_FORMAT_VERSION,
  WAVE_DEFAULT_ALIGNMENT_SAMPLES,
  WAVE_EXTENSION_BYTES,
  WAVE_FACT_BYTES,
  WAVE_FORMAT_CHUNK_BYTES,
  WAVE_HEADER_BYTES,
} from '../core/constants.js'
import { resolveProfile, resolveWaveProfile } from '../core/profiles.js'

import { ATRACX_GUID_BYTES } from '../core/tables.js'

const textDecoder = new TextDecoder('ascii')

/**
 * Write a four-character RIFF identifier at the requested byte offset.
 *
 * @param {Uint8Array} output
 * @param {number} offset
 * @param {string} value
 */
function writeFourCc(output, offset, value) {
  for (let index = 0; index < 4; index++) {
    output[offset + index] = value.charCodeAt(index)
  }
}

/**
 * Read a four-byte RIFF identifier as an ASCII string.
 *
 * @param {Uint8Array} input
 * @param {number} offset
 * @returns {string}
 */
function readFourCc(input, offset) {
  return textDecoder.decode(input.subarray(offset, offset + 4))
}

/**
 * Compare a WAVE subformat GUID with the ATRACX identifier byte for byte.
 *
 * @param {Uint8Array} input
 * @param {number} offset
 * @returns {boolean}
 */
function matchesAtracxGuid(input, offset) {
  for (let index = 0; index < ATRACX_GUID_BYTES.length; index++) {
    if (input[offset + index] !== ATRACX_GUID_BYTES[index]) return false
  }
  return true
}

/**
 * Validate frame-aligned payload size and timeline fields before writing the fixed ATRACX WAVE header.
 *
 * @param {CodecProfile} profile
 * @param {number} dataBytes
 * @param {number} alignmentSampleCount
 * @param {number} sampleCount
 */
function validateHeaderGeometry(
  profile,
  dataBytes,
  alignmentSampleCount,
  sampleCount
) {
  if (
    !profile ||
    !Number.isInteger(dataBytes) ||
    dataBytes < 0 ||
    dataBytes > 0xffffffff - WAVE_HEADER_BYTES ||
    dataBytes % profile.bytesPerFrame !== 0 ||
    !Number.isInteger(alignmentSampleCount) ||
    alignmentSampleCount < DELAY_SAMPLES ||
    alignmentSampleCount > 0xffffffff ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > 0xffffffff
  ) {
    throw new RangeError('Invalid ATRACX WAVE header geometry')
  }
}

/**
 * Build reference's canonical fixed 100-byte ATRACX WAVE header.
 *
 * @param {CodecProfile} profile Immutable maintained profile.
 * @param {number} dataBytes Total encoded frame bytes.
 * @param {number} [alignmentSampleCount] Container alignment timeline.
 * @param {number} [sampleCount] Visible PCM samples per channel.
 * @returns {Uint8Array} Canonical fixed-size WAVE header.
 */
export function createWaveHeader(
  profile,
  dataBytes,
  alignmentSampleCount = WAVE_DEFAULT_ALIGNMENT_SAMPLES,
  sampleCount = 0
) {
  validateHeaderGeometry(profile, dataBytes, alignmentSampleCount, sampleCount)
  const output = new Uint8Array(WAVE_HEADER_BYTES)
  const view = new DataView(output.buffer)
  writeFourCc(output, 0, 'RIFF')
  view.setUint32(4, output.length + dataBytes - 8, true)
  writeFourCc(output, 8, 'WAVE')
  writeFourCc(output, 12, 'fmt ')
  view.setUint32(16, WAVE_FORMAT_CHUNK_BYTES, true)
  view.setUint16(20, WAVE_FORMAT_TAG, true)
  view.setUint16(22, profile.channels, true)
  view.setUint32(24, profile.sampleRate, true)
  view.setUint32(
    28,
    Math.trunc(
      (profile.bytesPerFrame * profile.sampleRate + profile.frameSamples / 2) /
        profile.frameSamples
    ),
    true
  )
  view.setUint16(32, profile.bytesPerFrame, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, WAVE_EXTENSION_BYTES, true)
  view.setUint16(38, profile.frameSamples, true)
  view.setUint32(40, profile.channelMask, true)
  output.set(ATRACX_GUID_BYTES, 44)
  view.setUint16(60, WAVE_FORMAT_VERSION, true)
  output.set(profile.codecInfoBytes, 62)
  writeFourCc(output, 72, 'fact')
  view.setUint32(76, WAVE_FACT_BYTES, true)
  view.setUint32(80, sampleCount, true)
  view.setUint32(84, alignmentSampleCount - DELAY_SAMPLES, true)
  view.setUint32(88, alignmentSampleCount, true)
  writeFourCc(output, 92, 'data')
  view.setUint32(96, dataBytes, true)
  return output
}

/**
 * Materialize complete ATRACX WAVE bytes from fixed-size ATRAC3plus frames.
 *
 * @param {Uint8Array[]} frames Complete profile-sized encoded frames.
 * @param {WaveCodecOptions} [options] Profile and `fact` timeline options.
 * @returns {Uint8Array} Complete ATRACX WAVE byte image.
 */
export function createWave(frames, options = {}) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRACX WAVE profile')
  const dataBytes = frames.length * profile.bytesPerFrame
  const output = new Uint8Array(WAVE_HEADER_BYTES + dataBytes)
  output.set(
    createWaveHeader(
      profile,
      dataBytes,
      options.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES,
      options.sampleCount ?? 0
    )
  )
  let offset = WAVE_HEADER_BYTES
  for (const frame of frames) {
    if (
      !(frame instanceof Uint8Array) ||
      frame.length !== profile.bytesPerFrame
    ) {
      throw new RangeError('ATRACX WAVE frame has the wrong block alignment')
    }
    output.set(frame, offset)
    offset += frame.length
  }
  return output
}

/**
 * Parse the maintained ATRACX extensible WAVE subset without copying frames.
 *
 * @param {Uint8Array} input Complete ATRACX WAVE byte image.
 * @returns {ParsedWave} Profile, format, timeline, data geometry, and frame views.
 */
export function parseWave(input) {
  if (!(input instanceof Uint8Array) || input.length < 12) {
    throw new RangeError('ATRACX WAVE input is too short')
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (readFourCc(input, 0) !== 'RIFF' || readFourCc(input, 8) !== 'WAVE') {
    throw new RangeError('Invalid RIFF/WAVE signature')
  }
  let format = null
  let fact = null
  let dataOffset = -1
  let dataBytes = 0
  for (let offset = 12; offset + 8 <= input.length; ) {
    const id = readFourCc(input, offset)
    const size = view.getUint32(offset + 4, true)
    const payload = offset + 8
    if (payload + size > input.length) {
      throw new RangeError('Truncated ATRACX WAVE chunk')
    }
    if (id === 'fmt ') {
      if (
        size < WAVE_FORMAT_CHUNK_BYTES ||
        view.getUint16(payload, true) !== WAVE_FORMAT_TAG ||
        !matchesAtracxGuid(input, payload + 24)
      ) {
        throw new RangeError('Unsupported ATRACX WAVE format chunk')
      }
      format = {
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        averageBytesPerSecond: view.getUint32(payload + 8, true),
        blockAlign: view.getUint16(payload + 12, true),
        bitsPerSample: view.getUint16(payload + 14, true),
        extensionSize: view.getUint16(payload + 16, true),
        samplesPerBlock: view.getUint16(payload + 18, true),
        channelMask: view.getUint32(payload + 20, true),
        formatVersion: view.getUint16(payload + 40, true),
        codecInfoBytes: input.slice(payload + 42, payload + 44),
        reservedBytes: input.slice(payload + 44, payload + 52),
      }
    } else if (id === 'fact') {
      if (size >= 4) {
        fact = {
          sampleCount: view.getUint32(payload, true),
          reservedSampleCount:
            size >= 12 ? view.getUint32(payload + 4, true) : null,
          alignmentSampleCount:
            size >= 12
              ? view.getUint32(payload + 8, true)
              : size >= 8
                ? view.getUint32(payload + 4, true) + DELAY_SAMPLES
                : null,
        }
      }
    } else if (id === 'data') {
      if (dataOffset !== -1) {
        throw new RangeError('Duplicate ATRACX WAVE data chunk')
      }
      dataOffset = payload
      dataBytes = size
    }
    offset = payload + size + (size & 1)
  }
  if (!format || dataOffset < 0) {
    throw new RangeError('Incomplete ATRACX WAVE file')
  }
  const profile = resolveWaveProfile(format)
  if (!profile || dataBytes % profile.bytesPerFrame !== 0) {
    throw new RangeError('ATRACX WAVE profile or data alignment is invalid')
  }
  return {
    profile,
    format,
    fact,
    dataOffset,
    dataBytes,
    frameCount: dataBytes / profile.bytesPerFrame,
    /**
     * Yield fixed-size encoded frame views from the WAVE data chunk without copying.
     *
     * @returns {Generator<unknown>}
     */
    *frames() {
      for (let index = 0; index < this.frameCount; index++) {
        yield input.subarray(
          dataOffset + index * profile.bytesPerFrame,
          dataOffset + (index + 1) * profile.bytesPerFrame
        )
      }
    },
  }
}
