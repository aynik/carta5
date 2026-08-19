/** ATRAC3plus gain-control records, planning, and validation. */

import {
  GAIN_LEVEL_MAX,
  GAIN_LOCATION_MAX,
  GAIN_SLOT_COUNT,
} from '../core/constants.js'

/**
 * Coded gain-control record plus the detector history carried with that record.
 *
 * `entries`, `locations`, and `levels` are syntax. `peakHistory` is explicitly
 * local encoder history and is never packed by this module.
 */
export class GainRecord {
  /**
   * Create an inactive record with fixed-capacity point storage.
   */
  constructor() {
    this.entries = 0
    this.locations = new Uint32Array(GAIN_SLOT_COUNT)
    this.levels = new Uint32Array(GAIN_SLOT_COUNT)
    this.peakHistory = 0
  }

  /**
   * Copy wire-visible fields while preserving destination-local detector state.
   *
   * @param {GainRecord} source Record whose coded fields should be copied.
   * @returns {GainRecord} This destination record.
   */
  copyCodedFieldsFrom(source) {
    this.entries = source.entries
    const count = Math.min(source.entries, GAIN_SLOT_COUNT)
    this.locations.set(source.locations.subarray(0, count), 0)
    this.levels.set(source.levels.subarray(0, count), 0)
    return this
  }

  /**
   * Copy the complete record into preallocated transaction storage.
   *
   * `peakHistory` is retained beside the coded fields as detector-local carry.
   *
   * @param {GainRecord} destination Preallocated record to overwrite.
   * @returns {GainRecord} The destination record.
   */
  copyTo(destination) {
    destination.entries = this.entries
    destination.locations.set(this.locations)
    destination.levels.set(this.levels)
    destination.peakHistory = this.peakHistory
    return destination
  }

  /**
   * Reset all coded and detector-local fields without replacing storage.
   */
  clear() {
    this.entries = 0
    this.locations.fill(0)
    this.levels.fill(0)
    this.peakHistory = 0
  }

  /**
   * Create a detached copy including local detector history.
   *
   * @returns {GainRecord} Independent record copy.
   */
  clone() {
    const clone = new GainRecord()
    this.copyTo(clone)
    return clone
  }

  /**
   * Compare only fields that affect encoded gain syntax.
   *
   * @param {GainRecord} other Record to compare.
   * @returns {boolean} Whether both records encode identical syntax.
   */
  codedEquals(other) {
    if (this.entries !== other.entries) return false
    const count = Math.min(this.entries, GAIN_SLOT_COUNT)
    for (let index = 0; index < count; index++) {
      if (
        this.locations[index] !== other.locations[index] ||
        this.levels[index] !== other.levels[index]
      ) {
        return false
      }
    }
    return true
  }
}

/**
 * Fixed-capacity detached gain-record transaction shared by ATRAC3plus stages.
 */
export class GainRecordPlan {
  /**
   * Allocate fixed-capacity channel and record storage.
   *
   * @param {number} channelCapacity Maximum planned channels.
   * @param {number} recordCapacity Maximum records per channel.
   */
  constructor(channelCapacity = 2, recordCapacity = 16) {
    if (
      !Number.isInteger(channelCapacity) ||
      channelCapacity < 1 ||
      !Number.isInteger(recordCapacity) ||
      recordCapacity < 1
    ) {
      throw new RangeError('ATRAC3plus gain plan capacity is invalid')
    }
    this.records = Array.from({ length: channelCapacity }, () =>
      Array.from({ length: recordCapacity }, () => new GainRecord())
    )
    this.channelCount = 0
  }

  /**
   * Reset the plan for a new coding unit.
   *
   * @param {number} channelCount Active channel count.
   * @returns {GainRecordPlan} This reusable plan.
   */
  clear(channelCount = 0) {
    if (
      !Number.isInteger(channelCount) ||
      channelCount < 0 ||
      channelCount > this.records.length
    ) {
      throw new RangeError('ATRAC3plus gain plan channel count is invalid')
    }
    this.channelCount = channelCount
    for (const channel of this.records) {
      for (const record of channel) record.clear()
    }
    return this
  }

