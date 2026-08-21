/** Carta5 ATRAC3plus public normalized PCM boundary adapters. */

import { FRAME_SAMPLES } from '../core/constants.js'

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
