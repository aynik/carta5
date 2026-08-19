/** Fixed-capacity storage for adaptive ATRAC3plus gain analysis. */

import { GainRecord, GainRecordPlan } from '../coding/gain.js'
import {
  GAIN_SLOT_COUNT,
  GAIN_WINDOW_BLOCKS,
  ARENA_ENTRIES,
  COMPLETE_SIGNAL_SAMPLES,
  STATE_GAIN_ANALYSIS_CURRENT,
  ENTRY_STRIDE,
  STATE_GAIN_ANALYSIS_GAIN_BANDS,
  GAIN_DETECTION_SAMPLES,
  STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS,
  GAIN_OVERFLOW_STATE_CAPACITY,
  STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES,
  STATE_GAIN_ANALYSIS_GROUP_ENTRIES,
  STATE_GAIN_ANALYSIS_NEXT,
  STATE_GAIN_ANALYSIS_NO_ENTRY,
  STATE_GAIN_ANALYSIS_PREVIOUS,
} from '../core/constants.js'
import {
  GainEnvelopeScratch,
  GainMeasurementScratch,
  PeakEnvelopeComparison,
  SignalComparison,
} from './analysis.js'
import { GainCodingPlan, GainSyntaxModeProfile } from './gain.js'
import { GainScaleScratch } from './transform.js'

import { PERSISTED_POINT_FIELDS } from '../core/tables.js'

/**
 * Translate a history generation and point ordinal into the flat gain-point arena index.
 *
 * @param {number} generation
 * @param {number} index
 * @returns {number} Flat arena index for the requested generation and ordinal.
 */
function generationSlot(generation, index) {
  return generation * STATE_GAIN_ANALYSIS_GROUP_ENTRIES + index
}

/**
 * One relinkable gain-point node shared by detector ordering and overflow reduction.
 */
class GainPointWorkEntry {
  /**
   * Initialize one arena entry with empty ordering links and neutral gain-point fields.
   */
  constructor() {
    this.reset()
  }

  /**
   * Reset the reusable gain point work entry to its empty state without reallocating its storage.
   */
  reset() {
    this.index = 0
    this.delta = 0
    this.nextActiveOffset = 0
    this.nextByIndexOffset = 0
    this.previousByIndexOffset = 0
    this.disabled = 0
    this.step = 0
    this.hasLink = 0
    this.linkGroupDelta = 0
    this.linkIndex = 0
    this.spanCost = 0
    this.pointCount = 0
  }
}

/**
 * Relative-offset arena preserving detector point identity across searches.
 */
export class GainPointWorkArena {
  /**
   * Allocate every gain-point entry up front so detector searches only relink existing storage.
   */
  constructor() {
    this.entries = Array.from(
      { length: ARENA_ENTRIES },
      () => new GainPointWorkEntry()
    )
  }

  /**
   * Reset the reusable gain point work arena to its empty state without reallocating its storage.
   */
  reset() {
    for (const entry of this.entries) entry.reset()
  }

  /**
   * Resolve a compact relative gain-point offset to its absolute arena entry.
   *
   * @param {number} base
   * @param {number} offset
   * @returns {number}
   */
  offsetToEntry(base, offset) {
    return offset === 0
      ? STATE_GAIN_ANALYSIS_NO_ENTRY
      : base + Math.trunc(offset / ENTRY_STRIDE)
  }

  /**
   * Encode a target arena index as a compact relative link from its source entry.
   *
   * @param {number} source
   * @param {number} target
   * @returns {number}
   */
  entryToOffset(source, target) {
    return target === STATE_GAIN_ANALYSIS_NO_ENTRY
      ? 0
      : (target - source) * ENTRY_STRIDE
  }

  /**
   * Resolve the next enabled gain-point entry through its compact relative link.
   *
   * @param {number} entry
   * @returns {number}
   */
  nextActive(entry) {
    return this.offsetToEntry(entry, this.entries[entry].nextActiveOffset)
  }

  /**
   * Resolve the next node in gain-index order from its compact relative link.
   *
   * @param {number} entry
   * @returns {number}
   */
  nextByIndex(entry) {
    return this.offsetToEntry(entry, this.entries[entry].nextByIndexOffset)
  }

