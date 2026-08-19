import { describe, expect, it } from 'vitest'

import {
  measureSpectrumReconstructionNoise,
  quantizeSpectrumBand,
  quantizeSpectrumCoefficients,
  reconstructSpectrumSymbol,
  writeQuantizedBand,
} from '../codec/coding/spectrum-quantization.js'
import { reconstructCodingUnitSpectra } from '../codec/transforms/spectral-reconstruction.js'
import { DecodeChannelState } from '../codec/state/decoder.js'
import { CodingUnitChannels, SharedState } from '../codec/state/shared.js'
import { SpectralReconstructionScratch } from '../codec/state/transform.js'

const float64Bits = new DataView(new ArrayBuffer(8))

function bitsOf(value) {
  float64Bits.setFloat64(0, value, false)
  return float64Bits.getBigUint64(0, false)
}

describe('ATRAC3plus spectrum quantization', () => {
  it('matches reference float-bias rounding at threshold boundaries', () => {
    const source = Float32Array.from([
      -3.75, -1.5001, -1.5, -1.4999, -0.7501, -0.75, -0.7499, -0, 0, 0.374, 0.5,
      0.7499, 0.75, 1.4999, 1.5, 3.75,
    ])
    const fixtures = [
      {
        mode: 1,
        offset: 0,
        scale: 1,
        values: [
          65531, 65534, 65534, 65534, 65535, 65535, 65535, 0, 0, 0, 1, 1, 1, 2,
          2, 5,
        ],
      },
      {
        mode: 3,
        offset: 7,
        scale: 0.75,
        values: [
          65524, 65531, 65531, 65531, 65534, 65534, 65534, 0, 0, 1, 2, 2, 2, 5,
          5, 12,
        ],
      },
      {
        mode: 7,
        offset: 15,
        scale: 1.25,
        values: [
          65431, 65494, 65494, 65494, 65515, 65515, 65515, 0, 0, 10, 14, 21, 21,
          42, 42, 105,
        ],
      },
    ]
    for (const fixture of fixtures) {
      const output = new Uint16Array(source.length)
      expect(
        quantizeSpectrumCoefficients(
          source,
          0,
          fixture.mode,
          fixture.offset,
          fixture.scale,
          source.length,
          output
        )
      ).toBe(source.length)
      expect(Array.from(output)).toEqual(fixture.values)
    }
  })

  it('matches cached and live band quantization reconstruction noise', () => {
    const spectrum = new Float32Array(2048)
    const step = Math.fround(0.1375)
    for (let index = 128; index < 160; index++) {
      spectrum[index] = Math.fround((((index - 128) % 11) - 5) * step)
    }
    const thresholdScales = new Float32Array(32)
    thresholdScales.fill(1)
    thresholdScales[8] = 0.8125
    const allSymbols = new Uint16Array(2048)
    expect(
      quantizeSpectrumBand(spectrum, thresholdScales, 8, 5, 9, allSymbols)
    ).toBe(32)
    const symbols = allSymbols.slice(128, 160)
    expect(Array.from(symbols)).toEqual([
      65531, 65532, 65533, 65534, 65535, 0, 1, 2, 3, 4, 5, 65531, 65532, 65533,
      65534, 65535, 0, 1, 2, 3, 4, 5, 65531, 65532, 65533, 65534, 65535, 0, 1,
      2, 3, 4,
    ])
    const live = measureSpectrumReconstructionNoise(
      spectrum,
      thresholdScales,
      8,
      5,
      9,
      1.25,
      0.875
    )
    const cached = measureSpectrumReconstructionNoise(
      spectrum,
      thresholdScales,
      8,
      5,
      9,
      1.25,
      0.875,
      symbols
    )
    expect(bitsOf(live)).toBe(0x3fe062199f39bbbfn)
    expect(bitsOf(cached)).toBe(0x3fe062199f39bbbfn)
  })

  it('copies unsigned symbols into absolute signed channel storage', () => {
    const symbols = Uint16Array.from({ length: 32 }, (_unused, index) =>
      index % 2 === 0 ? index : 0x10000 - index
    )
    const output = new Int16Array(2048)
    writeQuantizedBand(symbols, 8, output)
    expect(Array.from(output.slice(128, 136))).toEqual([
      0, -1, 2, -3, 4, -5, 6, -7,
    ])
  })

  it('reconstructs signed wire symbols with float32 caller scaling', () => {
    expect(reconstructSpectrumSymbol(0xfffb, 5, 0.875)).toBe(
      -0.6545209884643555
    )
    expect(reconstructSpectrumSymbol(0x0005, 5, 0.875)).toBe(0.6545209884643555)
    expect(reconstructSpectrumSymbol(0, 8, 1)).toBeNull()
  })

  it('reconstructs decoder symbols sequentially and applies mute last', () => {
    const channels = new CodingUnitChannels()
    channels.push(0)
    const shared = new SharedState()
    shared.scaleFactorCount = 1
    const channel = new DecodeChannelState()
    channel.syntax.wordLengths[0] = 1
    channel.syntax.scaleFactors[0] = 7
    channel.quantizedSpectrum[0] = 1
    channel.quantizedSpectrum[1] = -1
    const spectra = [new Float32Array(2048)]
    const scratch = new SpectralReconstructionScratch()

    expect(
      reconstructCodingUnitSpectra(
        [channel],
        channels,
        shared,
        spectra,
        scratch
      )
    ).toBe(1)
    expect(Array.from(spectra[0].slice(0, 4))).toEqual([
      0.10499576479196548, -0.10499576479196548, 0, 0,
    ])

    shared.muteFlag = 1
    spectra[0].fill(123)
    reconstructCodingUnitSpectra([channel], channels, shared, spectra, scratch)
    expect(spectra[0].every((value) => value === 0)).toBe(true)
  })

  it('reuses primary symbols before exact stereo swap and polarity maps', () => {
    const channels = new CodingUnitChannels()
    channels.push(0)
    channels.push(1)
    const shared = new SharedState()
    shared.scaleFactorCount = 1
    const left = new DecodeChannelState(0)
    const right = new DecodeChannelState(1)
    right.primaryChannelIndex = 0
    left.syntax.wordLengths[0] = 1
    left.syntax.scaleFactors[0] = 7
    left.quantizedSpectrum[0] = 2
    left.quantizedSpectrum[1] = -3
    right.syntax.wordLengths[0] = 0
    right.syntax.scaleFactors[0] = 7
    right.syntax.codeTables[0] = 0
    const spectra = [new Float32Array(2048), new Float32Array(2048)]
    const scratch = new SpectralReconstructionScratch()

    reconstructCodingUnitSpectra(
      [left, right],
      channels,
      shared,
      spectra,
      scratch
    )
    expect(right.syntax.wordLengths[0]).toBe(1)
    expect(Array.from(right.quantizedSpectrum.slice(0, 2))).toEqual([2, -3])
    expect(Array.from(spectra[1].slice(0, 2))).toEqual([
      0.20999152958393097, -0.31498730182647705,
    ])

    shared.presenceFlags[1][0] = 1
    shared.presenceFlags[0][0] = 1
    right.syntax.wordLengths[0] = 2
    right.quantizedSpectrum[0] = 5
    right.quantizedSpectrum[1] = 6
    reconstructCodingUnitSpectra(
      [left, right],
      channels,
      shared,
      spectra,
      scratch
    )
    expect(Array.from(spectra[0].slice(0, 2))).toEqual([
      0.3149958550930023, 0.3779950439929962,
    ])
    expect(Array.from(spectra[1].slice(0, 2))).toEqual([
      -0.20999152958393097, 0.31498730182647705,
    ])
  })

  it('matches the decoder spectral-noise seed and float32 map fixture', () => {
    const channels = new CodingUnitChannels()
    channels.push(0)
    const shared = new SharedState()
    shared.scaleFactorCount = 3
    const channel = new DecodeChannelState()
    channel.syntax.wordLengths[2] = 1
    channel.syntax.scaleFactors.set([1, 2, 7])
    channel.syntax.spectralNoiseLevelIndices[0] = 0
    const spectra = [new Float32Array(2048)]
    const scratch = new SpectralReconstructionScratch()

    reconstructCodingUnitSpectra([channel], channels, shared, spectra, scratch)
    expect(scratch.noiseSeeds[0]).toBe(8)
    expect(Array.from(spectra[0].slice(32, 48))).toEqual([
      -0.150502547621727, -0.09240614622831345, -0.047891221940517426,
      0.035072751343250275, 0.09772174060344696, 0.01232887338846922,
      -0.031626518815755844, 0.08604778349399567, -0.002683230908587575,
      0.027836930006742477, 0.090752974152565, -0.01985717937350273,
      -0.12172457575798035, 0.08181311190128326, -0.017383774742484093,
      -0.053346700966358185,
    ])
  })
})
