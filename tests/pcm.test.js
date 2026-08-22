import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { FRAME_SAMPLES } from '../codec/core/constants.js'
import { resolveProfile } from '../codec/core/profiles.js'
import { FrameDecodeScratch } from '../codec/io/frame-decoder.js'
import { dequantize } from '../codec/dequantization/stage.js'
import { unpack } from '../codec/unpacking.js'
import {
  beginTransaction,
  decode,
  synthesize,
  validateFrame,
} from '../codec/pipeline/decoder.js'
import { encode } from '../codec/pipeline/encoder.js'
import {
  createPcmScaler,
  normalizePcm,
  PCM_SCALE,
  scalePcmFrame,
} from '../codec/io/pcm.js'
import { initializeDecoderStream } from '../codec/state/decoder.js'
import { pipe } from '../codec/utils.js'

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

  it('adapts normalized frame products at the public boundary', () => {
    const scale = createPcmScaler(1)
    const channels = [new Float32Array(FRAME_SAMPLES).fill(0.5)]
    const frame = scale({ channels, sampleCount: 1000 })

    expect(frame.sampleCount).toBe(1000)
    expect(frame.channels[0][0]).toBe(16384)
    expect(frame.channels[0]).not.toBe(channels[0])
    expect(() => scale([])).toThrow('PCM frame geometry is invalid')
  })

  it('normalizes detached decoder output without changing codec reconstruction', () => {
    const encodeFrame = encode(OPTIONS, new BufferPool())
    const normalizedInput = [
      Float32Array.from(
        { length: FRAME_SAMPLES },
        (_, sample) => (((sample * 37 + 11) % 257) - 128) / 32 / PCM_SCALE
      ),
    ]
    let frame = null
    for (let delayed = 0; delayed < 8; delayed++) {
      frame = encodeFrame(normalizedInput)
    }

    const decoderPool = new BufferPool()
    const normalized = decode(OPTIONS, decoderPool)(frame)
    const internal = decoderPool.decoder.frame.outputChannels
    for (let sample = 0; sample < FRAME_SAMPLES; sample++) {
      expect(normalized[0][sample]).toBe(
        Math.fround(internal[0][sample] / PCM_SCALE)
      )
    }
  })

  it('matches the manual semantic recipe without publishing state', () => {
    const encodeFrame = encode(OPTIONS, new BufferPool())
    const normalizedInput = [
      Float32Array.from(
        { length: FRAME_SAMPLES },
        (_, sample) => (((sample * 37 + 11) % 257) - 128) / 32 / PCM_SCALE
      ),
    ]
    let encoded = null
    for (let delayed = 0; delayed < 8; delayed++) {
      encoded = encodeFrame(normalizedInput)
    }

    const expectedPool = new BufferPool()
    const actualPool = new BufferPool()
    for (const pool of [expectedPool, actualPool]) {
      pool.decoder.state.channelBlocks[0].syntax.wordLengths[0] = 7
      pool.decoder.state.synthesisCodingUnits[0][0].inverseTransformOverlap[0] = 19
      pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex = 7
    }
    const expected = decode(OPTIONS, expectedPool)(encoded)

    const profile = resolveProfile(OPTIONS)
    initializeDecoderStream(profile, actualPool.decoder)
    const context = {
      profile,
      bufferPool: actualPool,
      frameDecode: new FrameDecodeScratch(actualPool.decoder.scratch.syntax),
    }
    const decodeFrame = pipe(
      context,
      validateFrame,
      beginTransaction,
      unpack,
      dequantize,
      synthesize
    )
    const actual = decodeFrame(encoded)

    expect(actual.spectra).toEqual(expectedPool.decoder.frame.spectra)
    expect(actual.subbandSamples).toEqual(
      expectedPool.decoder.frame.subbandSamples
    )
    expect(
      normalizePcm(
        actual.outputChannels
          .slice(0, OPTIONS.channels)
          .map((channel) => channel.slice())
      )
    ).toEqual(expected)
    expect(
      actualPool.decoder.state.channelBlocks[0].syntax.wordLengths[0]
    ).toBe(7)
    expect(
      actualPool.decoder.state.synthesisCodingUnits[0][0]
        .inverseTransformOverlap[0]
    ).toBe(19)
    expect(
      actualPool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex
    ).toBe(7)
    expect(
      actualPool.decoder.frame.synthesisCodingUnits[0][0].delayRingIndex
    ).toBe(23)
  })
})
