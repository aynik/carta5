import { describe, expect, it } from 'vitest'
import { createWave, parseWave } from '../codec/io/wave.js'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'
import { decodeWavePcm } from '../codec/io/wave-decoder.js'
import { PCM_SCALE } from '../codec/io/pcm.js'
import { WAVE_HEADER_BYTES } from '../codec/core/constants.js'

describe('ATRACX RIFF/WAVE_FORMAT_EXTENSIBLE container', () => {
  it('writes the canonical reference extensible header layout', () => {
    const frames = [new Uint8Array(744), new Uint8Array(744).fill(0x5a)]
    const wave = createWave(frames, {
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
      sampleCount: 3000,
    })
    const view = new DataView(wave.buffer)
    expect(wave).toHaveLength(WAVE_HEADER_BYTES + 1488)
    expect(new TextDecoder().decode(wave.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(16, true)).toBe(52)
    expect(view.getUint16(20, true)).toBe(0xfffe)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(32, true)).toBe(744)
    expect(view.getUint16(36, true)).toBe(34)
    expect(view.getUint16(38, true)).toBe(2048)
    expect(view.getUint32(40, true)).toBe(4)
    expect([...wave.slice(44, 60)]).toEqual([
      0xbf, 0xaa, 0x23, 0xe9, 0x58, 0xcb, 0x71, 0x44, 0xa1, 0x19, 0xff, 0xfa,
      0x01, 0xe4, 0xce, 0x62,
    ])
    expect(view.getUint16(60, true)).toBe(1)
    expect([...wave.slice(62, 64)]).toEqual([0x24, 0x5c])
    expect(view.getUint32(76, true)).toBe(12)
    expect(view.getUint32(80, true)).toBe(3000)
    expect(view.getUint32(84, true)).toBe(2048)
    expect(view.getUint32(88, true)).toBe(2232)
    expect(view.getUint32(96, true)).toBe(1488)
    expect(Buffer.from(wave.subarray(0, 100)).toString('hex')).toBe(
      '524946462c06000057415645666d742034000000feff010044ac0000953e0000e80200002200000804000000bfaa23e958cb7144a119fffa01e4ce620100245c0000000000000000666163740c000000b80b000000080000b808000064617461d0050000'
    )
  })

  it('round-trips profile, fact alignment, and frame boundaries', () => {
    const frames = [new Uint8Array(744).fill(3), new Uint8Array(744).fill(7)]
    const parsed = parseWave(
      createWave(frames, {
        bitrateKbps: 128,
        channels: 1,
        sampleRate: 44100,
        sampleCount: 2048,
      })
    )
    expect(parsed.profile).toMatchObject({
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
      bytesPerFrame: 744,
    })
    expect(parsed.fact).toEqual({
      sampleCount: 2048,
      reservedSampleCount: 2048,
      alignmentSampleCount: 2232,
    })
    expect(parsed.frameCount).toBe(2)
    expect([...parsed.frames()].map((frame) => frame[0])).toEqual([3, 7])
    const iterator = parsed.frames()
    expect(iterator[Symbol.iterator]()).toBe(iterator)
    expect(iterator.next().value[0]).toBe(3)
    expect(iterator.next().value[0]).toBe(7)
    expect(iterator.next().done).toBe(true)
  })

  it('rejects the wrong subtype and frame alignment', () => {
    expect(() =>
      createWave([new Uint8Array(384)], {
        bitrateKbps: 128,
        channels: 1,
        sampleRate: 44100,
      })
    ).toThrow(/alignment/)
    const malformed = createWave([new Uint8Array(744)], {
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    malformed[44] ^= 1
    expect(() => parseWave(malformed)).toThrow(/format chunk/)
  })

  it('preserves the arbitrary-chunk runtime and exact visible timeline', () => {
    const source = Float32Array.from(
      { length: 3000 },
      (_, sample) => (((sample * 31 + 17) % 251) - 125) / 16 / PCM_SCALE
    )
    const wave = encodeWavePcm([source], {
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    const parsed = parseWave(wave)
    expect(parsed.fact).toEqual({
      sampleCount: 3000,
      reservedSampleCount: 2048,
      alignmentSampleCount: 2232,
    })
    expect(parsed.frameCount).toBe(3)
    const decoded = decodeWavePcm(wave)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toHaveLength(3000)
    expect(decoded[0].every(Number.isFinite)).toBe(true)
  })
})
