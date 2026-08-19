import { describe, expect, it } from 'vitest'
import { packableSymbolBits } from '../codec/coding/entropy.js'
import { GainRecord } from '../codec/coding/gain.js'
import { GAIN_LEVEL_CODEBOOK_B_CODE_LENGTHS } from '../codec/core/tables.js'
import {
  captureGainSyntaxModes,
  measureGainSyntaxBitsWithModes,
  packGainSection,
  selectGainSyntax,
} from '../codec/io/gain-syntax.js'
import { unpackGainChannel } from '../codec/io/gain-decoder.js'
import { BitReader, BitCounter, BitWriter } from '../codec/io/bitstream.js'
import { DecodeGainFrame } from '../codec/state/decoder.js'
import { GAIN_MODE_FORBIDDEN_BITS } from '../codec/core/constants.js'
import { GainCodingPlan, GainSyntaxModeProfile } from '../codec/state/gain.js'

const U64_MASK = 0xffffffffffffffffn
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

function gainSource(channelOrdinal) {
  return {
    channelOrdinal,
    currentGainRecords: Array.from({ length: 16 }, () => new GainRecord()),
  }
}

function setRecord(record, locations, levels) {
  record.entries = locations.length
  record.locations.set(locations)
  record.levels.set(levels)
  return record
}

function stereoBaseSources() {
  const primary = gainSource(0)
  const secondary = gainSource(1)
  setRecord(primary.currentGainRecords[0], [4, 12], [10, 8]).copyTo(
    primary.currentGainRecords[1]
  )
  setRecord(secondary.currentGainRecords[0], [5, 12], [10, 8]).copyTo(
    secondary.currentGainRecords[1]
  )
  return [primary, secondary]
}

function oracleCases() {
  const cases = [[stereoBaseSources(), 2, 0x13]]

  const mono = gainSource(0)
  setRecord(mono.currentGainRecords[0], [2, 9, 28], [11, 6, 9])
  setRecord(mono.currentGainRecords[1], [3, 20], [10, 7]).copyTo(
    mono.currentGainRecords[2]
  )
  mono.currentGainRecords[1].copyTo(mono.currentGainRecords[3])
  cases.push([[mono], 4, 0x0f], [[mono], 4, 0x1d], [[mono], 4, 0x13])

  const stereo = stereoBaseSources()
  setRecord(stereo[0].currentGainRecords[0], [2, 10, 24], [12, 7, 10])
  setRecord(stereo[0].currentGainRecords[1], [18], [8])
  setRecord(stereo[1].currentGainRecords[0], [2, 11, 24, 30], [12, 7, 10, 8])
  setRecord(stereo[1].currentGainRecords[1], [18, 25], [8, 6])
  cases.push([stereo, 2, 0x17])

  const spanPrimary = gainSource(0)
  setRecord(spanPrimary.currentGainRecords[0], [10, 11], [8, 9])
  setRecord(spanPrimary.currentGainRecords[1], [11, 12], [9, 8])
  setRecord(spanPrimary.currentGainRecords[2], [10, 12], [8, 9])
  const spanSecondary = gainSource(1)
  for (let record = 0; record < 16; record++) {
    spanPrimary.currentGainRecords[record].copyTo(
      spanSecondary.currentGainRecords[record]
    )
  }
  setRecord(spanSecondary.currentGainRecords[1], [11, 12], [8, 9])
  setRecord(spanSecondary.currentGainRecords[2], [10, 13], [8, 9])
  cases.push([[spanPrimary, spanSecondary], 3, 0x13])

  const inactive = gainSource(0)
  setRecord(inactive.currentGainRecords[0], [7], [7])
  cases.push([[inactive], 0, 0x13])
  return cases
}

