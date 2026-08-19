/** ATRAC3plus gain-point detection, reduction, and detached publication. */

import {
  prepareGainEnvelopeReference,
  reconstructGainDeltaLevels,
  scoreGainLevelAdjustment,
  writeGainRecordDeltaEnvelope,
} from '../coding/gain.js'
import {
  gainBlock4IsActive,
  buildSortedIndexOrder,
  computeGainFlatnessScale,
  measureGainBlockPeaks,
  requiredGainRangeBits,
} from './gain-measurement.js'
import { planLowModeGainAdjustment } from './gain-adjustment.js'
import {
  GainPointWorkArena,
  lowRateGainScratchDepth,
} from '../state/gain-analysis.js'
import { saturatingInt32FromFloat } from '../utils.js'
import {
  BOUNDARY_END,
  BOUNDARY_START,
  ANALYSIS_GAIN_DETECTION_CURRENT,
  EXPAND_AFTER,
  EXPAND_BEFORE,
  ANALYSIS_GAIN_DETECTION_GAIN_BANDS,
  GAIN_CONTROL_LOG2_E,
  GAIN_CONTROL_SPAN_OFFSET_8,
  GAIN_CONTROL_SPAN_OFFSET_16,
  GAIN_CONTROL_SPAN_OFFSET_32,
  GAIN_CONTROL_START_OFFSET,
  GAIN_FLOATS_PER_BLOCK,
  ANALYSIS_GAIN_DETECTION_GAIN_MAX_CHANNELS,
  ANALYSIS_GAIN_DETECTION_GAIN_PREFIX_SAMPLES,
  ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES,
  ANALYSIS_GAIN_DETECTION_NEXT,
  ANALYSIS_GAIN_DETECTION_NO_ENTRY,
  ANALYSIS_GAIN_DETECTION_PREVIOUS,
  REDUCTION_LEVEL_CEILING,
  REDUCTION_LEVEL_FLOOR,
  GAIN_WINDOW_BLOCKS,
} from '../core/constants.js'

/**
 * Translate a history generation and point ordinal into the flat gain-point arena index.
 *
 * @param {number} generation
 * @param {number} index
 * @returns {number}
 */
function generationSlot(generation, index) {
  return generation * ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES + index
}

/**
 * Load band state from committed history into the detached workspace used inside the fixed-capacity gain-point detector and reduction graph.
 *
 * @param {GainDetectionBand} persisted
 * @param {GainBandState} state
 * @returns {GainBandState}
 */
function loadBandState(persisted, state) {
  state.pointCounts.set([persisted.pointCounts[0], persisted.pointCounts[1], 0])
  state.disabledCounts.set([
    persisted.disabledCounts[0],
    persisted.disabledCounts[1],
    0,
  ])
  state.duplicateCounts.set([persisted.duplicateCount, 0, 0])
  state.previousAbsoluteLevel = persisted.previousAbsoluteLevel
  state.previousPeakIndex = persisted.previousPeakIndex
  state.currentPeakIndex = persisted.currentPeakIndex | 0
  state.previousPeak = persisted.previousPeak
  state.currentPeak = persisted.currentPeak
  return state
}

/**
 * Copy the detector's next gain-point generation into persistent channel history.
 *
 * @param {GainBandState} state
 * @param {GainDetectionBand} persisted
 * @param {number} maximumIndex
 * @param {number} maximumValue
 * @param {ArrayLike<number>} absoluteLevels
 * @param {ArrayLike<number>} scaleFactors
 */
function commitBandState(
  state,
  persisted,
  maximumIndex,
  maximumValue,
  absoluteLevels,
  scaleFactors
) {
  const previousAbsoluteLevel = persisted.absoluteLevelHistory[31]
  persisted.absoluteLevelHistory.copyWithin(0, 32)
  persisted.absoluteLevelHistory.set(absoluteLevels, 32)
  state.previousAbsoluteLevel = previousAbsoluteLevel
  persisted.scaleHistory.copyWithin(0, 32, 63)
  for (let index = 0; index < 32; index++) {
    persisted.scaleHistory[31 + index] = scaleFactors[1 + index]
  }
  persisted.scaleHistory[63] = 0
  state.previousPeakIndex = state.currentPeakIndex >>> 0
  state.currentPeakIndex = maximumIndex
  state.previousPeak = state.currentPeak
  state.currentPeak = maximumValue
  persisted.previousAbsoluteLevel = state.previousAbsoluteLevel
  persisted.previousPeakIndex = state.previousPeakIndex
  persisted.currentPeakIndex = state.currentPeakIndex >>> 0
  persisted.previousPeak = state.previousPeak
  persisted.currentPeak = state.currentPeak
  persisted.pointCounts[0] = state.pointCounts[ANALYSIS_GAIN_DETECTION_CURRENT]
  persisted.pointCounts[1] = state.pointCounts[ANALYSIS_GAIN_DETECTION_NEXT]
  persisted.disabledCounts[0] =
    state.disabledCounts[ANALYSIS_GAIN_DETECTION_CURRENT]
  persisted.disabledCounts[1] =
    state.disabledCounts[ANALYSIS_GAIN_DETECTION_NEXT]
  persisted.duplicateCount =
    state.duplicateCounts[ANALYSIS_GAIN_DETECTION_CURRENT]
}

/**
 * Resolve detector tuning into caller-owned coding-unit storage.
 *
 * @param {GainDetectionRequest} destination Request object to overwrite.
 * @param {number} correlationStartBand First stereo-correlation band.
 * @param {number} bandCount Active gain-band count.
 * @param {number} coreMode Profile core-mode selector.
 * @param {number} channelMode Coding-unit channel mode.
 * @param {number} channelCount Active coding-unit channels.
 * @returns {GainDetectionRequest} The configured destination request.
 */
export function configureGainDetectionRequest(
  destination,
  correlationStartBand,
  bandCount,
  coreMode,
  channelMode,
  channelCount
) {
  if (!destination || typeof destination !== 'object') {
    throw new TypeError('ATRAC3plus gain detector request owner is invalid')
  }
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > ANALYSIS_GAIN_DETECTION_GAIN_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus gain detector supports mono or stereo')
  }
  const encodedChannelCount =
    channelMode === 1 || channelMode === 4
      ? 1
      : channelMode === 2 || channelMode === 3
        ? 2
        : 0
  const fullRate =
    encodedChannelCount === 1
      ? coreMode > 0x0e
      : encodedChannelCount === 2
        ? coreMode > 0x12
        : false
  const lowMode = lowRateGainScratchDepth(channelCount, coreMode) >= 0
  destination.correlationStartBand = Math.max(correlationStartBand, 6)
  destination.bandCount = Math.min(
    bandCount,
    ANALYSIS_GAIN_DETECTION_GAIN_BANDS
  )
  destination.spanShift = !fullRate ? 0.35 : lowMode ? 0.15 : 0
  destination.coreMode = coreMode
  destination.lowMode = lowMode
  destination.channelCount = channelCount
  return destination
}

/**
 * Translate a candidate and sort position into the flat ordering workspace.
 *
 * @param {ArrayLike<number>} order
 * @param {number} position
 * @returns {number}
 */
function orderIndex(order, position) {
  return position !== ANALYSIS_GAIN_DETECTION_NO_ENTRY
    ? order.indices[position]
    : 0
}

