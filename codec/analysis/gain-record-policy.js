/** Pure ATRAC3plus gain-record merge and cross-band edit policy. */

import {
  closeGainRecordMergeCount,
  copyGainRecordLocationSupersetIfLevelShapeClose,
  gainRecordBestLevelTransition,
  gainRecordHasLocationNear,
  gainRecordIncrementedLevel,
  gainRecordInitialLevelDelta,
  gainRecordIsActive,
  insertGainRecordEntry,
  mergeGainRecordMinLocationMaxLevel,
  mergeGainRecordPairMinLocationMaxLevel,
  normalizeGainRecord,
} from '../coding/gain.js'
import {
  GAIN_LEVEL_DEFAULT,
  GAIN_LEVEL_MAX,
  BAND0_SOURCE_TAIL_LEVEL,
  ANALYSIS_GAIN_RECORD_POLICY_NORMALIZE_TAIL_LEVEL,
} from '../core/constants.js'

/**
 * Sort, deduplicate, and clamp a gain record before policy decisions inspect it.
 *
 * @param {GainRecord} record
 * @returns {GainRecord}
 */
function normalizePolicyRecord(record) {
  return normalizeGainRecord(
    record,
    ANALYSIS_GAIN_RECORD_POLICY_NORMALIZE_TAIL_LEVEL,
    true
  )
}

/**
 * Count adjacent gain points that can collapse without changing the envelope materially.
 *
 * @param {GainRecord} first
 * @param {GainRecord} second
 * @returns {number}
 */
function closeRecordMergeCount(first, second) {
  return closeGainRecordMergeCount(first, second, 1, 1)
}

/**
 * Plan one destination record from a close peer into preallocated output.
 *
 * @param {GainRecord} destination Incumbent destination record.
 * @param {GainRecord} peer Peer record used as evidence.
 * @param {GainRecord} output Detached output record.
 * @returns {boolean} Whether the output differs from the incumbent.
 */
export function planCloseRecordFromPeer(destination, peer, output) {
  const count = closeRecordMergeCount(destination, peer)
  if (count === null) return false
  destination.copyTo(output)
  mergeGainRecordMinLocationMaxLevel(output, peer, count)
  normalizePolicyRecord(output)
  return !output.codedEquals(destination)
}

/**
 * Plan the symmetric close-record merge used between stereo channels.
 *
 * @param {GainRecord} primary Primary-channel record.
 * @param {GainRecord} secondary Secondary-channel record.
 * @param {GainRecordPolicyScratch} scratch Reusable merge storage.
 * @returns {GainRecord[]} Detached merged records.
 */
export function planCloseRecordsBetweenChannels(primary, secondary, scratch) {
  const records = scratch.stereoRecords
  primary.copyTo(records[0])
  secondary.copyTo(records[1])
  if (records[1].entries < records[0].entries) {
    copyGainRecordLocationSupersetIfLevelShapeClose(
      records[1],
      primary,
      1,
      1,
      scratch.mergeIndices
    )
  } else if (records[0].entries < records[1].entries) {
    copyGainRecordLocationSupersetIfLevelShapeClose(
      records[0],
      secondary,
      1,
      1,
      scratch.mergeIndices
    )
  }
  const count = closeRecordMergeCount(records[0], records[1])
  if (count !== null) {
    mergeGainRecordPairMinLocationMaxLevel(records[0], records[1], count)
    normalizePolicyRecord(records[0])
    normalizePolicyRecord(records[1])
  }
  return records
}

/**
 * Reference temporal-shape threshold for accepting a source merge.
 *
 * @param {SignalComparison} signalComparison Exact signal comparison.
 * @returns {boolean} Whether temporal support is sufficient.
 */
export function recordMergeHasTemporalSupport(signalComparison) {
  return signalComparison.shapeError <= 0.25
}