  /**
   * Resolve the previous node in gain-index order from its compact relative link.
   *
   * @param {number} entry
   * @returns {number}
   */
  previousByIndex(entry) {
    return this.offsetToEntry(entry, this.entries[entry].previousByIndexOffset)
  }

  /**
   * Store the compact relative link to the next active gain-point entry.
   *
   * @param {number} entry
   * @param {number} target
   */
  setNextActive(entry, target) {
    this.entries[entry].nextActiveOffset = this.entryToOffset(entry, target)
  }

  /**
   * Store the compact relative link to the next gain point in index order.
   *
   * @param {number} entry
   * @param {number} target
   */
  setNextByIndex(entry, target) {
    this.entries[entry].nextByIndexOffset = this.entryToOffset(entry, target)
  }

  /**
   * Store the compact relative link to the previous gain point in index order.
   *
   * @param {number} entry
   * @param {number} target
   */
  setPreviousByIndex(entry, target) {
    this.entries[entry].previousByIndexOffset = this.entryToOffset(
      entry,
      target
    )
  }

  /**
   * Copy previous/current compact gain history into the detector arena generations.
   *
   * @param {GainDetectionBand} persisted
   */
  loadPersisted(persisted) {
    for (const [generation, persistedGroup] of [
      [STATE_GAIN_ANALYSIS_PREVIOUS, 0],
      [STATE_GAIN_ANALYSIS_CURRENT, 1],
    ]) {
      const count = Math.min(
        persisted.pointCounts[persistedGroup],
        STATE_GAIN_ANALYSIS_GROUP_ENTRIES
      )
      for (let index = 0; index < count; index++) {
        const source =
          persistedGroup * STATE_GAIN_ANALYSIS_GROUP_ENTRIES + index
        const destination = this.entries[generationSlot(generation, index)]
        destination.reset()
        for (const [property, field] of PERSISTED_POINT_FIELDS) {
          destination[property] = persisted.points[field][source]
        }
      }
    }
  }

  /**
   * Copy one gain-point generation from the arena to its compact persistent arrays.
   *
   * @param {GainDetectionBand} persisted
   * @param {number} persistedGroup
   * @param {number} generation
   * @param {number} count
   */
  persistGeneration(persisted, persistedGroup, generation, count) {
    const copied = Math.min(count, STATE_GAIN_ANALYSIS_GROUP_ENTRIES)
    for (let index = 0; index < copied; index++) {
      const source = this.entries[generationSlot(generation, index)]
      const destination =
        persistedGroup * STATE_GAIN_ANALYSIS_GROUP_ENTRIES + index
      for (const [property, field] of PERSISTED_POINT_FIELDS) {
        persisted.points[field][destination] = source[property]
      }
      persisted.points.nextActiveOffset[destination] = 0
      persisted.points.nextByIndexOffset[destination] = 0
      persisted.points.previousByIndexOffset[destination] = 0
    }
  }

  /**
   * Rotate current and next gain-point generations into the persisted frame history.
   *
   * @param {GainDetectionBand} persisted
   */
  persistForNextFrame(persisted) {
    this.persistGeneration(
      persisted,
      0,
      STATE_GAIN_ANALYSIS_CURRENT,
      persisted.pointCounts[0]
    )
    this.persistGeneration(
      persisted,
      1,
      STATE_GAIN_ANALYSIS_NEXT,
      persisted.pointCounts[1]
    )
  }
}

/**
 * Detached interval, boundary cost, and predecessor state for one gain-point search candidate.
 */
class PointSearchState {
  /**
   * Allocate boundary-cost vectors and initialize the search interval for one candidate gain point.
   */
  constructor() {
    this.boundaryStart = new Int32Array(2)
    this.boundaryEnd = new Int32Array(2)
    this.reset()
  }

  /**
   * Reset the reusable point search state to its empty state without reallocating its storage.
   */
  reset() {
    this.value = 0
    this.stride = 0
    this.boundaryStart.fill(0)
    this.boundaryEnd.fill(0)
    this.start = 0
    this.end = 0
    this.windowStart = 0
    this.windowEnd = 0
    this.expansions = 0
    this.indexPosition = STATE_GAIN_ANALYSIS_NO_ENTRY
    this.pointCount = 0
  }

