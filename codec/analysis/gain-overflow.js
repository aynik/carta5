/** Fixed-frontier ATRAC3plus low-rate gain-overflow reduction mechanics. */

import { normalizeGainRecord } from '../coding/gain.js'
import {
  GAIN_LEVEL_DEFAULT,
  GAIN_SLOT_COUNT,
  ANALYSIS_GAIN_OVERFLOW_NORMALIZE_TAIL_LEVEL,
  OVERFLOW_ABSOLUTE_LIMIT,
  OVERFLOW_RELATIVE_FACTOR,
} from '../core/constants.js'

/**
 * Reference absolute-or-relative peak limit. NaN never overflows.
 *
 * @param {number} sourcePeak Unscaled source peak.
 * @param {number} gainPeak Gain-scaled candidate peak.
 * @returns {boolean} Whether the candidate overflows.
 */
export function gainPeakOverflows(sourcePeak, gainPeak) {
  return (
    gainPeak > OVERFLOW_ABSOLUTE_LIMIT ||
    gainPeak > Math.fround(sourcePeak * OVERFLOW_RELATIVE_FACTOR)
  )
}

/**
 * Canonical ATRAC3plus overflow record normalization.
 *
 * @param {GainRecord} record Record to normalize.
 * @returns {GainRecord} The normalized record.
 */
export function normalizeOverflowGainRecord(record) {
  return normalizeGainRecord(
    record,
    ANALYSIS_GAIN_OVERFLOW_NORMALIZE_TAIL_LEVEL,
    true
  )
}

/**
 * Collect entries whose level drops toward the next or implicit tail level.
 *
 * @param {GainRecord} record Record to scan.
 * @param {Int32Array} destination Caller-owned entry indices.
 * @returns {number} Collected entry count.
 */
export function collectGainLevelDropEntries(record, destination) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  let dropCount = 0
  for (let entry = 0; entry < count; entry++) {
    const levelAfter =
      entry + 1 < count ? record.levels[entry + 1] : GAIN_LEVEL_DEFAULT
    if (record.levels[entry] - levelAfter > 0) {
      destination[dropCount++] = entry
    }
  }
  return dropCount
}

/**
 * Translate a frontier state ordinal into its flat gain-record storage offset.
 *
 * @param {number} state
 * @returns {number}
 */
function stateOffset(state) {
  return state * GAIN_SLOT_COUNT
}

/**
 * Copy one gain record into flat frontier storage and retain its measured cost metadata.
 *
 * @param {GainOverflowScratch} scratch
 * @param {number} state
 * @param {GainRecord} record
 * @param {number} peak
 * @param {number} stepCount
 */
function storeState(scratch, state, record, peak, stepCount) {
  scratch.entries[state] = Math.min(record.entries, GAIN_SLOT_COUNT)
  const offset = stateOffset(state)
  scratch.locations.fill(0, offset, offset + GAIN_SLOT_COUNT)
  scratch.levels.fill(0, offset, offset + GAIN_SLOT_COUNT)
  scratch.locations.set(
    record.locations.subarray(0, scratch.entries[state]),
    offset
  )
  scratch.levels.set(record.levels.subarray(0, scratch.entries[state]), offset)
  scratch.peaks[state] = peak
  scratch.stepCounts[state] = stepCount
}

/**
 * Load one frontier state into caller-owned record storage.
 *
 * @param {GainOverflowScratch} scratch Overflow graph storage.
 * @param {number} state Frontier-state index.
 * @param {GainRecord} record Destination record.
 * @returns {GainRecord} The destination record.
 */
export function loadGainOverflowState(scratch, state, record) {
  const count = scratch.entries[state]
  const offset = stateOffset(state)
  record.clear()
  record.entries = count
  for (let entry = 0; entry < count; entry++) {
    record.locations[entry] = scratch.locations[offset + entry]
    record.levels[entry] = scratch.levels[offset + entry]
  }
  return record
}

/**
 * Hash the active fields of a gain record for frontier deduplication.
 *
 * @param {GainRecord} record
 * @returns {number}
 */
function hashGainRecord(record) {
  let hash = 2166136261
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  hash = Math.imul(hash ^ count, 16777619) >>> 0
  for (let entry = 0; entry < count; entry++) {
    hash = Math.imul(hash ^ record.locations[entry], 16777619) >>> 0
    hash = Math.imul(hash ^ record.levels[entry], 16777619) >>> 0
  }
  return hash
}

/**
 * Compare a stored frontier state with a gain record field by field.
 *
 * @param {GainOverflowScratch} scratch
 * @param {number} state
 * @param {GainRecord} record
 * @returns {boolean}
 */
function stateEqualsRecord(scratch, state, record) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  if (scratch.entries[state] !== count) return false
  const offset = stateOffset(state)
  for (let entry = 0; entry < count; entry++) {
    if (
      scratch.locations[offset + entry] !== record.locations[entry] ||
      scratch.levels[offset + entry] !== record.levels[entry]
    ) {
      return false
    }
  }
  return true
}

/**
 * Probe the open-addressed gain-state table for a matching or empty slot.
 *
 * @param {GainOverflowScratch} scratch
 * @param {GainRecord} record
 * @returns {number}
 */
