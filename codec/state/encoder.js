/** Persistent ATRAC3plus encoder analysis and shared-stereo state. */

import {
  ANALYSIS_BANDS,
  ANALYSIS_SLOTS,
  ANALYSIS_TAIL_SAMPLES,
  ANALYSIS_TO_STREAM_DELAY_FRAMES,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  MAX_CODING_UNITS,
  SUBBAND_SAMPLES,
  ANALYSIS_SAMPLE_COUNT,
  BAND_STRIDE,
  GAIN_HISTORY_SAMPLES,
  GAIN_POINT_ENTRY_COUNT,
  GAIN_POINT_GROUP_ENTRIES,
  GAIN_POINT_GROUPS,
  INTENSITY_HISTORY_SLOTS,
  SCALE_HISTORY_BANDS,
  TONE_SLOT_COUNT,
} from '../core/constants.js'
import {
  GAIN_HISTORY_INITIAL_VALUE,
  GAIN_POINT_FIELDS,
} from '../core/tables.js'
import { GainRecord } from '../coding/gain.js'
import {
  CodingUnitAllocationTransaction,
  CodingUnitAllocationWorkspace,
} from './allocation.js'
import {
  CodeTableAccountingTransaction,
  CodeTablePricingWorkspace,
} from './code-table.js'
import { ScaleFactorEncodeState } from './encoder-syntax.js'
import { GainCodingPlan } from './gain.js'
import { lowRateGainScratchDepth } from './gain-analysis.js'
import { ScaleFactorCodingPlan } from './scale-factor.js'
import { ChannelSyntaxState, SharedState, StreamTopology } from './shared.js'
import { ToneCodingPlan, ToneSlot } from './tone.js'
import {
  WordLengthAccountingTransaction,
  WordLengthPricingWorkspace,
} from './word-length.js'

/**
 * Create bounded typed-array views over a shared backing row without copying its samples.
 *
 * @param {ArrayLike<number>} values
 * @returns {Float32Array[]}
 */
function createPrefixViews(values) {
  return Array.from({ length: values.length + 1 }, (_, count) =>
    Object.freeze(values.slice(0, count))
  )
}

/**
 * Persistent analyzed-frame delay consumed only after successful allocation.
 */
export class AnalysisToStreamDelay {
  /**
   * Allocate the bounded queue that aligns analyzed frames with their delayed stream positions.
   *
   * @param {number} [frames]
   */
  constructor(frames = 0) {
    this.reset(frames)
  }

  /**
   * Reset the reusable analysis to stream delay to its empty state without reallocating its storage.
   *
   * @param {number} frames
   * @returns {AnalysisToStreamDelay}
   */
  reset(frames) {
    if (!Number.isInteger(frames) || frames < 0) {
      throw new RangeError('ATRAC3plus analysis delay is invalid')
    }
    this.remainingFrames = frames
    return this
  }

  /**
   * Advance the analysis-to-stream delay after allocation commits one analyzed frame.
   *
   * @returns {boolean}
   */
  consumeAfterAllocation() {
    if (this.remainingFrames === 0) return false
    this.remainingFrames--
    return true
  }
}

/**
 * Per-channel nine-slot QMF analysis ring and persistent look-back tail.
 */
export class EncodeAnalysisState {
  /**
   * Allocate QMF, transform, tone, gain, and perceptual analysis storage for one encoder channel.
   */
  constructor() {
    this.samples = new Float32Array(ANALYSIS_SAMPLE_COUNT)
    this.tail = new Float32Array(ANALYSIS_TAIL_SAMPLES)
    this.bandSlots = Array.from({ length: ANALYSIS_BANDS }, (_, band) =>
      Array.from({ length: ANALYSIS_SLOTS }, (_, slot) => {
        const start = band * BAND_STRIDE + slot * SUBBAND_SAMPLES
        return this.samples.subarray(start, start + SUBBAND_SAMPLES)
      })
    )
  }

