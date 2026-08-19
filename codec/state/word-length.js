/** Reusable state for transactional ATRAC3plus word-length planning. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  WORD_LENGTH_MODE_BITS,
  WORD_LENGTH_SIDE_DATA_BANDS,
} from '../core/constants.js'
import { WordLengthCodingPlan } from './encoder-syntax.js'

/**
 * Allocation-private caches for one channel's candidate word-length plan.
 */
class WordLengthScratch {
  /**
   * Allocate candidate rows and incremental ledgers for one channel's word-length search.
   */
  constructor() {
    this.rowNegativeCounts = new Uint8Array(4)
    this.rowNonzeroMasks = new Uint32Array(4)
    this.rowNononeMasks = new Uint32Array(4)
    this.rowAboveOneMasks = new Uint32Array(4)
    this.candidateRows = new Int32Array(4 * QUANTIZATION_UNIT_COUNT)
    this.rows = Array.from({ length: 4 }, (_, row) =>
      this.candidateRows.subarray(
        row * QUANTIZATION_UNIT_COUNT,
        (row + 1) * QUANTIZATION_UNIT_COUNT
      )
    )
    this.bandCounts = new Int32Array(16)
    this.mapIndices = new Int32Array(16)
    this.rowMeta = new Int32Array(4)
    this.deltaModeHuffmanBits = new Int32Array(4 * 4 * 4)
    this.channelHuffmanBits = new Int32Array(2 * 4 * 4)
  }

  /**
   * Reset the reusable word length scratch to its empty state without reallocating its storage.
   *
   * @returns {WordLengthScratch} This cleared reusable scratch.
   */
  clear() {
    this.rowNegativeCounts.fill(0)
    this.rowNonzeroMasks.fill(0)
    this.rowNononeMasks.fill(0)
    this.rowAboveOneMasks.fill(0)
    this.candidateRows.fill(0)
    this.bandCounts.fill(0)
    this.mapIndices.fill(0)
    this.rowMeta.fill(0)
    this.deltaModeHuffmanBits.fill(0)
    this.channelHuffmanBits.fill(0)
    return this
  }

  /**
   * Copy the incremental ledgers needed to reprice one candidate edit.
   *
   * @param {WordLengthScratch} destination Candidate storage to overwrite.
   * @returns {WordLengthScratch} The prepared candidate storage.
   */
  copyIncrementalStateTo(destination) {
    destination.rowNegativeCounts.set(this.rowNegativeCounts)
    destination.rowNonzeroMasks.set(this.rowNonzeroMasks)
    destination.rowNononeMasks.set(this.rowNononeMasks)
    destination.rowAboveOneMasks.set(this.rowAboveOneMasks)
    destination.candidateRows.set(this.candidateRows)
    destination.bandCounts.set(this.bandCounts)
    destination.mapIndices.set(this.mapIndices)
    destination.rowMeta.set(this.rowMeta)
    destination.deltaModeHuffmanBits.set(this.deltaModeHuffmanBits)
    destination.channelHuffmanBits.set(this.channelHuffmanBits)
    return destination
  }
}

/**
 * Shared fixed-capacity work arrays for exact word-length cost evaluation.
 */
class WordLengthCostWork {
  /**
   * Allocate one scratch candidate per maintained channel and shared section accounting.
   */
  constructor() {
    this.costs = new Int32Array(4)
    this.directFields = new Int32Array(5)
    this.predictiveFields = new Int32Array(5)
    this.huffmanFields = new Int32Array(5)
    this.mode1Lead = 0
    this.mode1Width = 0
    this.mode1Base = 0
    this.mode1PayloadBits = 0
    this.shapeValues = new Uint8Array(4 * QUANTIZATION_UNIT_COUNT)
    this.shapeRows = Array.from({ length: 4 }, (_, group) =>
      this.shapeValues.subarray(
        group * QUANTIZATION_UNIT_COUNT,
        (group + 1) * QUANTIZATION_UNIT_COUNT
      )
    )
    this.shapeCounts = new Uint8Array(4)
    this.shapeBases = new Uint8Array(4)
    this.shapeShifts = new Uint8Array(4)
    this.shapeAverages = new Int8Array(WORD_LENGTH_SIDE_DATA_BANDS)
    this.predicted = new Int32Array(WORD_LENGTH_SIDE_DATA_BANDS)
    this.baseCosts = new Int32Array(4)
    this.adjustedCosts = new Int32Array(4)
    this.selectors = new Int32Array(4)
    this.tempCosts = new Int32Array(4)
    this.payloadCosts = new Int32Array(2)
    this.pairPayloadCosts = new Int32Array(2)
    this.rowCosts = new Int32Array(4)
    this.rowPlanLeads = new Int32Array(4)
    this.rowPlanWidths = new Int32Array(4)
    this.rowPlanBases = new Int32Array(4)
    this.rowPlanPayloadBits = new Int32Array(4)
    this.rangeLeads = new Int32Array(3)
    this.rangeBases = new Int32Array(3)
  }
}