function fixedModeCostHash(sources, recordCount, coreMode) {
  const channelModes = sources.length === 1 ? 1 : 4
  const profile = new GainSyntaxModeProfile()
  const scratch = new GainCodingPlan()
  let hash = FNV_OFFSET
  const combinations = 64 * channelModes * channelModes * channelModes
  for (let packed = 0; packed < combinations; packed++) {
    let cursor = packed
    profile.pointCount[0] = cursor & 3
    cursor >>>= 2
    profile.level[0] = cursor & 3
    cursor >>>= 2
    profile.location[0] = cursor & 3
    cursor >>>= 2
    if (sources.length === 2) {
      profile.pointCount[1] = cursor & 3
      cursor >>>= 2
      profile.level[1] = cursor & 3
      cursor >>>= 2
      profile.location[1] = cursor & 3
    }
    const bits = measureGainSyntaxBitsWithModes(
      sources,
      recordCount,
      coreMode,
      profile,
      scratch
    )
    hash ^= BigInt(bits)
    hash = (hash * FNV_PRIME) & U64_MASK
  }
  return hash
}

function expectDecodedGain(actual, expected) {
  expect([
    actual.hasData,
    actual.hasDelta,
    actual.transmittedCount,
    actual.effectiveCount,
    actual.pointCountMode,
    actual.levelMode,
    actual.locationMode,
  ]).toEqual([
    expected.syntax.hasData,
    expected.syntax.hasDelta,
    expected.syntax.transmittedCount,
    expected.syntax.effectiveCount,
    expected.syntax.pointCountMode,
    expected.syntax.levelMode,
    expected.syntax.locationMode,
  ])
  for (let record = 0; record < actual.effectiveCount; record++) {
    expect(actual.records[record].entries).toBe(
      expected.records[record].entries
    )
    const entries = actual.records[record].entries
    expect([...actual.records[record].levels.subarray(0, entries)]).toEqual([
      ...expected.records[record].levels.subarray(0, entries),
    ])
    expect([...actual.records[record].locations.subarray(0, entries)]).toEqual([
      ...expected.records[record].locations.subarray(0, entries),
    ])
  }
}

