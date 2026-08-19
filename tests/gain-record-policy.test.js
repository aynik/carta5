import { describe, expect, it } from 'vitest'

import {
  adjustBand0RecordFromBand1,
  planCloseRecordsBetweenChannels,
} from '../codec/analysis/gain-record-policy.js'
import {
  comparePeakEnvelopeCandidate,
  compareSignalsExact,
  createPeakEnvelopeComparison,
  createSignalComparison,
  loadPeakEnvelopeReference,
} from '../codec/analysis/perceptual.js'
import { GainRecord, normalizeGainRecord } from '../codec/coding/gain.js'
import { LowRateGainScratch } from '../codec/state/gain-analysis.js'

const bitsView = new DataView(new ArrayBuffer(8))
function f64Bits(value) {
  bitsView.setFloat64(0, value, false)
  return bitsView.getBigUint64(0, false).toString(16).padStart(16, '0')
}

function record(entries, locations, levels) {
  const result = new GainRecord()
  result.entries = entries
  result.locations.set(locations)
  result.levels.set(levels)
  return result
}

function coded(record) {
  return {
    entries: record.entries,
    locations: Array.from(record.locations),
    levels: Array.from(record.levels),
  }
}

describe('ATRAC3plus low-rate gain record policy', () => {
  it('matches reference normalization and close stereo merges', () => {
    const normalized = record(
      7,
      [2, 5, 5, 9, 12, 17, 21],
      [8, 8, 10, 10, 6, 6, 7]
    )
    normalizeGainRecord(normalized, 6, true)
    expect(coded(normalized)).toEqual({
      entries: 4,
      locations: [5, 9, 17, 21, 0, 0, 0],
      levels: [8, 10, 6, 7, 0, 0, 0],
    })

    const scratch = new LowRateGainScratch().recordPolicy
    let merged = planCloseRecordsBetweenChannels(
      record(3, [4, 12, 20], [10, 8, 6]),
      record(3, [5, 11, 21], [9, 9, 7]),
      scratch
    )
    for (const result of merged) {
      expect(coded(result)).toEqual({
        entries: 3,
        locations: [4, 11, 20, 0, 0, 0, 0],
        levels: [10, 9, 7, 0, 0, 0, 0],
      })
    }

    merged = planCloseRecordsBetweenChannels(
      record(3, [4, 12, 20], [10, 8, 6]),
      record(4, [4, 8, 12, 20], [10, 9, 8, 6]),
      scratch
    )
    for (const result of merged) {
      expect(coded(result)).toEqual({
        entries: 4,
        locations: [4, 8, 12, 20, 0, 0, 0],
        levels: [10, 9, 8, 6, 0, 0, 0],
      })
    }
  })

  it('matches reference band-1 propagation edits and incumbent capture', () => {
    const scratch = new LowRateGainScratch().recordPolicy
    const replaceRecords = Array.from({ length: 16 }, () => new GainRecord())
    replaceRecords[1] = record(1, [5], [10])
    replaceRecords[2] = record(1, [4], [8])
    replaceRecords[3] = record(1, [6], [8])
    expect(
      adjustBand0RecordFromBand1(
        replaceRecords,
        record(1, [7], [9]),
        2,
        4,
        scratch
      )
    ).toBe(true)
    expect(coded(replaceRecords[0])).toEqual({
      entries: 1,
      locations: [5, 0, 0, 0, 0, 0, 0],
      levels: [7, 0, 0, 0, 0, 0, 0],
    })
    expect(coded(scratch.band0Incumbent)).toEqual({
      entries: 0,
      locations: [0, 0, 0, 0, 0, 0, 0],
      levels: [0, 0, 0, 0, 0, 0, 0],
    })

    const insertRecords = Array.from({ length: 16 }, () => new GainRecord())
    insertRecords[0] = record(1, [10], [8])
    insertRecords[1] = replaceRecords[1]
    insertRecords[2] = replaceRecords[2]
    insertRecords[3] = replaceRecords[3]
    expect(adjustBand0RecordFromBand1(insertRecords, null, 1, 4, scratch)).toBe(
      true
    )
    expect(coded(insertRecords[0])).toEqual({
      entries: 2,
      locations: [5, 10, 0, 0, 0, 0, 0],
      levels: [9, 8, 0, 0, 0, 0, 0],
    })
    expect(coded(scratch.band0Incumbent)).toEqual({
      entries: 1,
      locations: [10, 0, 0, 0, 0, 0, 0],
      levels: [8, 0, 0, 0, 0, 0, 0],
    })
  })

  it('matches reference aligned-signal and peak-envelope comparisons', () => {
    const candidate = new Float32Array([1, -2, 0.5, 4, -1, 0, 3, -0.25])
    const reference = new Float32Array([0.5, -1.5, 0.75, 3, -2, 0, 2, 0.25])
    const effect = compareSignalsExact(
      candidate,
      reference,
      createSignalComparison()
    )
    expect(
      [
        effect.referenceEnergy,
        effect.candidateEnergy,
        effect.differenceEnergy,
        effect.relativeDifferenceEnergy,
        effect.shapeError,
      ].map(f64Bits)
    ).toEqual([
      '4034200000000000',
      '403f500000000000',
      '400e800000000000',
      '3fc83f9a3c6c1fcd',
      '3fb9a54cc05e7390',
    ])

    const peakReference = new Float32Array(128)
    const peakCandidate = new Float32Array(128)
    for (let index = 0; index < 128; index++) {
      peakReference[index] = (((index * 17) % 31) - 15) / 8
      peakCandidate[index] = (((index * 23 + 5) % 37) - 18) / 8
    }
    const peak = createPeakEnvelopeComparison(32)
    loadPeakEnvelopeReference(peakReference, 0, 4, peak)
    const peakEffect = comparePeakEnvelopeCandidate(peakCandidate, 0, 4, peak)
    expect(
      [
        peakEffect.referenceEnergy,
        peakEffect.candidateEnergy,
        peakEffect.differenceEnergy,
        peakEffect.relativeDifferenceEnergy,
        peakEffect.shapeError,
      ].map(f64Bits)
    ).toEqual([
      '4055170000000000',
      '405fcd0000000000',
      '401f000000000000',
      '3fb784b7c8ff49ec',
      '3fa080ee9b0d0700',
    ])
  })
})