/**
 * Reusable speculative rows shared by sequential coding-unit word-length pricing.
 */
export class WordLengthPricingWorkspace {
  /**
   * Allocate incumbent/candidate caches and shared cost work once.
   */
  constructor() {
    this.scratch = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new WordLengthScratch()
    )
    this.work = new WordLengthCostWork()
    this.candidateScratch = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new WordLengthScratch()
    )
    this.candidatePlans = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new WordLengthCodingPlan()
    )
  }
}

/**
 * Allocation-private word-length caches and selected compact channel plans.
 */
export class WordLengthAccountingTransaction {
  /**
   * Allocate candidate plans and bindable section accounting for one mono or stereo coding unit.
   */
  constructor(workspace = new WordLengthPricingWorkspace()) {
    if (!(workspace instanceof WordLengthPricingWorkspace)) {
      throw new TypeError('ATRAC3plus word-length pricing workspace is invalid')
    }
    this.scratch = workspace.scratch
    this.work = workspace.work
    this.plans = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new WordLengthCodingPlan()
    )
    this.candidateScratch = workspace.candidateScratch
    this.candidatePlans = workspace.candidatePlans
    this.candidateReady = false
    this.channelCount = 0
    this.initialized = false
  }

  /**
   * Reset all incumbent and candidate storage for one coding unit.
   *
   * @param {number} [channelCount]
   * @returns {WordLengthAccountingTransaction}
   */
  clear(channelCount = 0) {
    this.channelCount = channelCount
    this.bandLimit = 0
    this.sideDataBandCount = 0
    this.initialized = false
    this.rawOnly = false
    for (let channel = 0; channel < this.scratch.length; channel++) {
      this.scratch[channel].clear()
      this.plans[channel].clear()
    }
    this.candidateReady = false
    return this
  }

  /**
   * Snapshot only channels affected by one speculative edit.
   *
   * @param {number} changedChannel Changed coding-unit channel ordinal.
   */
  prepareCandidate(changedChannel) {
    if (!this.initialized) {
      throw new RangeError(
        'ATRAC3plus word-length transaction is not initialized'
      )
    }
    for (let channel = changedChannel; channel < this.channelCount; channel++) {
      this.scratch[channel].copyIncrementalStateTo(
        this.candidateScratch[channel]
      )
    }
    this.candidateChannel = changedChannel
    this.candidateReady = true
  }

  /**
   * Promote the prepared candidate to the incumbent transaction state.
   */
  acceptCandidate() {
    if (!this.candidateReady) {
      throw new RangeError('ATRAC3plus word-length candidate is not ready')
    }
    for (
      let channel = this.candidateChannel;
      channel < this.channelCount;
      channel++
    ) {
      let accepted = this.scratch[channel]
      this.scratch[channel] = this.candidateScratch[channel]
      this.candidateScratch[channel] = accepted
      accepted = this.plans[channel]
      this.plans[channel] = this.candidatePlans[channel]
      this.candidatePlans[channel] = accepted
    }
    this.candidateReady = false
  }

  /**
   * Abandon a prepared candidate without mutating the incumbent.
   */
  discardCandidate() {
    this.candidateReady = false
  }

  /**
   * Exact serialized width of the incumbent section.
   *
   * @returns {number}
   */
  get bits() {
    let bits = this.channelCount * WORD_LENGTH_MODE_BITS
    for (let channel = 0; channel < this.channelCount; channel++) {
      bits += this.plans[channel].bits
    }
    return bits
  }
}

/**
 * Validate the local mono/stereo channel view used by word-length syntax.
 *
 * @param {EncodeChannelState[]} blocks Coding-unit channels in ordinal order.
 * @returns {void}
 */
export function validateWordLengthChannels(blocks) {
  if (
    !Array.isArray(blocks) ||
    blocks.length < 1 ||
    blocks.length > CODING_UNIT_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus word lengths require one or two channels')
  }
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    if (
      !block ||
      block.channelOrdinal !== channel ||
      block.primaryChannelOrdinal >= blocks.length
    ) {
      throw new RangeError('ATRAC3plus word-length channel topology is invalid')
    }
  }
}
