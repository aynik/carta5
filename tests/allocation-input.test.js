import { describe, expect, it } from 'vitest'

import {
  alignedAbsoluteSum,
  scaleFactorIndexForPeak,
  measureCodingUnitAllocationSource,
} from '../codec/analysis/allocation-input.js'

import { EncodeChannelState } from '../codec/state/encoder.js'
import { CodingUnitAllocationTransaction } from '../codec/state/allocation.js'

function fnv32Words(words) {
  let hash = 0xcbf29ce484222325n
  for (const value of words) {
    let word = BigInt(value >>> 0)
    for (let byte = 0; byte < 4; byte++) {
      hash ^= word & 0xffn
      hash = BigInt.asUintN(64, hash * 0x100000001b3n)
      word >>= 8n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function floatBits(value) {
  const values = new Float32Array([value])
  return new Uint32Array(values.buffer)[0]
}

function createMeasurementFixture() {
  const scaled = [new Float32Array(2048), new Float32Array(2048)]
  const unscaled = [new Float32Array(2048), new Float32Array(2048)]
  const channels = [new EncodeChannelState(0), new EncodeChannelState(1)]
  for (let channel = 0; channel < 2; channel++) {
    for (let index = 0; index < 2048; index++) {
      const wave = ((index * 37 + channel * 19 + 11) % 127) - 63
      const other = ((index * 23 + channel * 31 + 7) % 101) - 50
      scaled[channel][index] = Math.fround(wave * 0.03125)
      unscaled[channel][index] = Math.fround(other * 0.046875)
    }
    for (let band = 0; band < 32; band++) {
      channels[channel].previousScaleHistory.scales[band] = Math.fround(
        ((band * 5 + channel * 3) % 17) * 0.125
      )
      channels[channel].previousScaleHistory.scaleFactors[band] =
        (band * 7 + channel * 5) % 29
    }
  }
  return { scaled, unscaled, channels }
}

function bindMeasurement(transaction, channels, scaled, unscaled, coreMode) {
  transaction.reset(channels.length)
  transaction.coreMode = coreMode
  for (let channel = 0; channel < channels.length; channel++) {
    transaction.bindChannel(
      channel,
      channels[channel],
      scaled[channel],
      unscaled[channel]
    )
  }
  return transaction.completeBinding()
}

describe('ATRAC3plus allocation input measurement', () => {
  it('matches complete reference source, history, and joint-scale measurements', () => {
    const { scaled, unscaled, channels } = createMeasurementFixture()
    const transaction = new CodingUnitAllocationTransaction()
    bindMeasurement(transaction, channels, scaled, unscaled, 15)
    const sourceIdentity = transaction.sourceChannels
    const thresholdIdentity =
      transaction.sourceChannels[0].quantizationThresholdScales
    const maximumQuantizationUnits = measureCodingUnitAllocationSource(
      transaction,
      27,
      3
    )
    const sourceChannels = transaction.sourceChannels
    const sourceWords = []
    for (let channel = 0; channel < 2; channel++) {
      const measured = sourceChannels[channel]
      sourceWords.push(
        measured.bitAllocationMode,
        ...channels[channel].syntax.scaleFactors,
        ...Array.from(measured.quantizationThresholdScales, floatBits),
        ...Array.from(measured.bandLevels, floatBits)
      )
    }
    expect(transaction.sourceChannels).toBe(sourceIdentity)
    expect(sourceChannels[0].quantizationThresholdScales).toBe(
      thresholdIdentity
    )
    expect(fnv32Words(sourceWords)).toBe('5ef7d1b6c366956d')
    expect(fnv32Words(transaction.quantizationUnits)).toBe('f5c277d95412b9f2')
    expect(fnv32Words(transaction.initialWordLengths.slice(0, 32))).toBe(
      '22ec9eccdf958025'
    )
    expect(maximumQuantizationUnits).toBe(24)
    expect(sourceChannels.map((channel) => channel.bitAllocationMode)).toEqual([
      1, 1,
    ])
    expect(Array.from(transaction.initialWordLengths.slice(0, 32))).toEqual(
      Array(32).fill(21)
    )
    for (let channel = 0; channel < 2; channel++) {
      expect(
        Array.from(channels[channel].syntax.scaleFactors.slice(0, 27))
      ).toEqual(Array(27).fill(18))
      expect(channels[channel].currentScaleHistory.scales[0]).toBe(
        transaction.baseAllocationScores[channel * 32]
      )
    }
  })

  it('pins aligned float32 accumulation and capped upper-bound behavior', () => {
    const values = new Float32Array([1, -2, 3.5, -4.25, 8, -16, 32, -64])
    expect(floatBits(alignedAbsoluteSum(values, 0, values.length))).toBe(
      floatBits(130.75)
    )
    expect(scaleFactorIndexForPeak(0)).toBe(0)
    expect(scaleFactorIndexForPeak(Number.NaN)).toBe(63)
    expect(scaleFactorIndexForPeak(Number.POSITIVE_INFINITY)).toBe(63)
  })

  it('rejects geometry before publishing staged channel history', () => {
    const { channels } = createMeasurementFixture()
    const transaction = new CodingUnitAllocationTransaction()
    channels[0].currentScaleHistory.scales.fill(17)
    expect(() => measureCodingUnitAllocationSource(transaction, 33, 3)).toThrow(
      RangeError
    )
    expect(Array.from(channels[0].currentScaleHistory.scales)).toEqual(
      Array(32).fill(17)
    )
  })
})
