import { describe, expect, it } from 'vitest'
import {
  GainRecord,
  prepareGainEnvelopeReference,
  reconstructGainDeltaLevels,
  scoreGainLevelAdjustment,
  writeGainRecordDeltaEnvelope,
} from '../codec/coding/gain.js'
import { BufferPool } from '../codec/core/buffers.js'
import { GainEnvelopeScratch } from '../codec/state/analysis.js'

function writeEnvelope(record, events, options = {}) {
  const locations = Int32Array.from(events, (event) => event[0])
  const deltas = Int32Array.from(events, (event) => event[1])
  return writeGainRecordDeltaEnvelope(
    record,
    locations,
    deltas,
    events.length,
    options.floor ?? -6,
    options.ceiling ?? 9,
    options.limit ?? 7,
    options.reject ?? false,
    (level) => level + 10,
    options.scratch ?? new BufferPool().encoder.scratch.gain.detection.envelope
  )
}

describe('ATRAC3plus gain envelope lowering', () => {
  it('integrates equal-location events, clamps, and reverses records', () => {
    const record = new GainRecord()
    expect(
      writeEnvelope(
        record,
        [
          [10, 2],
          [10, 3],
          [8, -1],
          [4, -10],
        ],
        { floor: -2, ceiling: 3 }
      )
    ).toBe(2)
    expect(record.entries).toBe(2)
    expect([...record.locations.slice(0, 2)]).toEqual([4, 10])
    expect([...record.levels.slice(0, 2)]).toEqual([8, 13])
  })

  it('caps truncation and rejects overflow without partial publication', () => {
    const record = new GainRecord()
    expect(
      writeEnvelope(
        record,
        [
          [10, 1],
          [8, -2],
          [6, 2],
          [4, -2],
        ],
        { limit: 2 }
      )
    ).toBe(2)
    expect([...record.locations.slice(0, 2)]).toEqual([8, 10])
    expect([...record.levels.slice(0, 2)]).toEqual([9, 11])

    record.clear()
    record.entries = 1
    record.locations[0] = 3
    record.levels[0] = 6
    expect(
      writeEnvelope(
        record,
        [
          [10, 1],
          [8, -2],
          [6, 2],
        ],
        { limit: 2, reject: true }
      )
    ).toBeNull()
    expect(record.entries).toBe(1)
    expect(record.locations[0]).toBe(3)
    expect(record.levels[0]).toBe(6)
  })

  it('reconstructs and scores a signal-weighted local adjustment', () => {
    const deltas = new Int32Array(8)
    deltas[6] = 3
    deltas[3] = -5
    deltas[1] = 4
    const levels = new Int32Array(8)
    reconstructGainDeltaLevels(deltas, -1, 2, levels)
    expect([...levels]).toEqual([2, 2, -1, -1, 2, 2, 2, 0])

    const scratch = new BufferPool().encoder.scratch.gain.detection.envelope
    const idealDeltas = new Int32Array(32)
    idealDeltas[0] = -1
    idealDeltas[2] = 2
    idealDeltas[1] = -1
    const amplitudes = new Float32Array(32)
    amplitudes.set([1, 2, 3])
    prepareGainEnvelopeReference(idealDeltas, amplitudes, -6, 9, scratch)
    const currentDeltas = new Int32Array(32)
    currentDeltas[1] = 1
    reconstructGainDeltaLevels(
      currentDeltas,
      -2147483648,
      2147483647,
      scratch.currentRawLevels
    )
    expect(
      scoreGainLevelAdjustment(
        scratch,
        scratch.currentRawLevels,
        0,
        1,
        -1,
        -6,
        9
      )
    ).toBe(3)
  })

  it('uses detached pool scratch without replacing its fixed arrays', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.gain.detection.envelope
    expect(scratch).toBeInstanceOf(GainEnvelopeScratch)
    const locations = scratch.locations
    const record = new GainRecord()
    expect(writeEnvelope(record, [[4, 2]], { scratch })).toBe(1)
    expect(scratch.locations).toBe(locations)
    expect(record.locations[0]).toBe(4)
  })
})
