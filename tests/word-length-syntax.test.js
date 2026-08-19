import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { MAX_CODING_UNITS } from '../codec/core/constants.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'
import { unpackWordLengthChannel } from '../codec/io/word-length-decoder.js'
import {
  packWordLengthSection,
  planWordLengthSection,
  repriceWordLengthSection,
} from '../codec/io/word-length-syntax.js'

import { ChannelSyntaxState } from '../codec/state/shared.js'
import { WordLengthDecodeScratch } from '../codec/state/decoder-syntax.js'
import { WordLengthAccountingTransaction } from '../codec/state/word-length.js'

const MASK = 0xffffffffffffffffn
const RAW = [
  7, 2, 1, 4, 3, 6, 5, 0, 7, 2, 1, 4, 3, 6, 5, 0, 7, 2, 1, 4, 3, 6, 5, 0, 7, 2,
  1, 4, 3, 6, 5, 0,
]

const fixtures = [
  {
    name: 'primary_raw',
    channels: [RAW],
    payloads: [72],
    bits: 74,
    plans: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    scratchHashes: ['cc2e7a9cd6567f5c'],
    workHash: '426be4d7893f6844',
    byteHash: 'a22c1ad11d41e83c',
    hex: '3a31ea3a31ea3a31ea00',
  },
  {
    name: 'primary_curve',
    channels: [
      [
        7, 6, 7, 6, 7, 5, 6, 5, 6, 5, 5, 4, 5, 4, 5, 3, 4, 3, 4, 3, 3, 2, 3, 2,
        3, 1, 2, 1, 2, 1, 1, 0,
      ],
    ],
    payloads: [62],
    bits: 64,
    plans: [[1, 2, 0, 24, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0]],
    scratchHashes: ['147272f0cace260f'],
    workHash: '607a8be5fc8cb114',
    byteHash: '5a3dd4b146c907fa',
    hex: '60114589a9eeee99',
  },
  {
    name: 'secondary_raw',
    channels: [
      [
        4, 5, 4, 4, 3, 5, 5, 3, 4, 4, 5, 3, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
      ],
      [
        3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 4, 3, 6, 5, 0, 7, 2, 1, 4, 3, 6, 5,
        0, 7, 2, 1, 4, 3, 6, 5,
      ],
    ],
    payloads: [48, 72],
    bits: 124,
    plans: [
      [2, 0, 1, 18, 0, 0, 0, 0, 0, 1, 4, 5, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    scratchHashes: ['93b6c8a46e4dc36e', '0400d3ffbab0200d'],
    workHash: '97ddf378caf215d6',
    byteHash: '28dc440632d75a36',
    hex: '993150f274a007797797798f51d18f50',
  },
  {
    name: 'secondary_direct',
    channels: [RAW, RAW],
    payloads: [72, 28],
    bits: 104,
    plans: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [4, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    scratchHashes: ['cc2e7a9cd6567f5c', 'e3915b401e0b2c97'],
    workHash: '426be4d7893f6844',
    byteHash: '67bde64a0a39df04',
    hex: '3a31ea3a31ea3a31ea10000000',
  },
  {
    name: 'secondary_predict',
    channels: [
      [
        7, 6, 6, 6, 6, 7, 6, 6, 6, 7, 7, 7, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1, 0,
        0, 0, 1, 0, 1, 0, 1, 1,
      ],
      [
        0, 7, 7, 7, 7, 0, 7, 7, 7, 0, 0, 0, 0, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1,
        1, 1, 2, 1, 2, 1, 2, 2,
      ],
    ],
    payloads: [43, 29],
    bits: 76,
    plans: [
      [3, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0],
      [4, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    ],
    scratchHashes: ['bba9922f57b87a97', '24c986376bed82ac'],
    workHash: 'e4608cdc0d426be5',
    byteHash: 'ef57b77c72a7c14f',
    hex: 'c0f8b21fed9c10000000',
  },
  {
    name: 'secondary_delta',
    channels: [
      [
        6, 5, 4, 5, 6, 5, 6, 5, 4, 3, 4, 3, 2, 2, 1, 0, 1, 0, 0, 0, 0, 1, 2, 1,
        1, 2, 1, 2, 3, 2, 2, 2,
      ],
      [
        6, 6, 6, 5, 7, 7, 6, 6, 6, 3, 5, 5, 2, 3, 3, 0, 2, 2, 0, 1, 2, 1, 3, 3,
        1, 3, 3, 2, 4, 4, 2, 3,
      ],
    ],
    payloads: [48, 56],
    bits: 108,
    plans: [
      [2, 0, 0, 24, 0, 0, 0, 0, 0, 0, 5, 2, 0, 0],
      [3, 2, 0, 24, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0],
    ],
    scratchHashes: ['0ae576b456c243b1', '1846518259914c0a'],
    workHash: 'adf5fd30364afb97',
    byteHash: 'a25caa7cb0c73d27',
    hex: '8294d2687bfd3848a1ab46ad27a0',
  },
  {
    name: 'primary_run_tail',
    channels: [
      [
        0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0,
        0, 2, 4, 6, 0, 2, 4, 6,
      ],
      [
        7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5,
        7, 1, 3, 5, 7, 1, 3, 5,
      ],
    ],
    payloads: [49, 65],
    bits: 118,
    plans: [
      [3, 0, 3, 12, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      [4, 0, 0, 24, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1],
    ],
    scratchHashes: ['3e0b937a9294385f', 'e6a8f820efee317e'],
    workHash: '90a2852a84daf2fe',
    byteHash: 'f63b5d732d5f975c',
    hex: 'cd922db6db6db1d001733333333730',
  },
  {
    name: 'secondary_literal_tail',
    channels: [
      [
        2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0,
        2, 4, 6, 0, 2, 4, 6, 0,
      ],
      [
        1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
        1, 3, 5, 7, 1, 3, 5, 7,
      ],
    ],
    payloads: [72, 34],
    bits: 110,
    plans: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [4, 0, 2, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    ],
    scratchHashes: ['d17b51a507f521d1', 'ecdb6b52fa7d826d'],
    workHash: '7b6a9f9e15f90403',
    byteHash: '22cdc8de80f2501f',
    hex: '14c14c14c14c14c14c29c6000aa8',
  },
  {
    name: 'secondary_run_tail',
    channels: [
      [
        5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7, 1, 3,
        5, 7, 1, 3, 5, 7, 1, 3,
      ],
      [
        0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 6, 0, 2, 4, 1, 1, 1, 1, 1, 1, 0, 0, 0,
        0, 2, 4, 6, 0, 2, 4, 6,
      ],
    ],
    payloads: [72, 29],
    bits: 105,
    plans: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [4, 0, 3, 15, 6, 0, 0, 0, 0, 3, 0, 0, 0, 1],
    ],
    scratchHashes: ['ac8f166657aa16e5', 'aba84a75f0d61bb2'],
    workHash: '1089d3034b7ce418',
    byteHash: '6462fe64402b4a48',
    hex: '2f2ef2ef2ef2ef2ef2edffa00000',
  },
]

function createHash() {
  return { value: 0xcbf29ce484222325n }
}

function addWord(hash, word) {
  let value = word >>> 0
  for (let byte = 0; byte < 4; byte++) {
    hash.value = ((hash.value ^ BigInt(value & 0xff)) * 0x100000001b3n) & MASK
    value >>>= 8
  }
}

function hashWords(add) {
  const hash = createHash()
  add((word) => addWord(hash, word))
  return hash.value.toString(16).padStart(16, '0')
}

function hashScratch(scratch) {
  return hashWords((add) => {
    for (const row of [
      scratch.candidateRows,
      scratch.bandCounts,
      scratch.mapIndices,
      scratch.rowMeta,
      scratch.deltaModeHuffmanBits,
      scratch.channelHuffmanBits,
    ]) {
      for (const value of row) add(value)
    }
    for (const value of scratch.rowNegativeCounts) add(value)
    for (let row = 0; row < 4; row++) {
      add(scratch.rowNonzeroMasks[row])
      add(scratch.rowNononeMasks[row])
      add(scratch.rowAboveOneMasks[row])
    }
  })
}

function hashWork(work) {
  return hashWords((add) => {
    add(work.mode1Lead)
    add(work.mode1Width)
    add(work.mode1Base)
    add(work.mode1PayloadBits)
    for (let group = 0; group < 4; group++) {
      for (const value of work.shapeRows[group]) add(value)
      add(work.shapeCounts[group])
      add(work.shapeBases[group])
      add(work.shapeShifts[group])
    }
    for (const value of work.shapeAverages) add(value)
  })
}

function hashBytes(bytes) {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

function planFields(plan) {
  return [
    plan.kind,
    plan.delta,
    plan.tailMode,
    plan.tailCount,
    plan.tailExtra,
    plan.lead,
    plan.width,
    plan.base,
    plan.pairFlag,
    plan.codebook,
    plan.shapeBase,
    plan.shapeShift,
    plan.first,
    plan.channelMode,
  ]
}

function createBlock(channelOrdinal, values) {
  const block = {
    channelOrdinal,
    primaryChannelOrdinal: 0,
    syntax: new ChannelSyntaxState(),
  }
  block.syntax.wordLengths.set(values)
  return block
}

describe('ATRAC3plus word-length syntax planning and emission', () => {
  it('matches reference across all primary and secondary mode families', () => {
    for (const fixture of fixtures) {
      const blocks = fixture.channels.map((values, channel) =>
        createBlock(channel, values)
      )
      const transaction = new WordLengthAccountingTransaction()
      const rowIdentities = transaction.scratch.map((scratch) => [
        ...scratch.rows,
      ])
      const shapeIdentities = [...transaction.work.shapeRows]

      planWordLengthSection(blocks, 24, 8, transaction)
      const first = {
        bits: transaction.bits,
        plans: transaction.plans.slice(0, blocks.length).map(planFields),
        scratch: transaction.scratch.slice(0, blocks.length).map(hashScratch),
        work: hashWork(transaction.work),
      }
      planWordLengthSection(blocks, 24, 8, transaction)
      expect({
        bits: transaction.bits,
        plans: transaction.plans.slice(0, blocks.length).map(planFields),
        scratch: transaction.scratch.slice(0, blocks.length).map(hashScratch),
        work: hashWork(transaction.work),
      }).toEqual(first)
      for (let channel = 0; channel < rowIdentities.length; channel++) {
        for (let row = 0; row < 4; row++) {
          expect(transaction.scratch[channel].rows[row]).toBe(
            rowIdentities[channel][row]
          )
        }
      }
      for (let group = 0; group < 4; group++) {
        expect(transaction.work.shapeRows[group]).toBe(shapeIdentities[group])
      }

      const bytes = new Uint8Array(128)
      const writer = new BitWriter(bytes)
      packWordLengthSection(blocks, transaction, writer)
      const counter = new BitCounter()
      packWordLengthSection(blocks, transaction, counter)
      const used = Math.ceil(writer.bitPosition / 8)
      expect(
        {
          payloads: transaction.plans
            .slice(0, blocks.length)
            .map((plan) => plan.bits),
          bits: transaction.bits,
          measured: counter.bitPosition,
          packed: writer.bitPosition,
          plans: transaction.plans.slice(0, blocks.length).map(planFields),
          scratchHashes: transaction.scratch
            .slice(0, blocks.length)
            .map(hashScratch),
          workHash: hashWork(transaction.work),
          byteHash: hashBytes(bytes.slice(0, used)),
          hex: Buffer.from(bytes.slice(0, used)).toString('hex'),
        },
        fixture.name
      ).toEqual({
        payloads: fixture.payloads,
        bits: fixture.bits,
        measured: fixture.bits,
        packed: fixture.bits,
        plans: fixture.plans,
        scratchHashes: fixture.scratchHashes,
        workHash: fixture.workHash,
        byteHash: fixture.byteHash,
        hex: fixture.hex,
      })

      const reader = new BitReader(bytes)
      const decodeScratch = new WordLengthDecodeScratch()
      const decoded = fixture.channels.map(() => new ChannelSyntaxState())
      for (let channel = 0; channel < decoded.length; channel++) {
        unpackWordLengthChannel(
          decoded[channel],
          channel === 0 ? null : decoded[0],
          channel,
          24,
          reader,
          decodeScratch
        )
      }
      expect(reader.bitPosition, fixture.name).toBe(writer.bitPosition)
      expect(
        decoded.map((syntax) => [...syntax.wordLengths]),
        fixture.name
      ).toEqual(
        fixture.channels.map((values) => [
          ...values.slice(0, 24),
          ...Array(8).fill(0),
        ])
      )
    }
  })

  it('reprices edits without mutating the accepted image', () => {
    const blocks = [createBlock(0, RAW), createBlock(1, RAW)]
    const transaction = new WordLengthAccountingTransaction()
    planWordLengthSection(blocks, 24, 8, transaction)
    const initial = {
      payloads: [72, 28],
      bits: 104,
      plans: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [4, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ],
    }

    function acceptedState() {
      return {
        payloads: transaction.plans.map((plan) => plan.bits),
        bits: transaction.bits,
        plans: transaction.plans.map(planFields),
      }
    }

    function candidateState(changedChannel, bits) {
      return {
        bits,
        plans: transaction.candidatePlans.slice(changedChannel).map(planFields),
      }
    }

    function reprice(changedChannel, changedBand) {
      return repriceWordLengthSection(
        blocks,
        changedChannel,
        changedBand,
        transaction
      )
    }

    expect(acceptedState()).toEqual(initial)
    blocks[0].syntax.wordLengths[7] = 6
    expect(candidateState(0, reprice(0, 7))).toEqual({
      bits: 106,
      plans: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [4, 0, 0, 24, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      ],
    })
    transaction.discardCandidate()
    blocks[0].syntax.wordLengths[7] = RAW[7]
    expect(acceptedState()).toEqual(initial)

    blocks[1].syntax.wordLengths[9] = 7
    expect(candidateState(1, reprice(1, 9))).toEqual({
      bits: 107,
      plans: [[4, 0, 0, 24, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0]],
    })
    transaction.acceptCandidate()

    blocks[0].syntax.wordLengths[20] = 0
    expect(candidateState(0, reprice(0, 20))).toEqual({
      bits: 111,
      plans: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [4, 0, 0, 24, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0],
      ],
    })
    transaction.acceptCandidate()
    expect(transaction.bits).toBe(111)
  })

  it('matches complete planning for every deterministic single-band edit', () => {
    const cases = [
      { channelCount: 1, bandLimit: 12, sideDataBandCount: 4 },
      { channelCount: 2, bandLimit: 24, sideDataBandCount: 8 },
      { channelCount: 2, bandLimit: 32, sideDataBandCount: 10 },
    ]
    for (const geometry of cases) {
      const rows = Array.from({ length: geometry.channelCount }, (_, channel) =>
        Array.from(
          { length: 32 },
          (_unused, band) => (band * 5 + channel * 3 + (band >> 2)) & 7
        )
      )
      const blocks = rows.map((values, channel) => createBlock(channel, values))
      const incremental = new WordLengthAccountingTransaction()
      const complete = new WordLengthAccountingTransaction()
      planWordLengthSection(
        blocks,
        geometry.bandLimit,
        geometry.sideDataBandCount,
        incremental
      )
      for (
        let changedChannel = 0;
        changedChannel < blocks.length;
        changedChannel++
      ) {
        for (
          let changedBand = 0;
          changedBand < geometry.bandLimit;
          changedBand++
        ) {
          const oldValue =
            blocks[changedChannel].syntax.wordLengths[changedBand]
          for (const step of [1, 4]) {
            blocks[changedChannel].syntax.wordLengths[changedBand] =
              (oldValue + step) & 7
            const candidateBits = repriceWordLengthSection(
              blocks,
              changedChannel,
              changedBand,
              incremental
            )
            planWordLengthSection(
              blocks,
              geometry.bandLimit,
              geometry.sideDataBandCount,
              complete
            )
            const candidatePlans = blocks.map((_block, channel) =>
              planFields(
                channel < changedChannel
                  ? incremental.plans[channel]
                  : incremental.candidatePlans[channel]
              )
            )
            const candidateScratch = blocks.map((_block, channel) =>
              hashScratch(
                channel < changedChannel
                  ? incremental.scratch[channel]
                  : incremental.candidateScratch[channel]
              )
            )
            expect(
              {
                bits: candidateBits,
                plans: candidatePlans,
                scratch: candidateScratch,
              },
              `${geometry.channelCount}:${geometry.bandLimit}:${changedChannel}:${changedBand}:${step}`
            ).toEqual({
              bits: complete.bits,
              plans: complete.plans.slice(0, blocks.length).map(planFields),
              scratch: complete.scratch
                .slice(0, blocks.length)
                .map(hashScratch),
            })
            incremental.discardCandidate()
          }
          blocks[changedChannel].syntax.wordLengths[changedBand] = oldValue
        }
      }
    }
  })

  it('owns one stable transaction per pooled coding unit', () => {
    const pool = new BufferPool()
    const transactions = pool.encoder.frame.wordLengthTransactions
    expect(transactions).toHaveLength(MAX_CODING_UNITS)
    expect(new Set(transactions).size).toBe(MAX_CODING_UNITS)
    expect(
      transactions.every(
        (transaction) => transaction instanceof WordLengthAccountingTransaction
      )
    ).toBe(true)
  })
})