/**
 * Measure how strongly the original band-zero record supports a proposed edit.
 *
 * @param {GainRecord[]} currentRecords
 * @param {number} sourceLocation
 * @param {number} bandLimit
 * @returns {boolean}
 */
function band0SourceSupport(currentRecords, sourceLocation, bandLimit) {
  const scanEnd = Math.min(Math.max(bandLimit, 2), 4)
  const supportRequired = Math.max(0, scanEnd - 2)
  let supportCount = 0
  for (let band = 2; band < scanEnd; band++) {
    if (gainRecordHasLocationNear(currentRecords[band], sourceLocation, 1)) {
      supportCount++
    }
  }
  return supportCount === supportRequired
}

/**
 * Choose whether band zero should retain, merge, or replace its gain record using band-one support.
 *
 * @param {GainRecord[]} currentRecords
 * @param {GainRecord} peerBand1
 * @param {number} channelCount
 * @param {number} bandLimit
 * @param {GainRecordPolicyScratch} scratch
 * @returns {{type: number, index: number, location: number, level: number}}
 */
function planBand0Edit(
  currentRecords,
  peerBand1,
  channelCount,
  bandLimit,
  scratch
) {
  const edit = scratch.edit
  edit.type = 0
  if (
    bandLimit <= 1 ||
    !gainRecordBestLevelTransition(
      currentRecords[1],
      BAND0_SOURCE_TAIL_LEVEL,
      scratch.transition
    )
  ) {
    return edit
  }
  const source = scratch.transition
  const bestLocation = source.location
  if (
    source.drop <= 1 ||
    !band0SourceSupport(currentRecords, bestLocation, bandLimit) ||
    gainRecordInitialLevelDelta(currentRecords[0], 6) > 2
  ) {
    return edit
  }

  if (
    channelCount === 2 &&
    !gainRecordIsActive(currentRecords[0]) &&
    peerBand1 &&
    gainRecordInitialLevelDelta(peerBand1, 6) > 1
  ) {
    edit.type = 1
    edit.location = bestLocation
    edit.level = GAIN_LEVEL_DEFAULT
    return edit
  }

  const primary = currentRecords[0]
  const count = Math.min(primary.entries, 7)
  if (count < 7 && count > 0 && bestLocation < primary.locations[0]) {
    const level = gainRecordIncrementedLevel(primary, 0, GAIN_LEVEL_MAX)
    if (level !== null) {
      edit.type = 2
      edit.index = 0
      edit.location = bestLocation
      edit.level = level
    }
  }
  return edit
}

/**
 * Apply the band-1-derived band-0 edit and retain its incumbent when selected.
 *
 * @param {GainRecord[]} currentRecords Current channel gain records.
 * @param {GainRecord|null} peerBand1 Optional peer-channel band-1 record.
 * @param {number} channelCount Active coding-unit channels.
 * @param {number} bandLimit Active gain-band count.
 * @param {GainRecordPolicyScratch} scratch Reusable edit storage.
 * @returns {boolean} Whether an incumbent was retained for comparison.
 */
export function adjustBand0RecordFromBand1(
  currentRecords,
  peerBand1,
  channelCount,
  bandLimit,
  scratch
) {
  const target = currentRecords[0]
  const edit = planBand0Edit(
    currentRecords,
    peerBand1,
    channelCount,
    bandLimit,
    scratch
  )
  scratch.band0HasIncumbent = edit.type !== 0
  if (scratch.band0HasIncumbent) target.copyTo(scratch.band0Incumbent)
  if (edit.type === 1) {
    target.entries = 1
    target.locations[0] = edit.location
    target.levels[0] = edit.level
  } else if (edit.type === 2) {
    if (!insertGainRecordEntry(target, edit.index, edit.location, edit.level)) {
      throw new Error('ATRAC3plus band-0 gain edit exceeded record capacity')
    }
  }
  normalizePolicyRecord(target)
  return scratch.band0HasIncumbent
}
