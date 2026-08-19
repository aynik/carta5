/** Shared fixed-capacity ATRAC3plus tone synthesis state. */

import {
  ANALYSIS_BANDS,
  CODING_UNIT_MAX_CHANNELS,
  MDCT_TIME_SAMPLE_COUNT,
  SUBBAND_SAMPLES,
  TONE_ANALYSIS_SOURCE_SAMPLES,
  TONE_DETECTION_DFT_WORDS,
  TONE_MAX_ENTRIES,
  TONE_RECORD_COUNT,
  TONE_SHARED_WORDS,
} from '../core/constants.js'
import { ToneSynthesisScratch } from './transform.js'

import { TONE_HEADER_ARRAYS } from '../core/tables.js'

/** Fixed scratch map for packed tone item ordering. */

/** Header array descriptors in joint, frequency, and swap storage order. */

/** Header descriptors in canonical joint, swap, frequency wire order. */

/**
 * Fixed-capacity detached sinusoid publication plan for one tone band.
 */
export class ToneEntryPlan {
  /**
   * Allocate maximum-capacity tone-entry syntax vectors.
   */
  constructor() {
    this.entryCount = 0
    this.scaleFactorIndices = new Int32Array(TONE_MAX_ENTRIES)
    this.amplitudeIndices = new Int32Array(TONE_MAX_ENTRIES)
    this.phaseBases = new Int32Array(TONE_MAX_ENTRIES)
    this.steps = new Int32Array(TONE_MAX_ENTRIES)
  }

  /**
   * Reset the reusable tone entry plan to its empty state without reallocating its storage.
   *
   * @returns {ToneEntryPlan} This cleared reusable plan.
   */
  clear() {
    this.entryCount = 0
    this.scaleFactorIndices.fill(0)
    this.amplitudeIndices.fill(0)
    this.phaseBases.fill(0)
    this.steps.fill(0)
    return this
  }

  /**
   * Append a tone entry when capacity remains.
   *
   * @param {number} scaleFactorIndex Quantized tone scale-factor index.
   * @param {number} phaseBase Quantized starting phase.
   * @param {number} step Quantized frequency step.
   * @returns {boolean} Whether the entry was appended.
   */
  append(scaleFactorIndex, phaseBase, step) {
    if (this.entryCount >= TONE_MAX_ENTRIES) return false
    const index = this.entryCount++
    this.scaleFactorIndices[index] = scaleFactorIndex | 0
    this.amplitudeIndices[index] = 0
    this.phaseBases[index] = phaseBase | 0
    this.steps[index] = step | 0
    return true
  }

  /**
   * Sort active tone entries by ascending frequency step while keeping all parallel fields aligned.
   *
   * @returns {ToneEntryPlan} This plan sorted by ascending frequency step.
   */
  sortByStep() {
    for (let index = 1; index < this.entryCount; index++) {
      const scaleFactorIndex = this.scaleFactorIndices[index]
      const amplitudeIndex = this.amplitudeIndices[index]
      const phaseBase = this.phaseBases[index]
      const step = this.steps[index]
      let slot = index
      while (slot > 0 && this.steps[slot - 1] > step) {
        this.scaleFactorIndices[slot] = this.scaleFactorIndices[slot - 1]
        this.amplitudeIndices[slot] = this.amplitudeIndices[slot - 1]
        this.phaseBases[slot] = this.phaseBases[slot - 1]
        this.steps[slot] = this.steps[slot - 1]
        slot--
      }
      this.scaleFactorIndices[slot] = scaleFactorIndex
      this.amplitudeIndices[slot] = amplitudeIndex
      this.phaseBases[slot] = phaseBase
      this.steps[slot] = step
    }
    return this
  }

  /**
   * Publish the planned entries without replacing record-owned storage.
   *
   * @param {ToneSynthesisRecord} record Destination syntax record.
   * @returns {ToneSynthesisRecord} The destination record.
   */
  commitTo(record) {
    record.entryCount = this.entryCount
    record.scaleFactorIndices.fill(0)
    record.amplitudeIndices.fill(0)
    record.phaseBases.fill(0)
    record.steps.fill(0)
    record.scaleFactorIndices.set(
      this.scaleFactorIndices.subarray(0, this.entryCount)
    )
    record.amplitudeIndices.set(
      this.amplitudeIndices.subarray(0, this.entryCount)
    )
    record.phaseBases.set(this.phaseBases.subarray(0, this.entryCount))
    record.steps.set(this.steps.subarray(0, this.entryCount))
    return record
  }
}

