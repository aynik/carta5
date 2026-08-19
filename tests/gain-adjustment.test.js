import { describe, expect, it } from 'vitest'

import {
  compareGainRecordAlternative,
  maximumGainScaledMagnitude,
  maximumGainWindowMagnitude,
  planLowModeGainAdjustment,
} from '../codec/analysis/gain-adjustment.js'
import { GainRecordPlan, GainRecord } from '../codec/coding/gain.js'
import { BufferPool } from '../codec/core/buffers.js'
import {
  EncodeAnalysisState,
  EncodeChannelState,
} from '../codec/state/encoder.js'
import { LowRateGainScratch } from '../codec/state/gain-analysis.js'
import { float32ToBits, float64ToBits } from '../codec/utils.js'

function fixedWidthHex(bits, width) {
  return bits.toString(16).padStart(width, '0')
}

function record(entries, locations, levels) {
  const result = new GainRecord()
  result.entries = entries
  result.locations.set(locations)
  result.levels.set(levels)
  return result
}

function setRecord(target, locations, levels) {
  target.entries = locations.length
  target.locations.set(locations)
  target.levels.set(levels)
}

function fillAnalysis(analysis, channelBias) {
  for (let band = 0; band < 4; band++) {
    for (let sample = 0; sample < 256; sample++) {
      const value = ((sample * (band + 3) + channelBias) % 17) - 8
      analysis.samples[band * 9 * 128 + sample] = value * 32
    }
  }
}

function hashGainPlan(plan) {
  const mask = 0xffffffffffffffffn
  let hash = 0xcbf29ce484222325n
  for (let channel = 0; channel < plan.channelCount; channel++) {
    for (const current of plan.records[channel]) {
      hash ^= BigInt(current.entries)
      hash = (hash * 0x100000001b3n) & mask
      for (let entry = 0; entry < current.entries; entry++) {
        hash ^= BigInt(current.locations[entry])
        hash = (hash * 0x100000001b3n) & mask
        hash ^= BigInt(current.levels[entry])
        hash = (hash * 0x100000001b3n) & mask
      }
    }
  }
  return hash
}

function codedRecord(record) {
  return [
    record.entries,
    [...record.locations.slice(0, record.entries)],
    [...record.levels.slice(0, record.entries)],
  ]
}

