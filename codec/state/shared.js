/** ATRAC3plus coding-unit topology and shared transactional syntax state. */

import { codedSubbandCount, mapCount, shapeCount } from '../core/geometry.js'
import {
  CHANNEL_COUNT_BY_MODE_AND_BLOCK,
  CODING_UNIT_COUNT_BY_MODE,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  MAX_CODING_UNITS,
} from '../core/constants.js'
import { configureCodingUnitProfiles } from '../core/profiles.js'

/**
 * Fixed storage for the global channel indices owned by one coding unit.
 */
export class CodingUnitChannels {
  /**
   * Allocate the fixed stream-channel index list for one mono or stereo coding unit.
   */
  constructor() {
    this.indices = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
    this.length = 0
  }

  /**
   * Reset the reusable coding unit channels to its empty state without reallocating its storage.
   */
  clear() {
    this.indices.fill(0)
    this.length = 0
  }

  /**
   * Append a stream channel index to the fixed-capacity coding-unit channel list.
   *
   * @param {number} channelIndex
   */
  push(channelIndex) {
    if (this.length >= this.indices.length) {
      throw new RangeError('ATRAC3plus coding units are mono or stereo')
    }
    this.indices[this.length++] = channelIndex
  }

  /**
   * Return the stream channel index stored at one coding-unit-local ordinal.
   *
   * @param {number} ordinal
   * @returns {number|null}
   */
  at(ordinal) {
    return ordinal >= 0 && ordinal < this.length ? this.indices[ordinal] : null
  }

  /**
   * Copy all active coding unit channels fields into caller-owned destination storage.
   *
   * @param {CodingUnitChannels} destination
   */
  copyTo(destination) {
    destination.indices.set(this.indices)
    destination.length = this.length
  }
}

/**
 * Immutable-per-stream encoder policy for each serialized coding unit.
 */
export class CodingUnitProfiles {
  /**
   * Allocate parallel topology, bandwidth, mode, and budget vectors for every coding unit in a frame.
   */
  constructor() {
    this.channelModes = new Uint8Array(MAX_CODING_UNITS)
    this.quantizationUnitCounts = new Uint8Array(MAX_CODING_UNITS)
    this.coreModes = new Uint8Array(MAX_CODING_UNITS)
    this.toneAnalysisEnabled = new Uint8Array(MAX_CODING_UNITS)
    this.budgetBits = new Int32Array(MAX_CODING_UNITS)
    this.length = 0
  }

  /**
   * Reset the reusable coding unit profiles to its empty state without reallocating its storage.
   */
  clear() {
    this.channelModes.fill(0)
    this.quantizationUnitCounts.fill(0)
    this.coreModes.fill(0)
    this.toneAnalysisEnabled.fill(0)
    this.budgetBits.fill(0)
    this.length = 0
  }
}

/**
 * Immutable-per-stream coding-unit topology and derived profile policy.
 */
export class StreamTopology {
  /**
   * Allocate maximum-capacity topology storage once.
   */
  constructor() {
    this.codingUnitChannels = Array.from(
      { length: MAX_CODING_UNITS },
      () => new CodingUnitChannels()
    )
    this.codingUnitProfiles = new CodingUnitProfiles()
    this.codingUnitCount = 0
    this.channelCount = 0
  }

  /**
   * Configure this owner for one maintained stream profile.
   *
   * @param {CodecProfile} profile Immutable profile descriptor.
   * @returns {StreamTopology|null} This configured owner, or `null`.
   */
  configure(profile) {
    const topology = configureCodingUnitChannels(
      profile?.streamChannelMode,
      this.codingUnitChannels
    )
    if (
      !topology ||
      !configureCodingUnitProfiles(profile, this.codingUnitProfiles)
    ) {
      return null
    }
    this.codingUnitCount = topology.codingUnitCount
    this.channelCount = topology.channelCount
    return this
  }
}

/**
 * Configure preallocated coding-unit channel maps for one stream topology.
 * This runs once at stream construction; frames only read the stable maps.
 *
 * @param {number} streamMode Packed stream topology selector.
 * @param {CodingUnitChannels[]} destination Preallocated unit maps.
 * @returns {{codingUnitCount: number, channelCount: number}|null} Topology bounds.
 */
export function configureCodingUnitChannels(streamMode, destination) {
  const mode = streamMode & 7
  const codingUnitCount = CODING_UNIT_COUNT_BY_MODE[mode]
  if (
    codingUnitCount === 0 ||
    codingUnitCount > MAX_CODING_UNITS ||
    destination.length < codingUnitCount
  ) {
    return null
  }

  let channelIndex = 0
  for (let unit = 0; unit < destination.length; unit++) {
    const channels = destination[unit]
    channels.clear()
    if (unit >= codingUnitCount) continue
    const channelCount =
      CHANNEL_COUNT_BY_MODE_AND_BLOCK[mode * MAX_CODING_UNITS + unit]
    if (channelCount < 1 || channelCount > CODING_UNIT_MAX_CHANNELS) {
      return null
    }
    for (let ordinal = 0; ordinal < channelCount; ordinal++) {
      channels.push(channelIndex++)
    }
  }
  return Object.freeze({ codingUnitCount, channelCount: channelIndex })
}