/**
 * Advance to the next live entry in the candidate ordering.
 *
 * @param {ArrayLike<number>} order
 * @param {number} position
 * @returns {number}
 */
function orderNext(order, position) {
  const next = position + 1
  return position !== ANALYSIS_GAIN_DETECTION_NO_ENTRY && next < order.length
    ? next
    : ANALYSIS_GAIN_DETECTION_NO_ENTRY
}

/**
 * Load persisted gain points into the arena and initialize detector-local links and counters.
 *
 * @param {PointSearchState} state
 * @param {number} value
 * @param {number} windowStart
 * @param {number} windowEnd
 * @param {number} indexPosition
 * @param {number} startBits
 * @param {number} endBits
 * @param {number} expansion
 */
function initializePointState(
  state,
  value,
  windowStart,
  windowEnd,
  indexPosition,
  startBits,
  endBits,
  expansion
) {
  state.reset()
  state.value = value
  state.boundaryStart[0] = startBits
  state.boundaryEnd[1] = endBits
  state.start = windowStart
  state.end = windowEnd
  state.windowStart = windowStart
  state.windowEnd = windowEnd
  state.expansions = expansion
  state.indexPosition = indexPosition
}

/**
 * Materialize derived gain-point links, spans, and syntax costs from the compact persisted state.
 *
 * @param {PointSearchState} source
 * @param {ArrayLike<number>} order
 * @param {number} expansion
 * @param {PointSearchState} destination
 */
function expandPointState(source, order, expansion, destination) {
  destination.reset()
  const head = orderIndex(order, source.indexPosition)
  const limit = expansion === EXPAND_BEFORE ? source.start : source.end
  let position = orderNext(order, source.indexPosition)
  while (position !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    const index = order.indices[position]
    const inside =
      expansion === EXPAND_BEFORE
        ? index < head && index > limit
        : index > head && index < limit
    if (inside) break
    position = orderNext(order, position)
  }
  if (expansion === EXPAND_BEFORE) {
    destination.stride =
      limit === source.windowStart ? head * 2 - 0x20 : (head - limit) * 2 - 2
    destination.start = limit
    destination.end = head
  } else {
    destination.stride =
      limit === source.windowEnd
        ? (0x1f - head) * 2 + 0x20
        : (limit - head) * 2 - 2
    destination.start = head
    destination.end = limit
  }
  destination.windowStart = source.windowStart
  destination.windowEnd = source.windowEnd
  destination.indexPosition = position
}

/**
 * Map a wrapped gain index to the syntax group used for delta coding.
 *
 * @param {number} index
 * @returns {number}
 */
function gainIndexGroup(index) {
  return index > 0x1f ? 1 : 0
}

/**
 * Report whether two gain-point spans overlap or share a boundary.
 *
 * @param {GainPointSpan} span Candidate gain-point span.
 * @param {number} boundary
 * @param {PointSearchState} state
 * @returns {boolean}
 */
function spanTouches(span, boundary, state) {
  return boundary === BOUNDARY_START
    ? span.start === state.windowStart
    : span.end === state.windowEnd
}

/**
 * Convert a gain-point span into its compact stored offset.
 *
 * @param {number} start
 * @param {number} end
 * @param {PointSearchState} state
 * @returns {number}
 */
function gainSpanOffset(start, end, state) {
  if (start === state.windowStart) return GAIN_CONTROL_START_OFFSET
  if (end === state.windowEnd) return GAIN_CONTROL_SPAN_OFFSET_16
  const span = end - start - 1
  if (span >= 32) return GAIN_CONTROL_SPAN_OFFSET_32
  if (span >= 16) return GAIN_CONTROL_SPAN_OFFSET_16
  if (span >= 8) return GAIN_CONTROL_SPAN_OFFSET_8
  return 0
}

/**
 * Return the irreducible syntax cost of the active gain-point set.
 *
 * @param {number} start
 * @param {number} end
 * @param {PointSearchState} state
 * @returns {number}
 */
function gainMinimumBits(start, end, state) {
  if (start === state.windowStart || end === state.windowEnd) return 1
  const span = end - start - 1
  if (span >= 12) return 1
  if (span >= 8) return 2
  if (span >= 6) return 3
  return 4
}

/**
 * Wrap a gain index into the six-bit syntax domain.
 *
 * @param {number} index
 * @returns {number}
 */
function wrapGainIndex(index) {
  if (index < 0) {
    const base = (index + 0x1f) & ~0x1f
    return index - base
  }
  return index & 0x1f
}

/**
 * Populate one arena entry from a detected gain event and reset all graph links.
 *
 * @param {GainPointWorkEntry} entry
 * @param {number} pointCount
 * @param {number} index
 * @param {number} step
 * @param {number} delta
 */
function initializeGainPointEntry(entry, pointCount, index, step, delta) {
  entry.disabled = 0
  entry.spanCost = 0
  entry.pointCount = pointCount
  entry.index = wrapGainIndex(index)
  entry.step = step
  entry.delta = delta
  entry.hasLink = 0
}

/**
 * Connect adjacent gain-point entries in both active and index order.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} startEntry
 * @param {number} endEntry
 * @param {number} startGroup
 * @param {number} endGroup
 * @param {number} startIndex
 * @param {number} endIndex
 */
function linkGainPointPair(
  arena,
  startEntry,
  endEntry,
  startGroup,
  endGroup,
  startIndex,
  endIndex
) {
  const start = arena.entries[startEntry]
  start.hasLink = 1
  start.linkGroupDelta = endGroup - startGroup
  start.linkIndex = endIndex
  const end = arena.entries[endEntry]
  end.hasLink = 1
  end.linkGroupDelta = startGroup - endGroup
  end.linkIndex = startIndex
}

/**
 * Derive the sample span influenced by one gain point and its neighbors.
 *
 * @param {PointSearchState} destination
 * @param {ArrayLike<number>} order
 * @param {GainPointSpan} span Reusable destination for the derived bounds.
 * @returns {GainPointSpan} The populated span destination.
 */
function computePointSpan(destination, order, span) {
  const index = orderIndex(order, destination.indexPosition)
  const start = destination.start
  const end = destination.end
  let skip = 0
  if (index > start + 4 || start === destination.windowStart) {
    if (index !== start + 1) destination.expansions |= EXPAND_BEFORE
  } else {
    destination.expansions &= ~EXPAND_BEFORE
    skip = index - start - 1
  }
  if (end > index + 4 || end === destination.windowEnd) {
    if (end !== index + 1) destination.expansions |= EXPAND_AFTER
  } else {
    destination.expansions &= ~EXPAND_AFTER
    skip += end - index - 1
  }
  span.index = index
  span.start = start
  span.end = end
  span.startGroup = gainIndexGroup(start + 1)
  span.endGroup = gainIndexGroup(end - 1)
  span.skip = skip
  return span
}

/**
 * Return the syntax cost contributed by one gain-point boundary.
 *
 * @param {PointSearchState} state
 * @param {number} boundary
 * @param {number} group
 * @returns {number}
 */
function boundaryBits(state, boundary, group) {
  return boundary === BOUNDARY_START
    ? state.boundaryStart[group]
    : state.boundaryEnd[group]
}

