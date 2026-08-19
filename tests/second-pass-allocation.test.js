import { describe, expect, it } from 'vitest'

import { searchAllocation } from '../codec/coding/second-pass-allocation.js'
import { reduceCommittedAllocationToBudget } from '../codec/coding/offset-refinement.js'
import { fillRemainingBitBudget } from '../codec/coding/budget-fill.js'
import { quantizeActiveAllocation } from '../codec/coding/active-quantization.js'
import { refineSpectralNoiseLevels } from '../codec/coding/spectral-noise-refinement.js'
import { refineScaleFactors } from '../codec/coding/scale-factor-refinement.js'
import { planAllocationBandOrder } from '../codec/coding/allocation-order.js'

import { SPECTRUM_FORBIDDEN_BITS } from '../codec/core/constants.js'
import { priceSpectrumBand } from '../codec/coding/spectrum-pricing.js'

import { planRawWordLengthSection } from '../codec/io/word-length-syntax.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { SharedState } from '../codec/state/shared.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../codec/core/tables.js'
import { CodingUnitAllocationTransaction } from '../codec/state/allocation.js'
import { CodeTableAccountingTransaction } from '../codec/state/code-table.js'
import { ScaleFactorCodingPlan } from '../codec/state/scale-factor.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../codec/state/spectrum-pricing.js'
import { WordLengthAccountingTransaction } from '../codec/state/word-length.js'

const OFFSETS = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1])

