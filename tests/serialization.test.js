import { describe, expect, it } from 'vitest'
import {
  floatToPcm16,
  createPcmWave,
  createPcmWaveHeader,
  interleavePcm16,
} from '../codec/io/serialization.js'
import { PCM_SCALE } from '../codec/io/pcm.js'

describe('ATRAC3plus PCM serialization', () => {
  it('matches the codec float-to-PCM saturation and rounding contract', () => {
    expect(floatToPcm16(2)).toBe(32767)
    expect(floatToPcm16(-2)).toBe(-32767)
    expect(floatToPcm16(Number.NaN)).toBe(-32767)
    expect(floatToPcm16(0.49 / PCM_SCALE)).toBe(0)
    expect(floatToPcm16(0.51 / PCM_SCALE)).toBe(1)
    expect(floatToPcm16(-0.51 / PCM_SCALE)).toBe(-1)
  })

  it('writes a canonical stereo signed-16-bit WAVE header', () => {
    const header = createPcmWaveHeader({ sampleCount: 123 })
    const view = new DataView(header.buffer)
    expect(new TextDecoder().decode(header.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(header.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint32(40, true)).toBe(123 * 4)
  })

  it('interleaves normalized planar samples', () => {
    const channels = [
      new Float32Array([1 / PCM_SCALE, -2 / PCM_SCALE]),
      new Float32Array([3 / PCM_SCALE, -4 / PCM_SCALE]),
    ]
    const pcm = interleavePcm16(channels)
    const view = new DataView(pcm.buffer)
    expect([0, 1, 2, 3].map((index) => view.getInt16(index * 2, true))).toEqual(
      [1, 3, -2, -4]
    )
    expect(createPcmWave(channels)).toHaveLength(44 + 8)
  })
})