/**
 * Bitstream-visible syntax shared by all channels in one coding unit.
 */
export class SharedState {
  /**
   * Allocate coding-unit syntax fields that are shared by both channels and survive allocation retries.
   */
  constructor() {
    this.presenceEnabled = new Uint8Array(2)
    this.presenceMixed = new Uint8Array(2)
    this.presenceFlags = [new Uint8Array(16), new Uint8Array(16)]
    this.clear()
  }

  /**
   * Reset the reusable shared state to its empty state without reallocating its storage.
   *
   * @returns {SharedState}
   */
  clear() {
    this.presenceEnabled.fill(0)
    this.presenceMixed.fill(0)
    this.presenceFlags[0].fill(0)
    this.presenceFlags[1].fill(0)
    this.gainModeFlag = 0
    this.noisePresent = 0
    this.noiseLevelIndex = 0
    this.noiseTableIndex = 0
    this.scaleFactorCount = 0
    this.quantizationUnitCount = 0
    this.bandLimit = 0
    this.muteFlag = 0
    return this
  }

  /**
   * Return the number of intensity-map entries implied by the shared syntax flags.
   *
   * @returns {number}
   */
  get mapCount() {
    return mapCount(this.scaleFactorCount)
  }

  /**
   * Return the number of scale-factor shape values required by the active band count.
   *
   * @returns {number}
   */
  get shapeCount() {
    return shapeCount(this.quantizationUnitCount)
  }

  /**
   * Return the number of subbands covered by the coding unit's active quantization bands.
   *
   * @returns {number}
   */
  get codedSubbandCount() {
    return codedSubbandCount(this.quantizationUnitCount)
  }

  /**
   * Copy all active shared state fields into caller-owned destination storage.
   *
   * @param {SharedState} destination
   */
  copyTo(destination) {
    destination.presenceEnabled.set(this.presenceEnabled)
    destination.presenceMixed.set(this.presenceMixed)
    destination.presenceFlags[0].set(this.presenceFlags[0])
    destination.presenceFlags[1].set(this.presenceFlags[1])
    destination.gainModeFlag = this.gainModeFlag
    destination.noisePresent = this.noisePresent
    destination.noiseLevelIndex = this.noiseLevelIndex
    destination.noiseTableIndex = this.noiseTableIndex
    destination.scaleFactorCount = this.scaleFactorCount
    destination.quantizationUnitCount = this.quantizationUnitCount
    destination.bandLimit = this.bandLimit
    destination.muteFlag = this.muteFlag
  }
}

/**
 * Selected per-channel ATRAC3plus fields shared by encode and decode syntax stages.
 */
export class ChannelSyntaxState {
  /**
   * Allocate the decoded or planned sidechain fields associated with one coded channel.
   */
  constructor() {
    this.wordLengths = new Int32Array(32)
    this.scaleFactors = new Int32Array(32)
    this.codeTables = new Int32Array(32)
    this.toneFrequencyFlags = new Uint8Array(16)
    this.tonePresenceFlags = new Uint8Array(16)
    this.spectralNoiseLevelIndices = new Int32Array(5)
    this.clear()
  }

  /**
   * Reset the reusable channel syntax state to its empty state without reallocating its storage.
   *
   * @returns {ChannelSyntaxState}
   */
  clear() {
    this.wordLengths.fill(0)
    this.scaleFactors.fill(0)
    this.codeTables.fill(0)
    this.toneScaleFactorMode = 0
    this.toneFrequencyFlags.fill(0)
    this.tonePresenceFlags.fill(0)
    this.codeTableContext = 0
    this.spectralNoiseLevelIndices.fill(0)
    return this
  }

  /**
   * Copy all active channel syntax state fields into caller-owned destination storage.
   *
   * @param {ChannelSyntaxState} destination
   */
  copyTo(destination) {
    destination.wordLengths.set(this.wordLengths)
    destination.scaleFactors.set(this.scaleFactors)
    destination.codeTables.set(this.codeTables)
    destination.toneScaleFactorMode = this.toneScaleFactorMode
    destination.toneFrequencyFlags.set(this.toneFrequencyFlags)
    destination.tonePresenceFlags.set(this.tonePresenceFlags)
    destination.codeTableContext = this.codeTableContext
    destination.spectralNoiseLevelIndices.set(this.spectralNoiseLevelIndices)
  }
}
