import { describe, expect, it } from 'vitest'
import { GainRecord } from '../codec/coding/gain.js'
import { BufferPool } from '../codec/core/buffers.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import {
  applyInverseGainScale,
  applyForwardGainScale,
  reconstructForwardGainScale,
  reconstructInverseGainScale,
} from '../codec/transforms/gain-scale.js'
import {
  mdctWindow,
  forwardMdct128,
  inverseMdctFrame,
  writeMdctOutputs,
} from '../codec/transforms/mdct.js'

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

function referenceTimeSamples() {
  return Float32Array.from(
    { length: 256 },
    (_, index) => (((index * 37 + 11) % 257) - 128) / 32
  )
}

function gainRecords() {
  const previous = new GainRecord()
  previous.entries = 2
  previous.locations.set([3, 18])
  previous.levels.set([8, 4])
  const current = new GainRecord()
  current.entries = 3
  current.locations.set([2, 11, 27])
  current.levels.set([6, 12, 7])
  return { previous, current }
}

describe('ATRAC3plus gain scale and forward MDCT', () => {
  it('matches all four reference MDCT window/reversal vectors exactly', () => {
    const expected = [
      [
        'steady',
        0,
        0,
        false,
        271361903644n,
        4286576048n,
        9678597894772939240n,
        [
          3148023492, 3199916138, 3177066352, 3178220041, 1031647221,
          3173827562,
        ],
      ],
      [
        'current',
        0,
        1,
        false,
        273518069658n,
        2028295348n,
        11218092283251942800n,
        [
          3170837401, 3199590019, 3169713857, 3170976589, 1026780622,
          3175810364,
        ],
      ],
      [
        'previous',
        1,
        0,
        true,
        269394545403n,
        2100898009n,
        312878477829798110n,
        [
          3175880436, 1032241663, 3178709583, 3177317681, 3199877310,
          3144528840,
        ],
      ],
      [
        'both',
        1,
        1,
        true,
        273746222840n,
        2091898310n,
        2762102405346231223n,
        [
          3177863225, 1027817951, 3171466137, 3170216500, 3199551187,
          3170113643,
        ],
      ],
    ]
    const input = referenceTimeSamples()
    const output = new Float32Array(128)
    const scratch = new BufferPool().encoder.scratch.mdct
    for (const [
      name,
      previous,
      current,
      reverse,
      sum,
      xor,
      hash,
      endpoints,
    ] of expected) {
      output.fill(0)
      forwardMdct128(
        input,
        output,
        mdctWindow(previous, current),
        reverse,
        scratch
      )
      expect(rawSummary(output), name).toEqual({ sum, xor, hash })
      expect(
        [0, 1, 63, 64, 126, 127].map((index) => float32Bits(output[index])),
        name
      ).toEqual(endpoints)
    }
  })

  it('matches the reference ATRAC3plus table-interpolated gain envelope exactly', () => {
    const { previous, current } = gainRecords()
    const scratch = new BufferPool().encoder.scratch.mdct.gainScale
    const firstChange = reconstructForwardGainScale(
      previous,
      current,
      scratch.scale,
      scratch.steps
    )
    expect(firstChange).toBe(239)
    expect(rawSummary(scratch.scale)).toEqual({
      sum: 274309384192n,
      xor: 33554432n,
      hash: 8283951230584497267n,
    })
    expect(
      [0, 3, 4, 63, 64, 127, 128, 191, 252, 255].map((index) =>
        float32Bits(scratch.scale[index])
      )
    ).toEqual([
      1082130432, 1082130432, 1082130432, 1048576000, 1048576000, 1065353216,
      1065353216, 1073741824, 1065353216, 1065353216,
    ])

    const samples = new Float32Array(256).fill(1)
    expect(applyForwardGainScale(previous, current, samples, scratch)).toBe(239)
    expect(samples[0]).toBe(4)
    expect(samples[240]).toBe(1)
  })

  it('matches reference inverse gain scaling and subband overlap exactly', () => {
    const previousRecords = Array.from({ length: 16 }, () => new GainRecord())
    const currentRecords = Array.from({ length: 16 }, () => new GainRecord())
    const previous = previousRecords[3]
    previous.entries = 2
    previous.locations.set([3, 12])
    previous.levels.set([4, 8])
    const current = currentRecords[3]
    current.entries = 2
    current.locations.set([5, 20])
    current.levels.set([10, 6])

    const gainScratch = new BufferPool().encoder.scratch.mdct.gainScale
    expect(
      reconstructInverseGainScale(
        previous,
        current,
        gainScratch.scale,
        gainScratch.steps
      )
    ).toBe(151)
    const ones = new Float32Array(256).fill(1)
    expect(applyInverseGainScale(previous, current, ones, gainScratch)).toBe(
      151
    )
    expect(ones.slice(0, 152)).toEqual(gainScratch.scale.slice(0, 152))
    expect(ones.slice(152).every((value) => value === 1)).toBe(true)

    const spectrum = new Float32Array(2048)
    const offset = 3 * 128
    for (let index = 0; index < 128; index++) {
      spectrum[offset + index] = (((index * 37 + 11) % 257) - 128) / 32
    }
    const overlap = new Float32Array(2048)
    for (let index = 0; index < 128; index++) {
      overlap[offset + index] = (((index * 13 + 7) % 101) - 50) / 64
    }
    const destination = new Float32Array(2048)
    const previousFlags = new Uint8Array(16)
    const currentFlags = new Uint8Array(16)
    previousFlags[3] = 1

    expect(
      inverseMdctFrame(
        spectrum,
        destination,
        previousRecords,
        currentRecords,
        previousFlags,
        currentFlags,
        4,
        overlap,
        new BufferPool().encoder.scratch.mdct
      )
    ).toBe(destination)
    const outputBand = destination.subarray(offset, offset + 128)
    const overlapBand = overlap.subarray(offset, offset + 128)
    expect(rawSummary(outputBand)).toEqual({
      sum: 278537905837n,
      xor: 2265050643n,
      hash: 16324213640587905876n,
    })
    expect(rawSummary(overlapBand)).toEqual({
      sum: 269913060329n,
      xor: 2142935073n,
      hash: 17199091462055282019n,
    })
    expect(
      [0, 1, 31, 63, 64, 95, 126, 127].map((index) =>
        float32Bits(outputBand[index])
      )
    ).toEqual([
      3207331840, 3203399680, 3207593984, 3201428925, 3200726873, 3191336779,
      3205877248, 3206948591,
    ])
    expect(
      [0, 1, 31, 63, 64, 95, 126, 127].map((index) =>
        float32Bits(overlapBand[index])
      )
    ).toEqual([
      3204558434, 3192765991, 1102015503, 1082586077, 1082478202, 1083649506,
      3178391953, 3175855245,
    ])
  })

  it('writes dual spectra from delayed channel state using pool scratch', () => {
    const pool = new BufferPool()
    const channel = new EncodeChannelState()
    const input = referenceTimeSamples()
    channel.analysis.bandSlots[0][0].set(input.subarray(0, 128))
    channel.analysis.bandSlots[0][1].set(input.subarray(128))
    channel.analysis.bandSlots[1][0].set(input.subarray(0, 128))
    channel.analysis.bandSlots[1][1].set(input.subarray(128))
    const scaled = pool.encoder.frame.gainScaledSpectra[0]
    const unscaled = pool.encoder.frame.gainUnscaledSpectra[0]
    const fftIdentity = pool.encoder.scratch.mdct.fftWork

    expect(
      writeMdctOutputs(
        channel.analysis,
        2,
        channel.previousGainRecords,
        channel.currentGainRecords,
        scaled,
        unscaled,
        pool.encoder.scratch.mdct
      )
    ).toBe(scaled)
    expect(scaled.slice(0, 256)).toEqual(unscaled.slice(0, 256))

    const { previous, current } = gainRecords()
    previous.copyTo(channel.previousGainRecords[0])
    current.copyTo(channel.currentGainRecords[0])
    writeMdctOutputs(
      channel.analysis,
      2,
      channel.previousGainRecords,
      channel.currentGainRecords,
      scaled,
      unscaled,
      pool.encoder.scratch.mdct
    )
    expect(scaled.slice(0, 128)).not.toEqual(unscaled.slice(0, 128))
    expect(scaled.slice(128, 256)).toEqual(unscaled.slice(128, 256))
    expect(pool.encoder.scratch.mdct.fftWork).toBe(fftIdentity)
  })

  it('rejects incomplete transform geometry before writing output', () => {
    const output = new Float32Array(128)
    expect(() =>
      forwardMdct128(
        new Float32Array(255),
        output,
        mdctWindow(0, 0),
        false,
        new BufferPool().encoder.scratch.mdct
      )
    ).toThrow(RangeError)
    expect(output.every((value) => value === 0)).toBe(true)
  })
})
