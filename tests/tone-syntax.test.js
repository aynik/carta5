import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { createFrameEncoder } from '../codec/pipeline/encoder.js'
import { createFrameSyntaxDecoder } from '../codec/pipeline/decoder.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'
import {
  applyStereoToneFixes,
  unpackToneSection,
} from '../codec/io/tone-decoder.js'
import { packToneSection, planToneSection } from '../codec/io/tone-syntax.js'
import { ChannelSyntaxState } from '../codec/state/shared.js'
import { ToneSlot } from '../codec/state/tone.js'
import {
  TONE_HEADER_FREQUENCY_ARRAY_WORD,
  TONE_HEADER_BAND_COUNT_WORD,
  TONE_HEADER_JOINT_ARRAY_WORD,
  TONE_HEADER_SWAP_ARRAY_WORD,
} from '../codec/core/constants.js'
import { ToneDecodeScratch } from '../codec/state/decoder-syntax.js'

const MASK = 0xffffffffffffffffn

function setRecord(record, entries, gate) {
  record.gateStartValid = gate[0]
  record.gateStartIndex = gate[1]
  record.gateEndValid = gate[2]
  record.gateEndIndex = gate[3]
  record.entryCount = entries.length
  for (let item = 0; item < entries.length; item++) {
    const [scale, phase, step] = entries[item]
    record.scaleFactorIndices[item] = scale
    record.amplitudeIndices[item] = 0
    record.phaseBases[item] = phase
    record.steps[item] = step
  }
}

