import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { MAX_CODING_UNITS } from '../codec/core/constants.js'
import {
  packCodeTableSection,
  planCodeTableSection,
  repriceCodeTableSection,
} from '../codec/io/code-table-syntax.js'
import { unpackCodeTableSection } from '../codec/io/code-table-decoder.js'
import { BitReader, BitWriter } from '../codec/io/bitstream.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import { ChannelSyntaxState, SharedState } from '../codec/state/shared.js'
import { CodeTableAccountingTransaction } from '../codec/state/code-table.js'

const fullWords = Array(32).fill(0)
fullWords.fill(1, 0, 24)
const zero = Array(32).fill(0)

const fixed = zero.slice()
fixed.splice(0, 16, 0, 3, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1)

const diff = zero.slice()
diff.splice(0, 16, 0, 7, 2, 1, 4, 3, 6, 5, 0, 7, 2, 1, 4, 3, 6, 5)

const explicit = zero.slice()
explicit.splice(0, 6, 1, 0, 3, 2, 1, 0)

const secondaryWords = zero.slice()
for (let band = 0; band < 16; band++) {
  secondaryWords[band] = Number(band % 3 !== 1)
}
const primary = zero.slice()
primary.splice(0, 16, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6)
const secondary = zero.slice()
secondary.splice(0, 16, 1, 1, 5, 7, 1, 2, 5, 1, 7, 3, 1, 5, 0, 1, 5, 6)

const fixtures = [
  {
    name: 'primary pair-empty',
    words: [fullWords],
    values: [zero],
    count: 16,
    fixIndex: 0,
    entropy: true,
    bits: 4,
    hex: '30',
    states: [[65535, 0, 0, 16, 16, [32, 16, 16, 0], [32, 16, 16, 0]]],
    plans: [[3, 0, false, 0]],
  },
  {
    name: 'primary fixed',
    words: [fullWords],
    values: [fixed],
    count: 16,
    fixIndex: 0,
    entropy: true,
    bits: 37,
    hex: '01c9c9c9c8',
    states: [[65535, 0, 61166, 16, 16, [32, 36, 46, 0], [32, 36, 46, 0]]],
    plans: [[0, 16, false, 33]],
  },
  {
    name: 'primary differential',
    words: [fullWords],
    values: [diff],
    count: 16,
    fixIndex: 1,
    entropy: true,
    bits: 52,
    hex: 'a1a69a69a69a60',
    states: [[65535, 0, 65278, 16, 16, [48, 50, 47, 0], [48, 50, 47, 0]]],
    plans: [[2, 16, false, 48]],
  },
  {
    name: 'explicit entropy prefix',
    words: [fullWords],
    values: [explicit],
    count: 24,
    fixIndex: 1,
    entropy: true,
    bits: 24,
    hex: '99511a',
    states: [[16777215, 0, 29, 24, 5, [15, 14, 15, 0], [72, 52, 54, 0]]],
    plans: [[1, 5, true, 20]],
  },
  {
    name: 'entropy modes disabled',
    words: [fullWords],
    values: [explicit],
    count: 24,
    fixIndex: 1,
    entropy: false,
    bits: 77,
    hex: '810d1000000000000000',
    states: [[16777215, 0, 29, 24, 24, [72, 52, 54, 0], [72, 52, 54, 0]]],
    plans: [[0, 24, false, 73]],
  },
  {
    name: 'stereo pair with one-bit bands',
    words: [fullWords, secondaryWords],
    values: [primary, secondary],
    count: 16,
    fixIndex: 1,
    entropy: true,
    bits: 90,
    hex: 'a0db6db6db6dbe9929f9f600',
    states: [
      [65535, 0, 61166, 16, 16, [48, 48, 47, 0], [48, 48, 47, 0]],
      [56173, 9362, 61439, 16, 16, [38, 40, 41, 34], [38, 40, 41, 34]],
    ],
    plans: [
      [2, 16, false, 48],
      [3, 16, false, 35],
    ],
  },
]

function createFixture(words, values, count, fixIndex) {
  const blocks = words.map((wordLengths, channel) => {
    const block = new EncodeChannelState(channel)
    block.syntax.wordLengths.set(wordLengths)
    block.syntax.codeTables.set(values[channel])
    block.syntax.codeTableContext = channel
    return block
  })
  const shared = new SharedState()
  shared.scaleFactorCount = count
  shared.gainModeFlag = fixIndex
  return {
    blocks,
    shared,
  }
}

function packedHex(fixture, transaction) {
  const bytes = new Uint8Array(128)
  const writer = new BitWriter(bytes)
  packCodeTableSection(fixture.blocks, transaction, writer)
  return {
    bits: writer.bitPosition,
    hex: Buffer.from(
      bytes.subarray(0, Math.ceil(writer.bitPosition / 8))
    ).toString('hex'),
  }
}

function expectState(state, expected) {
  expect([
    state.valueMask,
    state.oneBitMask,
    state.positiveValueMask,
    state.maxCount,
    state.usedCount,
    Array.from(state.prefixBits),
    Array.from(state.fullBits),
  ]).toEqual(expected)
}

function expectPlan(plan, expected) {
  expect([plan.mode, plan.count, plan.explicit, plan.bits]).toEqual(expected)
}

