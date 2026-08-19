import { describe, expect, it } from 'vitest'

import {
  initializeAllocation,
  normalizeAllocationSpectrum,
} from '../codec/coding/initial-allocation.js'

import { BufferPool } from '../codec/core/buffers.js'
import { SPECTRUM_FORBIDDEN_BITS } from '../codec/core/constants.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../codec/core/tables.js'
import { BitCounter } from '../codec/io/bitstream.js'
import { packScaleFactorSection } from '../codec/io/scale-factor-syntax.js'
import {
  packWordLengthSection,
  repriceWordLengthSection,
} from '../codec/io/word-length-syntax.js'

import { EncodeChannelState } from '../codec/state/encoder.js'
import { SharedState } from '../codec/state/shared.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../codec/state/spectrum-pricing.js'

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

function createInitialFixture() {
  const pool = new BufferPool()
  const transaction = pool.encoder.frame.allocationTransactions[0].reset(2)
  transaction.toneSwapGate = pool.encoder.scratch.toneSwapGates[0].beginFrame()
  transaction.coreMode = 0x13
  transaction.bandCount = 27
  transaction.sampleRateHz = 44100
  const shared = new SharedState()
  shared.quantizationUnitCount = 27
  for (let channel = 0; channel < 2; channel++) {
    transaction.channelBlocks[channel] = new EncodeChannelState(channel)
    transaction.gainScaledSpectra[channel] = new Float32Array(2048)
    for (let coefficient = 0; coefficient < 2048; coefficient++) {
      const wave = ((coefficient * 29 + channel * 17 + 5) % 193) - 96
      transaction.gainScaledSpectra[channel][coefficient] = Math.fround(
        wave * 0.0625
      )
    }
    for (let band = 0; band < 32; band++) {
      transaction.channelBlocks[channel].syntax.scaleFactors[band] =
        band === 7 + channel ? 63 : 12 + ((band * 5 + channel * 3) % 19)
      transaction.sourceChannels[channel].quantizationThresholdScales[band] =
        Math.fround(0.625 + ((band * 7 + channel * 5) % 11) * 0.0625)
      transaction.initialWordLengths[channel * 32 + band] =
        band < 27 && (band + channel) % 5 !== 0
          ? 1 + ((band * 3 + channel) % 7)
          : 0
    }
    transaction.spectrumPricingStates[channel] = new SpectrumPricingState()
    transaction.spectrumPricedBands[channel] = new PricedSpectrumBand()
  }
  return { transaction, shared }
}

describe('ATRAC3plus initial allocation mutation', () => {
  it('matches normalized spectra and complete initial spectrum pricing', () => {
    const { transaction, shared } = createInitialFixture()
    expect(initializeAllocation(transaction, shared)).toBe(7103)
    const normalized = []
    const selected = []
    const costs = []
    for (let channel = 0; channel < 2; channel++) {
      normalized.push(
        ...Array.from(
          transaction.normalizedSpectra[channel].slice(
            0,
            QUANTIZATION_UNIT_OFFSETS[transaction.bandCount]
          ),
          floatBits
        )
      )
      const pricing = transaction.spectrumPricingStates[channel]
      for (let band = 0; band < 32; band++) {
        const index = pricing.selectedIndex(0, band)
        selected.push(index)
        costs.push(pricing.selectedCost(0, band))
      }
    }
    expect(fnv32Words(normalized)).toBe('5b2a97da6712cdaa')
    expect(fnv32Words(selected)).toBe('b68f2c70b8c9a4e7')
    expect(fnv32Words(costs)).toBe('3eef053b896768e3')
    expect(transaction.spectrumBits[0][0]).toBe(3358)
    expect(transaction.spectrumBits[1][0]).toBe(3130)
    expect(transaction.spectrumBits[0][1]).toBe(SPECTRUM_FORBIDDEN_BITS)
    expect(shared).toMatchObject({
      gainModeFlag: 1,
      noisePresent: 0,
      scaleFactorCount: 27,
      quantizationUnitCount: 27,
      bandLimit: 27,
      muteFlag: 0,
    })
    expect(transaction.channelBlocks[0].syntax.codeTableContext).toBe(0)
    expect(transaction).toMatchObject({
      fixedBits: 46,
      wordLengthBits: 166,
      scaleFactorBits: 260,
      codeTableBits: 143,
    })
    const wordLengthCounter = new BitCounter()
    packWordLengthSection(
      transaction.channelBlocks,
      transaction.wordLengthTransaction,
      wordLengthCounter
    )
    expect(wordLengthCounter.bitPosition).toBe(166)
    const scaleFactorCounter = new BitCounter()
    packScaleFactorSection(
      transaction.channelBlocks,
      shared.scaleFactorCount,
      scaleFactorCounter
    )
    expect(scaleFactorCounter.bitPosition).toBe(260)
    expect(
      transaction.channelBlocks.map((block, channel) => [
        transaction.wordLengthTransaction.plans[channel].kind,
        block.scaleFactorEncode.modeSelect,
        transaction.codeTableTransaction.syntaxes[channel].bits,
      ])
    ).toEqual([
      [0, 1, 64],
      [0, 2, 72],
    ])
    expect(() =>
      repriceWordLengthSection(
        transaction.channelBlocks,
        0,
        0,
        transaction.wordLengthTransaction
      )
    ).toThrow('incremental word-length request is invalid')
  })

  it('clamps six-bit overflow bands after exact float32 normalization', () => {
    const source = new Float32Array(2048)
    source.fill(100)
    const indices = new Int32Array(32)
    indices[0] = 63
    const destination = new Float32Array(2048)
    normalizeAllocationSpectrum(source, indices, destination, 32)
    expect(destination[0]).toBeLessThanOrEqual(Math.fround(1.1220093))
    expect(destination[0]).toBeGreaterThanOrEqual(Math.fround(-1.1220093))
    expect(destination[16]).toBeGreaterThan(destination[0])
  })
})
