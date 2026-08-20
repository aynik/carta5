/** Carta5 ATRAC3plus public normalized PCM boundary adapters. */

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
