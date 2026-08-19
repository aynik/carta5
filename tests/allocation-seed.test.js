import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import {
  MAX_CODING_UNITS,
  QUANTIZATION_UNIT_COUNT,
} from '../codec/core/constants.js'

import {
  deriveAllocationSeed,
  prepareIntensityStereoMask,
} from '../codec/coding/allocation-seed.js'
import { initializeAllocation } from '../codec/coding/initial-allocation.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { SharedState } from '../codec/state/shared.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../codec/state/spectrum-pricing.js'
import {
  AllocationSourceChannel,
  CodingUnitAllocationTransaction,
} from '../codec/state/allocation.js'

function createSourceChannels() {
  return [new AllocationSourceChannel(), new AllocationSourceChannel()]
}

function fnvWords(words, bytesPerWord) {
  let hash = 0xcbf29ce484222325n
  for (const value of words) {
    let word = BigInt(value >>> 0)
    for (let byte = 0; byte < bytesPerWord; byte++) {
      hash ^= word & 0xffn
      hash = BigInt.asUintN(64, hash * 0x100000001b3n)
      word >>= 8n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function float32Bits(values) {
  const copy = Float32Array.from(values)
  return new Uint32Array(copy.buffer)
}

function createSeedFixture() {
  const pool = new BufferPool()
  const transaction = pool.encoder.frame.allocationTransactions[0].reset(2)
  transaction.toneSwapGate = pool.encoder.scratch.toneSwapGates[0].beginFrame()
  transaction.coreMode = 15
  transaction.bandCount = 27
  transaction.sampleRateHz = 48000
  const sourceChannels = transaction.sourceChannels
  for (let channel = 0; channel < 2; channel++) {
    sourceChannels[channel].bitAllocationMode = channel === 0 ? 4 : 2
    for (let band = 0; band < QUANTIZATION_UNIT_COUNT; band++) {
      sourceChannels[channel].bandLevels[band] = Math.fround(
        ((band * 7 + channel * 11) % 29) * 0.4375 - 1.25
      )
    }
  }
  const quantizationUnits = transaction.quantizationUnits
  for (let channel = 0; channel < 2; channel++) {
    for (let band = 0; band < QUANTIZATION_UNIT_COUNT; band++) {
      quantizationUnits[channel * QUANTIZATION_UNIT_COUNT + band] =
        (band + channel * 3) % 11 === 0
          ? 0
          : ((band * 5 + channel * 7) % 24) + 1
    }
  }
  const seed = deriveAllocationSeed(transaction, 18, 23)
  return { transaction, sourceChannels, quantizationUnits, seed }
}

function createIntensityFixture() {
  const channels = [new EncodeChannelState(0), new EncodeChannelState(1)]
  const jointScaleFactorIndices = new Int32Array(QUANTIZATION_UNIT_COUNT)
  channels[0].intensityHistory.intensityBandLimit = 6
  const correlations = [18, 62, 48, 35, 72, 44]
  for (let record = 0; record < 6; record++) {
    channels[0].intensityHistory.setCorrelation(1, record, correlations[record])
    for (let channel = 0; channel < 2; channel++) {
      const gain = channels[channel].currentGainRecords[record]
      gain.entries = 1
      gain.locations[0] = record + 2
      gain.levels[0] = 7 + (record & 1)
    }
    if (record === 2 || record === 5) {
      channels[1].currentGainRecords[record].levels[0]++
    }
  }
  const sourceChannels = createSourceChannels()
  for (let band = 0; band < 27; band++) {
    channels[0].syntax.scaleFactors[band] = 18 + (band % 5)
    channels[1].syntax.scaleFactors[band] = 18 + ((band + 2) % 5)
    if (band % 4 === 0) {
      channels[1].syntax.scaleFactors[band] =
        channels[0].syntax.scaleFactors[band]
    }
    jointScaleFactorIndices[band] = 12 + (band % 3)
    sourceChannels[0].bandLevels[band] = Math.fround(((band * 3) % 17) * 0.625)
    sourceChannels[1].bandLevels[band] = Math.fround(((band * 5) % 19) * 0.5)
  }
  return { channels, jointScaleFactorIndices, sourceChannels }
}

describe('ATRAC3plus allocation seed transaction', () => {
  it('matches candidate caps and exact float32 base seeds from reference', () => {
    const { sourceChannels, seed } = createSeedFixture()
    const capWords = []
    for (let channel = 0; channel < 2; channel++) {
      capWords.push(
        sourceChannels[channel].bitAllocationMode,
        ...sourceChannels[channel].maximumQuantizationModes.slice(
          0,
          seed.bandCount
        )
      )
    }
    expect(fnvWords(capWords, 4)).toBe('9a48b9dc87046f62')
    expect(fnvWords(float32Bits(seed.baseAllocationScores), 4)).toBe(
      'c2b5d0184cd1fb50'
    )
    expect(fnvWords(seed.initialWordLengths, 4)).toBe('8747743e73d9a736')
    expect(Array.from(seed.initialWordLengths.slice(0, 27))).toEqual([
      0, 4, 6, 7, 7, 3, 5, 7, 6, 6, 1, 0, 5, 4, 6, 2, 3, 3, 4, 5, 2, 2, 0, 4, 1,
      1, 2,
    ])
    expect(Array.from(seed.initialWordLengths.slice(32, 59))).toEqual([
      5, 6, 7, 6, 3, 5, 7, 6, 0, 2, 4, 4, 5, 1, 2, 3, 4, 5, 1, 0, 2, 3, 5, 2, 1,
      2, 4,
    ])
  })

  it('matches the retained intensity allocation policy', () => {
    const { channels, jointScaleFactorIndices, sourceChannels } =
      createIntensityFixture()
    const mask = prepareIntensityStereoMask(
      channels,
      sourceChannels,
      jointScaleFactorIndices,
      18,
      27,
      16,
      new Uint16Array(QUANTIZATION_UNIT_COUNT)
    )
    expect(fnvWords(mask, 2)).toBe('6513fea3d9ed953d')
  })

  it('publishes modes and stereo suppression only at explicit commit', () => {
    const { transaction, seed } = createSeedFixture()
    const channels = [new EncodeChannelState(0), new EncodeChannelState(1)]
    const shared = new SharedState()
    shared.quantizationUnitCount = transaction.bandCount
    for (let channel = 0; channel < 2; channel++) {
      transaction.channelBlocks[channel] = channels[channel]
      transaction.gainScaledSpectra[channel] = new Float32Array(2048)
      transaction.normalizedSpectra[channel] = new Float32Array(2048)
      transaction.spectrumPricingStates[channel] = new SpectrumPricingState()
      transaction.spectrumPricedBands[channel] = new PricedSpectrumBand()
    }
    transaction.intensityStereoBandMask.fill(1, 0, transaction.bandCount)
    expect(channels[0].syntax.wordLengths[1]).toBe(0)
    initializeAllocation(transaction, shared)
    for (let band = 0; band < transaction.bandCount; band++) {
      const primaryMode = seed.initialWordLengths[band]
      const secondaryMode =
        seed.initialWordLengths[QUANTIZATION_UNIT_COUNT + band]
      expect(channels[0].syntax.wordLengths[band]).toBe(primaryMode)
      if (primaryMode === 0 || secondaryMode === 0) {
        expect(transaction.intensityStereoBandMask[band]).toBe(0)
        expect(channels[1].syntax.wordLengths[band]).toBe(secondaryMode)
      } else {
        expect(transaction.intensityStereoBandMask[band]).toBe(1)
        expect(channels[1].syntax.wordLengths[band]).toBe(0)
      }
    }
  })

  it('tracks exact section and spectrum ledgers without replacing owners', () => {
    const transaction = new CodingUnitAllocationTransaction()
    const maskIdentity = transaction.intensityStereoBandMask
    const sourceIdentity = transaction.sourceChannels
    transaction.reset(2)
    expect(transaction.intensityStereoBandMask).toBe(maskIdentity)
    expect(transaction.sourceChannels).toBe(sourceIdentity)
    transaction.fixedBits = 4
    transaction.wordLengthBits = 19
    transaction.scaleFactorBits = 37
    transaction.spectrumBits[0][0] = 101
    transaction.spectrumBits[1][1] = 79
    const blocks = [new EncodeChannelState(0), new EncodeChannelState(1)]
    blocks[1].syntax.codeTableContext = 1
    transaction.channelBlocks[0] = blocks[0]
    transaction.channelBlocks[1] = blocks[1]
    expect(transaction.recomputeBits()).toBe(240)
    expect(transaction.bitsTotal).toBe(240)
    expect(
      Number(transaction.spectrumBits[0][1] < transaction.spectrumBits[0][0])
    ).toBe(1)
    transaction.quantizationDirty = false
    transaction.codeTableCostAvailable = true
    expect(transaction).toMatchObject({
      codeTableCostAvailable: true,
      quantizationDirty: false,
    })
    transaction.codeTableCostAvailable = false
    transaction.quantizationDirty = true
    expect(transaction.quantizationDirty).toBe(true)
  })

  it('binds attempt and channel resources through explicit complete transitions', () => {
    const transaction = new CodingUnitAllocationTransaction().bindPlans(
      {},
      {},
      {},
      {},
      {}
    )
    transaction.beginAttempt(2, 15, 4096, {})
    const bind = (ordinal) => {
      const block = new EncodeChannelState(ordinal)
      const scaled = new Float32Array(2048)
      const unscaled = new Float32Array(2048)
      const pricing = transaction.spectrumPricingStates[ordinal]
      transaction.bindChannel(ordinal, block, scaled, unscaled)
      expect(transaction.channelBlocks[ordinal]).toBe(block)
      expect(transaction.gainScaledSpectra[ordinal]).toBe(scaled)
      expect(transaction.spectrumPricingStates[ordinal]).toBe(pricing)
    }

    expect(() => transaction.completeBinding()).toThrow(RangeError)
    expect(() => bind(1)).toThrow(RangeError)
    bind(0)
    bind(1)
    expect(transaction.completeBinding()).toBe(transaction)
    expect(transaction.bindingComplete).toBe(true)
    expect(() => bind(1)).toThrow(RangeError)
    const stableWordLengthPlan = transaction.wordLengthTransaction
    transaction.reset(0)
    expect(transaction.wordLengthTransaction).toBe(stableWordLengthPlan)
    expect(transaction.bindingComplete).toBe(false)
  })

  it('preallocates one complete allocation identity per coding unit', () => {
    const pool = new BufferPool()
    const workspace = pool.encoder.frame.allocationWorkspace
    const wordLengthWorkspace = pool.encoder.frame.wordLengthPricingWorkspace
    const codeTableWorkspace = pool.encoder.frame.codeTablePricingWorkspace
    const scaleFactorPlan = pool.encoder.frame.scaleFactorPlan
    const transactions = pool.encoder.frame.allocationTransactions
    expect(transactions).toHaveLength(MAX_CODING_UNITS)
    expect(
      transactions.every(
        (transaction) =>
          transaction instanceof CodingUnitAllocationTransaction &&
          transaction.quantizationOffsets === workspace.quantizationOffsets &&
          transaction.wordLengthTransaction.scratch ===
            wordLengthWorkspace.scratch &&
          transaction.codeTableTransaction.states ===
            codeTableWorkspace.states &&
          transaction.scaleFactorPlan === scaleFactorPlan &&
          transaction.spectrumBits.length === 2 &&
          transaction.quantizationOffsets.length === 2 &&
          transaction.baseAllocationScores.length === 64 &&
          transaction.allocationBandOrder.ordinals.length === 64 &&
          transaction.checkpointWordLengths.length === 2
      )
    ).toBe(true)
  })
})