function findHashSlot(scratch, record) {
  let slot = hashGainRecord(record) & scratch.hashMask
  for (;;) {
    const encodedState = scratch.hashSlots[slot]
    if (encodedState === 0) return ~slot
    if (stateEqualsRecord(scratch, encodedState - 1, record)) {
      return encodedState - 1
    }
    slot = (slot + 1) & scratch.hashMask
  }
}

/**
 * Insert a gain-overflow state only when its complete record is not already in the frontier.
 *
 * @param {GainOverflowScratch} scratch
 * @param {GainRecord} record
 * @param {number} peak
 * @param {number} stepCount
 * @returns {boolean}
 */
function appendUniqueState(scratch, record, peak, stepCount) {
  const found = findHashSlot(scratch, record)
  if (found >= 0) return false
  if (scratch.stateCount >= scratch.stateCapacity) {
    throw new RangeError('ATRAC3plus gain-overflow frontier exceeded capacity')
  }
  const state = scratch.stateCount++
  storeState(scratch, state, record, peak, stepCount)
  scratch.hashSlots[~found] = state + 1
  return true
}

/**
 * Record a terminal gain-overflow state once its syntax is within budget.
 *
 * @param {GainOverflowScratch} scratch
 * @param {number} state
 */
function appendTerminal(scratch, state) {
  if (scratch.terminalCount >= scratch.terminalIndices.length) {
    throw new RangeError('ATRAC3plus gain-overflow terminals exceeded capacity')
  }
  scratch.terminalIndices[scratch.terminalCount++] = state
}

/**
 * Build the complete reference-ordered reduction graph in fixed pooled storage.
 * `measurePeak` must return the gain-scaled peak for the supplied candidate.
 *
 * @param {GainRecord} record Initial overflowing record.
 * @param {number} sourcePeak Unscaled source peak.
 * @param {number} currentPeak Initial gain-scaled peak.
 * @param {GainOverflowScratch} scratch Reusable graph storage.
 * @param {function(GainRecord, *): number} measurePeak Candidate peak measurement callback.
 * @param {*} [measureContext] Opaque callback context.
 * @returns {GainOverflowScratch} The populated graph storage.
 */
export function buildGainOverflowStateFrontier(
  record,
  sourcePeak,
  currentPeak,
  scratch,
  measurePeak,
  measureContext = undefined
) {
  scratch.stateCount = 0
  scratch.terminalCount = 0
  scratch.hashSlots.fill(0)
  appendUniqueState(scratch, record, currentPeak, 0)

  let cursor = 0
  while (cursor < scratch.stateCount) {
    const state = cursor++
    const stepCount = scratch.stepCounts[state]
    const peak = scratch.peaks[state]
    if (stepCount !== 0 && !gainPeakOverflows(sourcePeak, peak)) {
      appendTerminal(scratch, state)
      continue
    }

    const source = loadGainOverflowState(scratch, state, scratch.sourceRecord)
    const dropCount = collectGainLevelDropEntries(source, scratch.dropEntries)
    if (dropCount === 0) {
      if (stepCount !== 0) appendTerminal(scratch, state)
      continue
    }

    for (let drop = 0; drop < dropCount; drop++) {
      source.copyTo(scratch.candidateRecord)
      const entry = scratch.dropEntries[drop]
      scratch.candidateRecord.levels[entry]--
      normalizeOverflowGainRecord(scratch.candidateRecord)
      if (findHashSlot(scratch, scratch.candidateRecord) >= 0) continue
      const candidatePeak = measurePeak(scratch.candidateRecord, measureContext)
      appendUniqueState(
        scratch,
        scratch.candidateRecord,
        candidatePeak,
        stepCount + 1
      )
    }
  }
  return scratch
}

/**
 * Select the reference safe/lowest-effect overflow candidate index.
 *
 * @param {GainOverflowIncumbent[]} candidates Ordered overflow alternatives.
 * @param {number} candidateCount Active candidate count.
 * @param {number} sourcePeak Unscaled source peak.
 * @param {number|null} [maximumSyntaxBits] Optional rate ceiling.
 * @returns {number} Selected candidate index, or `-1`.
 */
export function selectOverflowPathCandidate(
  candidates,
  candidateCount,
  sourcePeak,
  maximumSyntaxBits = null
) {
  let safeCount = 0
  let soleSafe = -1
  for (let index = 0; index < candidateCount; index++) {
    const candidate = candidates[index]
    const rateFeasible =
      maximumSyntaxBits === null ||
      (candidate.syntaxBits !== null &&
        candidate.syntaxBits <= maximumSyntaxBits)
    if (rateFeasible && !gainPeakOverflows(sourcePeak, candidate.peak)) {
      safeCount++
      soleSafe = index
    }
  }
  if (safeCount === 1) return soleSafe

  let selected = -1
  let lowest = Number.POSITIVE_INFINITY
  for (let index = 0; index < candidateCount; index++) {
    const candidate = candidates[index]
    const rateFeasible =
      maximumSyntaxBits === null ||
      (candidate.syntaxBits !== null &&
        candidate.syntaxBits <= maximumSyntaxBits)
    if (!rateFeasible) continue
    const safe = !gainPeakOverflows(sourcePeak, candidate.peak)
    if (safeCount > 1 ? !safe : false) continue
    let cost =
      safeCount > 1 ? candidate.effect.differenceEnergy : candidate.peak
    if (!Number.isFinite(cost)) cost = Number.POSITIVE_INFINITY
    if (selected === -1 || cost < lowest) {
      selected = index
      lowest = cost
    }
  }
  return selected
}