function hashInt16(values) {
  let hash = 0xcbf29ce484222325n
  for (const value of values) {
    const unsigned = value & 0xffff
    hash ^= BigInt(unsigned & 0xff)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    hash ^= BigInt(unsigned >>> 8)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function createFixture() {
  const transaction = new CodingUnitAllocationTransaction().reset(2)
  const shared = new SharedState()
  shared.quantizationUnitCount = 12
  shared.scaleFactorCount = 12
  shared.bandLimit = 12
  shared.gainModeFlag = 1
  transaction.bandCount = 12
  transaction.coreMode = 12
  transaction.sampleRateHz = 44100
  transaction.wordLengthTransaction = new WordLengthAccountingTransaction()
  transaction.codeTableTransaction = new CodeTableAccountingTransaction()
  transaction.scaleFactorPlan = new ScaleFactorCodingPlan()
  transaction.allocationBudgetBits = 2100
  transaction.quantizationUnits.fill(22)

  for (let channel = 0; channel < 2; channel++) {
    const block = new EncodeChannelState(channel)
    transaction.channelBlocks[channel] = block
    transaction.spectrumPricingStates[channel] = new SpectrumPricingState()
    transaction.spectrumPricedBands[channel] = new PricedSpectrumBand()
    for (let band = 0; band < 12; band++) {
      const mode = 1 + ((band * 3 + channel) % 7)
      block.syntax.wordLengths[band] = mode
      transaction.initialWordLengths[channel * 32 + band] = mode
      transaction.baseAllocationScores[channel * 32 + band] = Math.fround(
        mode + ((band % 3) - 1) * 0.25 + channel * 0.125
      )
      transaction.sourceChannels[channel].maximumQuantizationModes[band] = 7
      transaction.sourceChannels[channel].quantizationThresholdScales[band] =
        Math.fround(0.625 + ((band * 7 + channel * 5) % 11) * 0.0625)
    }
    for (let coefficient = 0; coefficient < 2048; coefficient++) {
      const wave = ((coefficient * 29 + channel * 17 + 5) % 193) - 96
      transaction.normalizedSpectra[channel][coefficient] = Math.fround(
        wave * 0.03125
      )
    }
    let sum = 0
    for (let band = 0; band < 12; band++) {
      const mode = block.syntax.wordLengths[band]
      priceSpectrumBand(
        transaction.spectrumPricingStates[channel],
        transaction.normalizedSpectra[channel],
        transaction.sourceChannels[channel].quantizationThresholdScales,
        0,
        band,
        mode,
        0,
        transaction.spectrumPricedBands[channel]
      )
      sum += transaction.spectrumPricingStates[channel].commit(
        transaction.spectrumPricedBands[channel],
        0
      )
    }
    transaction.spectrumBits[channel][0] = sum
    transaction.spectrumBits[channel][1] = SPECTRUM_FORBIDDEN_BITS
  }

  transaction.fixedBits = 22
  transaction.wordLengthBits = 76
  transaction.scaleFactorBits = 20
  transaction.codeTableBits = 50
  transaction.bitsTotal =
    transaction.sidechainBits +
    transaction.spectrumBits[0][0] +
    transaction.spectrumBits[1][0]
  planRawWordLengthSection(
    transaction.channelBlocks,
    12,
    transaction.wordLengthTransaction
  )
  planAllocationBandOrder(
    transaction.channelBlocks,
    transaction.sourceChannels,
    12,
    transaction.allocationBandOrder
  )
  return { transaction, shared }
}

function createFilledFixture() {
  const fixture = createFixture()
  searchAllocation(fixture.transaction, fixture.shared)
  fixture.transaction.allocationBudgetBits = 2300
  fillRemainingBitBudget(fixture.transaction, fixture.shared)
  return fixture
}

function createRefinementFixture() {
  const fixture = createFilledFixture()
  const { transaction, shared } = fixture
  quantizeActiveAllocation(transaction)
  transaction.coreMode = 0
  shared.presenceFlags[1][1] = 1
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const block = transaction.channelBlocks[channel]
    block.syntax.spectralNoiseLevelIndices.set(
      channel === 0 ? [2, 3, 4, 5, 6] : [7, 8, 9, 10, 11]
    )
    for (let band = 0; band < 12; band++) {
      block.syntax.scaleFactors[band] = 18 + ((band * 3 + channel) % 11)
      transaction.sourceChannels[channel].bandLevels[band] = Math.fround(
        0.001 + ((band * 5 + channel * 2) % 9) * 0.00025
      )
    }
  }
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  return fixture
}

describe('ATRAC3plus directional second allocation pass', () => {
  it('matches the complete reference search and context commit', () => {
    const { transaction, shared } = createFixture()
    expect(transaction.bitsTotal).toBe(1526)
    expect(searchAllocation(transaction, shared)).toBe(2029)
    expect(transaction.spectrumBits.flatMap((bits) => [...bits])).toEqual([
      965, 1025, 896, 943,
    ])
    expect(transaction.wordLengthTransaction.bits).toBe(76)
    expect(
      transaction.channelBlocks.map((block) => [
        ...block.syntax.wordLengths.slice(0, 12),
      ])
    ).toEqual([
      [2, 5, 7, 4, 7, 3, 6, 2, 5, 7, 4, 7],
      [3, 6, 3, 5, 7, 5, 7, 3, 6, 2, 5, 7],
    ])
    expect(
      transaction.quantizationOffsets.map((offsets) => [
        ...offsets.slice(0, 12),
      ])
    ).toEqual([OFFSETS, OFFSETS])
    expect(
      transaction.channelBlocks.map((block) => [
        block.syntax.codeTableContext,
        ...block.syntax.codeTables.slice(0, 12),
      ])
    ).toEqual([
      [0, 6, 1, 2, 1, 2, 0, 0, 6, 2, 2, 6, 2],
      [0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 6, 2, 2],
    ])
  })

  it('raises high-band offsets in reference scan order when still over budget', () => {
    const { transaction, shared } = createFixture()
    transaction.allocationBudgetBits = 1700
    const total = searchAllocation(transaction, shared)
    expect({
      total,
      offsets: transaction.quantizationOffsets.map((offsets) => [
        ...offsets.slice(0, 12),
      ]),
      spectra: transaction.spectrumBits.map((bits) => bits[0]),
    }).toEqual({
      total: 1717,
      offsets: [
        [0, 0, 0, 0, 0, 0, 0, 0, 12, 12, 12, 12],
        [0, 0, 0, 0, 0, 0, 0, 0, 12, 12, 12, 12],
      ],
      spectra: [911, 646],
    })
  })

  it('spends leftover bits through spectrum and sidechain raises', () => {
    const { transaction, shared } = createFixture()
    searchAllocation(transaction, shared)
    transaction.allocationBudgetBits = 2300

    const total = fillRemainingBitBudget(transaction, shared)
    expect({
      total,
      word: transaction.wordLengthBits,
      code: transaction.codeTableBits,
      spectra: transaction.spectrumBits.map(
        (bits, index) =>
          bits[transaction.channelBlocks[index].syntax.codeTableContext]
      ),
      modes: transaction.channelBlocks.map((block) => [
        ...block.syntax.wordLengths.slice(0, 12),
      ]),
      tables: transaction.channelBlocks.map((block) => [
        ...block.syntax.codeTables.slice(0, 12),
      ]),
    }).toEqual({
      total: 2300,
      word: 68,
      code: 65,
      spectra: [1084, 1041],
      modes: [
        [4, 7, 7, 6, 7, 4, 7, 4, 6, 7, 6, 7],
        [5, 7, 5, 6, 7, 7, 7, 4, 6, 3, 6, 7],
      ],
      tables: [
        [6, 2, 2, 0, 2, 6, 2, 5, 0, 2, 0, 2],
        [2, 2, 2, 0, 2, 2, 2, 5, 0, 0, 0, 2],
      ],
    })
    expect(transaction.codeTableCostAvailable).toBe(true)
    expect(transaction.quantizationDirty).toBe(true)
  })

  it('batches complete priority rounds without changing the exact fill result', () => {
    const exact = createFixture()
    const batched = createFixture()
    for (const fixture of [exact, batched]) {
      searchAllocation(fixture.transaction, fixture.shared)
      fixture.transaction.allocationBudgetBits = 3000
    }

    fillRemainingBitBudget(exact.transaction, exact.shared, false)
    fillRemainingBitBudget(batched.transaction, batched.shared, true)

    const allocation = ({ transaction }) => ({
      total: transaction.bitsTotal,
      sidechains: transaction.sidechainBits,
      modes: transaction.channelBlocks.map((block) => [
        ...block.syntax.wordLengths,
      ]),
      tables: transaction.channelBlocks.map((block) => [
        ...block.syntax.codeTables,
      ]),
      ledgers: transaction.spectrumBits.map((bits) => [...bits]),
    })
    expect(allocation(batched)).toEqual(allocation(exact))
  })

  it('publishes the active memoized quantization rows and clears dirty state', () => {
    const { transaction } = createFilledFixture()
    transaction.channelBlocks[0].quantizedSpectrum.fill(-1234)
    transaction.channelBlocks[1].quantizedSpectrum.fill(2345)

    expect(quantizeActiveAllocation(transaction)).toBe(transaction)
    expect(transaction.quantizationDirty).toBe(false)
    const coefficientCount = QUANTIZATION_UNIT_OFFSETS[12]
    expect(
      transaction.channelBlocks.map((block) =>
        hashInt16(block.quantizedSpectrum.slice(0, coefficientCount))
      )
    ).toEqual(['0241ed8b37fd2d86', 'ebc47a33225ac25d'])
    expect(
      transaction.channelBlocks[0].quantizedSpectrum[coefficientCount]
    ).toBe(-1234)
    expect(
      transaction.channelBlocks[1].quantizedSpectrum[coefficientCount]
    ).toBe(2345)
  })

  it('falls back to direct quantization when the prepared symbol cache is absent', () => {
    const cached = createFilledFixture().transaction
    const direct = createFilledFixture().transaction
    quantizeActiveAllocation(cached)
    for (let channel = 0; channel < direct.channelCount; channel++) {
      direct.spectrumPricingStates[channel].clearCache()
    }
    quantizeActiveAllocation(direct)

    expect(
      direct.channelBlocks.map((block) => [...block.quantizedSpectrum])
    ).toEqual(cached.channelBlocks.map((block) => [...block.quantizedSpectrum]))
  })

  it('validates every channel before publishing any quantized symbols', () => {
    const { transaction } = createFilledFixture()
    transaction.channelBlocks[0].quantizedSpectrum.fill(-1234)
    transaction.channelBlocks[1].quantizedSpectrum.fill(2345)
    const initial = transaction.channelBlocks.map((block) => [
      ...block.quantizedSpectrum,
    ])
    transaction.sourceChannels[1].quantizationThresholdScales[0] = NaN

    expect(() => quantizeActiveAllocation(transaction)).toThrow(
      'active quantization input is invalid'
    )
    expect(
      transaction.channelBlocks.map((block) => [...block.quantizedSpectrum])
    ).toEqual(initial)
    expect(transaction.quantizationDirty).toBe(true)
  })

  it('lowers quantized evidence into spectral-noise rows', () => {
    const { transaction, shared } = createFilledFixture()
    quantizeActiveAllocation(transaction)
    transaction.coreMode = 0
    shared.presenceFlags[1][1] = 1
    for (let channel = 0; channel < transaction.channelCount; channel++) {
      const block = transaction.channelBlocks[channel]
      block.syntax.spectralNoiseLevelIndices.set(
        channel === 0 ? [2, 3, 4, 5, 6] : [7, 8, 9, 10, 11]
      )
      for (let band = 0; band < 12; band++) {
        block.syntax.scaleFactors[band] = 18 + ((band * 3 + channel) % 11)
        transaction.sourceChannels[channel].bandLevels[band] = Math.fround(
          0.001 + ((band * 5 + channel * 2) % 9) * 0.00025
        )
      }
    }
    const refinement = refineSpectralNoiseLevels(
      transaction,
      shared,
      transaction.reconstructionRefinement
    )
    expect({
      slots: [refinement.slotStart, refinement.slotEnd],
      levels: [...refinement.levels.slice(0, transaction.channelCount * 5)],
      seeds: [...refinement.seeds.slice(0, shared.mapCount)],
    }).toEqual({
      slots: [1, 2],
      levels: [15, 4, 15, 15, 15, 15, 4, 15, 15, 15],
      seeds: [540, 668],
    })
    expect(
      transaction.channelBlocks.map((block) => [
        ...block.syntax.spectralNoiseLevelIndices,
      ])
    ).toEqual([
      [...refinement.levels.slice(0, 5)],
      [...refinement.levels.slice(5, 10)],
    ])
  })

  it('refines scale factors and reprices their sidechain', () => {
    const { transaction, shared } = createRefinementFixture()
    for (const block of transaction.channelBlocks.slice(
      0,
      transaction.channelCount
    )) {
      for (
        let coefficient = QUANTIZATION_UNIT_OFFSETS[8];
        coefficient < QUANTIZATION_UNIT_OFFSETS[12];
        coefficient++
      ) {
        block.quantizedSpectrum[coefficient] = Math.trunc(
          block.quantizedSpectrum[coefficient] / 2
        )
      }
    }
    const total = refineScaleFactors(
      transaction,
      shared,
      transaction.reconstructionRefinement
    )
    expect({
      wide: transaction.reconstructionRefinement.wide,
      total,
      scaleFactorBits: transaction.scaleFactorBits,
      rows: transaction.channelBlocks.map((block) => [
        ...block.syntax.scaleFactors.slice(0, 12),
      ]),
    }).toEqual({
      wide: true,
      total: 2380,
      scaleFactorBits: 100,
      rows: [
        [18, 21, 24, 27, 19, 22, 25, 28, 22, 25, 28, 20],
        [19, 22, 25, 28, 20, 23, 26, 18, 23, 26, 29, 21],
      ],
    })
  })

  it('reduces a committed post-refinement allocation with negative-cost offsets', () => {
    const { transaction, shared } = createRefinementFixture()
    for (const block of transaction.channelBlocks.slice(
      0,
      transaction.channelCount
    )) {
      for (
        let coefficient = QUANTIZATION_UNIT_OFFSETS[8];
        coefficient < QUANTIZATION_UNIT_OFFSETS[12];
        coefficient++
      ) {
        block.quantizedSpectrum[coefficient] = Math.trunc(
          block.quantizedSpectrum[coefficient] / 2
        )
      }
    }
    refineScaleFactors(
      transaction,
      shared,
      transaction.reconstructionRefinement
    )
    transaction.cbStartBand = 0

    const total = reduceCommittedAllocationToBudget(transaction, shared)
    expect({
      total,
      codeTableBits: transaction.codeTableBits,
      spectrum: transaction.spectrumBits.map((bits) => bits[0]),
      offsets: transaction.quantizationOffsets.map((offsets) => [
        ...offsets.slice(0, 12),
      ]),
      tables: transaction.channelBlocks.map((block) => [
        ...block.syntax.codeTables.slice(0, 12),
      ]),
    }).toEqual({
      total: 2378,
      codeTableBits: 65,
      spectrum: [1083, 1040],
      offsets: [
        [0, 0, 0, 0, 0, 0, 6, 0, 1, 1, 1, 1],
        [0, 0, 0, 0, 0, 0, 12, 0, 1, 1, 1, 1],
      ],
      tables: [
        [6, 2, 2, 0, 2, 6, 2, 5, 0, 2, 0, 2],
        [2, 2, 2, 0, 2, 2, 2, 5, 0, 0, 0, 2],
      ],
    })
    expect(transaction.quantizationDirty).toBe(true)
  })
})