/**
 * Detached tone gate selected for one analysis band.
 */
export class ToneGate {
  /**
   * Allocate an open, inactive gate.
   */
  constructor() {
    this.clear()
  }

  /**
   * Reset the reusable tone gate to its empty state without reallocating its storage.
   *
   * @returns {ToneGate} This reset gate.
   */
  clear() {
    this.startValid = 0
    this.endValid = 0
    this.startIndex = 0
    this.endIndex = 0x20
    return this
  }

  /**
   * Replace all gate fields.
   *
   * @param {number} startValid Whether the start position is coded.
   * @param {number} endValid Whether the end position is coded.
   * @param {number} startIndex Quantized gate start.
   * @param {number} endIndex Quantized gate end.
   * @returns {ToneGate} This updated gate.
   */
  set(startValid, endValid, startIndex, endIndex) {
    this.startValid = startValid >>> 0
    this.endValid = endValid >>> 0
    this.startIndex = startIndex | 0
    this.endIndex = endIndex | 0
    return this
  }

  /**
   * Copy into caller-owned gate storage.
   *
   * @param {ToneGate} destination Gate to overwrite.
   * @returns {ToneGate} The destination gate.
   */
  copyTo(destination) {
    return destination.set(
      this.startValid,
      this.endValid,
      this.startIndex,
      this.endIndex
    )
  }

  /**
   * Publish this gate into a tone syntax record.
   *
   * @param {ToneSynthesisRecord} record Destination syntax record.
   * @returns {ToneSynthesisRecord} The destination record.
   */
  commitTo(record) {
    record.gateStartValid = this.startValid
    record.gateEndValid = this.endValid
    record.gateStartIndex = this.startIndex
    record.gateEndIndex = this.endIndex
    return record
  }
}

/**
 * Detached fade window derived from one tone gate and its history.
 */
export class ToneWindow {
  /**
   * Allocate an inactive full-span window.
   */
  constructor() {
    this.clear()
  }

  /**
   * Reset the reusable tone window to its empty state without reallocating its storage.
   *
   * @returns {ToneWindow} This reset window.
   */
  clear() {
    this.hasLeftFade = 0
    this.hasRightFade = 0
    this.leftIndex = 0
    this.rightIndex = 0
    return this
  }

  /**
   * Replace all window fields.
   *
   * @param {number} hasLeftFade Whether the left fade is active.
   * @param {number} hasRightFade Whether the right fade is active.
   * @param {number} leftIndex Left fade boundary.
   * @param {number} rightIndex Right fade boundary.
   * @returns {ToneWindow} This updated window.
   */
  set(hasLeftFade, hasRightFade, leftIndex, rightIndex) {
    this.hasLeftFade = hasLeftFade | 0
    this.hasRightFade = hasRightFade | 0
    this.leftIndex = leftIndex | 0
    this.rightIndex = rightIndex | 0
    return this
  }

  /**
   * Publish this window into a tone syntax record.
   *
   * @param {ToneSynthesisRecord} record Destination syntax record.
   * @returns {ToneSynthesisRecord} The destination record.
   */
  commitTo(record) {
    record.hasLeftFade = this.hasLeftFade
    record.hasRightFade = this.hasRightFade
    record.leftIndex = this.leftIndex
    record.rightIndex = this.rightIndex
    return record
  }
}

/**
 * Stage-private numerical work for tone detection and selection.
 */
export class ToneDetectionScratch {
  /**
   * Allocate complete numerical work for tone detection and selection.
   */
  constructor() {
    this.dftWork = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.bandOrder = new Int32Array(ANALYSIS_BANDS)
    this.combinedBandPower = new Float32Array(ANALYSIS_BANDS)
    this.logBandPower = new Float32Array(ANALYSIS_BANDS)
    this.perBandUnits = new Uint32Array(ANALYSIS_BANDS)
    this.candidateLimits = [
      new Int32Array(ANALYSIS_BANDS),
      new Int32Array(ANALYSIS_BANDS),
    ]
    this.windowSamples = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.spectrum = new Float32Array(TONE_DETECTION_DFT_WORDS)
    this.frequencyMask = new Float32Array(TONE_DETECTION_DFT_WORDS)
    this.candidateSamples = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.candidateSpectrum = new Float32Array(TONE_DETECTION_DFT_WORDS)
    this.sourceGroupPeaks = new Float32Array(8)
    this.entryPlan = new ToneEntryPlan()
    this.frequencyFit = { omega: 0, emittedStep: -1 }
    this.estimate = { magnitude: 0, phase: 0, step: 0 }
    this.groupMax = new Float32Array(32)
    this.attackRatio = new Float32Array(32)
    this.pairMax = new Float32Array(32)
    this.releaseRatio = new Float32Array(32)
    this.gate = new ToneGate()
    this.window = new ToneWindow()
  }
}