/**
 * Accumulate the syntax cost introduced by a gain-point boundary.
 *
 * @param {PointSearchState} state
 * @param {number} boundary
 * @param {number} group
 * @param {number} bits
 */
function addBoundaryBits(state, boundary, group, bits) {
  if (boundary === BOUNDARY_START) state.boundaryStart[group] += bits
  else state.boundaryEnd[group] += bits
}

/**
 * Recompute the retained gain-point count and exact syntax budget.
 *
 * @param {GainDetectionBand} history
 * @param {PointSearchState} source
 * @param {ArrayLike<number>} order
 * @param {PointSearchState} destination
 * @param {GainPointSpan} span Derived sample and group bounds.
 * @param {number} spanShift
 * @param {GainPointBudget} budget Reusable destination for the computed syntax cost.
 * @returns {GainPointBudget} The populated budget destination.
 */
function computePointBudget(
  history,
  source,
  order,
  destination,
  span,
  spanShift,
  budget
) {
  const value = history.absoluteLevelHistory[span.index]
  const sourceIndex = orderIndex(order, source.indexPosition)
  const sourceValue = history.absoluteLevelHistory[sourceIndex]
  let interpolationScale = 1
  const sourceLevel = source.value
  let requestedBitCount = 0
  if (sourceValue > 0 && value > 0) {
    if (!spanTouches(span, BOUNDARY_START, destination)) {
      interpolationScale = history.scaleHistory[span.start + 1]
    }
    if (!spanTouches(span, BOUNDARY_END, destination)) {
      const endValue = history.scaleHistory[span.end]
      if (endValue > interpolationScale) interpolationScale = endValue
    }
    const scaledValue = value * interpolationScale
    if (
      Number.isNaN(scaledValue) ||
      Number.isNaN(sourceLevel) ||
      scaledValue <= sourceLevel
    ) {
      const log2Ratio =
        Math.log(sourceLevel / scaledValue) * GAIN_CONTROL_LOG2_E
      requestedBitCount = saturatingInt32FromFloat(
        log2Ratio +
          gainSpanOffset(span.start, span.end, destination) -
          spanShift
      )
    }
  }
  let bitCount = requestedBitCount
  let saturationStart = false
  let saturationEnd = false
  for (const boundary of [BOUNDARY_END, BOUNDARY_START]) {
    if (spanTouches(span, boundary, destination)) continue
    const group = boundary === BOUNDARY_START ? span.startGroup : span.endGroup
    const used = boundaryBits(destination, boundary, group)
    const maximum = boundary === BOUNDARY_START ? 6 : 9
    if (bitCount + used > maximum) {
      bitCount = maximum - used
      if (boundary === BOUNDARY_START) saturationStart = true
      else saturationEnd = true
    }
  }
  budget.requestedBitCount = requestedBitCount
  budget.bitCount = bitCount
  budget.saturationStart = saturationStart
  budget.saturationEnd = saturationEnd
  budget.value = value
  budget.interpolationScale = interpolationScale
  return budget
}

/**
 * Convert detected envelope events into bounded arena entries and return their active count.
 *
 * @param {GainPointSpan} span Derived sample and group bounds.
 * @param {GainPointBudget} budget Saturated syntax budget for the point.
 * @param {PointSearchState} destination
 * @param {GainPointWorkArena} arena
 * @param {ArrayLike<number>} counts
 */
function emitGainPointEntries(span, budget, destination, arena, counts) {
  const step = (budget.bitCount * destination.stride) | 0
  let endEntry = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  if (!spanTouches(span, BOUNDARY_END, destination)) {
    const endIndex = counts[span.endGroup + 1]
    endEntry = generationSlot(span.endGroup + 1, endIndex)
    arena.entries[endEntry].reset()
    initializeGainPointEntry(
      arena.entries[endEntry],
      destination.pointCount,
      span.end - 1,
      step,
      budget.bitCount
    )
    addBoundaryBits(destination, BOUNDARY_END, span.endGroup, budget.bitCount)
    counts[span.endGroup + 1]++
  }
  if (spanTouches(span, BOUNDARY_START, destination)) {
    destination.value = budget.value
    return
  }
  const startIndex = counts[span.startGroup + 1]
  const startEntry = generationSlot(span.startGroup + 1, startIndex)
  arena.entries[startEntry].reset()
  initializeGainPointEntry(
    arena.entries[startEntry],
    destination.pointCount,
    span.start + 1,
    step,
    -budget.bitCount
  )
  if (endEntry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    linkGainPointPair(
      arena,
      startEntry,
      endEntry,
      span.startGroup,
      span.endGroup,
      counts[span.startGroup + 1],
      counts[span.endGroup + 1] - 1
    )
  }
  addBoundaryBits(destination, BOUNDARY_START, span.startGroup, budget.bitCount)
  counts[span.startGroup + 1]++
  destination.value = budget.value
}

/**
 * Insert one detected gain event into the arena and update its active and index orderings.
 *
 * @param {GainDetectionBand} history
 * @param {PointSearchState} source
 * @param {ArrayLike<number>} order
 * @param {PointSearchState} destination
 * @param {GainPointWorkArena} arena
 * @param {ArrayLike<number>} counts
 * @param {number} spanShift
 * @param {GainDetectionScratch} scratch
 * @returns {number}
 */
function placeGainPoint(
  history,
  source,
  order,
  destination,
  arena,
  counts,
  spanShift,
  scratch
) {
  destination.copyBoundaryFrom(source)
  const span = computePointSpan(destination, order, scratch.span)
  const budget = computePointBudget(
    history,
    source,
    order,
    destination,
    span,
    spanShift,
    scratch.budget
  )
  const minimum = gainMinimumBits(span.start, span.end, destination)
  if (budget.bitCount < minimum) {
    destination.pointCount = source.pointCount
    if (budget.saturationStart || budget.saturationEnd) {
      destination.value = budget.value
    } else {
      const value = budget.value
      destination.value = Math.fround(
        value + (source.value - value) / budget.interpolationScale
      )
    }
  } else {
    destination.pointCount = source.pointCount + 1
    emitGainPointEntries(span, budget, destination, arena, counts)
  }
  return span.skip
}

/**
 * Resolve the first index-ordered entry represented by a sentinel node.
 *
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @returns {number}
 */
function sentinelNextByIndex(sentinels, sentinel) {
  const offset = sentinels[sentinel].nextByIndexOffset
  return offset === 0 ? ANALYSIS_GAIN_DETECTION_NO_ENTRY : offset - 1
}

/**
 * Update the sentinel link that anchors the index-ordered gain-point list.
 *
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @param {number} target
 */
function setSentinelNextByIndex(sentinels, sentinel, target) {
  sentinels[sentinel].nextByIndexOffset =
    target === ANALYSIS_GAIN_DETECTION_NO_ENTRY ? 0 : target + 1
}

/**
 * Resolve the first active entry represented by a sentinel node.
 *
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @returns {number}
 */
function sentinelNextActive(sentinels, sentinel) {
  const offset = sentinels[sentinel].nextActiveOffset
  return offset === 0 ? ANALYSIS_GAIN_DETECTION_NO_ENTRY : offset - 1
}

/**
 * Update the sentinel link that anchors the active gain-point list.
 *
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @param {number} target
 */