function hashBytes(bytes) {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

describe('ATRAC3plus tone syntax planning and emission', () => {
  it('matches reference costs, retry-stable orientation, and packed bytes', () => {
    const pool = new BufferPool()
    const blocks = pool.encoder.frame.channelBlocks.slice(0, 2)
    for (let channel = 0; channel < 2; channel++) {
      blocks[channel].toneSlots[0].active = true
      blocks[channel].toneSlots[0].shared[0] = 1
      blocks[channel].toneSlots[0].shared[1] = 1
      blocks[channel].toneSlots[0].shared[2] = 4
    }
    const primary = blocks[0].toneSlots[0]
    primary.shared.set([1, 0, 0, 1], TONE_HEADER_JOINT_ARRAY_WORD)
    primary.shared.set([0, 1, 0, 1], TONE_HEADER_FREQUENCY_ARRAY_WORD)

    setRecord(
      primary.records[0],
      [
        [12, 3, 100],
        [20, 9, 900],
      ],
      [1, 7, 1, 25]
    )
    setRecord(
      primary.records[1],
      [
        [22, 5, 900],
        [25, 11, 960],
        [28, 17, 1000],
      ],
      [0, -1, 1, 30]
    )
    setRecord(primary.records[3], [[40, 29, 1023]], [1, 15, 0, 32])

    const secondary = blocks[1].toneSlots[0]
    setRecord(
      secondary.records[0],
      [
        [12, 3, 100],
        [20, 9, 900],
      ],
      [1, 7, 1, 25]
    )
    setRecord(
      secondary.records[1],
      [
        [23, 6, 902],
        [24, 12, 958],
        [29, 18, 1002],
      ],
      [1, 6, 0, 32]
    )
    setRecord(
      secondary.records[2],
      [
        [8, 7, 2],
        [9, 13, 3],
      ],
      [0, -1, 0, 32]
    )
    setRecord(secondary.records[3], [[40, 29, 1023]], [1, 15, 0, 32])

    const gate = pool.encoder.scratch.toneSwapGates[0].beginFrame()
    const plan = pool.encoder.frame.tonePlans[0]
    planToneSection(blocks, gate, plan)
    const first = {
      total: plan.totalBits,
    }
    planToneSection(blocks, gate, plan)

    const bytes = new Uint8Array(256)
    const writer = new BitWriter(bytes)
    packToneSection(blocks, plan, writer)
    const counter = new BitCounter()
    packToneSection(blocks, plan, counter)
    const byteLength = Math.ceil(writer.bitPosition / 8)

    expect({
      first,
      retry: plan.totalBits,
      measured: counter.bitPosition,
      bits: writer.bitPosition,
      bytes: byteLength,
      hash: hashBytes(bytes.slice(0, byteLength)),
      hex: Buffer.from(bytes.slice(0, byteLength)).toString('hex'),
      scaleFactors: plan.sides.slice(0, 2).map((side) => side.scaleFactorMode),
      presence: plan.sides
        .slice(0, 2)
        .map((side) => [...side.presenceFlags.slice(0, 4)]),
      frequencies: plan.sides
        .slice(0, 2)
        .map((side) => [...side.frequencyDirectionFlags.slice(0, 4)]),
      headers: Array.from(plan.headerEnables, (enabled, array) => [
        enabled,
        plan.headerModes[array],
      ]).flat(),
      swaps: [...primary.shared.slice(TONE_HEADER_SWAP_ARRAY_WORD, 0xee)],
      counts: blocks
        .slice(0, 2)
        .map((block) =>
          block.toneSlots[0].records
            .slice(0, 4)
            .map((record) => record.entryCount)
        ),
    }).toEqual({
      first: { total: 298 },
      retry: 298,
      measured: 298,
      bits: 298,
      bytes: 38,
      hash: '5d5de14fde3b7429',
      hex: 'ef9cb59f97c5e1190864e11c240a201dff8c51665c209a0692ae276f5300c0e19f6a94466480',
      scaleFactors: [0, 2],
      presence: [
        [1, 1, 1, 1],
        [0, 1, 1, 0],
      ],
      frequencies: [
        [0, 0, 1, 0],
        [0, 0, 0, 0],
      ],
      headers: [1, 1, 1, 1, 1, 1],
      swaps: [0, 0, 1, 0],
      counts: [
        [2, 3, 2, 1],
        [2, 3, 0, 1],
      ],
    })

    const decodedSlots = [new ToneSlot(), new ToneSlot()]
    const decodedSyntaxes = [new ChannelSyntaxState(), new ChannelSyntaxState()]
    const decodeScratch = new ToneDecodeScratch()
    const reader = new BitReader(bytes)
    expect(
      unpackToneSection(decodedSlots, decodedSyntaxes, reader, decodeScratch)
    ).toBe(4)
    expect(reader.bitPosition).toBe(writer.bitPosition)
    expect(
      decodedSlots.map((slot) =>
        slot.records.slice(0, 4).map((record) => record.entryCount)
      )
    ).toEqual([
      [2, 3, 2, 1],
      [0, 3, 0, 0],
    ])
    expect([...decodedSlots[1].records[1].steps.slice(0, 3)]).toEqual([
      902, 958, 1002,
    ])
    expect([
      ...decodedSlots[1].records[1].scaleFactorIndices.slice(0, 3),
    ]).toEqual([23, 24, 29])
    expect([...decodedSlots[1].records[1].phaseBases.slice(0, 3)]).toEqual([
      6, 12, 18,
    ])
    expect(
      decodedSyntaxes.map((syntax) => [
        syntax.toneScaleFactorMode,
        ...syntax.tonePresenceFlags.slice(0, 4),
      ])
    ).toEqual([
      [0, 1, 1, 1, 1],
      [2, 0, 1, 1, 0],
    ])

    const previous = [new ToneSlot(), new ToneSlot()]
    applyStereoToneFixes(
      [previous[0], decodedSlots[0]],
      [previous[1], decodedSlots[1]],
      decodeScratch
    )
    expect(
      decodedSlots.map((slot) =>
        slot.records.slice(0, 4).map((record) => record.entryCount)
      )
    ).toEqual([
      [2, 3, 0, 1],
      [2, 3, 2, 1],
    ])
  })

  it('prices a missing delayed slot as the one-bit disabled section', () => {
    const pool = new BufferPool()
    const plan = planToneSection(
      [pool.encoder.frame.channelBlocks[0]],
      pool.encoder.scratch.toneSwapGates[0].beginFrame(),
      pool.encoder.frame.tonePlans[0]
    )
    expect(plan.totalBits).toBe(1)
  })

  it('resolves every stereo unit before syntax-only decoding returns', () => {
    const options = {
      bitrateKbps: 320,
      channels: 6,
      sampleRate: 44100,
    }
    const encode = createFrameEncoder(options, new BufferPool())
    let encoded = null
    for (let frame = 0; frame < 10; frame++) {
      const channels = Array.from({ length: 6 }, (_, channel) =>
        Float32Array.from({ length: 2048 }, (_, sample) => {
          const time = frame * 2048 + sample
          const pair = channel < 2 ? 0 : channel < 5 ? 1 : 2
          const frequency = pair === 0 ? 440 : pair === 1 ? 880 : 110
          const sign = channel === 4 ? -1 : 1
          return (
            sign *
            (12000 * Math.sin((2 * Math.PI * frequency * time) / 44100) +
              2500 * Math.sin((2 * Math.PI * frequency * 2 * time) / 44100))
          )
        })
      )
      encoded = encode(channels) ?? encoded
    }

    const pool = new BufferPool()
    pool.decoder.frame.spectra[0][0] = 17
    pool.decoder.frame.subbandSamples[0][0] = 19
    const frame = createFrameSyntaxDecoder(options, pool)(encoded)
    const topology = pool.decoder.state.topology
    for (const unit of [0, 2]) {
      const channels = topology.codingUnitChannels[unit]
      const primary = frame.channelBlocks[channels.at(0)]
      const secondary = frame.channelBlocks[channels.at(1)]
      const tone = primary.toneSlots[1]
      const bandCount = tone.shared[TONE_HEADER_BAND_COUNT_WORD]
      expect(bandCount).toBeGreaterThan(0)
      expect(tone.shared[TONE_HEADER_JOINT_ARRAY_WORD]).toBe(1)
      expect(primary.syntax.tonePresenceFlags[0]).toBe(1)
      expect(secondary.syntax.tonePresenceFlags[0]).toBe(0)
      expect(secondary.toneSlots[1].records[0].entryCount).toBe(
        tone.records[0].entryCount
      )
      expect(tone.records[0].entryCount).toBeGreaterThan(0)
    }
    expect(pool.decoder.frame.spectra[0][0]).toBe(17)
    expect(pool.decoder.frame.subbandSamples[0][0]).toBe(19)
  })
})