/**
 * Stage-private owner for one coding unit's complete tone transaction.
 */
export class ToneAnalysisScratch {
  /**
   * Allocate complete detection, synthesis, and transaction-local work.
   */
  constructor() {
    this.detection = new ToneDetectionScratch()
    this.synthesis = new ToneSynthesisScratch()
    this.sourceRows = Array.from({ length: CODING_UNIT_MAX_CHANNELS }, () =>
      Array.from(
        { length: ANALYSIS_BANDS },
        () => new Float32Array(TONE_ANALYSIS_SOURCE_SAMPLES)
      )
    )
    this.sourcePresent = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
    this.records = Array.from({ length: CODING_UNIT_MAX_CHANNELS }, () =>
      Array.from({ length: ANALYSIS_BANDS }, () => new ToneSynthesisRecord())
    )
    this.recordPresent = new Uint8Array(CODING_UNIT_MAX_CHANNELS)
    this.bandPower = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Float32Array(ANALYSIS_BANDS)
    )
    this.bandPowerSum = new Float32Array(ANALYSIS_BANDS)
    this.jointFlags = new Int32Array(ANALYSIS_BANDS)
    this.mixFlags = new Int32Array(ANALYSIS_BANDS)
    this.resolvedJointFlags = new Int32Array(ANALYSIS_BANDS)
    this.resolvedMixFlags = new Int32Array(ANALYSIS_BANDS)
    this.gates = Array.from({ length: CODING_UNIT_MAX_CHANNELS }, () =>
      Array.from({ length: ANALYSIS_BANDS }, () => new ToneGate())
    )
    this.gatePresent = new Uint8Array(CODING_UNIT_MAX_CHANNELS * ANALYSIS_BANDS)
    this.clearJointMix = new Uint8Array(ANALYSIS_BANDS)
    this.mixed = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.primarySpectrum = new Float32Array(TONE_DETECTION_DFT_WORDS)
    this.secondarySpectrum = new Float32Array(TONE_DETECTION_DFT_WORDS)
    this.residualRows = Array.from({ length: CODING_UNIT_MAX_CHANNELS }, () =>
      Array.from(
        { length: ANALYSIS_BANDS },
        () => new Float32Array(SUBBAND_SAMPLES)
      )
    )
    this.residualPresent = new Uint8Array(
      CODING_UNIT_MAX_CHANNELS * ANALYSIS_BANDS
    )
    this.powerTriplet = new Float32Array(3)
    this.headerEnabled = 0
    this.headerAmplitudeMode = 1
    this.headerBandCount = 0
  }
}

/**
 * Return the active current tone slot for one encoder channel block.
 *
 * @param {EncodeChannelState} block Encoder channel block.
 * @returns {ToneSlot|null} Active slot, or `null`.
 */
export function activeToneSlot(block) {
  const slot = block?.toneSlots?.[0]
  return slot?.active ? slot : null
}

/**
 * Fixed-capacity sinusoidal components for one tone subband.
 */
export class ToneSynthesisRecord {
  /**
   * Allocate fixed-capacity sinusoidal component storage.
   */
  constructor() {
    this.scaleFactorIndices = new Int32Array(TONE_MAX_ENTRIES)
    this.amplitudeIndices = new Int32Array(TONE_MAX_ENTRIES)
    this.phaseBases = new Int32Array(TONE_MAX_ENTRIES)
    this.steps = new Int32Array(TONE_MAX_ENTRIES)
    this.clear()
  }

  /**
   * Reset the reusable tone synthesis record to its empty state without reallocating its storage.
   *
   * @returns {ToneSynthesisRecord} This cleared reusable record.
   */
  clear() {
    this.hasLeftFade = 0
    this.hasRightFade = 0
    this.leftIndex = 0
    this.rightIndex = 0
    this.gateStartValid = 0
    this.gateEndValid = 0
    this.gateStartIndex = 0
    this.gateEndIndex = 0
    this.entryCount = 0
    this.scaleFactorIndices.fill(0)
    this.amplitudeIndices.fill(0)
    this.phaseBases.fill(0)
    this.steps.fill(0)
    return this
  }