  /**
   * Copy the complete plan into preallocated transaction storage.
   *
   * @param {GainRecordPlan} destination Plan to overwrite.
   * @returns {GainRecordPlan} The destination plan.
   */
  copyTo(destination) {
    if (
      !(destination instanceof GainRecordPlan) ||
      destination.records.length < this.records.length ||
      destination.records[0].length < this.records[0].length
    ) {
      throw new RangeError('ATRAC3plus gain plan destination is too small')
    }
    destination.channelCount = this.channelCount
    for (let channel = 0; channel < this.records.length; channel++) {
      for (let record = 0; record < this.records[channel].length; record++) {
        this.records[channel][record].copyTo(
          destination.records[channel][record]
        )
      }
    }
    return destination
  }

  /**
   * Publish every selected record into preallocated channel state together.
   *
   * @param {EncodeChannelState[]} channelBlocks Ordered coding-unit channel blocks.
   * @returns {EncodeChannelState[]} The supplied channel-block collection.
   */
  commitTo(channelBlocks) {
    if (
      !Array.isArray(channelBlocks) ||
      channelBlocks.length < this.channelCount
    ) {
      throw new RangeError(
        'ATRAC3plus gain plan commit destination is too small'
      )
    }
    for (let channel = 0; channel < this.channelCount; channel++) {
      const destination = channelBlocks[channel]?.currentGainRecords
      if (!destination || destination.length < this.records[channel].length) {
        throw new RangeError('ATRAC3plus gain plan commit geometry is invalid')
      }
      for (let record = 0; record < this.records[channel].length; record++) {
        this.records[channel][record].copyTo(destination[record])
      }
    }
    return channelBlocks
  }
}

/**
 * Reconstruct a reverse-scanned piecewise-constant delta envelope.
 *
 * @param {Int32Array} deltas Reverse-integrated level changes.
 * @param {number} levelFloor Smallest reconstructed level.
 * @param {number} levelCeiling Largest reconstructed level.
 * @param {Int32Array} destination Caller-owned level output.
 * @returns {Int32Array} The destination array.
 */
export function reconstructGainDeltaLevels(
  deltas,
  levelFloor,
  levelCeiling,
  destination
) {
  if (
    !(deltas instanceof Int32Array) ||
    !(destination instanceof Int32Array) ||
    destination.length < deltas.length ||
    levelFloor > levelCeiling
  ) {
    throw new RangeError('ATRAC3plus gain envelope geometry is invalid')
  }
  let level = 0
  for (let location = deltas.length - 1; location >= 0; location--) {
    level += deltas[location]
    destination[location] = Math.max(levelFloor, Math.min(levelCeiling, level))
  }
  return destination
}

/**
 * Capture the ideal level envelope and signal-power weights for reduction.
 *
 * @param {Int32Array} idealDeltas Ideal reverse-integrated changes.
 * @param {Float32Array} signalAmplitudes Per-location signal amplitudes.
 * @param {number} levelFloor Smallest reconstructed level.
 * @param {number} levelCeiling Largest reconstructed level.
 * @param {GainEnvelopeScratch} scratch Reusable envelope scratch.
 * @returns {GainEnvelopeScratch} The populated scratch object.
 */
export function prepareGainEnvelopeReference(
  idealDeltas,
  signalAmplitudes,
  levelFloor,
  levelCeiling,
  scratch
) {
  if (
    !(idealDeltas instanceof Int32Array) ||
    idealDeltas.length !== 32 ||
    !(signalAmplitudes instanceof Float32Array) ||
    signalAmplitudes.length < 32 ||
    !(scratch?.idealLevels instanceof Int32Array) ||
    !(scratch?.signalPower instanceof Float64Array)
  ) {
    throw new RangeError('ATRAC3plus gain reference geometry is invalid')
  }
  reconstructGainDeltaLevels(
    idealDeltas,
    levelFloor,
    levelCeiling,
    scratch.idealLevels
  )
  for (let location = 0; location < 32; location++) {
    const amplitude = signalAmplitudes[location]
    scratch.signalPower[location] = amplitude * amplitude
  }
  return scratch
}