function setSentinelNextActive(sentinels, sentinel, target) {
  sentinels[sentinel].nextActiveOffset =
    target === ANALYSIS_GAIN_DETECTION_NO_ENTRY ? 0 : target + 1
}

/**
 * Link every enabled gain point in chronological active order.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} generation
 * @param {number} count
 * @returns {number}
 */
function buildActiveList(arena, generation, count) {
  let activeHead = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  for (let index = 0; index < count; index++) {
    const entry = generationSlot(generation, index)
    if (arena.previousByIndex(entry) !== ANALYSIS_GAIN_DETECTION_NO_ENTRY)
      continue
    arena.setNextActive(entry, activeHead)
    activeHead = entry
  }
  return activeHead
}

/**
 * Insert a gain point into stable index order while retaining the active ordering.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @param {number} tail
 * @param {number} entry
 * @returns {number}
 */
function insertByIndex(arena, sentinels, sentinel, tail, entry) {
  let previousIsSentinel = true
  let previous = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  let next = sentinelNextByIndex(sentinels, sentinel)
  const indexKey = arena.entries[entry].index
  if (
    next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    indexKey < arena.entries[next].index
  ) {
    for (;;) {
      previousIsSentinel = false
      previous = next
      next = arena.nextByIndex(previous)
      if (
        next === ANALYSIS_GAIN_DETECTION_NO_ENTRY ||
        indexKey >= arena.entries[next].index
      )
        break
    }
  }
  if (arena.entries[entry].delta < 0) {
    while (
      next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
      indexKey === arena.entries[next].index &&
      arena.entries[entry].pointCount >>> 0 <
        arena.entries[next].pointCount >>> 0
    ) {
      previousIsSentinel = false
      previous = next
      next = arena.nextByIndex(previous)
    }
  } else {
    while (
      next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
      indexKey === arena.entries[next].index &&
      arena.entries[next].pointCount >>> 0 <
        arena.entries[entry].pointCount >>> 0
    ) {
      previousIsSentinel = false
      previous = next
      next = arena.nextByIndex(previous)
    }
  }
  arena.setNextByIndex(entry, next)
  arena.setPreviousByIndex(
    entry,
    previousIsSentinel ? ANALYSIS_GAIN_DETECTION_NO_ENTRY : previous
  )
  if (next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY)
    arena.setPreviousByIndex(next, entry)
  else tail = entry
  if (previousIsSentinel) setSentinelNextByIndex(sentinels, sentinel, entry)
  else arena.setNextByIndex(previous, entry)
  return tail
}

/**
 * Link every gain point in stable gain-index order for duplicate and merge searches.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} sentinel
 * @param {number} generation
 * @param {number} count
 * @returns {number}
 */
function buildByIndexList(arena, sentinels, sentinel, generation, count) {
  let tail = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  for (let index = 0; index < count; index++) {
    const entry = generationSlot(generation, index)
    if (arena.entries[entry].disabled !== 0) continue
    tail = insertByIndex(arena, sentinels, sentinel, tail, entry)
  }
  return tail
}

/**
 * Count equal gain-point keys while traversing the reverse ordering.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} tail
 * @returns {number}
 */
function duplicateKeyCountReverse(arena, tail) {
  if (tail === ANALYSIS_GAIN_DETECTION_NO_ENTRY) return 0
  let count = 0
  let previous = tail
  let entry = arena.previousByIndex(tail)
  while (entry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    if (arena.entries[entry].index === arena.entries[previous].index) count++
    previous = entry
    entry = arena.previousByIndex(entry)
  }
  return count
}

/**
 * Build reverse cumulative delta costs for merge-candidate scoring.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} tail
 * @param {ArrayLike<number>} sums
 * @returns {ArrayLike<number>}
 */
function fillDeltaSumsReverse(arena, tail, sums) {
  sums.fill(0)
  let entry = tail
  while (entry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    const key = arena.entries[entry].index
    if (key >>> 0 < GAIN_WINDOW_BLOCKS) {
      sums[key] += arena.entries[entry].delta
    }
    entry = arena.previousByIndex(entry)
  }
  return sums
}

/**
 * Collect nonzero gain-envelope deltas and their locations into fixed event arrays.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} head
 * @param {ArrayLike<number>} locations
 * @param {ArrayLike<number>} deltas
 * @returns {number}
 */
function collectDeltaEvents(arena, head, locations, deltas) {
  let count = 0
  let entry = head
  while (entry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    if (count >= locations.length) {
      throw new Error('ATRAC3plus gain by-index chain exceeds its arena')
    }
    locations[count] = arena.entries[entry].index
    deltas[count] = arena.entries[entry].delta
    count++
    entry = arena.nextByIndex(entry)
  }
  return count
}

/**
 * Find the next entry whose gain-point index differs from the current run.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} entry
 * @param {number} direction
 * @returns {number}
 */
function distinctIndexBy(arena, entry, direction) {
  const index = arena.entries[entry].index
  let adjacent =
    direction > 0 ? arena.nextByIndex(entry) : arena.previousByIndex(entry)
  while (
    adjacent !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    arena.entries[adjacent].index === index
  ) {
    adjacent =
      direction > 0
        ? arena.nextByIndex(adjacent)
        : arena.previousByIndex(adjacent)
  }
  return adjacent
}

/**
 * Append a reduction candidate only when its gain-point pair is not already present.
 *
 * @param {GainMergeFrontier} frontier
 * @param {number} cost
 * @param {number} first
 * @param {number} second
 */
function pushUniqueCandidate(frontier, cost, first, second) {
  for (let index = 0; index < frontier.length; index++) {
    if (
      frontier.cost[index] === cost &&
      frontier.first[index] === first &&
      frontier.second[index] === second
    ) {
      return
    }
  }
  if (frontier.length >= 4) {
    throw new Error('ATRAC3plus merge frontier exceeded fixed capacity')
  }
  const index = frontier.length++
  frontier.cost[index] = cost
  frontier.first[index] = first
  frontier.second[index] = second
}

/**
 * Evaluate one gain-point merge and retain it only if it improves the current reduction choice.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} source
 * @param {number} target
 * @param {number} direction
 * @param {number} linkedTarget
 * @param {ArrayLike<number>} deltaSums
 * @param {number} baseline
 * @param {GainMergeFrontier} frontier
 */
function considerMergeCandidate(
  arena,
  source,
  target,
  direction,
  linkedTarget,
  deltaSums,
  baseline,
  frontier
) {
  if (target === ANALYSIS_GAIN_DETECTION_NO_ENTRY) return
  const targetDelta = arena.entries[target].delta
  if (direction > 0 ? targetDelta <= 0 : targetDelta >= 0) return
  let higher = source
  let lower = target
  if (arena.entries[higher].index < arena.entries[lower].index) {
    const swap = higher
    higher = lower
    lower = swap
  }
  const first = direction > 0 ? lower : higher
  const second = direction > 0 ? higher : lower
  const targetIndex = arena.entries[second].index
  const distance = Math.abs(arena.entries[first].index - targetIndex)
  const spanBase =
    linkedTarget === second
      ? arena.entries[second].linkIndex
      : arena.entries[second].spanCost
  const span = spanBase + distance
  if (span >>> 0 >= 2) return
  const cost =
    (distance * deltaSums[targetIndex] * (direction > 0 ? 2 : -2)) >>> 0
  if (cost < baseline) pushUniqueCandidate(frontier, cost, first, second)
}

