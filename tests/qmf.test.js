import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { resolveProfile } from '../codec/core/profiles.js'
import {
  historyStage,
  qmfStage,
  transactionStage,
  validateFrameStage,
} from '../codec/pipeline/encoder.js'
import { EncodeAnalysisState } from '../codec/state/encoder.js'
import { SynthesisState } from '../codec/state/decoder.js'
import {
  analyzeQmfChannel,
  analyzeQmfFrame,
  synthesizeQmfChannel,
} from '../codec/transforms/qmf.js'

const rawBits = new DataView(new ArrayBuffer(4))
const U64_MASK = 0xffffffffffffffffn

function float32Bits(value) {
  rawBits.setFloat32(0, value, true)
  return rawBits.getUint32(0, true)
}

function rawSummary(values) {
  let sum = 0n
  let xor = 0n
  let hash = 0xcbf29ce484222325n
  for (const value of values) {
    const bits = float32Bits(value)
    sum = (sum + BigInt(bits)) & U64_MASK
    xor ^= BigInt(bits)
    for (const byte of [
      bits & 0xff,
      (bits >>> 8) & 0xff,
      (bits >>> 16) & 0xff,
      bits >>> 24,
    ]) {
      hash ^= BigInt(byte)
      hash = (hash * 0x100000001b3n) & U64_MASK
    }
  }
  return { sum, xor, hash }
}

function newestSlotSummary(state) {
  let sum = 0n
  let xor = 0n
  let hash = 0xcbf29ce484222325n
  for (let band = 0; band < 16; band++) {
    for (const sample of state.bandSlots[band][8]) {
      const bits = float32Bits(sample)
      sum = (sum + BigInt(bits)) & U64_MASK
      xor ^= BigInt(bits)
      for (const byte of [
        bits & 0xff,
        (bits >>> 8) & 0xff,
        (bits >>> 16) & 0xff,
        bits >>> 24,
      ]) {
        hash ^= BigInt(byte)
        hash = (hash * 0x100000001b3n) & U64_MASK
      }
    }
  }
  return { sum, xor, hash }
}

function firstReferencePcm() {
  return Float32Array.from(
    { length: 2048 },
    (_, index) => (((index * 37) % 257) - 128) / 64
  )
}