describe('ATRAC3plus gain syntax pricing', () => {
  it('treats both entropy-table absent markers as unrepresentable', () => {
    expect(packableSymbolBits(GAIN_LEVEL_CODEBOOK_B_CODE_LENGTHS, 0)).toBeNull()
    expect(packableSymbolBits(GAIN_LEVEL_CODEBOOK_B_CODE_LENGTHS, 15)).toBe(1)
    expect(packableSymbolBits(new Uint8Array([0xff]), 0)).toBeNull()
    expect(
      packableSymbolBits(GAIN_LEVEL_CODEBOOK_B_CODE_LENGTHS, 16)
    ).toBeNull()
  })

  it('selects and reprices a bound stereo plan exactly', () => {
    const sources = stereoBaseSources()
    const plan = selectGainSyntax(sources, 2, 0x13, new GainCodingPlan())
    const modes = captureGainSyntaxModes(plan, new GainSyntaxModeProfile())
    expect(plan.bits).toBe(58)
    expect([...modes.pointCount]).toEqual([0, 3])
    expect([...modes.level]).toEqual([0, 3])
    expect([...modes.location]).toEqual([0, 1])
    expect(plan.channels[0].syntax.effectiveCount).toBe(2)
    expect(plan.channels[0].syntax.transmittedCount).toBe(1)
    expect(plan.channels[0].syntax.hasDelta).toBe(1)
    const bytes = new Uint8Array(8)
    const writer = new BitWriter(bytes)
    packGainSection(plan, writer)
    expect({
      bits: writer.bitPosition,
      hex: Buffer.from(bytes).toString('hex'),
    }).toEqual({ bits: 58, hex: '844454046423ec00' })

    const reader = new BitReader(bytes)
    const decoded = [new DecodeGainFrame(), new DecodeGainFrame()]
    unpackGainChannel(decoded[0], null, 0, reader)
    unpackGainChannel(decoded[1], decoded[0], 1, reader)
    expect(reader.bitPosition).toBe(plan.bits)
    expectDecodedGain(decoded[0], plan.channels[0])
    expectDecodedGain(decoded[1], plan.channels[1])

    const repriced = new GainCodingPlan()
    expect(
      measureGainSyntaxBitsWithModes(sources, 2, 0x13, modes, repriced)
    ).toBe(58)

    expect(plan.channels[0].records).toBe(sources[0].currentGainRecords)
  })

  it('retains selected raw-span parameters in caller-owned syntax', () => {
    const [sources, recordCount, coreMode] = oracleCases()[5]
    const plan = selectGainSyntax(
      sources,
      recordCount,
      coreMode,
      new GainCodingPlan()
    )
    const modes = captureGainSyntaxModes(plan, new GainSyntaxModeProfile())
    expect(plan.bits).toBe(74)
    expect([...modes.pointCount]).toEqual([2, 3])
    expect([...modes.level]).toEqual([3, 1])
    expect([...modes.location]).toEqual([3, 1])
    const syntax = plan.channels[0].syntax
    expect([
      syntax.levelWidth,
      syntax.levelBase,
      syntax.locationWidth,
      syntax.locationBase,
    ]).toEqual([1, 8, 1, 10])
  })

  it('matches reference across every fixed mode profile in seven fixtures', () => {
    const expectedSelected = [58, 67, 67, 67, 94, 74, 1]
    const expectedHashes = [
      0xf688b323a2e96d5dn,
      0x960421968c3faff2n,
      0xeabcb6823c618ea5n,
      0x13fe542ab91202c3n,
      0x8636b3a3e12df699n,
      0x42b420b040a520b5n,
      0xea7805377dec9065n,
    ]
    for (const [
      index,
      [sources, recordCount, coreMode],
    ] of oracleCases().entries()) {
      const plan = selectGainSyntax(
        sources,
        recordCount,
        coreMode,
        new GainCodingPlan()
      )
      expect(plan.bits).toBe(expectedSelected[index])
      expect(fixedModeCostHash(sources, recordCount, coreMode)).toBe(
        expectedHashes[index]
      )
      const counter = new BitCounter()
      packGainSection(plan, counter)
      expect(counter.bitPosition).toBe(plan.bits)

      const bytes = new Uint8Array(128)
      const writer = new BitWriter(bytes)
      packGainSection(plan, writer)
      const reader = new BitReader(bytes)
      const decoded = [new DecodeGainFrame(), new DecodeGainFrame()]
      for (let channel = 0; channel < plan.channelCount; channel++) {
        unpackGainChannel(
          decoded[channel],
          channel === 0 ? null : decoded[0],
          channel,
          reader
        )
        expectDecodedGain(decoded[channel], plan.channels[channel])
      }
      expect(reader.bitPosition).toBe(plan.bits)
    }
  })

  it('returns the reference forbidden sentinel for an unavailable profile', () => {
    const [sources] = oracleCases()[0]
    const modes = new GainSyntaxModeProfile()
    modes.pointCount.set([3, 0])
    modes.level.set([0, 0])
    modes.location.set([3, 0])
    expect(
      measureGainSyntaxBitsWithModes(
        sources,
        2,
        0x0f,
        modes,
        new GainCodingPlan()
      )
    ).toBe(GAIN_MODE_FORBIDDEN_BITS)
  })

  it('preserves fixed plan identities across repeated selection', () => {
    const sources = stereoBaseSources()
    const plan = new GainCodingPlan()
    const flags = plan.channels[1].syntax.locationFlags
    selectGainSyntax(sources, 2, 0x13, plan)
    const records = plan.channels[0].records
    selectGainSyntax(sources, 2, 0x13, plan)
    expect(plan.channels[0].records).toBe(records)
    expect(plan.channels[1].syntax.locationFlags).toBe(flags)
  })
})
