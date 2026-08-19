/** Reusable state for ATRAC3plus gain syntax capture and selection. */

import { CODING_UNIT_MAX_CHANNELS, GAIN_RECORDS } from '../core/constants.js'

/**
 * Gain-control records serialized per channel.
 *
 * @param {EncodeChannelState|GainCodingChannel} source
 * @returns {GainRecord[]|null}
 */
function recordsFromSource(source) {
  return source?.currentGainRecords ?? source?.records ?? null
}

/**
 * Bind one gain source and publish its channel ordinal into syntax storage.
 *
 * @param {EncodeChannelState|GainCodingChannel} source Encoder channel block or record owner.
 * @param {GainCodingChannel} destination Bound channel syntax storage.
 * @returns {GainRecord[]} Bound source records.
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