  /**
   * Rotate QMF subband history slots so the next analysis frame can be appended in place.
   */
  shiftBandSlots() {
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      const start = band * BAND_STRIDE
      this.samples.copyWithin(
        start,
        start + SUBBAND_SAMPLES,
        start + BAND_STRIDE
      )
    }
  }

  /**
   * Copy one subband slot between detached analysis states without allocating a new view.
   *
   * @param {number} band
   * @param {number} start
   * @param {Float32Array} destination
   */
  copyBandSamples(band, start, destination) {
    if (band < 0 || band >= ANALYSIS_BANDS || start < 0) {
      destination.fill(0)
      return
    }
    const available = Math.max(
      0,
      Math.min(destination.length, BAND_STRIDE - start)
    )
    if (available > 0) {
      const source = band * BAND_STRIDE + start
      destination.set(this.samples.subarray(source, source + available), 0)
    }
    destination.fill(0, available)
  }

  /**
   * Copy all active encode analysis state fields into caller-owned destination storage.
   *
   * @param {EncodeAnalysisState} destination
   */
  copyTo(destination) {
    destination.samples.set(this.samples)
    destination.tail.set(this.tail)
  }
}

/**
 * Current or previous per-quantization-unit scale selection.
 */
export class EncodeScaleHistory {
  /**
   * Allocate current and previous scale-factor rows used by inter-frame syntax predictors.
   */
  constructor() {
    this.scaleFactors = new Int32Array(SCALE_HISTORY_BANDS)
    this.scales = new Float32Array(SCALE_HISTORY_BANDS)
  }

  /**
   * Copy all active encode scale history fields into caller-owned destination storage.
   *
   * @param {EncodeScaleHistory} destination
   */
  copyTo(destination) {
    destination.scaleFactors.set(this.scaleFactors)
    destination.scales.set(this.scales)
  }
}

/**
 * Fixed, structure-of-arrays arena for both 64-point detector groups.
 */
export class GainPointArena {
  /**
   * Allocate fixed-capacity gain-point locations and levels for one history generation.
   */
  constructor() {
    for (const field of GAIN_POINT_FIELDS) {
      this[field] = new Int32Array(GAIN_POINT_ENTRY_COUNT)
    }
  }

  /**
   * Translate a gain-point ordinal into its flat arena offset.
   *
   * @param {number} group
   * @param {number} index
   * @returns {number}
   */
  offset(group, index) {
    if (
      !Number.isInteger(group) ||
      !Number.isInteger(index) ||
      group < 0 ||
      group >= GAIN_POINT_GROUPS ||
      index < 0 ||
      index >= GAIN_POINT_GROUP_ENTRIES
    ) {
      throw new RangeError('ATRAC3plus gain point is outside its fixed arena')
    }
    return group * GAIN_POINT_GROUP_ENTRIES + index
  }

  /**
   * Copy all active gain point arena fields into caller-owned destination storage.
   *
   * @param {GainPointArena} destination
   */
  copyTo(destination) {
    for (const field of GAIN_POINT_FIELDS) {
      destination[field].set(this[field])
    }
  }
}

/**
 * Persistent gain detector history for one QMF analysis band.
 */
export class GainDetectionBand {
  /**
   * Allocate envelope histories, point arenas, and peak metadata for one analyzed gain band.
   */
  constructor() {
    this.absoluteLevelHistory = new Float32Array(GAIN_HISTORY_SAMPLES)
    this.scaleHistory = new Float32Array(GAIN_HISTORY_SAMPLES)
    this.scaleHistory.fill(GAIN_HISTORY_INITIAL_VALUE)
    this.previousAbsoluteLevel = 0
    this.previousPeakIndex = 0
    this.currentPeakIndex = 0
    this.previousPeak = 0
    this.currentPeak = 0
    this.pointCounts = new Uint32Array(GAIN_POINT_GROUPS)
    this.disabledCounts = new Uint32Array(GAIN_POINT_GROUPS)
    this.duplicateCount = 0
    this.points = new GainPointArena()
  }

  /**
   * Copy all active gain detection band fields into caller-owned destination storage.
   *
   * @param {GainDetectionBand} destination
   */
  copyTo(destination) {
    destination.absoluteLevelHistory.set(this.absoluteLevelHistory)
    destination.scaleHistory.set(this.scaleHistory)
    destination.previousAbsoluteLevel = this.previousAbsoluteLevel
    destination.previousPeakIndex = this.previousPeakIndex
    destination.currentPeakIndex = this.currentPeakIndex
    destination.previousPeak = this.previousPeak
    destination.currentPeak = this.currentPeak
    destination.pointCounts.set(this.pointCounts)
    destination.disabledCounts.set(this.disabledCounts)
    destination.duplicateCount = this.duplicateCount
    this.points.copyTo(destination.points)
  }
}