/**
 * Score one inclusive level adjustment against a prepared ideal envelope.
 *
 * @param {GainEnvelopeScratch} reference Prepared ideal levels and signal powers.
 * @param {Int32Array} currentRawLevels Current unbounded levels.
 * @param {number} start First adjusted location, inclusive.
 * @param {number} end Last adjusted location, inclusive.
 * @param {number} levelAdjustment Candidate level delta.
 * @param {number} levelFloor Smallest reconstructed level.
 * @param {number} levelCeiling Largest reconstructed level.
 * @returns {number} Weighted error change relative to the current levels.
 */
export function scoreGainLevelAdjustment(
  reference,
  currentRawLevels,
  start,
  end,
  levelAdjustment,
  levelFloor,
  levelCeiling
) {
  let weightedDifference = 0
  for (let location = start; location <= end; location++) {
    const raw = currentRawLevels[location]
    const current = Math.max(levelFloor, Math.min(levelCeiling, raw))
    const candidate = Math.max(
      levelFloor,
      Math.min(levelCeiling, raw + levelAdjustment)
    )
    const ideal = reference.idealLevels[location]
    const currentDifference = current - ideal
    const candidateDifference = candidate - ideal
    weightedDifference +=
      (candidateDifference * candidateDifference -
        currentDifference * currentDifference) *
      reference.signalPower[location]
  }
  return weightedDifference
}

/**
 * Integrate scan-ordered ATRAC3plus gain delta events into one seven-slot record.
 * Equal-location events must be adjacent, matching detector arena traversal.
 *
 * @param {GainRecord} record Destination record.
 * @param {Int32Array} eventLocations Scan-ordered event locations.
 * @param {Int32Array} eventDeltas Level deltas paired with the events.
 * @param {number} eventCount Number of valid event entries.
 * @param {number} levelFloor Smallest reconstructed level.
 * @param {number} levelCeiling Largest reconstructed level.
 * @param {number} maxTransitions Maximum transitions to retain.
 * @param {boolean} rejectOverflow Whether excess transitions reject the plan.
 * @param {function(number): number} levelIndex Map a reconstructed level to its coded index.
 * @param {GainEnvelopeScratch} scratch Reusable locations and levels storage.
 * @returns {number|null} Written transition count, or `null` when rejected.
 */
export function writeGainRecordDeltaEnvelope(
  record,
  eventLocations,
  eventDeltas,
  eventCount,
  levelFloor,
  levelCeiling,
  maxTransitions,
  rejectOverflow,
  levelIndex,
  scratch
) {
  if (
    !(record instanceof GainRecord) ||
    !(eventLocations instanceof Int32Array) ||
    !(eventDeltas instanceof Int32Array) ||
    !Number.isInteger(eventCount) ||
    eventCount < 0 ||
    eventCount > eventLocations.length ||
    eventCount > eventDeltas.length ||
    !(scratch?.locations instanceof Uint32Array) ||
    !(scratch?.levels instanceof Uint32Array)
  ) {
    throw new RangeError('ATRAC3plus gain event geometry is invalid')
  }
  let sum = 0
  let minimumLevel = 0
  let maximumLevel = 0
  for (let event = 0; event < eventCount; event++) {
    sum += eventDeltas[event]
    minimumLevel = Math.min(minimumLevel, sum)
    maximumLevel = Math.max(maximumLevel, sum)
  }
  minimumLevel = Math.max(minimumLevel, levelFloor)
  maximumLevel = Math.min(maximumLevel, levelCeiling)

  const limit = Math.min(maxTransitions, GAIN_SLOT_COUNT)
  let transitionCount = 0
  let previousLevel = 0
  sum = 0
  for (let event = 0; event < eventCount; event++) {
    const location = eventLocations[event]
    sum += eventDeltas[event]
    if (event + 1 < eventCount && eventLocations[event + 1] === location) {
      continue
    }
    const level = Math.max(minimumLevel, Math.min(maximumLevel, sum))
    if (level === previousLevel) continue
    if (transitionCount < limit) {
      const index = levelIndex(level)
      if (index === null || index === undefined) return null
      scratch.locations[transitionCount] = location >>> 0
      scratch.levels[transitionCount] = index >>> 0
      transitionCount++
    } else if (rejectOverflow) {
      return null
    }
    previousLevel = level
  }

  record.entries = transitionCount
  for (let destination = 0; destination < transitionCount; destination++) {
    const source = transitionCount - 1 - destination
    record.locations[destination] = scratch.locations[source]
    record.levels[destination] = scratch.levels[source]
  }
  return transitionCount
}

