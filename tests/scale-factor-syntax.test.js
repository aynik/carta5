import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'
import { unpackScaleFactorChannel } from '../codec/io/scale-factor-decoder.js'
import {
  packScaleFactorSection,
  planScaleFactorSection,
} from '../codec/io/scale-factor-syntax.js'

import { ChannelSyntaxState, SharedState } from '../codec/state/shared.js'
import { ScaleFactorDecodeScratch } from '../codec/state/decoder-syntax.js'
import { ScaleFactorEncodeState } from '../codec/state/encoder-syntax.js'
import { ScaleFactorCodingPlan } from '../codec/state/scale-factor.js'

const MASK = 0xffffffffffffffffn

const RAW = [
  42, 1, 44, 27, 62, 5, 32, 63, 18, 9, 20, 35, 38, 13, 8, 7, 58, 17, 60, 43, 14,
  21, 48, 15,
]
const DELTA_RAW = [
  17, 18, 17, 16, 15, 14, 13, 13, 14, 14, 13, 12, 12, 12, 12, 13, 13, 14, 14,
  13, 12, 13, 14, 13,
]

const fixtures = [
  {
    name: 'raw',
    count: 24,
    channels: [RAW],
    payloads: [144],
    bits: 146,
    states: [[0, 23, 0, 15, 0, 0, 3, 29]],
    stateHashes: ['527ff3ee2349132a'],
    byteHash: '3bd6fbf0d14c033d',
    hex: '2a06c6fe160fd22548e63481fa47cace5703c0',
  },
  {
    name: 'range_raw',
    count: 24,
    channels: [Array(24).fill(24)],
    payloads: [16],
    bits: 18,
    states: [[1, 0, 0, 24, 0, 0, 0, 24]],
    stateHashes: ['eda97726ae59c363'],
    byteHash: '03976e19a5fd8781',
    hex: '400600',
  },
  {
    name: 'range_shape',
    count: 32,
    channels: [
      [
        34, 35, 36, 41, 42, 43, 34, 34, 32, 38, 39, 38, 30, 32, 31, 39, 40, 38,
        42, 42, 41, 41, 40, 41, 33, 33, 33, 28, 28, 29, 30, 28,
      ],
    ],
    payloads: [136],
    bits: 138,
    states: [[1, 15, 3, 6, 0, 3, 3, 35]],
    stateHashes: ['5150c41434b5b491'],
    byteHash: '0e13e1a284a0e6e4',
    hex: '78c37facf1bdecc95748cae2daeb8004a640',
  },
  {
    name: 'delta_raw',
    count: 24,
    channels: [DELTA_RAW],
    payloads: [65],
    bits: 67,
    states: [[3, 4, 2, 12, 2, 0, 13, 17]],
    stateHashes: ['10976750c91d547e'],
    byteHash: 'acbd6aadc21b85f0',
    hex: 'c9196db516888b64a0',
  },
  {
    name: 'delta_shape',
    count: 32,
    channels: [
      [
        45, 45, 44, 37, 37, 37, 43, 42, 41, 41, 39, 39, 46, 47, 46, 44, 42, 43,
        44, 45, 46, 40, 41, 41, 42, 40, 42, 38, 36, 38, 37, 37,
      ],
    ],
    payloads: [117],
    bits: 119,
    states: [[3, 21, 3, 0xfffffffd, 1, 3, 44, 45]],
    stateHashes: ['b19740701e63379a'],
    byteHash: 'cfe3890dbd01f57a',
    hex: 'f6db20b03bb4872ad89a5f208ff8e8',
  },
  {
    name: 'stereo_raw',
    count: 24,
    channels: [
      [
        3, 8, 17, 22, 31, 36, 45, 50, 59, 0, 9, 14, 23, 28, 37, 42, 51, 56, 1,
        6, 15, 20, 29, 34,
      ],
      [
        38, 8, 58, 60, 14, 48, 34, 36, 54, 24, 10, 12, 30, 0, 50, 52, 6, 40, 26,
        28, 46, 16, 2, 4,
      ],
    ],
    payloads: [144, 144],
    bits: 292,
    states: [
      [0, 23, 0, 34, 0, 0, 0, 9],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ],
    stateHashes: ['9fbcf4890cef8fc0', '9986ba9af2021da5'],
    byteHash: '344a9ac0be2b4a0b',
    hex: '0321159f92dcbb009397725ab3e0118f51d88988ebc3b08a4d9828c780cb41a869cb900840',
  },
  {
    name: 'stereo_predict',
    count: 24,
    channels: [DELTA_RAW, DELTA_RAW.map((value) => value + 1)],
    payloads: [65, 28],
    bits: 97,
    states: [
      [3, 4, 2, 12, 2, 0, 13, 17],
      [2, 0, 0, 0, 2, 0, 0, 0],
    ],
    stateHashes: ['10976750c91d547e', '99a2b78485486e25'],
    byteHash: '4685225520398aaf',
    hex: 'c9196db516888b64b500000000',
  },
  {
    name: 'stereo_direct',
    count: 24,
    channels: [
      [
        12, 13, 12, 14, 13, 14, 14, 15, 14, 16, 15, 16, 16, 17, 16, 18, 17, 18,
        18, 19, 18, 20, 19, 20,
      ],
      [
        12, 14, 14, 14, 14, 16, 14, 16, 16, 16, 16, 18, 16, 18, 18, 18, 18, 20,
        18, 20, 20, 20, 20, 22,
      ],
    ],
    payloads: [71, 66],
    bits: 141,
    states: [
      [3, 3, 3, 13, 1, 1, 0, 12],
      [1, 0, 0, 0, 1, 0, 0, 0],
    ],
    stateHashes: ['7aabada67537cc04', '1978bc26285ef565'],
    byteHash: 'db4881d86f635a81',
    hex: 'd4c431243124312431289898989898989898',
  },
  {
    name: 'stereo_copy',
    count: 24,
    channels: [RAW, RAW],
    payloads: [144, 0],
    bits: 148,
    states: [
      [0, 23, 0, 15, 0, 0, 3, 29],
      [3, 0, 0, 0, 0, 0, 0, 0],
    ],
    stateHashes: ['527ff3ee2349132a', 'c78faac7ab7e6626'],
    byteHash: '3bd72bf0d14c54cd',
    hex: '2a06c6fe160fd22548e63481fa47cace5703f0',
  },
]