/**
 * Complete persistent gain-detection carry for one encoded channel.
 */
export class GainDetectionState {
  /**
   * Allocate current, previous, and next detector history for every analyzed gain band.
   */
  constructor() {
    this.bands = Array.from(
      { length: ANALYSIS_BANDS },
      () => new GainDetectionBand()
    )
    this.energySum = new Float32Array(ANALYSIS_BANDS)
    this.energyRatio = new Float32Array(ANALYSIS_BANDS)
  }

  /**
   * Copy all active gain detection state fields into caller-owned destination storage.
   *
   * @param {GainDetectionState} destination
   */
  copyTo(destination) {
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      this.bands[band].copyTo(destination.bands[band])
    }
    destination.energySum.set(this.energySum)
    destination.energyRatio.set(this.energyRatio)
  }
}

/**
 * Per-channel intensity cutoff and five-frame correlation history.
 */
export class ChannelIntensityHistory {
  /**
   * Allocate delayed intensity decisions and per-band correlation evidence for one channel pair.
   */
  constructor() {
    this.intensityBandLimit = 0
    this.correlationMetrics = new Float32Array(
      INTENSITY_HISTORY_SLOTS * ANALYSIS_BANDS
    )
  }

  /**
   * Rotate intensity-stereo correlation history and clear the newly current row.
   */
  shift() {
    this.correlationMetrics.copyWithin(
      0,
      ANALYSIS_BANDS,
      INTENSITY_HISTORY_SLOTS * ANALYSIS_BANDS
    )
    this.correlationMetrics.fill(
      0,
      (INTENSITY_HISTORY_SLOTS - 1) * ANALYSIS_BANDS
    )
  }

  /**
   * Read the retained inter-channel correlation for one intensity-stereo band.
   *
   * @param {number} slot
   * @param {number} band
   * @returns {number}
   */
  correlation(slot, band) {
    return this.correlationMetrics[slot * ANALYSIS_BANDS + band] ?? 0
  }

  /**
   * Store one measured inter-channel correlation in the current intensity history row.
   *
   * @param {number} slot
   * @param {number} band
   * @param {number} value
   */
  setCorrelation(slot, band, value) {
    if (
      slot >= 0 &&
      slot < INTENSITY_HISTORY_SLOTS &&
      band >= 0 &&
      band < ANALYSIS_BANDS
    ) {
      this.correlationMetrics[slot * ANALYSIS_BANDS + band] = value
    }
  }

  /**
   * Copy all active channel intensity history fields into caller-owned destination storage.
   *
   * @param {ChannelIntensityHistory} destination
   */
  copyTo(destination) {
    destination.intensityBandLimit = this.intensityBandLimit
    destination.correlationMetrics.set(this.correlationMetrics)
  }
}

/**
 * Persistent cross-channel intensity-stereo history for one coding unit.
 */
export class IntensityStereoState {
  /**
   * Allocate committed and staged intensity history for every maintained stereo coding unit.
   */
  constructor() {
    this.intensityBandLimit = 16
    this.correlationDecibels = new Float32Array(ANALYSIS_BANDS)
    this.mixHistory = new Float32Array(5 * ANALYSIS_BANDS)
    this.previousScales = new Float32Array(2 * ANALYSIS_BANDS)
    this.currentScales = new Float32Array(2 * ANALYSIS_BANDS)
  }

  /**
   * Copy all active intensity stereo state fields into caller-owned destination storage.
   *
   * @param {IntensityStereoState} destination
   */
  copyTo(destination) {
    destination.intensityBandLimit = this.intensityBandLimit
    destination.correlationDecibels.set(this.correlationDecibels)
    destination.mixHistory.set(this.mixHistory)
    destination.previousScales.set(this.previousScales)
    destination.currentScales.set(this.currentScales)
  }
}