/**
 * Validate the wire-visible geometry and ordering of one gain record.
 *
 * @param {GainRecord} record Record to validate.
 * @returns {GainRecord} The validated input record.
 */
export function validateGainRecord(record) {
  if (
    !Number.isInteger(record.entries) ||
    record.entries < 0 ||
    record.entries > 7
  ) {
    throw new RangeError('ATRAC3plus gain point count must be in 0..7')
  }
  let previousLocation = -1
  for (let index = 0; index < record.entries; index++) {
    const level = record.levels[index]
    const location = record.locations[index]
    if (level > GAIN_LEVEL_MAX) {
      throw new RangeError('ATRAC3plus gain level must be in 0..15')
    }
    if (location > GAIN_LOCATION_MAX) {
      throw new RangeError('ATRAC3plus gain location must be in 0..31')
    }
    if (location <= previousLocation) {
      throw new RangeError(
        'ATRAC3plus gain locations must be strictly ascending'
      )
    }
    if (index > 0 && level === record.levels[index - 1]) {
      throw new RangeError('Adjacent ATRAC3plus gain levels must differ')
    }
    previousLocation = location
  }
  return record
}

/**
 * Whether one coded gain record contains at least one transition.
 *
 * @param {GainRecord} record Record to inspect.
 * @returns {boolean} Whether the record is active.
 */
export function gainRecordIsActive(record) {
  return record.entries !== 0
}

/**
 * Whether either half of an adjacent-frame gain pair is active.
 *
 * @param {GainRecord} previous Previous-frame record.
 * @param {GainRecord} current Current-frame record.
 * @returns {boolean} Whether either record is active.
 */
export function gainRecordPairIsActive(previous, current) {
  return gainRecordIsActive(previous) || gainRecordIsActive(current)
}

/**
 * Delete one gain point in place while keeping the remaining fields compact.
 *
 * @param {GainRecord} record
 * @param {number} index
 * @param {number} count
 * @returns {number}
 */
function removeGainRecordEntry(record, index, count) {
  for (let source = index + 1; source < count; source++) {
    record.locations[source - 1] = record.locations[source]
    record.levels[source - 1] = record.levels[source]
  }
  record.entries = count - 1
  return count - 1
}

/**
 * Remove adjacent gain points whose selected field carries the same value.
 *
 * @param {GainRecord} record
 * @param {number} count
 * @param {string} field
 * @returns {number}
 */
function collapseAdjacentEqualGainField(record, count, field) {
  let index = 0
  while (index + 1 < count) {
    if (record[field][index] === record[field][index + 1]) {
      count = removeGainRecordEntry(record, index, count)
    } else {
      index++
    }
  }
  return count
}

/**
 * Canonicalize one record while preserving its profile-local carry.
 *
 * @param {GainRecord} record Record to normalize in place.
 * @param {number} defaultTailLevel Profile's implicit terminal level.
 * @param {boolean} clearInactiveSlots Whether to zero unused fixed slots.
 * @returns {GainRecord} The normalized record.
 */
export function normalizeGainRecord(
  record,
  defaultTailLevel,
  clearInactiveSlots
) {
  let count = Math.min(record.entries, GAIN_SLOT_COUNT)
  count = collapseAdjacentEqualGainField(record, count, 'levels')
  while (count > 0 && record.levels[count - 1] === defaultTailLevel) {
    count--
  }
  record.entries = count
  count = collapseAdjacentEqualGainField(record, count, 'locations')
  if (clearInactiveSlots) {
    record.locations.fill(0, count)
    record.levels.fill(0, count)
  }
  return record
}

/**
 * Return the common close-shape entry count, or `null` when not mergeable.
 *
 * @param {GainRecord} first First candidate record.
 * @param {GainRecord} second Second candidate record.
 * @param {number} maximumLocationDelta Allowed per-slot location delta.
 * @param {number} maximumLevelDelta Allowed per-slot level delta.
 * @returns {number|null} Common entry count when mergeable.
 */