/**
 * Generate every legal predecessor/successor merge involving one active gain point.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} entry
 * @param {number} baseline
 * @param {ArrayLike<number>} deltaSums
 * @param {GainMergeFrontier} frontier
 * @returns {GainMergeFrontier}
 */
function mergeCandidatesForEntry(arena, entry, baseline, deltaSums, frontier) {
  frontier.length = 0
  const direction = arena.entries[entry].delta >= 0 ? 1 : -1
  considerMergeCandidate(
    arena,
    entry,
    distinctIndexBy(arena, entry, 1),
    direction,
    ANALYSIS_GAIN_DETECTION_NO_ENTRY,
    deltaSums,
    baseline,
    frontier
  )
  considerMergeCandidate(
    arena,
    entry,
    distinctIndexBy(arena, entry, -1),
    direction,
    ANALYSIS_GAIN_DETECTION_NO_ENTRY,
    deltaSums,
    baseline,
    frontier
  )
  const anchor = arena.entries[entry]
  if (anchor.hasLink !== 0 && anchor.linkGroupDelta === 0) {
    const linked = ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES + anchor.linkIndex
    const linkedDirection = -direction
    considerMergeCandidate(
      arena,
      linked,
      distinctIndexBy(arena, linked, 1),
      linkedDirection,
      linked,
      deltaSums,
      baseline,
      frontier
    )
    considerMergeCandidate(
      arena,
      linked,
      distinctIndexBy(arena, linked, -1),
      linkedDirection,
      linked,
      deltaSums,
      baseline,
      frontier
    )
  }
  return frontier
}

/**
 * Resolve the active gain point paired with one merge candidate.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} entry
 * @returns {number}
 */
function linkedPartner(arena, entry) {
  const point = arena.entries[entry]
  return point.hasLink !== 0
    ? (1 + point.linkGroupDelta) * ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES +
        point.linkIndex
    : ANALYSIS_GAIN_DETECTION_NO_ENTRY
}

/**
 * Snapshot the unreduced gain envelope used to measure every merge candidate consistently.
 *
 * @param {GainDetectionScratch} scratch
 * @param {ArrayLike<number>} amplitudes
 */
function prepareReductionReference(scratch, amplitudes) {
  if (!scratch.referencePrepared) {
    prepareGainEnvelopeReference(
      scratch.idealDeltaSums,
      amplitudes,
      REDUCTION_LEVEL_FLOOR,
      REDUCTION_LEVEL_CEILING,
      scratch.envelope
    )
    scratch.referencePrepared = true
  }
  reconstructGainDeltaLevels(
    scratch.deltaSums,
    -2147483648,
    2147483647,
    scratch.envelope.currentRawLevels
  )
}

/**
 * Evaluate merge candidate against the retained candidate metrics inside the fixed-capacity gain-point detector and reduction graph.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} first
 * @param {number} second
 * @param {ArrayLike<number>} deltaSums
 * @param {GainEnvelopeScratch} envelope
 * @returns {number}
 */
function scoreMergeCandidate(arena, first, second, deltaSums, envelope) {
  const source = arena.entries[first].index
  const target = arena.entries[second].index
  const movedDelta = deltaSums[source]
  return source < target
    ? scoreGainLevelAdjustment(
        envelope,
        envelope.currentRawLevels,
        source + 1,
        target,
        movedDelta,
        REDUCTION_LEVEL_FLOOR,
        REDUCTION_LEVEL_CEILING
      )
    : scoreGainLevelAdjustment(
        envelope,
        envelope.currentRawLevels,
        target + 1,
        source,
        -movedDelta,
        REDUCTION_LEVEL_FLOOR,
        REDUCTION_LEVEL_CEILING
      )
}

/**
 * Choose the legal gain-point merge with the best retained reduction score.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainMergeFrontier} frontier
 * @param {GainDetectionScratch} scratch
 * @param {ArrayLike<number>} amplitudes
 * @param {GainReductionCandidate} output
 * @returns {boolean}
 */
function selectMergeCandidate(arena, frontier, scratch, amplitudes, output) {
  if (frontier.length === 0) return false
  let selected = 0
  if (frontier.length > 1) {
    prepareReductionReference(scratch, amplitudes)
    let lowest = Number.POSITIVE_INFINITY
    for (let index = 0; index < frontier.length; index++) {
      let score = scoreMergeCandidate(
        arena,
        frontier.first[index],
        frontier.second[index],
        scratch.deltaSums,
        scratch.envelope
      )
      if (!Number.isFinite(score)) score = Number.POSITIVE_INFINITY
      if (score < lowest) {
        lowest = score
        selected = index
      }
    }
  }
  output.cost = frontier.cost[selected]
  output.first = frontier.first[selected]
  output.second = frontier.second[selected]
  return true
}

/**
 * Restrict merge probing to the gain-point interval affected by the current edit.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainProbeSet} probes
 * @param {number} start
 * @param {number} end
 * @param {GainDetectionScratch} scratch
 * @param {ArrayLike<number>} amplitudes
 * @returns {number}
 */
function selectProbeRange(arena, probes, start, end, scratch, amplitudes) {
  let legalCount = 0
  let firstLegal = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  for (let index = start; index < end; index++) {
    if (probes.hasCandidate[index]) {
      if (firstLegal === ANALYSIS_GAIN_DETECTION_NO_ENTRY) firstLegal = index
      legalCount++
    }
  }
  if (legalCount <= 1) return firstLegal
  prepareReductionReference(scratch, amplitudes)
  let selected = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  let lowest = Number.POSITIVE_INFINITY
  for (let index = start; index < end; index++) {
    if (!probes.hasCandidate[index]) continue
    let score = scoreMergeCandidate(
      arena,
      probes.first[index],
      probes.second[index],
      scratch.deltaSums,
      scratch.envelope
    )
    if (!Number.isFinite(score)) score = Number.POSITIVE_INFINITY
    if (selected === ANALYSIS_GAIN_DETECTION_NO_ENTRY || score < lowest) {
      lowest = score
      selected = index
    }
  }
  return selected
}

/**
 * Choose whether the next reduction step merges, disables, or retains a gain point.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} activeHead
 * @param {ArrayLike<number>} amplitudes
 * @param {GainDetectionScratch} scratch
 * @returns {GainReductionAction}
 */