describe('ATRAC3plus low-rate gain adjustment signal probes', () => {
  it('matches reference gain-scaled peaks and alternative effect', () => {
    const previous = record(2, [4, 20], [9, 7])
    const incumbent = record(2, [8, 24], [10, 6])
    const candidate = record(3, [6, 16, 26], [9, 8, 6])
    const source = new Float32Array(256)
    for (let index = 0; index < source.length; index++) {
      const raw = ((index * 37 + 11) % 257) - 128
      source[index] = Math.fround((raw / 16) * 2 ** ((index % 5) - 2))
    }
    const scratch = new LowRateGainScratch()
    const sourcePeak = maximumGainWindowMagnitude(source)
    const scaledPeak = maximumGainScaledMagnitude(
      source,
      previous,
      incumbent,
      scratch
    )
    expect(
      [sourcePeak, scaledPeak].map((value) =>
        fixedWidthHex(float32ToBits(value), 8)
      )
    ).toEqual(['41fa0000', '45620000'])

    const effect = compareGainRecordAlternative(
      source,
      previous,
      incumbent,
      candidate,
      scratch
    )
    expect(
      [
        effect.referenceEnergy,
        effect.candidateEnergy,
        effect.differenceEnergy,
        effect.relativeDifferenceEnergy,
        effect.shapeError,
      ].map((value) => fixedWidthHex(float64ToBits(value), 16))
    ).toEqual([
      '417c94389247ee69',
      '415c8693472b9cd6',
      '415cfd6a8f2fdbd6',
      '3fd03ae4cdd9774e',
      '3f799b79435b3300',
    ])
  })

  it('is owned once by the ATRAC3plus encoder pool', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.gain.configureAdjustment(2)
    expect(scratch.source).toBeInstanceOf(Float32Array)
    expect(scratch.source).toHaveLength(256)
    expect(scratch.overflow.stateCapacity).toBe(32768)
    expect(pool.encoder.scratch.gain.adjustment).toBe(scratch)
    expect(pool.encoder.scratch.gain.configureAdjustment(2)).toBe(scratch)
  })

  it('matches whole-policy mono, stereo, and BFS reference oracles', () => {
    const monoBlocks = [new EncodeChannelState(0, 0)]
    const monoAnalysis = [new EncodeAnalysisState()]
    fillAnalysis(monoAnalysis[0], 0)
    const monoDetected = new GainRecordPlan()
    monoDetected.channelCount = 1
    setRecord(monoDetected.records[0][0], [20], [8])
    setRecord(monoDetected.records[0][1], [10, 20], [12, 6])
    setRecord(monoDetected.records[0][2], [10, 20], [12, 6])
    setRecord(monoDetected.records[0][3], [11, 20], [12, 6])
    const mono = planLowModeGainAdjustment(
      monoBlocks,
      monoAnalysis,
      4,
      0x0f,
      monoDetected,
      new LowRateGainScratch()
    )
    expect(hashGainPlan(mono)).toBe(0x44b56a1a1f940987n)
    expect(mono.records[0].slice(0, 4).map(codedRecord)).toEqual([
      [2, [10, 20], [9, 8]],
      [1, [10], [9]],
      [1, [10], [9]],
      [1, [11], [9]],
    ])

    const stereoBlocks = [
      new EncodeChannelState(0, 0),
      new EncodeChannelState(1, 0),
    ]
    const stereoAnalysis = [
      new EncodeAnalysisState(),
      new EncodeAnalysisState(),
    ]
    fillAnalysis(stereoAnalysis[0], 0)
    fillAnalysis(stereoAnalysis[1], 0)
    const stereoDetected = new GainRecordPlan()
    stereoDetected.channelCount = 2
    for (let band = 0; band < 4; band++) {
      setRecord(stereoDetected.records[0][band], [4 + band, 18], [10, 6])
      setRecord(stereoDetected.records[1][band], [5 + band, 18], [10, 6])
    }
    const stereo = planLowModeGainAdjustment(
      stereoBlocks,
      stereoAnalysis,
      4,
      0x13,
      stereoDetected,
      new LowRateGainScratch()
    )
    expect(hashGainPlan(stereo)).toBe(0xb0236e941341fc3dn)
    expect(stereo.records[0].slice(0, 4).map(codedRecord)).toEqual([
      [1, [4], [9]],
      [1, [5], [9]],
      [1, [6], [9]],
      [1, [7], [9]],
    ])
    expect(stereo.records[1].slice(0, 4).map(codedRecord)).toEqual(
      stereo.records[0].slice(0, 4).map(codedRecord)
    )

    const overflowBlocks = [new EncodeChannelState(0, 0)]
    const overflowAnalysis = [new EncodeAnalysisState()]
    fillAnalysis(overflowAnalysis[0], 5)
    const overflowDetected = new GainRecordPlan()
    overflowDetected.channelCount = 1
    setRecord(overflowDetected.records[0][0], [2, 10, 18, 27], [15, 8, 14, 6])
    const overflow = planLowModeGainAdjustment(
      overflowBlocks,
      overflowAnalysis,
      1,
      0x0f,
      overflowDetected,
      new LowRateGainScratch()
    )
    expect(hashGainPlan(overflow)).toBe(0xe6ec97b02a0f61cen)
    expect(codedRecord(overflow.records[0][0])).toEqual([2, [10, 18], [8, 9]])
  })

  it('returns a reusable detached publication and commits only on request', () => {
    const blocks = [new EncodeChannelState(0, 0)]
    const analysis = [new EncodeAnalysisState()]
    fillAnalysis(analysis[0], 5)
    blocks[0].currentGainRecords[0].entries = 1
    blocks[0].currentGainRecords[0].locations[0] = 31
    blocks[0].currentGainRecords[0].levels[0] = 8
    const detected = new GainRecordPlan()
    detected.channelCount = 1
    setRecord(detected.records[0][0], [2, 10, 18, 27], [15, 8, 14, 6])
    const scratch = new LowRateGainScratch()
    const publication = planLowModeGainAdjustment(
      blocks,
      analysis,
      1,
      0x0f,
      detected,
      scratch
    )
    const publishedRecord = publication.records[0][0]
    expect(blocks[0].currentGainRecords[0].locations[0]).toBe(31)
    publication.commitTo(blocks)
    expect(codedRecord(blocks[0].currentGainRecords[0])).toEqual([
      2,
      [10, 18],
      [8, 9],
    ])
    expect(
      planLowModeGainAdjustment(blocks, analysis, 1, 0x0f, detected, scratch)
    ).toBe(publication)
    expect(publication.records[0][0]).toBe(publishedRecord)
  })
})
