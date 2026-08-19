import { describe, expect, it } from 'vitest'
import * as tables from '../codec/core/tables.js'
import { float32ToBits } from '../codec/utils.js'

const codecTables = tables
const entropyTables = tables
const transformTables = tables

const U64_MASK = 0xffffffffffffffffn

function checksum(values, rawValue = (value) => value) {
  let sum = 0n
  let xor = 0n
  for (const value of values) {
    const raw = BigInt(rawValue(value))
    sum = (sum + raw) & U64_MASK
    xor ^= raw
  }
  return { count: values.length, sum, xor }
}

describe('canonical ATRAC3plus tables', () => {
  it('centralizes every canonical ATRAC3plus lookup table', () => {
    expect(Object.keys(tables)).toHaveLength(206)
  })

  it('preserves codec table shapes and typed ownership', () => {
    expect(codecTables.WORD_LENGTH_DELTA_CURVES).toBeInstanceOf(Int8Array)
    expect(codecTables.WORD_LENGTH_DELTA_CURVES).toHaveLength(192)
    expect(codecTables.WORD_LENGTH_SHAPE_CODEBOOK).toHaveLength(1152)
    expect(codecTables.NOISE_VALUES).toBeInstanceOf(Int16Array)
    expect(codecTables.NOISE_VALUES).toHaveLength(1024)
    expect(
      codecTables.MONO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND
    ).toHaveLength(1024)
    expect(
      codecTables.STEREO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND
    ).toHaveLength(1024)
    expect(codecTables.SCALE_FACTOR_MODE_2_DELTAS).toHaveLength(2)
    expect(codecTables.SCALE_FACTOR_MODE_2_DELTAS[0]).toBeInstanceOf(
      Uint32Array
    )
    expect(codecTables.SCALE_FACTOR_MODE_2_DELTAS[0]).toHaveLength(32)
    expect([...codecTables.SCALE_FACTOR_MODE_2_DELTAS[1].slice(-5)]).toEqual([
      9, 9, 9, 10, 10,
    ])
  })

  it('preserves complete QMF, DFT, and MDCT table geometry', () => {
    expect(transformTables.QMF_ANALYSIS_COEFFICIENT_BITS).toHaveLength(640)
    expect(transformTables.QMF_SYNTHESIS_COEFFICIENT_BITS).toHaveLength(640)
    expect(transformTables.DFT_16_TWIDDLES).toHaveLength(8)
    expect(transformTables.DFT_256_TWIDDLES).toHaveLength(128)
    expect(transformTables.MDCT_COSINE_COEFFICIENTS).toHaveLength(128)
    expect(transformTables.MDCT_SINE_COEFFICIENTS).toHaveLength(128)
    expect(transformTables.MDCT_REORDER_INDICES).toBeInstanceOf(Int16Array)
    for (const table of [
      transformTables.MDCT_WINDOW_BOTH_TRANSIENT,
      transformTables.MDCT_WINDOW_PREVIOUS_TRANSIENT,
      transformTables.MDCT_WINDOW_CURRENT_TRANSIENT,
      transformTables.MDCT_WINDOW_STEADY,
    ]) {
      expect(table).toBeInstanceOf(Float32Array)
      expect(table).toHaveLength(256)
    }
  })

  it('preserves canonical gain entropy lengths and absent symbols', () => {
    expect(entropyTables.GAIN_LEVEL_CODEBOOK_A_CODE_LENGTHS).toHaveLength(16)
    expect(
      entropyTables.GAIN_LOCATION_CODEBOOK_C_ATTACK_CODE_LENGTHS
    ).toHaveLength(32)
    expect(entropyTables.GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS).toHaveLength(
      8
    )
    expect(entropyTables.GAIN_LEVEL_CODEBOOK_B_CODE_LENGTHS[0]).toBe(0)
    expect(entropyTables.GAIN_LOCATION_CODEBOOK_A_ATTACK_CODE_LENGTHS[0]).toBe(
      0
    )
    expect(checksum(entropyTables.GAIN_LEVEL_CODEBOOK_D_CODE_LENGTHS)).toEqual({
      count: 16,
      sum: 0x6en,
      xor: 0x6n,
    })
    expect(
      checksum(entropyTables.GAIN_LOCATION_CODEBOOK_C_ATTACK_CODE_LENGTHS)
    ).toEqual({ count: 32, sum: 0xc7n, xor: 0x5n })
    expect(
      checksum(entropyTables.GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS)
    ).toEqual({ count: 8, sum: 0x23n, xor: 0x7n })
  })

  it('preserves spectral descriptor identities and packed metadata', () => {
    expect(entropyTables.SPECTRAL_CODEBOOK_CODE_LENGTHS).toHaveLength(112)
    expect(
      entropyTables.SPECTRAL_CODEBOOK_CODE_LENGTHS.every(
        (row) => row instanceof Uint8Array
      )
    ).toBe(true)
    expect(entropyTables.SPECTRAL_CODEBOOK_SYMBOL_METADATA).toHaveLength(112)
    expect(entropyTables.SPECTRAL_CODEBOOK_GROUPING_METADATA).toHaveLength(112)
    expect(entropyTables.SPECTRAL_CODEBOOK_VALUE_METADATA).toHaveLength(112)
    expect(checksum(entropyTables.SPECTRAL_CODEBOOK_SYMBOL_METADATA)).toEqual({
      count: 112,
      sum: 0x2eec03ee3n,
      xor: 0x115001e1n,
    })
    expect(checksum(entropyTables.SPECTRAL_CODEBOOK_GROUPING_METADATA)).toEqual(
      { count: 112, sum: 0x669ff728n, xor: 0x2050506n }
    )
    expect(checksum(entropyTables.SPECTRAL_CODEBOOK_VALUE_METADATA)).toEqual({
      count: 112,
      sum: 0x7838a26n,
      xor: 0x60200n,
    })
  })

  it('matches reference pinned raw-bit checksums', () => {
    expect(checksum(transformTables.QMF_SYNTHESIS_COEFFICIENT_BITS)).toEqual({
      count: 640,
      sum: 0x000001587dfce10an,
      xor: 0n,
    })
    expect(checksum(codecTables.SCALE_FACTOR_VALUES, float32ToBits)).toEqual({
      count: 64,
      sum: 0x0000001088c10000n,
      xor: 0x000000007bbaa400n,
    })
    expect(
      checksum(codecTables.INVERSE_QUANTIZER_SCALES, float32ToBits)
    ).toEqual({
      count: 8,
      sum: 0x00000001b3d9ae00n,
      xor: 0x000000003fb2e600n,
    })
    expect(
      checksum(codecTables.NOISE_VALUES, (value) => value & 0xffff)
    ).toEqual({
      count: 1024,
      sum: 0x0000000001f454ddn,
      xor: 0x00000000000045c3n,
    })
    expect(
      checksum(codecTables.SPECTRAL_NOISE_LEVEL_SCALES, float32ToBits)
    ).toEqual({
      count: 16,
      sum: 0x00000003b58c0000n,
      xor: 0x000000003e000000n,
    })
    expect(checksum(codecTables.QUANTIZATION_UNIT_BOUNDARIES)).toEqual({
      count: 17,
      sum: 0x173n,
      xor: 0x33n,
    })
    expect(checksum(codecTables.SPECTRUM_BAND_LIMITS)).toEqual({
      count: 16,
      sum: 0x2bn,
      xor: 0x5n,
    })
    expect(checksum(codecTables.SPECTRAL_NOISE_START_BAND_BY_MAP)).toEqual({
      count: 16,
      sum: 0x155n,
      xor: 0x11n,
    })
    expect(checksum(codecTables.NOISE_TABLE_OFFSETS)).toEqual({
      count: 48,
      sum: 0x4bcen,
      xor: 0x6n,
    })
  })
})