  /**
   * Copy retained search-boundary arrays into this point-search state.
   *
   * @param {PointSearchState} source
   */
  copyBoundaryFrom(source) {
    this.boundaryStart.set(source.boundaryStart)
    this.boundaryEnd.set(source.boundaryEnd)
  }
}

/**
 * Allocate compact gain-band counters and previous/current peak metadata.
 *
 * @returns {GainBandState} Fresh counters and peak history for one detector band.
 */
function createBandState() {
  return {
    pointCounts: new Int32Array(3),
    disabledCounts: new Int32Array(3),
    duplicateCounts: new Int32Array(3),
    previousAbsoluteLevel: 0,
    previousPeakIndex: 0,
    currentPeakIndex: 0,
    previousPeak: 0,
    currentPeak: 0,
  }
}

/**
 * Stage-private owner for one coding-unit gain detector transaction.
 */
export class GainDetectionScratch {
  /**
   * Allocate complete detector, measurement, and envelope work.
   */
  constructor() {
    const plan = new GainRecordPlan(
      STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS,
      STATE_GAIN_ANALYSIS_GAIN_BANDS
    )
    this.arena = new GainPointWorkArena()
    this.sentinels = Array.from({ length: 3 }, () => new GainPointWorkEntry())
    this.analysisWindow = new Float32Array(GAIN_DETECTION_SAMPLES)
    this.absoluteLevels = new Float32Array(GAIN_WINDOW_BLOCKS)
    this.scaleFactors = new Float32Array(GAIN_WINDOW_BLOCKS + 1)
    this.pointStates = Array.from(
      { length: STATE_GAIN_ANALYSIS_GROUP_ENTRIES },
      () => new PointSearchState()
    )
    this.bandState = createBandState()
    this.deltaSums = new Int32Array(GAIN_WINDOW_BLOCKS)
    this.idealDeltaSums = new Int32Array(GAIN_WINDOW_BLOCKS)
    this.eventLocations = new Int32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES)
    this.eventDeltas = new Int32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES)
    this.records = plan.records
    this.plan = plan
    this.request = {}
    this.unitChannelBlocks = new Array(STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS)
    this.unitAnalysisStates = new Array(STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS)
    this.measurement = new GainMeasurementScratch()
    this.envelope = new GainEnvelopeScratch()
    this.span = {
      index: 0,
      start: 0,
      end: 0,
      startGroup: 0,
      endGroup: 0,
      skip: 0,
    }
    this.budget = {
      requestedBitCount: 0,
      bitCount: 0,
      saturationStart: false,
      saturationEnd: false,
      value: 0,
      interpolationScale: 1,
    }
    this.frontier = {
      cost: new Uint32Array(4),
      first: new Int32Array(4),
      second: new Int32Array(4),
      length: 0,
    }
    this.probes = {
      entry: new Int32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES),
      hasCandidate: new Uint8Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES),
      cost: new Uint32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES),
      first: new Int32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES),
      second: new Int32Array(STATE_GAIN_ANALYSIS_GROUP_ENTRIES),
      length: 0,
    }
    this.action = {
      merge: false,
      entry: STATE_GAIN_ANALYSIS_NO_ENTRY,
      cost: 0,
      first: 0,
      second: 0,
    }
    this.referencePrepared = false
  }
}

/**
 * Fixed storage shared by low-rate gain-record merge policy.
 */
export class GainRecordPolicyScratch {
  /**
   * Allocate detached merge, edit, and transition records.
   */
  constructor() {
    this.mergeIndices = new Int32Array(GAIN_SLOT_COUNT)
    this.stereoRecords = [new GainRecord(), new GainRecord()]
    this.mergedRecord = new GainRecord()
    this.band0Incumbent = new GainRecord()
    this.band0HasIncumbent = false
    this.transition = {
      entry: 0,
      location: 0,
      levelBefore: 0,
      levelAfter: 0,
      drop: 0,
    }
    this.edit = { type: 0, index: 0, location: 0, level: 0 }
  }
}

/**
 * Round a requested hash capacity up to the next power of two.
 *
 * @param {number} value
 * @returns {number}
 */
function nextPowerOfTwo(value) {
  let result = 1
  while (result < value) result *= 2
  return result
}