/**
 * Complete persistent and transactional encoder state for one ATRAC3plus channel.
 */
export class EncodeChannelState {
  /**
   * Allocate persistent analysis history, syntax plans, spectra, and transaction work for one encoder channel.
   *
   * @param {number} [channelOrdinal]
   * @param {number} [sharedIndex]
   */
  constructor(channelOrdinal = 0, sharedIndex = 0) {
    this.channelOrdinal = channelOrdinal
    this.sharedIndex = sharedIndex
    this.primaryChannelOrdinal = 0
    this.analysis = new EncodeAnalysisState()
    this.currentScaleHistory = new EncodeScaleHistory()
    this.previousScaleHistory = new EncodeScaleHistory()
    this.intensityHistory = new ChannelIntensityHistory()
    this.toneSlots = Array.from(
      { length: TONE_SLOT_COUNT },
      () => new ToneSlot()
    )
    this.detection = new GainDetectionState()
    this.syntax = new ChannelSyntaxState()
    this.scaleFactorEncode = new ScaleFactorEncodeState()
    this.quantizedSpectrum = new Int16Array(FRAME_SAMPLES)
    this.currentGainRecords = Array.from(
      { length: ANALYSIS_BANDS },
      () => new GainRecord()
    )
    this.previousGainRecords = Array.from(
      { length: ANALYSIS_BANDS },
      () => new GainRecord()
    )
  }

  /**
   * Promote current analysis, gain, tone, and intensity state to the previous-frame history.
   */
  rotateFrameHistory() {
    const currentScaleHistory = this.currentScaleHistory
    this.currentScaleHistory = this.previousScaleHistory
    this.previousScaleHistory = currentScaleHistory
    const currentGainRecords = this.currentGainRecords
    this.currentGainRecords = this.previousGainRecords
    this.previousGainRecords = currentGainRecords
    const oldest = this.toneSlots[0]
    for (let slot = 0; slot < TONE_SLOT_COUNT - 1; slot++) {
      this.toneSlots[slot] = this.toneSlots[slot + 1]
    }
    this.toneSlots[TONE_SLOT_COUNT - 1] = oldest
  }

  /**
   * Copy all active encode channel state fields into caller-owned destination storage.
   *
   * @param {EncodeChannelState} destination
   */
  copyTo(destination) {
    destination.channelOrdinal = this.channelOrdinal
    destination.sharedIndex = this.sharedIndex
    destination.primaryChannelOrdinal = this.primaryChannelOrdinal
    this.analysis.copyTo(destination.analysis)
    this.currentScaleHistory.copyTo(destination.currentScaleHistory)
    this.previousScaleHistory.copyTo(destination.previousScaleHistory)
    this.intensityHistory.copyTo(destination.intensityHistory)
    for (let slot = 0; slot < TONE_SLOT_COUNT; slot++) {
      this.toneSlots[slot].copyTo(destination.toneSlots[slot])
    }
    this.detection.copyTo(destination.detection)
    this.syntax.copyTo(destination.syntax)
    this.scaleFactorEncode.copyTo(destination.scaleFactorEncode)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      this.currentGainRecords[band].copyTo(destination.currentGainRecords[band])
      this.previousGainRecords[band].copyTo(
        destination.previousGainRecords[band]
      )
    }
  }
}

/**
 * Copyable encoder history image shared by committed and detached owners.
 */
export class EncoderStateImage {
  /**
   * Allocate profile-neutral maximum-capacity history storage.
   */
  constructor() {
    const channelBlocks = Array.from(
      { length: MAX_CHANNELS },
      (_, channel) => new EncodeChannelState(channel)
    )
    this.sharedCodingUnits = Array.from(
      { length: MAX_CODING_UNITS },
      () => new SharedState()
    )
    this.channelBlocks = channelBlocks
    this.analysisChannels = channelBlocks.map((channel) => channel.analysis)
    this.intensityCodingUnits = Array.from(
      { length: MAX_CODING_UNITS },
      () => new IntensityStereoState()
    )
  }
}

/**
 * Committed encoder history plus immutable stream and control state.
 */