describe('ATRAC3plus 16-band QMF analysis', () => {
  it('matches reference 16-band QMF synthesis and staged delay history', () => {
    const subbands = new Float32Array(2048)
    for (let band = 0; band < 16; band++) {
      for (let sample = 0; sample < 128; sample++) {
        subbands[band * 128 + sample] =
          (((band * 131 + sample * 37 + 11) % 509) - 254) / 32
      }
    }
    const state = new SynthesisState()
    state.delayRingIndex = 7
    for (let row = 0; row < 24; row++) {
      for (let sample = 0; sample < 8; sample++) {
        state.firstPhaseDelay[row * 8 + sample] =
          (((row * 17 + sample * 7 + 3) % 113) - 56) / 64
        state.secondPhaseDelay[row * 8 + sample] =
          (((row * 19 + sample * 11 + 5) % 127) - 63) / 32
      }
    }
    const output = new Float32Array(2048)
    expect(synthesizeQmfChannel(subbands, state, output)).toBe(output)
    expect(rawSummary(output)).toEqual({
      sum: 4380829605050n,
      xor: 2258100032n,
      hash: 8454069191439297757n,
    })
    expect(rawSummary(state.firstPhaseDelay)).toEqual({
      sum: 433330122270n,
      xor: 4240207770n,
      hash: 12351766520106812622n,
    })
    expect(rawSummary(state.secondPhaseDelay)).toEqual({
      sum: 438218144447n,
      xor: 2223500099n,
      hash: 10397829147764515496n,
    })
    expect(state.delayRingIndex).toBe(23)
    expect(
      [0, 1, 15, 16, 511, 1023, 2046, 2047].map((index) =>
        float32Bits(output[index])
      )
    ).toEqual([
      1023643838, 1021911120, 3173188552, 3168463442, 1117216298, 3257379126,
      3233903851, 1118613979,
    ])
  })

  it('matches the first complete reference raw-bit vector', () => {
    const state = new EncodeAnalysisState()
    for (let index = 0; index < state.tail.length; index++) {
      state.tail[index] = (((index * 13) % 97) - 48) / 32
    }
    const pcm = firstReferencePcm()
    const scratch = new BufferPool().encoder.scratch.qmf
    state.shiftBandSlots()
    analyzeQmfChannel(state, pcm, scratch)

    expect(newestSlotSummary(state)).toEqual({
      sum: 4321202821368n,
      xor: 2298417366n,
      hash: 8288924493446930380n,
    })
    expect(
      state.bandSlots.map((slots) => [
        float32Bits(slots[8][0]),
        float32Bits(slots[8][1]),
        float32Bits(slots[8][126]),
        float32Bits(slots[8][127]),
      ])
    ).toEqual([
      [0x3ca0b5d2, 0xbb84b248, 0x3c4e0775, 0xbd9e8fc5],
      [0xbd3f07ee, 0xbd8aa047, 0xbc7a176e, 0x3bdfcef0],
      [0xbe225cb1, 0xbe059aed, 0xbc0ccd5f, 0x3b61ab96],
      [0xbd1821b4, 0xbcaebf75, 0x3d127640, 0x3bde6afd],
      [0xbe7aac31, 0x3f025d40, 0xbe0c4f60, 0x3fa37f1e],
      [0x3c807771, 0x3d04c757, 0xbce34737, 0x3c292954],
      [0xbe2dd739, 0xbe45a1ae, 0xbc153ca5, 0x3b30b88d],
      [0x3ccbfa05, 0xbb0e9ede, 0x3cd6d9aa, 0x3b933046],
      [0xbefa0ad7, 0x3e503181, 0xbdf340d7, 0x3d895676],
      [0xbc7f45d0, 0xbcb2a922, 0x3eb2e248, 0xbf175b48],
      [0x3da902f8, 0xbe762b90, 0xbbafc7a0, 0x3baaaada],
      [0xbcdf6ef2, 0x3c901952, 0x3ca786b9, 0x3a864150],
      [0xbe69800a, 0x3cd5b668, 0xbcdb3b99, 0xb7ee1bb5],
      [0xbb85dc3d, 0x3d2068e2, 0xbe6445c1, 0xbf15ba29],
      [0x3e536ad3, 0xbe54ecef, 0x3c033410, 0x3beb8f92],
      [0x3c26bd14, 0xbcb84377, 0x3cbbdda5, 0xba37f965],
    ])
    expect(state.tail).toEqual(pcm.slice(-384))
  })

  it('matches reference after a second frame advances tail and ring state', () => {
    const state = new EncodeAnalysisState()
    for (let index = 0; index < state.tail.length; index++) {
      state.tail[index] = (((index * 13) % 97) - 48) / 32
    }
    const scratch = new BufferPool().encoder.scratch.qmf
    state.shiftBandSlots()
    analyzeQmfChannel(state, firstReferencePcm(), scratch)
    const second = Float32Array.from(
      { length: 2048 },
      (_, index) => (((index * 19 + 11) % 193) - 96) / 16
    )
    state.shiftBandSlots()
    analyzeQmfChannel(state, second, scratch)

    expect(newestSlotSummary(state)).toEqual({
      sum: 4326216600626n,
      xor: 2357666508n,
      hash: 15985924581946908244n,
    })
    expect(state.bandSlots[0][7]).not.toEqual(state.bandSlots[0][8])
    expect(state.tail).toEqual(second.slice(-384))
  })

  it('reuses one pool-owned scratch across every active channel', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.qmf
    const windowIdentity = scratch.window
    const pcm = [firstReferencePcm(), firstReferencePcm()]
    analyzeQmfFrame(pcm, pool.encoder.frame.analysisChannels, 2, scratch)
    expect(scratch.window).toBe(windowIdentity)
    expect(pool.encoder.frame.analysisChannels[0].samples).toEqual(
      pool.encoder.frame.analysisChannels[1].samples
    )
    expect(
      pool.encoder.state.analysisChannels[0].samples.every((x) => x === 0)
    ).toBe(true)
  })

  it('rejects incomplete frame and scratch geometry before mutation', () => {
    const state = new EncodeAnalysisState()
    expect(() =>
      analyzeQmfChannel(
        state,
        new Float32Array(2047),
        new BufferPool().encoder.scratch.qmf
      )
    ).toThrow(RangeError)
    expect(() => analyzeQmfChannel(state, new Float32Array(2048), {})).toThrow(
      RangeError
    )
    expect(state.samples.every((sample) => sample === 0)).toBe(true)
  })

  it('occupies explicit validation, transaction, and QMF pipeline phases', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
    })
    const context = { profile, bufferPool }
    const source = [firstReferencePcm(), firstReferencePcm()]
    bufferPool.encoder.state.analysisChannels[0].tail[0] = 1.5

    const frame = qmfStage(context)(
      historyStage()(
        transactionStage(context)(
          validateFrameStage(context)({
            channels: source,
            sampleCount: 1000,
          })
        )
      )
    )

    expect(frame.channels[0]).toBe(bufferPool.encoder.frame.pcmChannels[0])
    expect(frame.channels[0][999]).toBe(source[0][999])
    expect(frame.channels[0][1000]).toBe(0)
    expect(source[0][1000]).not.toBe(0)
    expect(frame.qmfBands).toHaveLength(2)
    expect(frame.qmfBands[0]).toHaveLength(16)
    expect(frame.qmfBands[0][0]).toBe(
      bufferPool.encoder.frame.analysisChannels[0].bandSlots[0][8]
    )
    expect(bufferPool.encoder.frame.analysisChannels[0].tail[0]).not.toBe(1.5)
    expect(bufferPool.encoder.state.analysisChannels[0].tail[0]).toBe(1.5)
  })
})
