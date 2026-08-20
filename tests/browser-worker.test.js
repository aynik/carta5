import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decodeWavePcm } from '../codec/io/wave-decoder.js'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'
import { createPcmWave } from '../codec/io/serialization.js'
import { PCM_SCALE } from '../codec/io/pcm.js'

describe('ATRAC3plus browser worker boundaries', () => {
  const messages = []
  const originalSelf = globalThis.self

  beforeAll(async () => {
    globalThis.self = {
      postMessage(message) {
        messages.push(message)
      },
    }
    await import('../codec/browser/worker.js')
  })

  afterAll(() => {
    globalThis.self = originalSelf
  })

  async function dispatch(data) {
    messages.length = 0
    await globalThis.self.onmessage({ data })
    expect(messages).toHaveLength(1)
    expect(messages[0].error).toBeUndefined()
    return messages[0].result
  }

  it('matches complete helpers while assembling encoded and decoded blobs in parts', async () => {
    const options = {
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
    }
    const channels = Array.from({ length: 2 }, (_, channel) =>
      Float32Array.from({ length: 3000 }, (_, sample) =>
        Math.fround(
          (10000 *
            Math.sin((2 * Math.PI * (440 + channel * 220) * sample) / 44100)) /
            PCM_SCALE
        )
      )
    )
    const expectedWave = encodeWavePcm(channels, options)
    const encoded = await dispatch({
      jobId: 1,
      type: 'encode',
      pcmData: channels,
      options,
    })
    expect(new Uint8Array(await encoded.waveBlob.arrayBuffer())).toEqual(
      expectedWave
    )
    expect(encoded.info).toMatchObject({ frameCount: 3, sampleCount: 3000 })

    const expectedPcmWave = createPcmWave(decodeWavePcm(expectedWave), options)
    const decoded = await dispatch({
      jobId: 2,
      type: 'decode',
      wave: expectedWave,
    })
    expect(new Uint8Array(await decoded.wavBlob.arrayBuffer())).toEqual(
      expectedPcmWave
    )
  })
})
