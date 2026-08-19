import { describe, expect, it } from 'vitest'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'
import { WaveReader } from '../codec/io/readers.js'

function fixture() {
  const channels = [new Float32Array(1500), new Float32Array(1500)]
  channels[0][100] = 12000
  channels[1][200] = -9000
  return encodeWavePcm(channels, {
    bitrateKbps: 128,
    channels: 2,
    sampleRate: 44100,
  })
}

describe('WaveReader', () => {
  it('publishes validated metadata and complete frames', () => {
    const reader = new WaveReader(fixture())
    expect(reader.metadata).toMatchObject({
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
      sampleCount: 1500,
    })
    expect([...reader]).toHaveLength(reader.metadata.frameCount)
    expect([...reader][0]).toHaveLength(744)
  })

  it('supports async frame iteration', async () => {
    const reader = new WaveReader(fixture())
    const frames = []
    for await (const frame of reader) frames.push(frame)
    expect(frames).toHaveLength(reader.metadata.frameCount)
  })

  it('rejects a truncated container instead of yielding a partial frame', () => {
    const wave = fixture()
    expect(() => new WaveReader(wave.subarray(0, wave.length - 1))).toThrow(
      /Truncated/
    )
  })
})
