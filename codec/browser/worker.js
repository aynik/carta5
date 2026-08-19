/** Browser worker boundary for complete ATRACX WAVE jobs. */

import {
  DELAY_SAMPLES,
  FRAME_SAMPLES,
  WAVE_DEFAULT_ALIGNMENT_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { PROFILE_ROWS } from '../core/tables.js'
import { createWaveStreamingDecoder } from '../io/wave-decoder.js'
import { createWaveStreamingEncoder } from '../io/wave-encoder.js'
import { createWaveHeader, parseWave } from '../io/wave.js'
import { createPcmWaveHeader, interleavePcm16 } from '../io/serialization.js'

/**
 * Normalize browser binary inputs to a byte view.
 *
 * @param {Blob|Uint8Array|ArrayBuffer} value Browser binary input.
 * @returns {Promise<Uint8Array>} Byte view over the supplied binary data.
 */
async function asBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('ATRAC3plus worker requires a Blob or byte array')
}

/**
 * Project a parsed WAVE image onto worker-safe metadata.
 *
 * @param {ParsedWave} parsed
 * @returns {{bitrateKbps: number, channels: number, sampleRate: number, frameCount: number, sampleCount: number|null}}
 */
function metadata(parsed) {
  return {
    bitrateKbps: parsed.profile.bitrateKbps,
    channels: parsed.profile.channels,
    sampleRate: parsed.profile.sampleRate,
    frameCount: parsed.frameCount,
    sampleCount: parsed.fact?.sampleCount ?? null,
  }
}

self.onmessage = async ({ data }) => {
  const { jobId, type } = data
  try {
    let result
    if (type === 'encode') {
      const options = data.options ?? {}
      const profile = resolveProfile(options)
      if (!profile) throw new RangeError('Unsupported ATRACX WAVE profile')
      const encoder = createWaveStreamingEncoder(options)
      const frames = [...encoder.frames(data.pcmData), ...encoder.finish()]
      const header = createWaveHeader(
        profile,
        frames.length * profile.bytesPerFrame,
        options.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES,
        encoder.sampleCount
      )
      result = {
        waveBlob: new Blob([header, ...frames], { type: 'audio/wav' }),
        info: {
          bitrateKbps: profile.bitrateKbps,
          channels: profile.channels,
          sampleRate: profile.sampleRate,
          frameCount: frames.length,
          sampleCount: encoder.sampleCount,
        },
      }
    } else if (type === 'decode') {
      const wave = await asBytes(data.wave)
      const parsed = parseWave(wave)
      const alignmentSampleCount =
        parsed.fact?.alignmentSampleCount ?? WAVE_DEFAULT_ALIGNMENT_SAMPLES
      const sampleCount =
        parsed.fact?.sampleCount ??
        Math.max(
          0,
          parsed.frameCount * FRAME_SAMPLES -
            alignmentSampleCount -
            DELAY_SAMPLES
        )
      const decoder = createWaveStreamingDecoder({
        bitrateKbps: parsed.profile.bitrateKbps,
        channels: parsed.profile.channels,
        sampleRate: parsed.profile.sampleRate,
        alignmentSampleCount,
        sampleCount,
      })
      const pcmParts = [
        createPcmWaveHeader({
          sampleCount,
          sampleRate: parsed.profile.sampleRate,
          channels: parsed.profile.channels,
        }),
      ]
      for (const frame of parsed.frames()) {
        const chunk = decoder.write(frame)
        if (chunk[0].length !== 0) pcmParts.push(interleavePcm16(chunk))
      }
      decoder.finish()
      result = {
        wavBlob: new Blob(pcmParts, { type: 'audio/wav' }),
        info: metadata(parsed),
      }
    } else if (type === 'inspect') {
      result = metadata(parseWave(await asBytes(data.wave)))
    } else if (type === 'getProfiles') {
      result = PROFILE_ROWS.map((profile) => ({ ...profile }))
    } else {
      throw new RangeError(`Unknown worker operation: ${type}`)
    }
    self.postMessage({ jobId, result })
  } catch (error) {
    self.postMessage({ jobId, error: error.message })
  }
}
