/** Persistent ATRAC3plus inverse-transform and QMF synthesis state. */

import {
  FRAME_SAMPLES,
  MAX_CHANNELS,
  MAX_CODING_UNITS,
} from '../core/constants.js'
import { GainRecord } from '../coding/gain.js'
import { ChannelSyntaxState, SharedState, StreamTopology } from './shared.js'
import { ToneSlot } from './tone.js'

/**
 * Persistent decoded gain records plus their channel-local wire header.
 */
export class DecodeGainFrame {
  /**
   * Allocate current and previous gain records for every transform subband in one decoded channel.
   */
  constructor() {
    this.records = Array.from({ length: 16 }, () => new GainRecord())
    this.windowFlags = new Uint8Array(16)
    this.clear()
  }

  /**
   * Reset the reusable decode gain frame to its empty state without reallocating its storage.
   *
   * @returns {DecodeGainFrame}
   */
  clear() {
    for (const record of this.records) record.clear()
    this.windowFlags.fill(0)
    this.hasData = 0
    this.hasDelta = 0
    this.transmittedCount = 0
    this.effectiveCount = 0
    this.pointCountMode = 0
    this.levelMode = 0
    this.locationMode = 0
    this.countWidth = 0
    this.countBase = 0
    this.levelWidth = 0
    this.levelBase = 0
    this.locationWidth = 0
    this.locationBase = 0
    return this
  }

  /**
   * Copy all active decode gain frame fields into caller-owned destination storage.
   *
   * @param {DecodeGainFrame} destination
   */
  copyTo(destination) {
    for (let index = 0; index < 16; index++) {
      this.records[index].copyTo(destination.records[index])
    }
    destination.windowFlags.set(this.windowFlags)
    destination.hasData = this.hasData
    destination.hasDelta = this.hasDelta
    destination.transmittedCount = this.transmittedCount
    destination.effectiveCount = this.effectiveCount
    destination.pointCountMode = this.pointCountMode
    destination.levelMode = this.levelMode
    destination.locationMode = this.locationMode
    destination.countWidth = this.countWidth
    destination.countBase = this.countBase
    destination.levelWidth = this.levelWidth
    destination.levelBase = this.levelBase
    destination.locationWidth = this.locationWidth
    destination.locationBase = this.locationBase
  }
}

/**
 * Persistent inverse-transform overlap and two-phase synthesis delay rings.
 */
export class SynthesisState {
  /**
   * Allocate overlap, gain, tone, QMF, and PCM work that carries decoder synthesis across frames.
   */
  constructor() {
    this.inverseTransformOverlap = new Float32Array(FRAME_SAMPLES)
    this.firstPhaseDelay = new Float32Array(24 * 8)
    this.secondPhaseDelay = new Float32Array(24 * 8)
    this.delayRingIndex = 0
  }

  /**
   * Copy all active synthesis state fields into caller-owned destination storage.
   *
   * @param {SynthesisState} destination
   */
  copyTo(destination) {
    destination.inverseTransformOverlap.set(this.inverseTransformOverlap)
    destination.firstPhaseDelay.set(this.firstPhaseDelay)
    destination.secondPhaseDelay.set(this.secondPhaseDelay)
    destination.delayRingIndex = this.delayRingIndex
  }
}

/**
 * One decoder channel's parsed frame state and cross-frame syntax history.
 */
export class DecodeChannelState {
  /**
   * Allocate syntax, coefficient, and reconstruction state for one maintained decoder channel.
   *
   * @param {number} [channelOrdinal]
   * @param {number} [sharedIndex]
   */
  constructor(channelOrdinal = 0, sharedIndex = 0) {
    this.channelOrdinal = channelOrdinal
    this.sharedIndex = sharedIndex
    this.primaryChannelIndex = 0
    this.syntax = new ChannelSyntaxState()
    this.quantizedSpectrum = new Int16Array(FRAME_SAMPLES)
    this.gain = new DecodeGainFrame()
    this.previousGainRecords = Array.from(
      { length: 16 },
      () => new GainRecord()
    )
    this.previousGainWindowFlags = new Uint8Array(16)
    this.toneSlots = [new ToneSlot(), new ToneSlot()]
    for (const slot of this.toneSlots) slot.active = true
  }

  /**
   * Copy all active decode channel state fields into caller-owned destination storage.
   *
   * @param {DecodeChannelState} destination
   */
  copyTo(destination) {
    destination.channelOrdinal = this.channelOrdinal
    destination.sharedIndex = this.sharedIndex
    destination.primaryChannelIndex = this.primaryChannelIndex
    this.syntax.copyTo(destination.syntax)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    this.gain.copyTo(destination.gain)
    for (let band = 0; band < 16; band++) {
      this.previousGainRecords[band].copyTo(
        destination.previousGainRecords[band]
      )
    }
    destination.previousGainWindowFlags.set(this.previousGainWindowFlags)
    for (let slot = 0; slot < 2; slot++) {
      this.toneSlots[slot].copyTo(destination.toneSlots[slot])
    }
  }

