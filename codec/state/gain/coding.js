/** Reusable state for ATRAC3plus gain syntax capture and selection. */

import {
  CODING_UNIT_MAX_CHANNELS,
  GAIN_RECORDS,
  GAIN_SLOT_COUNT,
} from '../../core/constants.js'
/**
 * Coded gain-control record plus the detector history carried with that record.
 *
 * `entries`, `locations`, and `levels` are syntax. `peakHistory` is explicitly
 * local encoder history and is never packed by this module.
 *
 * @property {i32} entries Active syntax-point count, at most seven.
 * @property {number} peakHistory Detector-local retained peak.
 * @nativeStable Own data descriptors and field order stay fixed after construction.
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
 * Gain-control records serialized per channel.
 *
 * @param {EncodeChannelState|GainCodingChannel} source
 * @returns {object[]|null}
 */
function recordsFromSource(source) {
  return source?.currentGainRecords ?? source?.records ?? null
}

/**
 * Bind one gain source and publish its channel ordinal into syntax storage.
 *
 * @param {EncodeChannelState|GainCodingChannel} source Encoder channel block or record owner.
 * @param {GainCodingChannel} destination Bound channel syntax storage.
 * @returns {object[]} Bound source records.
 */
function bindGainSource(source, destination) {
  const records = recordsFromSource(source)
  if (!records || records.length < GAIN_RECORDS) {
    throw new RangeError('ATRAC3plus gain source requires 16 records')
  }
  const ordinal = source?.channelOrdinal ?? source?.channel_ordinal ?? 0
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError('ATRAC3plus gain channel ordinal is invalid')
  }
  destination.channelOrdinal = ordinal
  destination.syntax.clear()
  return records
}

/**
 * Selected per-channel gain header, plane modes, and mode-local fields.
 */
export class GainChannelSyntax {
  /**
   * Allocate fixed per-record flags for one channel syntax image.
   */
  constructor() {
    this.levelFlags = new Uint8Array(GAIN_RECORDS)
    this.locationFlags = new Uint8Array(GAIN_RECORDS)
    this.clear()
  }

  /**
   * Reset the reusable gain channel syntax to its empty state without reallocating its storage.
   *
   * @returns {GainChannelSyntax} This cleared reusable syntax image.
   */
  clear() {
    this.hasData = 0
    this.hasDelta = 0
    this.effectiveCount = 0
    this.transmittedCount = 0
    this.pointCountMode = 0
    this.levelMode = 0
    this.levelWidth = 0
    this.levelBase = 0
    this.locationMode = 0
    this.countWidth = 0
    this.countBase = 0
    this.locationWidth = 0
    this.locationBase = 0
    this.levelFlags.fill(0)
    this.locationFlags.fill(0)
    return this
  }

  /**
   * Return the fixed gain-channel header width implied by the selected presence and delta modes.
   *
   * @returns {number} Fixed channel header width for the selected modes.
   */
  get fixedBits() {
    if (this.hasData === 0) return 1
    return 1 + 4 + 1 + (this.hasDelta ? 4 : 0) + 3 * 2
  }
}

/**
 * Selected syntax and a non-owning record view for one coding-unit channel.
 */
export class GainCodingChannel {
  /**
   * Allocate one empty record view and its reusable syntax fields.
   */
  constructor() {
    this.channelOrdinal = 0
    this.records = null
    this.syntax = new GainChannelSyntax()
  }

  /**
   * Bind caller-owned records without copying them.
   *
   * @param {EncodeChannelState|GainCodingChannel} source Encoder channel block or record owner.
   * @returns {GainCodingChannel} This bound channel plan.
   */
  bind(source) {
    const records = bindGainSource(source, this)
    this.records = records
    return this
  }
}

/**
 * Three selected two-bit gain-plane modes for both possible channels.
 */
export class GainSyntaxModeProfile {
  /**
   * Allocate three mode selectors for each possible channel.
   */
  constructor() {
    this.pointCount = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
    this.level = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
    this.location = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
  }

  /**
   * Reset the reusable gain syntax mode profile to its empty state without reallocating its storage.
   *
   * @returns {GainSyntaxModeProfile} This cleared reusable profile.
   */
  clear() {
    this.pointCount.fill(0)
    this.level.fill(0)
    this.location.fill(0)
    return this
  }
}

/**
 * Preallocated immutable-after-selection gain coding plan.
 */
export class GainCodingPlan {
  /**
   * Allocate maximum mono/stereo syntax storage once.
   */
  constructor() {
    this.channels = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new GainCodingChannel()
    )
    this.channelCount = 0
    this.bits = 0
  }
}