function selectReductionAction(
  arena,
  sentinels,
  activeHead,
  amplitudes,
  scratch
) {
  const baseline = (arena.entries[activeHead].step << 2) >>> 0
  const probes = scratch.probes
  probes.length = 0
  probes.hasCandidate.fill(0)
  let entry = sentinelNextActive(sentinels, 1)
  const selectedCandidate = { cost: 0, first: 0, second: 0 }
  while (
    entry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    probes.length < ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES
  ) {
    let recentPartner = false
    for (let index = 0; index < probes.length; index++) {
      if (linkedPartner(arena, probes.entry[index]) === entry) {
        recentPartner = true
        break
      }
    }
    if (recentPartner) {
      entry = arena.nextActive(entry)
      continue
    }
    const index = probes.length++
    probes.entry[index] = entry
    const frontier = mergeCandidatesForEntry(
      arena,
      entry,
      baseline,
      scratch.deltaSums,
      scratch.frontier
    )
    if (
      selectMergeCandidate(
        arena,
        frontier,
        scratch,
        amplitudes,
        selectedCandidate
      )
    ) {
      probes.hasCandidate[index] = 1
      probes.cost[index] = selectedCandidate.cost
      probes.first[index] = selectedCandidate.first
      probes.second[index] = selectedCandidate.second
    }
    entry = arena.nextActive(entry)
  }
  if (entry !== ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    throw new Error('ATRAC3plus reduction frontier exceeded arena capacity')
  }
  const localEnd = Math.min(probes.length, 4)
  let selected = selectProbeRange(
    arena,
    probes,
    0,
    localEnd,
    scratch,
    amplitudes
  )
  if (selected === ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    selected = selectProbeRange(
      arena,
      probes,
      localEnd,
      probes.length,
      scratch,
      amplitudes
    )
  }
  const action = scratch.action
  if (selected === ANALYSIS_GAIN_DETECTION_NO_ENTRY) {
    action.merge = false
    action.entry = activeHead
  } else {
    action.merge = true
    action.cost = probes.cost[selected]
    action.first = probes.first[selected]
    action.second = probes.second[selected]
  }
  return action
}

/**
 * Measure the contiguous run of entries that share one gain-point index.
 *
 * @param {GainPointWorkArena} arena
 * @param {number} entry
 * @returns {{count: number, tail: number}}
 */
function duplicateIndexRun(arena, entry) {
  const key = arena.entries[entry].index
  let count = 1
  let tail = entry
  let next = arena.nextByIndex(entry)
  while (
    next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    arena.entries[next].index === key
  ) {
    count++
    tail = next
    next = arena.nextByIndex(next)
  }
  let previous = arena.previousByIndex(entry)
  while (
    previous !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    arena.entries[previous].index === key
  ) {
    count++
    previous = arena.previousByIndex(previous)
  }
  return { count, tail }
}

/**
 * Remove one gain-point entry from the active linked list without disturbing index order.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} activeHead
 * @param {number} entry
 * @returns {GainActiveRemoval|null}
 */
function unlinkActiveEntry(arena, sentinels, activeHead, entry) {
  let previousIsSentinel = true
  let previous = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  let current = activeHead
  while (current !== ANALYSIS_GAIN_DETECTION_NO_ENTRY && current !== entry) {
    previousIsSentinel = false
    previous = current
    current = arena.nextActive(current)
  }
  if (current === ANALYSIS_GAIN_DETECTION_NO_ENTRY) return null
  const next = arena.nextActive(entry)
  if (previousIsSentinel) setSentinelNextActive(sentinels, 1, next)
  else arena.setNextActive(previous, next)
  return { previousIsSentinel, previous, next }
}

/**
 * Reinsert an edited gain point by scanning forward from its prior active position.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} entry
 * @param {GainActiveRemoval} removal
 */
function reinsertActiveForward(arena, sentinels, entry, removal) {
  if (
    removal.next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    arena.entries[entry].step >>> 0 > arena.entries[removal.next].step >>> 0
  ) {
    let insertAfter = removal.next
    let insertBefore = arena.nextActive(removal.next)
    while (
      insertBefore !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
      arena.entries[insertBefore].step >>> 0 < arena.entries[entry].step >>> 0
    ) {
      insertAfter = insertBefore
      insertBefore = arena.nextActive(insertBefore)
    }
    arena.setNextActive(entry, insertBefore)
    arena.setNextActive(insertAfter, entry)
  } else {
    arena.setNextActive(entry, removal.next)
    if (removal.previousIsSentinel) {
      setSentinelNextActive(sentinels, 1, entry)
    } else {
      arena.setNextActive(removal.previous, entry)
    }
  }
}

/**
 * Reinsert an edited gain point from the stable active-list head after its order changes.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {number} activeHead
 * @param {number} entry
 */
function reinsertActiveFromStableHead(arena, sentinels, activeHead, entry) {
  let previousIsSentinel = true
  let previous = ANALYSIS_GAIN_DETECTION_NO_ENTRY
  let next = activeHead
  while (
    next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    arena.entries[next].step >>> 0 < arena.entries[entry].step >>> 0
  ) {
    previousIsSentinel = false
    previous = next
    next = arena.nextActive(next)
  }
  arena.setNextActive(entry, next)
  if (previousIsSentinel) setSentinelNextActive(sentinels, 1, entry)
  else arena.setNextActive(previous, entry)
}

/**
 * Apply the selected gain-point merge and repair both linked-list orderings.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {ArrayLike<number>} duplicateCounts
 * @param {ArrayLike<number>} deltaSums
 * @param {number} activeHead
 * @param {GainReductionAction} action
 */
function applyMergeCandidate(
  arena,
  sentinels,
  duplicateCounts,
  deltaSums,
  activeHead,
  action
) {
  const keyA = arena.entries[action.first].index
  const keyB = arena.entries[action.second].index
  const stepDelta = arena.entries[action.first].step
  const absoluteSpan = Math.abs(keyA - keyB)
  const costBits = arena.entries[action.first].spanCost
  const runA = duplicateIndexRun(arena, action.first)
  const runB = duplicateIndexRun(arena, action.second)
  let entry = runA.tail
  for (let count = 0; count < runA.count; count++) {
    deltaSums[arena.entries[entry].index] -= arena.entries[entry].delta
    arena.entries[entry].spanCost = absoluteSpan + costBits
    arena.entries[entry].index = keyB
    arena.entries[entry].step += stepDelta
    deltaSums[keyB] += arena.entries[entry].delta
    const removal = unlinkActiveEntry(arena, sentinels, activeHead, entry)
    if (removal) reinsertActiveForward(arena, sentinels, entry, removal)
    entry = arena.previousByIndex(entry)
    if (entry === ANALYSIS_GAIN_DETECTION_NO_ENTRY) break
  }
  entry = runB.tail
  for (let count = 0; count < runB.count; count++) {
    arena.entries[entry].step += stepDelta
    arena.entries[entry].spanCost = absoluteSpan + costBits
    if (unlinkActiveEntry(arena, sentinels, activeHead, entry)) {
      reinsertActiveFromStableHead(arena, sentinels, activeHead, entry)
    }
    entry = arena.previousByIndex(entry)
    if (entry === ANALYSIS_GAIN_DETECTION_NO_ENTRY) break
  }
  duplicateCounts[ANALYSIS_GAIN_DETECTION_CURRENT]++
}

/**
 * Remove a gain point from reduction consideration while retaining its arena storage.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {ArrayLike<number>} disabledCounts
 * @param {number} activeHead
 * @param {number} entry
 */