  /**
   * Copy every synthesis field into preallocated record storage.
   *
   * @param {ToneSynthesisRecord} destination Record to overwrite.
   * @returns {ToneSynthesisRecord} The destination record.
   */
  copyTo(destination) {
    destination.hasLeftFade = this.hasLeftFade
    destination.hasRightFade = this.hasRightFade
    destination.leftIndex = this.leftIndex
    destination.rightIndex = this.rightIndex
    destination.gateStartValid = this.gateStartValid
    destination.gateEndValid = this.gateEndValid
    destination.gateStartIndex = this.gateStartIndex
    destination.gateEndIndex = this.gateEndIndex
    destination.entryCount = this.entryCount
    destination.scaleFactorIndices.set(this.scaleFactorIndices)
    destination.amplitudeIndices.set(this.amplitudeIndices)
    destination.phaseBases.set(this.phaseBases)
    destination.steps.set(this.steps)
    return destination
  }
}

/**
 * One logical slot in an encoder or decoder tone history.
 */
export class ToneSlot {
  /**
   * Allocate shared header words and all per-band records.
   */
  constructor() {
    this.active = false
    this.shared = new Int32Array(TONE_SHARED_WORDS)
    this.records = Array.from(
      { length: TONE_RECORD_COUNT },
      () => new ToneSynthesisRecord()
    )
  }

  /**
   * Reset the reusable tone slot to its empty state without reallocating its storage.
   *
   * @returns {ToneSlot} This cleared reusable history slot.
   */
  clear() {
    this.active = false
    this.shared.fill(0)
    for (const record of this.records) record.clear()
    return this
  }

  /**
   * Copy this slot into preallocated history storage.
   *
   * @param {ToneSlot} destination Slot to overwrite.
   * @returns {ToneSlot} The destination slot.
   */
  copyTo(destination) {
    destination.active = this.active
    destination.shared.set(this.shared)
    for (let band = 0; band < TONE_RECORD_COUNT; band++) {
      this.records[band].copyTo(destination.records[band])
    }
    return destination
  }
}

/**
 * Retry-persistent gate for the once-per-frame stereo record orientation.
 */
export class ToneSwapGate {
  /**
   * Allocate the gate and its temporary stereo-swap record.
   */
  constructor() {
    this.temporary = new ToneSynthesisRecord()
    this.applied = false
  }

  /**
   * Reset the tone-orientation gate so one swap may be applied during the new frame.
   *
   * @returns {ToneSwapGate} This reset frame gate.
   */
  beginFrame() {
    this.applied = false
    return this
  }

  /**
   * Claim the frame's single tone-orientation application and report whether the claim succeeded.
   *
   * @returns {boolean} Whether this is the first application this frame.
   */
  takeFirstApplication() {
    const first = !this.applied
    this.applied = true
    return first
  }
}

/**
 * Selected syntax fields for one channel in a tone coding unit.
 */
export class ToneChannelPlan {
  /**
   * Allocate fixed record flags and packing-map storage.
   */
  constructor() {
    this.presenceFlags = new Uint8Array(TONE_RECORD_COUNT)
    this.frequencyDirectionFlags = new Uint8Array(TONE_RECORD_COUNT)
    this.clear()
  }

  /**
   * Reset the reusable tone channel plan to its empty state without reallocating its storage.
   *
   * @returns {ToneChannelPlan} This cleared reusable channel plan.
   */
  clear() {
    this.presenceFlags.fill(0)
    this.frequencyDirectionFlags.fill(0)
    this.scaleFactorMode = 0
    return this
  }
}

/**
 * Fixed owner for one selected mono/stereo tone syntax transaction.
 */
export class ToneCodingPlan {
  /**
   * Allocate maximum channel, header, accounting, and packing storage.
   */
  constructor() {
    this.sides = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new ToneChannelPlan()
    )
    this.headerEnables = new Uint8Array(TONE_HEADER_ARRAYS.length)
    this.headerModes = new Uint8Array(TONE_HEADER_ARRAYS.length)
    this.clear()
  }

  /**
   * Reset the reusable tone coding plan to its empty state without reallocating its storage.
   *
   * @returns {ToneCodingPlan} This cleared reusable transaction.
   */
  clear() {
    for (const side of this.sides) side.clear()
    this.headerEnables.fill(0)
    this.headerModes.fill(0)
    this.totalBits = 0
    return this
  }
}
