import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { FRAME_SAMPLES } from '../codec/core/constants.js'
import { createPcmFrameDecoder, decode } from '../codec/pipeline/decoder.js'
import { createFrameEncoder, encode } from '../codec/pipeline/encoder.js'
import { normalizePcm, PCM_SCALE, scalePcmFrame } from '../codec/io/pcm.js'

const OPTIONS = { bitrateKbps: 128, channels: 1, sampleRate: 44100 }

describe('ATRAC3plus normalized PCM boundaries', () => {
  it('converts between normalized and codec-domain planar PCM', () => {
    const normalized = [new Float32Array([-1, -0.5, 0, 0.5, 1])]
    const codec = [new Float32Array(normalized[0].length)]

    expect(scalePcmFrame(normalized, codec)[0]).toEqual(
      new Float32Array([-32768, -16384, 0, 16384, 32768])
    )
    expect(normalizePcm(codec)[0]).toEqual(normalized[0])
  })

  it('keeps normalized frame encoding byte-compatible with codec-domain input', () => {
    const normalized = [
      Float32Array.from(
        { length: FRAME_SAMPLES },
        (_, sample) => (((sample * 37 + 11) % 257) - 128) / 32 / PCM_SCALE
      ),
    ]
    const codec = [
      Float32Array.from(normalized[0], (sample) =>
        Math.fround(sample * PCM_SCALE)
      ),
    ]
    const encodeNormalized = encode(OPTIONS, new BufferPool())
    const encodeCodec = createFrameEncoder(OPTIONS, new BufferPool())
    let normalizedFrame = null
    let codecFrame = null

    for (let frame = 0; frame < 8; frame++) {
      normalizedFrame = encodeNormalized(normalized)
      codecFrame = encodeCodec(codec)
    }

    expect(normalizedFrame).toEqual(codecFrame)
  })

  it('normalizes detached decoder output without changing codec reconstruction', () => {
    const encodeCodec = createFrameEncoder(OPTIONS, new BufferPool())
    const codec = [
      Float32Array.from(
        { length: FRAME_SAMPLES },
        (_, sample) => (((sample * 37 + 11) % 257) - 128) / 32
      ),
    ]
    let frame = null
    for (let delayed = 0; delayed < 8; delayed++) frame = encodeCodec(codec)

    const normalized = decode(OPTIONS, new BufferPool())(frame)
    const internal = createPcmFrameDecoder(OPTIONS, new BufferPool())(frame)
    for (let sample = 0; sample < FRAME_SAMPLES; sample++) {
      expect(normalized[0][sample]).toBe(
        Math.fround(internal.outputChannels[0][sample] / PCM_SCALE)
      )
    }
  })
})