  /**
   * Rotate accepted current gain/window/tone payloads into prior history.
   *
   * @returns {DecodeChannelState}
   */
  rotateAfterSynthesis() {
    const gainRecords = this.gain.records
    this.gain.records = this.previousGainRecords
    this.previousGainRecords = gainRecords
    const windowFlags = this.gain.windowFlags
    this.gain.windowFlags = this.previousGainWindowFlags
    this.previousGainWindowFlags = windowFlags
    const toneSlot = this.toneSlots[0]
    this.toneSlots[0] = this.toneSlots[1]
    this.toneSlots[1] = toneSlot
    return this
  }
}

/**
 * Copyable decoder history image shared by committed and detached owners.
 */
export class DecoderStateImage {
  /**
   * Allocate profile-neutral maximum-capacity history storage.
   */
  constructor() {
    const channelBlocks = Array.from(
      { length: MAX_CHANNELS },
      (_, channel) => new DecodeChannelState(channel)
    )
    this.sharedCodingUnits = Array.from(
      { length: MAX_CODING_UNITS },
      () => new SharedState()
    )
    this.channelBlocks = channelBlocks
    this.synthesisCodingUnits = Array.from({ length: MAX_CODING_UNITS }, () => [
      new SynthesisState(),
      new SynthesisState(),
    ])
  }
}

/**
 * Committed decoder history plus immutable stream topology.
 */
export class DecoderState extends DecoderStateImage {
  /**
   * Allocate a complete committed stream owner.
   */
  constructor() {
    super()
    this.topology = new StreamTopology()
  }
}

/**
 * Detached decoder state and stage data for one frame transaction.
 */
export class DecoderFrameState extends DecoderStateImage {
  /**
   * Allocate every fixed-capacity owner used by one frame transaction.
   */
  constructor() {
    super()
    this.spectra = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.outputChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.subbandSamples = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
  }
}

/**
 * Bind fixed decoder channel blocks to configured coding-unit ownership.
 *
 * @param {CodingUnitChannels[]} codingUnits Configured coding-unit channel maps.
 * @param {number} codingUnitCount Active coding-unit count.
 * @param {DecodeChannelState[]} channels Preallocated decoder channels.
 * @returns {number} Bound channel count.
 */
export function bindDecoderChannelStates(
  codingUnits,
  codingUnitCount,
  channels
) {
  if (
    !Number.isInteger(codingUnitCount) ||
    codingUnitCount < 1 ||
    codingUnitCount > codingUnits.length
  ) {
    throw new RangeError('ATRAC3plus decoder coding-unit count is invalid')
  }
  let boundChannels = 0
  for (let unit = 0; unit < codingUnitCount; unit++) {
    const codingUnit = codingUnits[unit]
    const primaryChannelIndex = codingUnit.at(0)
    for (let ordinal = 0; ordinal < codingUnit.length; ordinal++) {
      const channelIndex = codingUnit.at(ordinal)
      const channel = channels[channelIndex]
      if (!channel) {
        throw new RangeError(
          'ATRAC3plus decoder topology exceeds channel storage'
        )
      }
      channel.channelOrdinal = ordinal
      channel.sharedIndex = unit
      channel.primaryChannelIndex = primaryChannelIndex
      boundChannels++
    }
  }
  return boundChannels
}

/**
 * Configure immutable topology and bind both decoder transaction images.
 *
 * @param {CodecProfile} profile Immutable maintained profile.
 * @param {DecoderState} decoder Decoder pool ownership root.
 * @returns {StreamTopology} Configured stream topology.
 */
export function initializeDecoderStream(profile, decoder) {
  const topology = decoder?.state?.topology?.configure(profile)
  if (!topology) {
    throw new RangeError('ATRAC3plus decoder topology is unsupported')
  }
  for (const storage of [decoder.state, decoder.frame]) {
    const count = bindDecoderChannelStates(
      topology.codingUnitChannels,
      topology.codingUnitCount,
      storage.channelBlocks
    )
    if (count !== topology.channelCount) {
      throw new Error('ATRAC3plus decoder topology and state disagree')
    }
  }
  return topology
}

/**
 * Copy all currently ported decoder state into detached transaction storage.
 *
 * @param {DecoderState} source Committed decoder state.
 * @param {DecoderStateImage} destination Detached frame transaction.
 * @returns {void}
 */
export function copyDecoderState(source, destination) {
  for (let index = 0; index < source.sharedCodingUnits.length; index++) {
    source.sharedCodingUnits[index].copyTo(destination.sharedCodingUnits[index])
  }
  for (let index = 0; index < source.channelBlocks.length; index++) {
    source.channelBlocks[index].copyTo(destination.channelBlocks[index])
  }
  for (let unit = 0; unit < source.synthesisCodingUnits.length; unit++) {
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      source.synthesisCodingUnits[unit][ordinal].copyTo(
        destination.synthesisCodingUnits[unit][ordinal]
      )
    }
  }
}
