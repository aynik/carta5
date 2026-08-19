import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import {
  buildSortedIndexOrder,
  computeGainFlatnessScale,
  measureGainBlockPeaks,
  requiredGainRangeBits,
} from '../codec/analysis/gain-measurement.js'
import {
  forwardRealDft16,
  magnitudeSpectrum16LowBins,
} from '../codec/transforms/dft.js'
import { GainMeasurementScratch } from '../codec/state/analysis.js'

const rawBits = new DataView(new ArrayBuffer(4))
function float32Bits(value) {
  rawBits.setFloat32(0, value, true)
  return rawBits.getUint32(0, true)
}

function referenceWindow() {
  return Float32Array.from(
    { length: 16 },
    (_, index) => (((index * 23 + 5) % 41) - 20) / 8
  )
}

describe('ATRAC3plus gain measurement', () => {
  it('matches the reference 16-point real DFT at every raw float', () => {
    const spectrum = referenceWindow()
    forwardRealDft16(spectrum)
    expect([...spectrum].map(float32Bits)).toEqual([
      1075314688, 1076363264, 1074726992, 3213988880, 3234068268, 3222951896,
      3205098331, 3225122555, 3223322624, 1076363264, 3230581396, 3210455659,
      1066392751, 1076209704, 3236398120, 1093595286,
    ])
  })

  it('matches the windowed spectral-flatness measurement exactly', () => {
    const scratch = new BufferPool().encoder.scratch.gain.detection.measurement
    expect(
      float32Bits(computeGainFlatnessScale(referenceWindow(), scratch))
    ).toBe(1067770609)
    expect([...scratch.magnitudes].map(float32Bits)).toEqual([
      1017054144, 1073475126, 1080310082, 1076638916, 1075560634, 1076561362,
      1082419883, 1087714382,
    ])
  })

  it('supports an aliased input and DFT work buffer without changing magnitudes', () => {
    const source = referenceWindow()
    const detachedMagnitudes = new Float32Array(8)
    magnitudeSpectrum16LowBins(source, detachedMagnitudes, new Float32Array(16))

    const aliasedSpectrum = source.slice()
    const aliasedMagnitudes = new Float32Array(8)
    magnitudeSpectrum16LowBins(
      aliasedSpectrum,
      aliasedMagnitudes,
      aliasedSpectrum
    )

    expect([...aliasedMagnitudes].map(float32Bits)).toEqual(
      [...detachedMagnitudes].map(float32Bits)
    )
  })

  it('preserves ordered NaN peak and index traversal behavior', () => {
    const scratch = new BufferPool().encoder.scratch.gain.detection.measurement
    const peakSource = Float32Array.from(
      { length: 128 },
      (_, index) => (((index * 17 + 3) % 67) - 33) / 16
    )
    peakSource[9] = Number.NaN
    peakSource[127] = -9.25
    expect(
      measureGainBlockPeaks(peakSource, scratch.blockPeaks, scratch.peakResult)
    ).toEqual({
      maximumIndex: 31,
      maximumValue: 9.25,
      activity: 0xffffffff,
    })
    expect([...scratch.blockPeaks].map(float32Bits)).toEqual([
      1072693248, 1072168960, 1071644672, 1071120384, 1070596096, 1070596096,
      1071120384, 1071644672, 1072168960, 1072693248, 1073217536, 1073741824,
      1074003968, 1074003968, 1073741824, 1073217536, 1072693248, 1072168960,
      1071644672, 1071120384, 1070596096, 1070071808, 1070596096, 1071120384,
      1071644672, 1072168960, 1072693248, 1073217536, 1073741824, 1074003968,
      1074003968, 1091829760,
    ])

    const values = Float32Array.from(
      { length: 64 },
      (_, index) => (((index * 11) % 19) - 9) / 4
    )
    let order = buildSortedIndexOrder(values, 63, 3, 20, scratch.sortedOrder)
    expect([...order.indices.slice(0, order.length)]).toEqual([
      63, 12, 5, 17, 10, 3, 15, 8, 13, 6, 18, 11, 4, 16, 9, 14, 7, 19,
    ])
    values[7] = Number.NaN
    order = buildSortedIndexOrder(values, 62, 3, 12, scratch.sortedOrder)
    expect([...order.indices.slice(0, order.length)]).toEqual([
      62, 5, 10, 3, 8, 6, 11, 4, 7, 9,
    ])
  })

  it('reuses pool-owned measurement storage and clamps range widths', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.gain.detection.measurement
    expect(scratch).toBeInstanceOf(GainMeasurementScratch)
    const spectrumIdentity = scratch.spectrum
    computeGainFlatnessScale(referenceWindow(), scratch)
    expect(scratch.spectrum).toBe(spectrumIdentity)
    expect([
      requiredGainRangeBits(1, 1, 6),
      requiredGainRangeBits(1, 3.9, 6),
      requiredGainRangeBits(1, 128, 6),
    ]).toEqual([0, 2, 6])
  })

  it('rejects incomplete DFT and measurement geometry', () => {
    expect(() => forwardRealDft16(new Float32Array(15))).toThrow(RangeError)
    expect(() =>
      computeGainFlatnessScale(
        new Float32Array(15),
        new BufferPool().encoder.scratch.gain.detection.measurement
      )
    ).toThrow(RangeError)
  })
})