describe('ATRAC3plus code-table syntax', () => {
  for (const expected of fixtures) {
    it(`matches reference for ${expected.name}`, () => {
      const fixture = createFixture(
        expected.words,
        expected.values,
        expected.count,
        expected.fixIndex
      )
      const transaction = new CodeTableAccountingTransaction()
      planCodeTableSection(
        fixture.blocks,
        fixture.shared,
        expected.entropy,
        transaction
      )

      expect(transaction.bits).toBe(expected.bits)
      expect(packedHex(fixture, transaction)).toEqual({
        bits: expected.bits,
        hex: expected.hex,
      })
      for (let channel = 0; channel < expected.states.length; channel++) {
        expectState(transaction.states[channel], expected.states[channel])
        expectPlan(transaction.syntaxes[channel], expected.plans[channel])
      }

      const decoded = expected.words.map((wordLengths) => {
        const syntax = new ChannelSyntaxState()
        syntax.wordLengths.set(wordLengths)
        return syntax
      })
      const decodedShared = new SharedState()
      decodedShared.scaleFactorCount = expected.count
      const reader = new BitReader(Buffer.from(expected.hex, 'hex'))
      unpackCodeTableSection(decoded, decodedShared, reader)
      expect(reader.bitPosition).toBe(expected.bits)
      expect(decodedShared.gainModeFlag).toBe(expected.fixIndex)
      for (let channel = 0; channel < decoded.length; channel++) {
        expect([...decoded[channel].codeTables]).toEqual(
          expected.values[channel]
        )
        expect(decoded[channel].codeTableContext).toBe(channel)
      }
    })
  }

  it('keeps accepted and speculative incremental images isolated', () => {
    const fixture = createFixture(
      [fullWords, secondaryWords],
      [primary, secondary],
      16,
      1
    )
    const transaction = new CodeTableAccountingTransaction()
    planCodeTableSection(fixture.blocks, fixture.shared, true, transaction)

    repriceCodeTableSection(0, 2, 4, 7, transaction)
    expect(transaction.candidateBits).toBe(92)
    expectState(transaction.candidateStates[0], [
      65535,
      0,
      61166,
      16,
      16,
      [48, 49, 48, 0],
      [48, 49, 48, 0],
    ])
    expectState(transaction.candidateStates[1], [
      56173,
      9362,
      61439,
      16,
      16,
      [38, 40, 41, 35],
      [38, 40, 41, 35],
    ])
    transaction.discardCandidate()
    expect(transaction.bits).toBe(90)
    expect(packedHex(fixture, transaction).hex).toBe('a0db6db6db6dbe9929f9f600')

    repriceCodeTableSection(1, 10, 1, 6, transaction)
    expect(transaction.candidateBits).toBe(90)
    transaction.acceptCandidate()
    expect(packedHex(fixture, transaction).hex).toBe('a0db6db6db6dbe9929f8f600')

    repriceCodeTableSection(0, 5, 2, 5, transaction)
    expect(transaction.candidateBits).toBe(94)
    expectState(transaction.candidateStates[0], [
      65535,
      0,
      61166,
      16,
      16,
      [48, 48, 48, 0],
      [48, 48, 48, 0],
    ])
    expectState(transaction.candidateStates[1], [
      56173,
      9362,
      61439,
      16,
      16,
      [38, 40, 41, 37],
      [38, 40, 41, 37],
    ])
    transaction.acceptCandidate()
    expect(transaction.bits).toBe(94)
    expect(transaction.syntaxes.map((syntax) => syntax.bits)).toEqual([49, 38])
    expect(packedHex(fixture, transaction)).toEqual({
      bits: 94,
      hex: '80530b305305374c9d9f8f60',
    })
  })

  it('owns one stable transaction per maximum coding unit', () => {
    const pool = new BufferPool()
    const transactions = pool.encoder.frame.codeTableTransactions
    expect(transactions).toHaveLength(MAX_CODING_UNITS)
    expect(new Set(transactions).size).toBe(MAX_CODING_UNITS)
    expect(
      transactions.every(
        (transaction) => transaction instanceof CodeTableAccountingTransaction
      )
    ).toBe(true)
  })

  it('emits no section when the scale-factor count is zero', () => {
    const fixture = createFixture([fullWords], [fixed], 0, 1)
    const transaction = new CodeTableAccountingTransaction()
    planCodeTableSection(fixture.blocks, fixture.shared, true, transaction)
    expect(transaction.bits).toBe(0)
    expect(packedHex(fixture, transaction)).toEqual({
      bits: 0,
      hex: '',
    })
  })

  it('retains incumbent accounting over a newly current value model', () => {
    const fixture = createFixture(
      [fullWords, secondaryWords],
      [primary, secondary],
      16,
      1
    )
    const transaction = planCodeTableSection(
      fixture.blocks,
      fixture.shared,
      true,
      new CodeTableAccountingTransaction()
    )
    expect(transaction.modeledBits).toBe(90)
    transaction.retainAccountedBits(87)
    expect(transaction.bits).toBe(87)
    expect(transaction.modeledBits).toBe(90)

    repriceCodeTableSection(0, 2, 4, 7, transaction)
    expect(transaction.candidateBits).toBe(92)
    transaction.acceptCandidate()
    expect(transaction.bits).toBe(92)
    expect(transaction.modeledBits).toBe(92)
  })
})
