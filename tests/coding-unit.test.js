import { describe, expect, it } from 'vitest'

import { selectGainSyntax } from '../codec/io/gain-syntax.js'
import { planScaleFactorSection } from '../codec/io/scale-factor-syntax.js'

import { planRawWordLengthSection } from '../codec/io/word-length-syntax.js'
import { planCodeTableSection } from '../codec/io/code-table-syntax.js'
import { packCodingUnit } from '../codec/io/coding-unit.js'
import { unpackCodingUnit } from '../codec/io/coding-unit-decoder.js'

import { BitReader, BitWriter } from '../codec/io/bitstream.js'
import { DecodeChannelState } from '../codec/state/decoder.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { SharedState } from '../codec/state/shared.js'
import { CodingUnitAllocationTransaction } from '../codec/state/allocation.js'
import { CodeTableAccountingTransaction } from '../codec/state/code-table.js'
import { CodingUnitDecodeScratch } from '../codec/state/decoder-syntax.js'
import { GainCodingPlan } from '../codec/state/gain.js'
import { ScaleFactorCodingPlan } from '../codec/state/scale-factor.js'
import { SpectrumSyntaxScratch } from '../codec/state/spectrum.js'
import { ToneCodingPlan } from '../codec/state/tone.js'
import { WordLengthAccountingTransaction } from '../codec/state/word-length.js'

function createActiveMonoFixture() {
  const shared = new SharedState()
  shared.bandLimit = 1
  shared.scaleFactorCount = 1
  shared.quantizationUnitCount = 1
  shared.gainModeFlag = 0

  const block = new EncodeChannelState(0)
  block.syntax.wordLengths[0] = 1
  block.syntax.scaleFactors[0] = 7
  block.syntax.codeTables[0] = 0
  block.scaleFactorEncode.modeSelect = 0
  block.quantizedSpectrum[0] = 1
  block.quantizedSpectrum[1] = -1

  const blocks = [block]
  const wordLength = planRawWordLengthSection(
    blocks,
    1,
    new WordLengthAccountingTransaction()
  )
  const scaleFactor = planScaleFactorSection(
    blocks,
    shared,
    new ScaleFactorCodingPlan()
  )
  const codeTable = planCodeTableSection(
    blocks,
    shared,
    false,
    new CodeTableAccountingTransaction()
  )
  const gain = selectGainSyntax(blocks, 0, 0, new GainCodingPlan())
  const tone = new ToneCodingPlan().clear(1)
  const transaction = new CodingUnitAllocationTransaction().reset(1)
  transaction.channelBlocks[0] = block
  transaction.wordLengthTransaction = wordLength
  transaction.scaleFactorPlan = scaleFactor
  transaction.codeTableTransaction = codeTable
  transaction.gainPlan = gain
  transaction.tonePlan = tone
  return { block, shared, transaction }
}

describe('ATRAC3plus coding-unit emission', () => {
  it('matches reference for an active one-band mono coding unit', () => {
    const { shared, transaction } = createActiveMonoFixture()

    const bytes = new Uint8Array(5)
    const writer = new BitWriter(bytes)
    expect(
      packCodingUnit(transaction, shared, new SpectrumSyntaxScratch(), writer)
    ).toBe(40)
    expect(Buffer.from(bytes).toString('hex')).toBe('0020e03900')

    const decodedBlock = new DecodeChannelState(0)
    const decodedShared = new SharedState()
    const reader = new BitReader(bytes)
    expect(
      unpackCodingUnit(
        [decodedBlock],
        decodedShared,
        reader,
        new CodingUnitDecodeScratch()
      )
    ).toBe(40)
    expect(reader.bitPosition).toBe(40)
    expect([
      decodedShared.bandLimit,
      decodedShared.scaleFactorCount,
      decodedShared.gainModeFlag,
      decodedShared.noisePresent,
    ]).toEqual([1, 1, 0, 0])
    expect([...decodedBlock.syntax.wordLengths.slice(0, 2)]).toEqual([1, 0])
    expect([...decodedBlock.syntax.scaleFactors.slice(0, 2)]).toEqual([7, 0])
    expect([...decodedBlock.syntax.codeTables.slice(0, 2)]).toEqual([0, 0])
    expect([...decodedBlock.quantizedSpectrum.slice(0, 4)]).toEqual([
      1, -1, 0, 0,
    ])
    expect(decodedBlock.gain.hasData).toBe(0)
    expect(decodedBlock.toneSlots[1].active).toBe(false)
  })
})
