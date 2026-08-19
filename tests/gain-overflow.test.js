import { describe, expect, it } from 'vitest'

import {
  gainPeakOverflows,
  buildGainOverflowStateFrontier,
  loadGainOverflowState,
  selectOverflowPathCandidate,
} from '../codec/analysis/gain-overflow.js'
import { GainRecord } from '../codec/coding/gain.js'
import { GainOverflowScratch } from '../codec/state/gain-analysis.js'

const HASH_OFFSET = 1469598103934665603n
const HASH_PRIME = 1099511628211n
const HASH_MASK = 0xffffffffffffffffn
const bitsView = new DataView(new ArrayBuffer(4))

function mix(hash, value) {
  return ((hash ^ BigInt(value >>> 0)) * HASH_PRIME) & HASH_MASK
}

function floatBits(value) {
  bitsView.setFloat32(0, value, true)
  return bitsView.getUint32(0, true)
}

function record(entries, locations, levels) {
  const result = new GainRecord()
  result.entries = entries
  result.locations.set(locations)
  result.levels.set(levels)
  return result
}

describe('ATRAC3plus low-rate gain overflow frontier', () => {
  it('matches reference state order and terminal records', () => {
    const source = record(4, [2, 9, 18, 27], [12, 10, 14, 9])
    const measurePeak = (candidate) => {
      let sum = 0
      for (let entry = 0; entry < candidate.entries; entry++) {
        sum += candidate.levels[entry]
      }
      return Math.fround(sum * 250)
    }
    const scratch = new GainOverflowScratch(128)
    buildGainOverflowStateFrontier(
      source,
      1000,
      measurePeak(source),
      scratch,
      measurePeak
    )
    expect([scratch.stateCount, scratch.terminalCount]).toEqual([42, 17])

    let hash = HASH_OFFSET
    const terminal = new GainRecord()
    for (let position = 0; position < scratch.terminalCount; position++) {
      const state = scratch.terminalIndices[position]
      loadGainOverflowState(scratch, state, terminal)
      hash = mix(hash, state)
      hash = mix(hash, scratch.stepCounts[state])
      hash = mix(hash, floatBits(scratch.peaks[state]))
      hash = mix(hash, terminal.entries)
      for (const location of terminal.locations) hash = mix(hash, location)
      for (const level of terminal.levels) hash = mix(hash, level)
    }
    expect(hash.toString(16).padStart(16, '0')).toBe('288c76d593004745')
  })

  it('uses safe-effect, fallback-peak, and rate ordering', () => {
    const candidates = [
      { peak: 7000, syntaxBits: 20, effect: { differenceEnergy: 3 } },
      { peak: 7500, syntaxBits: 18, effect: { differenceEnergy: 1 } },
      { peak: 6500, syntaxBits: 30, effect: { differenceEnergy: 2 } },
    ]
    expect(selectOverflowPathCandidate(candidates, 3, 1000)).toBe(1)
    expect(selectOverflowPathCandidate(candidates, 3, 1000, 19)).toBe(1)

    const unsafe = candidates.map((candidate, index) => ({
      ...candidate,
      peak: 9000 + index * 1000,
    }))
    expect(selectOverflowPathCandidate(unsafe, 3, 1000)).toBe(0)
    expect(gainPeakOverflows(1000, 9000)).toBe(true)
    expect(gainPeakOverflows(1000, Number.NaN)).toBe(false)
  })

  it('fails explicitly before writing beyond its fixed transaction arena', () => {
    const source = record(4, [2, 9, 18, 27], [12, 10, 14, 9])
    const scratch = new GainOverflowScratch(4)
    expect(() =>
      buildGainOverflowStateFrontier(source, 1000, 20000, scratch, () => 20000)
    ).toThrow(/exceeded capacity/)
  })
})