function disableReductionEntry(
  arena,
  sentinels,
  disabledCounts,
  activeHead,
  entry
) {
  const point = arena.entries[entry]
  if (point.hasLink !== 0) {
    const index = point.linkIndex >>> 0
    const generation = point.linkGroupDelta + 1
    if (
      index < ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES &&
      generation >= 0 &&
      generation < 3
    ) {
      disabledCounts[generation]++
    }
  }
  point.disabled = 1
  disabledCounts[ANALYSIS_GAIN_DETECTION_CURRENT]++
  const previous = arena.previousByIndex(entry)
  const next = arena.nextByIndex(entry)
  if (next !== ANALYSIS_GAIN_DETECTION_NO_ENTRY)
    arena.setPreviousByIndex(next, previous)
  if (previous !== ANALYSIS_GAIN_DETECTION_NO_ENTRY)
    arena.setNextByIndex(previous, next)
  else setSentinelNextByIndex(sentinels, 1, next)
  unlinkActiveEntry(arena, sentinels, activeHead, entry)
}

/**
 * Iteratively merge or disable gain points until the record satisfies its syntax budget.
 *
 * @param {GainPointWorkArena} arena
 * @param {GainPointSentinel[]} sentinels
 * @param {ArrayLike<number>} pointCounts
 * @param {ArrayLike<number>} duplicateCounts
 * @param {ArrayLike<number>} disabledCounts
 * @param {number} activeHead
 * @param {ArrayLike<number>} amplitudes
 * @param {GainDetectionScratch} scratch
 */
function reduceGainPoints(
  arena,
  sentinels,
  pointCounts,
  duplicateCounts,
  disabledCounts,
  activeHead,
  amplitudes,
  scratch
) {
  scratch.idealDeltaSums.set(scratch.deltaSums)
  scratch.referencePrepared = false
  while (
    activeHead !== ANALYSIS_GAIN_DETECTION_NO_ENTRY &&
    pointCounts[ANALYSIS_GAIN_DETECTION_CURRENT] -
      duplicateCounts[ANALYSIS_GAIN_DETECTION_CURRENT] -
      disabledCounts[ANALYSIS_GAIN_DETECTION_CURRENT] >
      7
  ) {
    const action = selectReductionAction(
      arena,
      sentinels,
      activeHead,
      amplitudes,
      scratch
    )
    if (action.merge) {
      applyMergeCandidate(
        arena,
        sentinels,
        duplicateCounts,
        scratch.deltaSums,
        activeHead,
        action
      )
    } else {
      disableReductionEntry(
        arena,
        sentinels,
        disabledCounts,
        activeHead,
        action.entry
      )
    }
  }
}

/**
 * Measure one subband envelope, place gain points, and reduce them to the encodable limit.
 *
 * @param {GainDetectionBand} persisted
 * @param {Float32Array} analysis
 * @param {number} spanShift
 * @param {GainDetectionScratch} scratch
 * @param {GainRecord} record
 * @returns {GainRecord}
 */
function detectGainBand(persisted, analysis, spanShift, scratch, record) {
  const state = loadBandState(persisted, scratch.bandState)
  const measurement = measureGainBlockPeaks(
    analysis,
    scratch.absoluteLevels,
    scratch.measurement.peakResult,
    ANALYSIS_GAIN_DETECTION_GAIN_PREFIX_SAMPLES
  )

  const scaleFactors = scratch.scaleFactors
  scaleFactors[0] = 0
  let activity = 0
  for (let historyBlock = 0; historyBlock < 3; historyBlock++) {
    activity =
      ((activity << 1) |
        Number(
          gainBlock4IsActive(analysis, historyBlock * GAIN_FLOATS_PER_BLOCK)
        )) &
      0xff
  }
  for (let block = 0; block < GAIN_WINDOW_BLOCKS; block++) {
    const currentActivity = (measurement.activity >>> block) & 1
    let scale = 1
    if ((activity | currentActivity) !== 0) {
      scale = computeGainFlatnessScale(
        analysis,
        scratch.measurement,
        block * GAIN_FLOATS_PER_BLOCK
      )
    }
    scaleFactors[block + 1] = scale
    activity = ((activity << 1) | currentActivity) & 0b111
  }

  persisted.scaleHistory[63] = scaleFactors[1]

  const previousPeakIndex = state.previousPeakIndex
  const currentPeakIndex = state.currentPeakIndex
  const nextWindowPeakIndex = currentPeakIndex + 0x20
  let headIndex
  let insertionStart
  let insertionEnd
  if (state.previousPeak < state.currentPeak) {
    headIndex = nextWindowPeakIndex
    insertionStart = previousPeakIndex
    insertionEnd = nextWindowPeakIndex
  } else {
    headIndex = previousPeakIndex
    insertionStart = previousPeakIndex + 1
    insertionEnd = nextWindowPeakIndex + 1
  }

  const order = buildSortedIndexOrder(
    persisted.absoluteLevelHistory,
    headIndex,
    insertionStart,
    insertionEnd,
    scratch.measurement.sortedOrder
  )
  let indexCount = order.length
  const states = scratch.pointStates
  const headPeak =
    headIndex === previousPeakIndex ? state.previousPeak : state.currentPeak
  const initialLevel = headPeak < 0 ? 0 : headPeak
  const startBits = requiredGainRangeBits(
    Math.fround(state.previousPeak),
    Math.fround(state.previousAbsoluteLevel),
    6
  )
  const endBits = requiredGainRangeBits(
    Math.fround(state.currentPeak),
    Math.fround(scratch.absoluteLevels[0]),
    9
  )
  initializePointState(
    states[0],
    initialLevel,
    previousPeakIndex - 1,
    nextWindowPeakIndex + 1,
    0,
    startBits,
    endBits,
    headIndex === previousPeakIndex ? EXPAND_AFTER : EXPAND_BEFORE
  )

  const arena = scratch.arena
  arena.loadPersisted(persisted)
  if (indexCount !== 1) {
    let sourceStateIndex = 0
    let outputIndex = 0
    while (outputIndex < indexCount - 1) {
      const source = states[sourceStateIndex]
      for (const expansion of [EXPAND_BEFORE, EXPAND_AFTER]) {
        if ((source.expansions & expansion) === 0) continue
        outputIndex++
        const destination = states[outputIndex]
        expandPointState(source, order, expansion, destination)
        const skip = placeGainPoint(
          persisted,
          source,
          order,
          destination,
          arena,
          state.pointCounts,
          spanShift,
          scratch
        )
        indexCount -= skip
      }
      sourceStateIndex++
      if (outputIndex >= indexCount - 1) break
    }
  }

  for (const sentinel of scratch.sentinels) sentinel.reset()
  const activeHead = buildActiveList(
    arena,
    ANALYSIS_GAIN_DETECTION_CURRENT,
    state.pointCounts[ANALYSIS_GAIN_DETECTION_CURRENT]
  )
  buildByIndexList(
    arena,
    scratch.sentinels,
    ANALYSIS_GAIN_DETECTION_PREVIOUS,
    ANALYSIS_GAIN_DETECTION_PREVIOUS,
    state.pointCounts[ANALYSIS_GAIN_DETECTION_PREVIOUS]
  )
  const currentTail = buildByIndexList(
    arena,
    scratch.sentinels,
    ANALYSIS_GAIN_DETECTION_CURRENT,
    ANALYSIS_GAIN_DETECTION_CURRENT,
    state.pointCounts[ANALYSIS_GAIN_DETECTION_CURRENT]
  )
  const nextTail = buildByIndexList(
    arena,
    scratch.sentinels,
    ANALYSIS_GAIN_DETECTION_NEXT,
    ANALYSIS_GAIN_DETECTION_NEXT,
    state.pointCounts[ANALYSIS_GAIN_DETECTION_NEXT]
  )
  state.duplicateCounts[ANALYSIS_GAIN_DETECTION_CURRENT] =
    duplicateKeyCountReverse(arena, currentTail)
  state.duplicateCounts[ANALYSIS_GAIN_DETECTION_NEXT] =
    duplicateKeyCountReverse(arena, nextTail)
  fillDeltaSumsReverse(arena, currentTail, scratch.deltaSums)
  state.disabledCounts[ANALYSIS_GAIN_DETECTION_NEXT] = 0
  setSentinelNextActive(
    scratch.sentinels,
    ANALYSIS_GAIN_DETECTION_CURRENT,
    activeHead
  )
  reduceGainPoints(
    arena,
    scratch.sentinels,
    state.pointCounts,
    state.duplicateCounts,
    state.disabledCounts,
    activeHead,
    persisted.absoluteLevelHistory,
    scratch
  )

  for (
    let entry = 0;
    entry < state.pointCounts[ANALYSIS_GAIN_DETECTION_PREVIOUS];
    entry++
  ) {
    const point =
      arena.entries[generationSlot(ANALYSIS_GAIN_DETECTION_PREVIOUS, entry)]
    if (point.disabled !== 0) point.nextByIndexOffset = 0
  }
  const eventCount = collectDeltaEvents(
    arena,
    sentinelNextByIndex(scratch.sentinels, ANALYSIS_GAIN_DETECTION_PREVIOUS),
    scratch.eventLocations,
    scratch.eventDeltas
  )
  record.clear()
  writeGainRecordDeltaEnvelope(
    record,
    scratch.eventLocations,
    scratch.eventDeltas,
    eventCount,
    REDUCTION_LEVEL_FLOOR,
    REDUCTION_LEVEL_CEILING,
    7,
    false,
    (level) => Math.max(0, Math.min(15, level + 6)),
    scratch.envelope
  )

  commitBandState(
    state,
    persisted,
    measurement.maximumIndex,
    measurement.maximumValue,
    scratch.absoluteLevels,
    scaleFactors
  )
  arena.persistForNextFrame(persisted)
  return record
}