export function closeGainRecordMergeCount(
  first,
  second,
  maximumLocationDelta,
  maximumLevelDelta
) {
  if (first.codedEquals(second)) return null
  const count = first.entries
  if (count === 0 || count !== second.entries || count > GAIN_SLOT_COUNT) {
    return null
  }
  for (let index = 0; index < count; index++) {
    if (
      Math.abs(first.locations[index] - second.locations[index]) >
        maximumLocationDelta ||
      Math.abs(first.levels[index] - second.levels[index]) > maximumLevelDelta
    ) {
      return null
    }
  }
  return count
}

/**
 * Merge slots into one earliest-location/highest-level record.
 *
 * @param {GainRecord} destination Record to update.
 * @param {GainRecord} source Peer record to merge.
 * @param {number} count Number of corresponding slots.
 * @returns {GainRecord} The updated destination.
 */
export function mergeGainRecordMinLocationMaxLevel(destination, source, count) {
  const limit = Math.min(count, GAIN_SLOT_COUNT)
  for (let index = 0; index < limit; index++) {
    destination.locations[index] = Math.min(
      destination.locations[index],
      source.locations[index]
    )
    destination.levels[index] = Math.max(
      destination.levels[index],
      source.levels[index]
    )
  }
  return destination
}

/**
 * Apply the same earliest-location/highest-level merge to both records.
 *
 * @param {GainRecord} first First record to update.
 * @param {GainRecord} second Second record to update.
 * @param {number} count Number of corresponding slots.
 * @returns {void}
 */
export function mergeGainRecordPairMinLocationMaxLevel(first, second, count) {
  const limit = Math.min(count, GAIN_SLOT_COUNT)
  for (let index = 0; index < limit; index++) {
    const location = Math.min(first.locations[index], second.locations[index])
    const level = Math.max(first.levels[index], second.levels[index])
    first.locations[index] = location
    second.locations[index] = location
    first.levels[index] = level
    second.levels[index] = level
  }
}

/**
 * Copy a longer peer location shape when all shared endpoints and drops agree.
 * `sourceIndices` is seven-entry caller-owned scratch.
 *
 * @param {GainRecord} destination Shorter record to update.
 * @param {GainRecord} source Longer peer record.
 * @param {number} maximumEndpointLevelDelta Allowed endpoint level delta.
 * @param {number} maximumAdjacentDropDelta Allowed adjacent-drop delta.
 * @param {Int32Array} sourceIndices Caller-owned match-index scratch.
 * @returns {boolean} Whether the source shape was copied.
 */
export function copyGainRecordLocationSupersetIfLevelShapeClose(
  destination,
  source,
  maximumEndpointLevelDelta,
  maximumAdjacentDropDelta,
  sourceIndices
) {
  const sourceCount = Math.min(source.entries, GAIN_SLOT_COUNT)
  const destinationCount = Math.min(destination.entries, GAIN_SLOT_COUNT)
  if (
    !(sourceIndices instanceof Int32Array) ||
    sourceIndices.length < GAIN_SLOT_COUNT
  ) {
    throw new RangeError('gain-record merge scratch must contain seven indices')
  }
  if (sourceCount <= destinationCount || destinationCount === 0) return false

  sourceIndices.fill(-1)
  let matchedCount = 0
  for (
    let destinationIndex = 0;
    destinationIndex < destinationCount;
    destinationIndex++
  ) {
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex++) {
      if (
        source.locations[sourceIndex] ===
        destination.locations[destinationIndex]
      ) {
        if (matchedCount < GAIN_SLOT_COUNT) {
          sourceIndices[matchedCount] = sourceIndex
        }
        matchedCount++
      }
    }
  }

  const adjacentPairs = Math.max(0, matchedCount - 1)
  let matchingDrops = 0
  for (let index = 0; index < adjacentPairs; index++) {
    const sourceIndex = sourceIndices[index]
    const nextSourceIndex = sourceIndices[index + 1]
    if (
      sourceIndex < 0 ||
      nextSourceIndex < 0 ||
      sourceIndex >= sourceCount ||
      nextSourceIndex >= sourceCount ||
      index + 1 >= destinationCount
    ) {
      continue
    }
    const destinationDrop =
      destination.levels[index] - destination.levels[index + 1]
    const sourceDrop =
      source.levels[sourceIndex] - source.levels[nextSourceIndex]
    if (Math.abs(destinationDrop - sourceDrop) <= maximumAdjacentDropDelta) {
      matchingDrops++
    }
  }

  const firstDelta = Math.abs(source.levels[0] - destination.levels[0])
  const lastDelta = Math.abs(
    source.levels[sourceCount - 1] - destination.levels[destinationCount - 1]
  )
  if (
    firstDelta > maximumEndpointLevelDelta ||
    matchedCount <= 1 ||
    lastDelta > maximumEndpointLevelDelta ||
    matchingDrops !== adjacentPairs ||
    matchedCount !== sourceCount - 1
  ) {
    return false
  }
  destination.entries = sourceCount
  for (let index = 0; index < sourceCount; index++) {
    destination.locations[index] = source.locations[index]
    destination.levels[index] = source.levels[index]
  }
  return true
}

