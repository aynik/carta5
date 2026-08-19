import { describe, expect, it } from 'vitest'

import { initializeQuantizationOffsets } from '../codec/coding/quantization-offset.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { CodingUnitAllocationTransaction } from '../codec/state/allocation.js'
import { SpectrumPricingState } from '../codec/state/spectrum-pricing.js'
import { MONO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND } from '../codec/core/tables.js'

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

function createOffsetFixture() {
  const quantizationUnits = new Int32Array(64)
  for (let channel = 0; channel < 2; channel++) {
    for (let band = 0; band < 32; band++) {
      quantizationUnits[channel * 32 + band] =
        ((band * 5 + channel * 9) % 22) + 1
    }
  }
  const transaction = new CodingUnitAllocationTransaction().reset(2)
  transaction.bandCount = 27
  transaction.coreMode = 12
  transaction.sampleRateHz = 48000
  transaction.quantizationUnits.set(quantizationUnits)
  const channels = [new EncodeChannelState(0), new EncodeChannelState(1)]
  const pricing = [new SpectrumPricingState(), new SpectrumPricingState()]
  for (let channel = 0; channel < 2; channel++) {
    channels[channel].syntax.codeTableContext = channel
    for (let band = 0; band < 27; band++) {
      channels[channel].syntax.wordLengths[band] =
        (band + channel) % 3 === 0 ? 1 : 2
      const selected = (band + channel * 3) % 8
      const work = channel * 32 + band
      pricing[channel].selectedIndices[work] = selected
      pricing[channel].selectedCosts[work] =
        35 + ((band * 13 + channel * 17 + selected * 7) % 91)
    }
  }
  transaction.channelBlocks.splice(0, 2, ...channels)
  transaction.spectrumPricingStates.splice(0, 2, ...pricing)
  return transaction
}

describe('ATRAC3plus quantization offsets', () => {
  it('matches low-rate base/high-band bumps and 48 kHz remapping', () => {
    const transaction = createOffsetFixture()
    const offsetsIdentity = transaction.quantizationOffsets
    const rowIdentities = [...offsetsIdentity]
    expect(initializeQuantizationOffsets(transaction)).toBe(offsetsIdentity)
    expect(transaction.quantizationOffsets).toEqual(rowIdentities)
    expect([transaction.cbStartBand, transaction.cbIterationLimit]).toEqual([
      8, 12,
    ])
    expect(
      fnv32Words([
        ...transaction.quantizationOffsets[0],
        ...transaction.quantizationOffsets[1],
      ])
    ).toBe('413836c3d6f52a87')
    expect(Array.from(transaction.quantizationOffsets[0].slice(0, 27))).toEqual(
      [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 1, 1, 4, 3, 3, 6, 4, 4, 15, 4, 4, 5, 4,
        4, 9, 4, 4,
      ]
    )
    expect(Array.from(transaction.quantizationOffsets[1].slice(0, 27))).toEqual(
      [
        0, 0, 0, 0, 0, 0, 0, 0, 10, 1, 1, 1, 3, 3, 5, 3, 4, 8, 4, 4, 4, 4, 4, 7,
        4, 4, 10,
      ]
    )
  })

  it('keeps high-rate modes at their table-derived base offsets', () => {
    const transaction = new CodingUnitAllocationTransaction().reset(1)
    transaction.bandCount = 32
    transaction.coreMode = 23
    transaction.sampleRateHz = 44100
    const channel = new EncodeChannelState(0)
    channel.syntax.wordLengths.fill(1)
    transaction.channelBlocks[0] = channel
    transaction.spectrumPricingStates[0] = new SpectrumPricingState()
    initializeQuantizationOffsets(transaction)
    expect(Array.from(transaction.quantizationOffsets[0])).toEqual(
      Array.from(
        MONO_QUANTIZATION_OFFSET_BASE_BY_MODE_AND_BAND.slice(23 * 32, 24 * 32)
      )
    )
  })
})
