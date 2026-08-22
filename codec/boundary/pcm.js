/** PCM serialization used at the ATRACX WAVE decode boundary. */

import { float32ToBits } from '../utils.js'
import {
  DEFAULT_PCM_CHANNELS,
  DEFAULT_PCM_SAMPLE_RATE,
  FRAME_SAMPLES,
  PCM_WAVE_BITS_PER_SAMPLE,
  PCM_WAVE_HEADER_BYTES,
} from '../core/constants.js'

export const PCM_SCALE = 32768

/**
 * Scale one normalized planar frame into the codec's signed-amplitude domain.
 *
 * @param {Float32Array[]} channels Normalized source channels.
 * @param {Float32Array[]} output Reusable codec-domain destination channels.
 * @returns {Float32Array[]} The populated destination channels.
 */
export function scalePcmFrame(channels, output) {
  for (let channel = 0; channel < channels.length; channel++) {
    const source = channels[channel]
    const destination = output[channel]
    for (let sample = 0; sample < source.length; sample++) {
      destination[sample] = Math.fround(source[sample] * PCM_SCALE)
    }
  }
  return output
}

/**
 * Create a reusable normalized-to-codec PCM input adapter.
 *
 * @param {number} channelCount Configured stream channel count.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): {channels: Float32Array[], sampleCount: number}}
 */
export function createPcmScaler(channelCount) {
  if (!Number.isInteger(channelCount) || channelCount < 1) {
    throw new RangeError('ATRAC3plus PCM channel count is invalid')
  }
  const output = Array.from(
    { length: channelCount },
    () => new Float32Array(FRAME_SAMPLES)
  )

  return (input) => {
    const channels = Array.isArray(input) ? input : input?.channels
    const sampleCount = Array.isArray(input)
      ? FRAME_SAMPLES
      : (input?.sampleCount ?? FRAME_SAMPLES)
    if (
      !Array.isArray(channels) ||
      channels.length !== channelCount ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 0 ||
      sampleCount > FRAME_SAMPLES ||
      !channels.every(
        (channel) =>
          channel instanceof Float32Array && channel.length === FRAME_SAMPLES
      )
    ) {
      throw new RangeError('ATRAC3plus PCM frame geometry is invalid')
    }
    scalePcmFrame(channels, output)
    return { channels: output, sampleCount }
  }
}

/**
 * Normalize detached codec-domain PCM channels in place.
 *
 * @param {Float32Array[]} channels Codec-domain PCM channels.
 * @returns {Float32Array[]} The normalized channels.
 */
export function normalizePcm(channels) {
  for (const channel of channels) {
    for (let sample = 0; sample < channel.length; sample++) {
      channel[sample] = Math.fround(channel[sample] / PCM_SCALE)
    }
  }
  return channels
}

/**
 * Convert normalized floats to signed PCM with codec-compatible rounding.
 *
 * @param {number} sample Normalized PCM sample value.
 * @returns {number} Clipped signed 16-bit integer.
 */
export function floatToPcm16(sample) {
  sample = Math.fround(sample * PCM_SCALE)
  if (sample > 32767) return 32767
  if (Number.isNaN(sample) || sample <= -32767) return -32767
  return (float32ToBits(Math.fround(sample + 12582912)) << 16) >> 16
}

/**
 * Write one four-character RIFF identifier.
 *
 * @param {ArrayLike<number>} output
 * @param {number} offset
 * @param {string} value
 */
function writeFourCc(output, offset, value) {
  for (let index = 0; index < 4; index++) {
    output[offset + index] = value.charCodeAt(index)
  }
}

/**
 * Create a canonical signed 16-bit PCM WAVE header.
 *
 * @param {PcmWaveGeometry} [geometry] Sample count and optional PCM format overrides.
 * @returns {Uint8Array} Fixed-size PCM WAVE header.
 */
export function createPcmWaveHeader({
  sampleCount,
  sampleRate = DEFAULT_PCM_SAMPLE_RATE,
  channels = DEFAULT_PCM_CHANNELS,
} = {}) {
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0
  ) {
    throw new RangeError('Invalid PCM WAVE geometry')
  }
  const dataBytes = sampleCount * channels * 2
  const output = new Uint8Array(PCM_WAVE_HEADER_BYTES)
  const view = new DataView(output.buffer)
  writeFourCc(output, 0, 'RIFF')
  view.setUint32(4, PCM_WAVE_HEADER_BYTES + dataBytes - 8, true)
  writeFourCc(output, 8, 'WAVE')
  writeFourCc(output, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, PCM_WAVE_BITS_PER_SAMPLE, true)
  writeFourCc(output, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return output
}

/**
 * Interleave normalized float channels as signed 16-bit PCM.
 *
 * @param {Float32Array[]} channels Two equal planar channels.
 * @returns {Uint8Array} Little-endian interleaved PCM bytes.
 */
export function interleavePcm16(channels) {
  if (
    !Array.isArray(channels) ||
    channels.length < 1 ||
    !channels.every(
      (channel) =>
        channel instanceof Float32Array && channel.length === channels[0].length
    )
  ) {
    throw new RangeError('PCM must contain equally sized Float32 channels')
  }
  const channelCount = channels.length
  const output = new Uint8Array(channels[0].length * channelCount * 2)
  const view = new DataView(output.buffer)
  for (let sample = 0; sample < channels[0].length; sample++) {
    for (let channel = 0; channel < channelCount; channel++) {
      view.setInt16(
        (sample * channelCount + channel) * 2,
        floatToPcm16(channels[channel][sample]),
        true
      )
    }
  }
  return output
}

/**
 * Create a complete signed 16-bit PCM WAVE byte image.
 *
 * @param {Float32Array[]} channels Two equal planar channels.
 * @param {PcmWaveOptions} [options] Optional sample-rate/header overrides.
 * @returns {Uint8Array} Header followed by interleaved PCM data.
 */
export function createPcmWave(channels, options = {}) {
  const pcm = interleavePcm16(channels)
  const header = createPcmWaveHeader({
    ...options,
    sampleCount: channels[0].length,
    channels: channels.length,
  })
  const output = new Uint8Array(header.length + pcm.length)
  output.set(header)
  output.set(pcm, header.length)
  return output
}