export class EncoderState extends EncoderStateImage {
  /**
   * Allocate a complete committed stream owner.
   */
  constructor() {
    super()
    this.topology = new StreamTopology()
    this.analysisToStreamDelay = new AnalysisToStreamDelay()
    this.lastAllocationAttempts = 0
  }
}

/**
 * Detached encoder state, stage data, plans, and retry checkpoint.
 */
export class EncoderFrameState extends EncoderStateImage {
  /**
   * Allocate every fixed-capacity owner used by one frame transaction.
   */
  constructor() {
    super()
    this.allocationCheckpoint = new EncoderAllocationCheckpoint()

    this.pcmChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.pcmChannelViews = createPrefixViews(this.pcmChannels)
    this.qmfBands = this.analysisChannels.map((state) =>
      state.bandSlots.map((slots) => slots[8])
    )
    this.qmfBandViews = createPrefixViews(this.qmfBands)

    this.gainScaledSpectra = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.gainUnscaledSpectra = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.gainScaledSpectrumViews = createPrefixViews(this.gainScaledSpectra)
    this.gainUnscaledSpectrumViews = createPrefixViews(this.gainUnscaledSpectra)

    // Allocation completes one coding unit before advancing, so all
    // source-dependent scratch is shared by channel ordinal.
    this.allocationWorkspace = new CodingUnitAllocationWorkspace()

    this.gainPlans = Array.from(
      { length: MAX_CODING_UNITS },
      () => new GainCodingPlan()
    )
    this.scaleFactorPlan = new ScaleFactorCodingPlan()
    this.tonePlans = Array.from(
      { length: MAX_CODING_UNITS },
      () => new ToneCodingPlan()
    )
    this.wordLengthPricingWorkspace = new WordLengthPricingWorkspace()
    this.wordLengthTransactions = Array.from(
      { length: MAX_CODING_UNITS },
      () => new WordLengthAccountingTransaction(this.wordLengthPricingWorkspace)
    )
    this.codeTablePricingWorkspace = new CodeTablePricingWorkspace()
    this.codeTableTransactions = Array.from(
      { length: MAX_CODING_UNITS },
      () => new CodeTableAccountingTransaction(this.codeTablePricingWorkspace)
    )
    this.allocationTransactions = Array.from(
      { length: MAX_CODING_UNITS },
      () => new CodingUnitAllocationTransaction(this.allocationWorkspace)
    )
    for (let unit = 0; unit < MAX_CODING_UNITS; unit++) {
      this.allocationTransactions[unit].bindPlans(
        this.wordLengthTransactions[unit],
        this.scaleFactorPlan,
        this.codeTableTransactions[unit],
        this.gainPlans[unit],
        this.tonePlans[unit]
      )
    }
    this.allocationTransactionViews = createPrefixViews(
      this.allocationTransactions
    )
  }
}

/**
 * Allocation-owned subset of one analyzed encoder channel.
 */
class EncodeAllocationCheckpointChannel {
  /**
   * Allocate every per-channel syntax field that allocation may mutate before a retry.
   */
  constructor() {
    this.currentScaleHistory = new EncodeScaleHistory()
    this.syntax = new ChannelSyntaxState()
    this.scaleFactorEncode = new ScaleFactorEncodeState()
    this.quantizedSpectrum = new Int16Array(FRAME_SAMPLES)
    this.toneSlot = new ToneSlot()
  }

  /**
   * Snapshot the active encode allocation checkpoint channel state into this caller-owned checkpoint.
   *
   * @param {EncodeChannelState} source
   */
  capture(source) {
    source.currentScaleHistory.copyTo(this.currentScaleHistory)
    source.syntax.copyTo(this.syntax)
    source.scaleFactorEncode.copyTo(this.scaleFactorEncode)
    this.quantizedSpectrum.set(source.quantizedSpectrum)
    source.toneSlots[0].copyTo(this.toneSlot)
  }

  /**
   * Restore the active codec transaction from this encode allocation checkpoint channel snapshot.
   *
   * @param {EncodeChannelState} destination
   */
  restore(destination) {
    this.currentScaleHistory.copyTo(destination.currentScaleHistory)
    this.syntax.copyTo(destination.syntax)
    this.scaleFactorEncode.copyTo(destination.scaleFactorEncode)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    this.toneSlot.copyTo(destination.toneSlots[0])
  }
}