/**
 * Measure the windowed energy represented by one gain-analysis interval.
 *
 * @param {ArrayLike<number>} samples
 * @returns {number}
 */
function gainEnergy(samples) {
  let sum = 0
  for (let coefficient = 0; coefficient < 128; coefficient += 4) {
    let group = Math.fround(samples[coefficient] * samples[coefficient])
    group = Math.fround(
      group + Math.fround(samples[coefficient + 1] * samples[coefficient + 1])
    )
    group = Math.fround(
      group + Math.fround(samples[coefficient + 2] * samples[coefficient + 2])
    )
    group = Math.fround(
      group + Math.fround(samples[coefficient + 3] * samples[coefficient + 3])
    )
    sum = Math.fround(sum + group)
  }
  return sum
}

/**
 * Report whether adjacent gain-energy measurements stay within the stability threshold.
 *
 * @param {number} value
 * @returns {boolean}
 */
function gainEnergyRatioIsStable(value) {
  return Number.isNaN(value) || (value <= 2 && value >= 0.5)
}

/**
 * Detect the unadjusted gain records for one coding unit into pooled storage.
 * The returned plan remains valid until this scratch object is reused.
 *
 * @param {EncodeChannelState[]} channelBlocks Detached coding-unit channel blocks.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {GainDetectionRequest} request Configured detector request.
 * @param {GainDetectionScratch} scratch Reusable detector work.
 * @returns {GainRecordPlan} Detector-owned publication plan.
 */
export function detectGainRecordsRaw(
  channelBlocks,
  analysisStates,
  request,
  scratch
) {
  const channelCount = request?.channelCount
  if (
    !Array.isArray(channelBlocks) ||
    !Array.isArray(analysisStates) ||
    channelBlocks.length < channelCount ||
    analysisStates.length < channelCount ||
    !Number.isInteger(request?.bandCount) ||
    request.bandCount < 0 ||
    request.bandCount > ANALYSIS_GAIN_DETECTION_GAIN_BANDS ||
    !(scratch?.arena instanceof GainPointWorkArena)
  ) {
    throw new RangeError('ATRAC3plus raw gain detector geometry is invalid')
  }

  scratch.arena.reset()
  scratch.plan.channelCount = channelCount
  for (
    let channel = 0;
    channel < ANALYSIS_GAIN_DETECTION_GAIN_MAX_CHANNELS;
    channel++
  ) {
    for (let band = 0; band < ANALYSIS_GAIN_DETECTION_GAIN_BANDS; band++) {
      scratch.records[channel][band].clear()
    }
  }

  for (let band = 0; band < request.bandCount; band++) {
    for (let channel = 0; channel < channelCount; channel++) {
      analysisStates[channel].copyBandSamples(band, 500, scratch.analysisWindow)
      detectGainBand(
        channelBlocks[channel].detection.bands[band],
        scratch.analysisWindow,
        request.spanShift,
        scratch,
        scratch.records[channel][band]
      )
    }

    if (channelCount === 2 && band >= request.correlationStartBand) {
      const firstEnergy = gainEnergy(analysisStates[0].bandSlots[band][2])
      const secondEnergy = gainEnergy(analysisStates[1].bandSlots[band][2])
      const firstDetection = channelBlocks[0].detection
      const secondDetection = channelBlocks[1].detection
      const denominator = Math.fround(
        firstDetection.energySum[band] * secondEnergy
      )
      let ratio = -1
      if (denominator !== 0) {
        ratio = Math.fround(
          Math.fround(secondDetection.energySum[band] * firstEnergy) /
            denominator
        )
        if (
          gainEnergyRatioIsStable(firstDetection.energyRatio[band]) &&
          gainEnergyRatioIsStable(ratio)
        ) {
          scratch.records[0][band].copyTo(scratch.records[1][band])
        }
      }
      firstDetection.energyRatio[band] = ratio
      firstDetection.energySum[band] = firstEnergy
      secondDetection.energySum[band] = secondEnergy
    }
  }
  return scratch.plan
}

/**
 * Plan one coding unit's gain records without committing channel syntax.
 *
 * Full-rate profiles publish the detector-owned plan directly. Low-rate
 * profiles lower that plan into the adjustment scratch's independent
 * publication, so detector reuse cannot alias the selected result.
 *
 * @param {EncodeChannelState[]} channelBlocks Detached coding-unit channel blocks.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {GainDetectionRequest} request Configured detector request.
 * @param {GainDetectionScratch} detectionScratch Reusable detector work.
 * @param {LowRateGainScratch} adjustmentScratch Reusable low-rate work.
 * @returns {GainRecordPlan} Selected detached publication plan.
 */
export function planGainRecords(
  channelBlocks,
  analysisStates,
  request,
  detectionScratch,
  adjustmentScratch
) {
  const detectedPlan = detectGainRecordsRaw(
    channelBlocks,
    analysisStates,
    request,
    detectionScratch
  )
  if (!request.lowMode) return detectedPlan
  return planLowModeGainAdjustment(
    channelBlocks,
    analysisStates,
    request.bandCount,
    request.coreMode,
    detectedPlan,
    adjustmentScratch
  )
}