/**
 * Fixed-frontier graph and uniqueness index for gain-overflow reduction.
 */
export class GainOverflowScratch {
  /**
   * Allocate a bounded graph and hash index.
   *
   * @param {number} [stateCapacity] Maximum retained frontier states.
   */
  constructor(stateCapacity = GAIN_OVERFLOW_STATE_CAPACITY) {
    if (!Number.isInteger(stateCapacity) || stateCapacity < 1) {
      throw new RangeError('gain-overflow state capacity must be positive')
    }
    const hashCapacity = nextPowerOfTwo(stateCapacity * 2)
    this.stateCapacity = stateCapacity
    this.entries = new Uint8Array(stateCapacity)
    this.locations = new Uint8Array(stateCapacity * GAIN_SLOT_COUNT)
    this.levels = new Uint8Array(stateCapacity * GAIN_SLOT_COUNT)
    this.peaks = new Float32Array(stateCapacity)
    this.stepCounts = new Uint8Array(stateCapacity)
    this.terminalIndices = new Uint32Array(stateCapacity)
    this.candidateStateIndices = new Uint32Array(stateCapacity)
    this.candidateDifferenceEnergies = new Float64Array(stateCapacity)
    this.candidateSyntaxBits = new Int32Array(stateCapacity)
    this.hashSlots = new Uint32Array(hashCapacity)
    this.hashMask = hashCapacity - 1
    this.dropEntries = new Int32Array(GAIN_SLOT_COUNT)
    this.sourceRecord = new GainRecord()
    this.candidateRecord = new GainRecord()
    this.stateCount = 0
    this.terminalCount = 0
    this.candidateCount = 0
  }
}

/**
 * Allocate detached previous/current gain records for one candidate channel block.
 *
 * @returns {GainCandidateBlock}
 */
function createGainCandidateBlock() {
  return {
    channelOrdinal: 0,
    currentGainRecords: Array.from(
      { length: STATE_GAIN_ANALYSIS_GAIN_BANDS },
      () => new GainRecord()
    ),
    previousGainRecords: Array.from(
      { length: STATE_GAIN_ANALYSIS_GAIN_BANDS },
      () => new GainRecord()
    ),
  }
}

/**
 * Allocate the maximum channel bank of detached gain candidate blocks.
 *
 * @returns {GainCandidateBlock[]}
 */
function createGainCandidateBank() {
  return Array.from(
    { length: STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS },
    createGainCandidateBlock
  )
}

/**
 * Allocate fixed band and paired-record storage for stereo gain-merge candidates.
 *
 * @returns {{count: number, bands: Uint8Array, records: GainRecord[][]}}
 */
function createStereoMergeFrontier() {
  return {
    count: 0,
    bands: new Uint8Array(STATE_GAIN_ANALYSIS_GAIN_BANDS),
    records: Array.from({ length: STATE_GAIN_ANALYSIS_GAIN_BANDS }, () => [
      new GainRecord(),
      new GainRecord(),
    ]),
  }
}

/**
 * Allocate per-channel storage for neighboring-band gain-merge candidates.
 *
 * @returns {{counts: Uint8Array, bands: Uint8Array[], records: GainRecord[][]}}
 */
function createAdjacentMergeFrontier() {
  return {
    counts: new Uint8Array(STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS),
    bands: Array.from(
      { length: STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS },
      () => new Uint8Array(STATE_GAIN_ANALYSIS_GAIN_BANDS)
    ),
    records: Array.from({ length: STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS }, () =>
      Array.from(
        { length: STATE_GAIN_ANALYSIS_GAIN_BANDS },
        () => new GainRecord()
      )
    ),
  }
}

/**
 * Allocate one detached incumbent gain candidate for every record slot.
 *
 * @returns {GainOverflowIncumbent[]}
 */
function createOverflowIncumbentCandidates() {
  return Array.from({ length: GAIN_SLOT_COUNT }, () => ({
    record: new GainRecord(),
    peak: 0,
    effect: new SignalComparison(),
    syntaxBits: null,
  }))
}

/**
 * Return the nested adjustment depth required by one coding-unit policy.
 *
 * @param {number} channelCount Active coding-unit channels.
 * @param {number} coreMode Profile core-mode selector.
 * @returns {number} Negative one when adjustment is unused, otherwise the required nested depth.
 */