/**
 * Validate stream channel and coding-unit counts against the checkpoint's fixed capacities.
 *
 * @param {StreamTopology} topology
 * @param {number} channelCapacity
 * @param {number} unitCapacity
 * @returns {{channelCount: number, codingUnitCount: number}}
 */
function validateCheckpointTopology(topology, channelCapacity, unitCapacity) {
  const channelCount = topology?.channelCount
  const codingUnitCount = topology?.codingUnitCount
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > channelCapacity ||
    !Number.isInteger(codingUnitCount) ||
    codingUnitCount < 1 ||
    codingUnitCount > unitCapacity
  ) {
    throw new RangeError('ATRAC3plus allocation checkpoint topology is invalid')
  }
  return { channelCount, codingUnitCount }
}

/**
 * Pool-owned rollback image for fields mutated after frame analysis.
 */
export class EncoderAllocationCheckpoint {
  /**
   * Allocate shared and per-channel snapshots needed to restore a failed frame allocation attempt.
   */
  constructor() {
    this.sharedCodingUnits = Array.from(
      { length: MAX_CODING_UNITS },
      () => new SharedState()
    )
    this.channels = Array.from(
      { length: MAX_CHANNELS },
      () => new EncodeAllocationCheckpointChannel()
    )
    this.channelCount = 0
    this.codingUnitCount = 0
  }

  /**
   * Snapshot the active encoder allocation checkpoint state into this caller-owned checkpoint.
   *
   * @param {EncoderFrameState} source
   * @param {StreamTopology} topology
   * @returns {EncoderAllocationCheckpoint}
   */
  capture(source, topology) {
    const { channelCount, codingUnitCount } = validateCheckpointTopology(
      topology,
      this.channels.length,
      this.sharedCodingUnits.length
    )
    for (let unit = 0; unit < codingUnitCount; unit++) {
      source.sharedCodingUnits[unit].copyTo(this.sharedCodingUnits[unit])
    }
    for (let channel = 0; channel < channelCount; channel++) {
      this.channels[channel].capture(source.channelBlocks[channel])
    }
    this.channelCount = channelCount
    this.codingUnitCount = codingUnitCount
    return this
  }

  /**
   * Restore the active codec transaction from this encoder allocation checkpoint snapshot.
   *
   * @param {EncoderFrameState} destination
   * @param {StreamTopology} topology
   * @returns {EncoderFrameState}
   */
  restore(destination, topology) {
    const geometry = validateCheckpointTopology(
      topology,
      this.channels.length,
      this.sharedCodingUnits.length
    )
    if (
      geometry.channelCount !== this.channelCount ||
      geometry.codingUnitCount !== this.codingUnitCount
    ) {
      throw new RangeError('ATRAC3plus allocation checkpoint geometry changed')
    }
    for (let unit = 0; unit < this.codingUnitCount; unit++) {
      this.sharedCodingUnits[unit].copyTo(destination.sharedCodingUnits[unit])
    }
    for (let channel = 0; channel < this.channelCount; channel++) {
      this.channels[channel].restore(destination.channelBlocks[channel])
    }
    return destination
  }
}

/**
 * Bind preallocated channel blocks to an already configured stream topology.
 * This is stream-construction work, never a per-frame pipeline phase.
 *
 * @param {CodingUnitChannels[]} codingUnits Configured coding-unit channel maps.
 * @param {number} codingUnitCount Active coding-unit count.
 * @param {EncodeChannelState[]} channels Preallocated encoder channels.
 * @returns {number} Bound channel count.
 */
export function bindEncoderChannelStates(
  codingUnits,
  codingUnitCount,
  channels
) {
  if (
    !Number.isInteger(codingUnitCount) ||
    codingUnitCount < 1 ||
    codingUnitCount > codingUnits.length
  ) {
    throw new RangeError('ATRAC3plus coding-unit count is invalid')
  }
  let boundChannels = 0
  for (let unit = 0; unit < codingUnitCount; unit++) {
    const codingUnit = codingUnits[unit]
    for (let ordinal = 0; ordinal < codingUnit.length; ordinal++) {
      const channelIndex = codingUnit.at(ordinal)
      const channel = channels[channelIndex]
      if (!channel) {
        throw new RangeError(
          'ATRAC3plus channel topology exceeds state storage'
        )
      }
      channel.channelOrdinal = ordinal
      channel.sharedIndex = unit
      channel.primaryChannelOrdinal = 0
      channel.detection.energyRatio.fill(GAIN_HISTORY_INITIAL_VALUE)
      for (const slot of channel.toneSlots) slot.active = true
      boundChannels++
    }
  }
  return boundChannels
}

