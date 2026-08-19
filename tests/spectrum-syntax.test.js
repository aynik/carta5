import { describe, expect, it } from 'vitest'

import {
  spectrumBitstreamCodeTableIndex,
  spectrumDescriptor,
  groupSpectrumCoefficients,
  packSpectrumPayload,
  unpackSpectrumPayload,
} from '../codec/coding/spectrum.js'
import { BufferPool } from '../codec/core/buffers.js'
import {
  spectralNoiseLevelFieldCount,
  packChannelSpectrum,
} from '../codec/io/spectrum-syntax.js'
import { unpackChannelSpectrum } from '../codec/io/spectrum-decoder.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { ChannelSyntaxState, SharedState } from '../codec/state/shared.js'
import {
  SpectrumSymbolScratch,
  SpectrumSyntaxScratch,
} from '../codec/state/spectrum.js'

const payloads = [
  {
    name: 'four signed values',
    descriptor: 0,
    values: [0, 0, 0, 0, 1, 0, 0, 0, -1, 1, 0, 0, 0, 0, 0, 0],
    bits: 14,
    hex: '63a8',
  },
  {
    name: 'four magnitudes with sign extras',
    descriptor: 1,
    values: [0, 0, 0, 0, 1, 0, 0, 0, -1, 1, 0, 0, 0, 0, 0, 0],
    bits: 16,
    hex: '1d78',
  },
  {
    name: 'one magnitude with sign extras',
    descriptor: 3,
    values: [0, 1, -1, 2, -2, 0, 3, -3, 0, 0, 1, 0, -1, 0, 0, 0],
    bits: 50,
    hex: '80a72ae410c900',
  },
  {
    name: 'four signed values with four-symbol zero runs',
    descriptor: 7,
    values: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ],
    bits: 10,
    hex: '6c00',
  },
  {
    name: 'four magnitudes with two-symbol zero runs',
    descriptor: 50,
    values: [
      0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ],
    bits: 20,
    hex: '5e4b20',
  },
  {
    name: 'one signed value with four-symbol zero runs',
    descriptor: 55,
    values: [0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 2, 0, 0, 0],
    bits: 24,
    hex: '50c600',
  },
]

function descriptorAt(index) {
  const context = Math.trunc(index / 56)
  const withinContext = index % 56
  return spectrumDescriptor(
    context,
    (withinContext % 7) + 1,
    Math.trunc(withinContext / 7)
  )
}

function packPayload(values, descriptor, scratch) {
  const bytes = new Uint8Array(128)
  const writer = new BitWriter(bytes)
  const coefficients = Int16Array.from(values)
  packSpectrumPayload(
    coefficients,
    0,
    coefficients.length,
    descriptor,
    scratch,
    writer
  )
  return {
    bits: writer.bitPosition,
    hex: Buffer.from(
      bytes.subarray(0, Math.ceil(writer.bitPosition / 8))
    ).toString('hex'),
  }
}

describe('ATRAC3plus spectrum syntax', () => {
  for (const payload of payloads) {
    it(`matches reference for ${payload.name}`, () => {
      const descriptor = descriptorAt(payload.descriptor)
      expect(
        packPayload(payload.values, descriptor, new SpectrumSymbolScratch())
      ).toEqual({ bits: payload.bits, hex: payload.hex })

      const decoded = new Int16Array(payload.values.length)
      const reader = new BitReader(Buffer.from(payload.hex, 'hex'))
      unpackSpectrumPayload(decoded, 0, decoded.length, descriptor, reader)
      expect(reader.bitPosition).toBe(payload.bits)
      expect([...decoded]).toEqual(payload.values)
    })
  }

  it('matches the complete context-zero table remap', () => {
    const expected = [
      0, 5, 4, 1, 0, 1, 2, 3, 3, 0, 4, 2, 4, 0, 1, 2, 1, 0, 4, 3, 3, 0, 2, 1, 0,
      3, 1, 2, 4, 0, 1, 2, 0, 3, 2, 1, 0, 1, 2, 3, 0, 1, 2, 4, 0, 1, 2, 3, 1, 4,
      2, 0, 0, 1, 2, 3,
    ]
    const actual = []
    for (let context = 0; context < 2; context++) {
      for (let mode = 1; mode <= 7; mode++) {
        for (let codeTable = 0; codeTable < 4; codeTable++) {
          actual.push(
            spectrumBitstreamCodeTableIndex(context, mode, codeTable, 0)
          )
        }
      }
    }
    expect(actual).toEqual(expected)
    expect(spectrumBitstreamCodeTableIndex(0, 1, 7, 1)).toBe(7)
    expect(spectrumBitstreamCodeTableIndex(0, 1, 8, 1)).toBeNull()
    expect(spectrumBitstreamCodeTableIndex(0, 1, 4, 0)).toBeNull()
  })

  it('groups signed low-byte coefficients with four-symbol padding', () => {
    const source = Uint16Array.from([0xffff, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const destination = new Uint16Array(16)
    expect(
      groupSpectrumCoefficients(source, 0, source.length, 2, 3, destination)
    ).toBe(8)
    expect(Array.from(destination.subarray(0, 8))).toEqual([
      58, 28, 46, 56, 10, 0, 0, 0,
    ])
  })

  it('packs a complete multi-band channel and its noise trailer', () => {
    const block = new EncodeChannelState(0)
    const shared = new SharedState()
    const scratch = new SpectrumSyntaxScratch()
    shared.scaleFactorCount = 16
    shared.gainModeFlag = 1
    block.syntax.wordLengths.set([1, 2, 3, 4, 5, 6])
    block.syntax.codeTables.set([1, 7, 3, 0, 5, 2])
    block.syntax.spectralNoiseLevelIndices.set([3, 12])
    for (const [index, value] of [
      [4, 1],
      [18, -1],
      [35, 1],
      [49, -2],
      [65, 1],
      [83, -1],
    ]) {
      block.quantizedSpectrum[index] = value
    }
    const bytes = new Uint8Array(256)
    const writer = new BitWriter(bytes)
    packChannelSpectrum(block, shared, scratch, writer)
    const counter = new BitCounter()
    packChannelSpectrum(block, shared, scratch, counter)
    expect(writer.bitPosition).toBe(141)
    expect(counter.bitPosition).toBe(141)
    expect(Buffer.from(bytes.subarray(0, 18)).toString('hex')).toBe(
      'ac560c0047249249249220000068000001e0'
    )
    expect(spectralNoiseLevelFieldCount(16, shared.mapCount)).toBe(2)

    const decodedSyntax = new ChannelSyntaxState()
    decodedSyntax.wordLengths.set(block.syntax.wordLengths)
    decodedSyntax.codeTables.set(block.syntax.codeTables)
    decodedSyntax.codeTableContext = block.syntax.codeTableContext
    const decodedSpectrum = new Int16Array(2048)
    const reader = new BitReader(bytes)
    unpackChannelSpectrum(decodedSyntax, decodedSpectrum, shared, reader)
    expect(reader.bitPosition).toBe(writer.bitPosition)
    expect([...decodedSpectrum]).toEqual([...block.quantizedSpectrum])
    expect([...decodedSyntax.spectralNoiseLevelIndices]).toEqual([
      3, 12, 15, 15, 15,
    ])
  })

  it('uses the pool-owned scalar syntax scratch', () => {
    const pool = new BufferPool()
    expect(pool.encoder.scratch.spectrumSyntax).toBeInstanceOf(
      SpectrumSyntaxScratch
    )
    expect(pool.encoder.scratch.spectrumSyntax.symbol.fields).toBeInstanceOf(
      Uint32Array
    )
  })
})