export function lowRateGainScratchDepth(channelCount, coreMode) {
  if (channelCount === 1) return coreMode < 0x10 ? 1 : -1
  if (channelCount === 2) return coreMode < 0x14 ? 2 : -1
  return -1
}

/**
 * Complete fixed numerical and policy work for low-rate gain adjustment.
 */
export class LowRateGainScratch {
  /**
   * Allocate nested candidate work to a bounded retry depth.
   *
   * @param {number} [nestedDepth=2] Remaining nested adjustment depth.
   */
  constructor(nestedDepth = 2) {
    if (!Number.isInteger(nestedDepth) || nestedDepth < 0) {
      throw new RangeError('ATRAC3plus nested gain scratch depth is invalid')
    }
    this.source = new Float32Array(STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES)
    this.incumbent = new Float32Array(STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES)
    this.candidate = new Float32Array(STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES)
    this.completeIncumbent = new Float32Array(COMPLETE_SIGNAL_SAMPLES)
    this.completeCandidate = new Float32Array(COMPLETE_SIGNAL_SAMPLES)
    this.gainScale = new GainScaleScratch()
    this.effect = new SignalComparison()
    this.loweredEffect = new SignalComparison()
    this.peakEnvelopes = new PeakEnvelopeComparison(GAIN_WINDOW_BLOCKS)
    this.recordPolicy = new GainRecordPolicyScratch()
    this.overflow = new GainOverflowScratch()
    this.overflowIncumbentCandidates = createOverflowIncumbentCandidates()
    this.overflowIncumbentCount = 0
    this.selectedBlocks = createGainCandidateBank()
    this.candidateBlocks = createGainCandidateBank()
    this.postStereoBlocks = createGainCandidateBank()
    this.preOverflowBlocks = createGainCandidateBank()
    this.monoSources = new Array(1)
    this.stereoSources = new Array(STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS)
    this.publication = new GainRecordPlan(
      STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS,
      STATE_GAIN_ANALYSIS_GAIN_BANDS
    )
    this.stereoFrontier = createStereoMergeFrontier()
    this.band0FrontierActive = new Uint8Array(
      STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS
    )
    this.band0FrontierRecords = Array.from(
      { length: STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS },
      () => new GainRecord()
    )
    this.adjacentFrontier = createAdjacentMergeFrontier()
    this.temporaryRecord = new GainRecord()
    this.selectedRecord = new GainRecord()
    this.overflowSourceRecord = new GainRecord()
    this.overflowPreviousRecord = new GainRecord()
    this.syntaxPricing = {
      workspace: new GainCodingPlan(),
      incumbentModes: new GainSyntaxModeProfile(),
      incumbentBits: 0,
    }
    this.lowered = {
      incumbentBits: 0,
      fixedModeBits: 0,
      optimizedBits: 0,
    }
    this.nested =
      nestedDepth > 0 ? new LowRateGainScratch(nestedDepth - 1) : null
  }
}

/**
 * Complete stage-private work shared by gain detection and adjustment.
 */
export class GainAnalysisScratch {
  /**
   * Allocate profile-neutral detection work. Adjustment storage is configured with the stream.
   */
  constructor() {
    this.detection = new GainDetectionScratch()
    this.adjustment = null
    this.adjustmentDepth = -1
  }

  /**
   * Match low-rate adjustment storage to the deepest active coding-unit policy.
   *
   * @param {number} nestedDepth Negative one when the profile never adjusts gain.
   * @returns {LowRateGainScratch|null} Configured reusable adjustment storage.
   */
  configureAdjustment(nestedDepth) {
    if (
      !Number.isInteger(nestedDepth) ||
      nestedDepth < -1 ||
      nestedDepth > STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS
    ) {
      throw new RangeError('ATRAC3plus gain scratch depth is invalid')
    }
    if (nestedDepth !== this.adjustmentDepth) {
      this.adjustment =
        nestedDepth < 0 ? null : new LowRateGainScratch(nestedDepth)
      this.adjustmentDepth = nestedDepth
    }
    return this.adjustment
  }
}
