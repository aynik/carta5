import { describe, expect, it } from 'vitest'
import { AudioProcessor } from '../codec/io/processor.js'
import { PCM_SCALE } from '../codec/io/pcm.js'

function signal(sampleCount = 1500) {
  const channels = [
    new Float32Array(sampleCount),
    new Float32Array(sampleCount),
  ]
  for (let sample = 0; sample < sampleCount; sample++) {
    channels[0][sample] =
      Math.round(12000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)) /
      PCM_SCALE
    channels[1][sample] =
      Math.round(9000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)) /
      PCM_SCALE
  }
  return channels
}

async function* chunks(channels) {
  for (let offset = 0; offset < channels[0].length; offset += 317) {
    yield channels.map((channel) => channel.subarray(offset, offset + 317))
  }
}

describe('AudioProcessor ATRAC3plus boundaries', () => {
  it('streams arbitrary PCM chunks through the WAVE encoder timeline', async () => {
    const frames = []
    for await (const frame of AudioProcessor.encodeStream(chunks(signal()), {
      bitrateKbps: 128,
    })) {
      frames.push(frame)
    }
    expect(frames).toHaveLength(2)
    expect(frames.every((frame) => frame.length === 744)).toBe(true)
  })

  it('round-trips an ATRACX WAVE Blob and decodes its exact sample count', async () => {
    const channels = signal()
    const wave = AudioProcessor.encodeWavePcm(channels, {
      bitrateKbps: 128,
    })
    const parsed = await AudioProcessor.parseWaveBlob(
      new Blob([wave], { type: 'audio/wav' })
    )
    expect(parsed.fact.sampleCount).toBe(channels[0].length)
    const frames = [...parsed.frames]
    expect(frames).toHaveLength(2)
    const rebuilt = await AudioProcessor.createWaveBlob(frames, {
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
      sampleCount: channels[0].length,
    })
    expect(new Uint8Array(await rebuilt.arrayBuffer())).toEqual(wave)
    const decoded = AudioProcessor.decodeWavePcm(parsed.bytes)
    expect(decoded[0]).toHaveLength(channels[0].length)
    expect(AudioProcessor.createPcmWaveBlob(decoded).type).toBe('audio/wav')
  })

  it('folds any planar topology into equally shaped zero-padded frames', () => {
    const channels = Array.from({ length: 6 }, (_, channel) =>
      Float32Array.from(
        { length: 2049 },
        (_, sample) => channel * 10000 + sample
      )
    )
    const frames = [...AudioProcessor.frameBufferToFrames(channels)]
    expect(frames).toHaveLength(2)
    expect(frames[0]).toHaveLength(6)
    expect(frames[0][0]).toHaveLength(2048)
    expect(frames[1][5][0]).toBe(channels[5][2048])
    expect(frames[1][0][1]).toBe(0)
  })

  it('rejects mismatched planar buffers and invalid frame sizes', () => {
    expect(() => [
      ...AudioProcessor.frameBufferToFrames([
        new Float32Array(2),
        new Float32Array(1),
      ]),
    ]).toThrow(/equally sized/)
    expect(() => [
      ...AudioProcessor.frameBufferToFrames([new Float32Array(2)], 0),
    ]).toThrow(/positive integer/)
    expect(() => [
      ...AudioProcessor.frameBufferToFrames(
        Array.from({ length: 3 }, () => new Float32Array(2))
      ),
    ]).toThrow(/maintained topology/)
  })
})