/**
 * Configure immutable topology/policy and bind committed channel identities.
 *
 * @param {CodecProfile} profile Immutable maintained profile.
 * @param {EncoderState} encoder Encoder pool ownership root.
 * @returns {StreamTopology} Configured stream topology.
 */
export function initializeEncoderStream(profile, encoder) {
  const topology = encoder?.state?.topology?.configure(profile)
  const gainScratch = encoder?.scratch?.gain
  if (!topology || typeof gainScratch?.configureAdjustment !== 'function') {
    throw new RangeError('ATRAC3plus encoder topology is unsupported')
  }
  let adjustmentDepth = -1
  for (let unit = 0; unit < topology.codingUnitCount; unit++) {
    adjustmentDepth = Math.max(
      adjustmentDepth,
      lowRateGainScratchDepth(
        topology.codingUnitChannels[unit].length,
        topology.codingUnitProfiles.coreModes[unit]
      )
    )
  }
  gainScratch.configureAdjustment(adjustmentDepth)
  const boundChannels = bindEncoderChannelStates(
    topology.codingUnitChannels,
    topology.codingUnitCount,
    encoder.state.channelBlocks
  )
  if (boundChannels !== topology.channelCount) {
    throw new Error('ATRAC3plus topology and channel state disagree')
  }
  encoder.state.analysisToStreamDelay.reset(ANALYSIS_TO_STREAM_DELAY_FRAMES)
  return topology
}

/**
 * Rotate delayed channel histories and clear the detached current records.
 *
 * @param {EncodeChannelState[]} channelBlocks Active channel blocks.
 * @param {number} channelCount Active stream channel count.
 * @returns {EncodeChannelState[]} The supplied channel blocks.
 */
export function rotateEncoderFrameHistories(channelBlocks, channelCount) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > channelBlocks?.length
  ) {
    throw new RangeError('ATRAC3plus history rotation geometry is invalid')
  }
  for (let channel = 0; channel < channelCount; channel++) {
    const state = channelBlocks[channel]
    state.rotateFrameHistory()
    for (const record of state.currentGainRecords) record.clear()
  }
  return channelBlocks
}

/**
 * Copy active encoder state into detached transaction storage.
 *
 * @param {EncoderState} source Committed encoder state.
 * @param {EncoderFrameState} destination Detached frame transaction.
 * @param {StreamTopology|null} [topology] Optional active topology bounds.
 * @returns {EncoderFrameState} The destination transaction.
 */
export function copyEncoderState(source, destination, topology = null) {
  const channelCount = topology?.channelCount ?? source.channelBlocks.length
  const codingUnitCount =
    topology?.codingUnitCount ?? source.sharedCodingUnits.length
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 0 ||
    channelCount > source.channelBlocks.length ||
    channelCount > destination.channelBlocks.length ||
    !Number.isInteger(codingUnitCount) ||
    codingUnitCount < 0 ||
    codingUnitCount > source.sharedCodingUnits.length ||
    codingUnitCount > destination.sharedCodingUnits.length ||
    codingUnitCount > source.intensityCodingUnits.length ||
    codingUnitCount > destination.intensityCodingUnits.length
  ) {
    throw new RangeError('ATRAC3plus encoder copy topology is invalid')
  }
  for (let index = 0; index < codingUnitCount; index++) {
    source.sharedCodingUnits[index].copyTo(destination.sharedCodingUnits[index])
  }
  for (let index = 0; index < channelCount; index++) {
    source.channelBlocks[index].copyTo(destination.channelBlocks[index])
  }
  for (let index = 0; index < codingUnitCount; index++) {
    source.intensityCodingUnits[index].copyTo(
      destination.intensityCodingUnits[index]
    )
  }
}