/**
 * Insert a transition into a bounded record.
 *
 * @param {GainRecord} record Record to update.
 * @param {number} index Insertion index.
 * @param {number} location Encoded transition location.
 * @param {number} level Encoded transition level.
 * @returns {boolean} Whether the transition fit in the record.
 */
export function insertGainRecordEntry(record, index, location, level) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  if (count >= GAIN_SLOT_COUNT || index < 0 || index > count) return false
  for (let source = count - 1; source >= index; source--) {
    record.locations[source + 1] = record.locations[source]
    record.levels[source + 1] = record.levels[source]
  }
  record.locations[index] = location >>> 0
  record.levels[index] = level >>> 0
  record.entries = count + 1
  return true
}

/**
 * Return one saturating incremented level for an active entry.
 *
 * @param {GainRecord} record Record to inspect.
 * @param {number} index Entry index.
 * @param {number} maximumLevel Saturation ceiling.
 * @returns {number|null} Incremented level, or `null` for an inactive index.
 */
export function gainRecordIncrementedLevel(record, index, maximumLevel) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  return index >= 0 && index < count
    ? Math.min(record.levels[index] + 1, maximumLevel)
    : null
}

/**
 * Initial record level relative to the profile's implicit tail level.
 *
 * @param {GainRecord} record Record to inspect.
 * @param {number} defaultTailLevel Profile's implicit terminal level.
 * @returns {number} Signed initial-level delta.
 */
export function gainRecordInitialLevelDelta(record, defaultTailLevel) {
  return record.entries === 0 ? 0 : record.levels[0] - defaultTailLevel
}

/**
 * Select the largest record transition into caller-owned result storage.
 *
 * @param {GainRecord} record Record to inspect.
 * @param {number} defaultTailLevel Profile's implicit terminal level.
 * @param {{entry: number, location: number, levelBefore: number, levelAfter: number, drop: number}} result Caller-owned transition result.
 * @returns {boolean} Whether an active transition was found.
 */
export function gainRecordBestLevelTransition(
  record,
  defaultTailLevel,
  result
) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  if (count === 0) return false
  let bestDrop = Number.NEGATIVE_INFINITY
  for (let entry = 0; entry < count; entry++) {
    const levelBefore = record.levels[entry]
    const levelAfter =
      entry + 1 < count ? record.levels[entry + 1] : defaultTailLevel
    const drop = levelBefore - levelAfter
    if (drop > bestDrop) {
      bestDrop = drop
      result.entry = entry
      result.location = record.locations[entry]
      result.levelBefore = levelBefore
      result.levelAfter = levelAfter
      result.drop = drop
    }
  }
  return true
}

/**
 * Whether any transition lies within an inclusive absolute location delta.
 *
 * @param {GainRecord} record Record to inspect.
 * @param {number} target Target location.
 * @param {number} maximumDelta Inclusive location tolerance.
 * @returns {boolean} Whether a nearby transition exists.
 */
export function gainRecordHasLocationNear(record, target, maximumDelta) {
  const count = Math.min(record.entries, GAIN_SLOT_COUNT)
  for (let index = 0; index < count; index++) {
    if (Math.abs(record.locations[index] - target) <= maximumDelta) return true
  }
  return false
}