function hashBytes(bytes) {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

function hashState(state) {
  const scalars = [
    state.modeSelect,
    state.lead,
    state.width,
    state.base,
    state.mode,
    state.mode2,
    state.codebookIndex,
    state.baseValue,
  ]
  let hash = 0xcbf29ce484222325n
  function addWord(word) {
    let value = word >>> 0
    for (let byte = 0; byte < 4; byte++) {
      hash = ((hash ^ BigInt(value & 0xff)) * 0x100000001b3n) & MASK
      value >>>= 8
    }
  }
  for (const value of scalars) addWord(value)
  for (const value of state.mode2Values) addWord(value)
  return hash.toString(16).padStart(16, '0')
}

function stateScalars(state) {
  return [
    state.modeSelect,
    state.lead,
    state.width,
    state.base,
    state.mode,
    state.mode2,
    state.codebookIndex,
    state.baseValue,
  ]
}

function createBlock(channelOrdinal, values) {
  const block = {
    channelOrdinal,
    primaryChannelOrdinal: 0,
    syntax: new ChannelSyntaxState(),
    scaleFactorEncode: new ScaleFactorEncodeState(),
  }
  block.syntax.scaleFactors.set(values)
  return block
}

describe('ATRAC3plus scale-factor syntax planning and emission', () => {
  it('matches reference for every primary and secondary representation family', () => {
    for (const fixture of fixtures) {
      const blocks = fixture.channels.map((values, channel) =>
        createBlock(channel, values)
      )
      const shared = new SharedState()
      shared.scaleFactorCount = fixture.count
      shared.quantizationUnitCount = fixture.count
      const plan = new ScaleFactorCodingPlan()

      planScaleFactorSection(blocks, shared, plan)
      const firstStateHashes = blocks.map((block) =>
        hashState(block.scaleFactorEncode)
      )
      const firstBits = plan.bits

      // Retrying selection preserves the same pooled channel-owned image.
      planScaleFactorSection(blocks, shared, plan)
      expect(plan.bits).toBe(firstBits)
      expect(blocks.map((block) => hashState(block.scaleFactorEncode))).toEqual(
        firstStateHashes
      )
      const bytes = new Uint8Array(256)
      const writer = new BitWriter(bytes)
      packScaleFactorSection(blocks, fixture.count, writer)
      const counter = new BitCounter()
      packScaleFactorSection(blocks, fixture.count, counter)
      const used = Math.ceil(writer.bitPosition / 8)

      expect(
        {
          header: blocks.length * 2,
          total: plan.bits,
          measured: counter.bitPosition,
          packed: writer.bitPosition,
          states: blocks.map((block) => stateScalars(block.scaleFactorEncode)),
          stateHashes: blocks.map((block) =>
            hashState(block.scaleFactorEncode)
          ),
          byteHash: hashBytes(bytes.slice(0, used)),
          hex: Buffer.from(bytes.slice(0, used)).toString('hex'),
        },
        fixture.name
      ).toEqual({
        header: blocks.length * 2,
        total: fixture.bits,
        measured: fixture.bits,
        packed: fixture.bits,
        states: fixture.states,
        stateHashes: fixture.stateHashes,
        byteHash: fixture.byteHash,
        hex: fixture.hex,
      })

      const reader = new BitReader(bytes)
      const decoded = fixture.channels.map(() => new ChannelSyntaxState())
      const scratch = new ScaleFactorDecodeScratch()
      for (let channel = 0; channel < decoded.length; channel++) {
        unpackScaleFactorChannel(
          decoded[channel],
          channel === 0 ? null : decoded[0],
          channel,
          fixture.count,
          reader,
          scratch
        )
      }
      expect(reader.bitPosition, fixture.name).toBe(fixture.bits)
      for (let channel = 0; channel < decoded.length; channel++) {
        expect([...decoded[channel].scaleFactors], fixture.name).toEqual([
          ...fixture.channels[channel],
          ...Array(32 - fixture.count).fill(0),
        ])
      }
    }
  })

  it('shares one sequential pricing plan across pooled coding units', () => {
    const pool = new BufferPool()
    const plan = pool.encoder.frame.scaleFactorPlan
    expect(plan).toBeInstanceOf(ScaleFactorCodingPlan)
    expect(
      pool.encoder.frame.allocationTransactions.every(
        (transaction) => transaction.scaleFactorPlan === plan
      )
    ).toBe(true)
  })
})
