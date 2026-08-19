/** Reusable state for transactional ATRAC3plus code-table planning. */

import { CodeTableCodingCostState } from '../coding/code-table.js'
import { CODING_UNIT_MAX_CHANNELS } from '../core/constants.js'
import { CodeTableCodingSyntax } from './encoder-syntax.js'

/**
 * Reusable speculative cost images shared by sequential code-table pricing.
 */
export class CodeTablePricingWorkspace {
  /**
   * Allocate incumbent and candidate cost states plus discardable syntax once.
   */
  constructor() {
    this.states = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new CodeTableCodingCostState()
    )
    this.candidateStates = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new CodeTableCodingCostState()
    )
    this.candidateSyntaxes = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new CodeTableCodingSyntax()
    )
  }
}

/**
 * Allocation-private accepted and discardable code-table cost images.
 */
export class CodeTableAccountingTransaction {
  /**
   * Allocate incumbent and discardable candidate images once.
   */
  constructor(workspace = new CodeTablePricingWorkspace()) {
    if (!(workspace instanceof CodeTablePricingWorkspace)) {
      throw new TypeError('ATRAC3plus code-table pricing workspace is invalid')
    }
    this.states = workspace.states
    this.syntaxes = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new CodeTableCodingSyntax()
    )
    this.values = new Array(CODING_UNIT_MAX_CHANNELS)
    this.candidateStates = workspace.candidateStates
    this.candidateSyntaxes = workspace.candidateSyntaxes
    this.clear()
  }

  /**
   * Reset the transaction for one coding unit.
   *
   * @param {number} channelCount Active channel count.
   * @returns {CodeTableAccountingTransaction} This transaction.
   */
  clear(channelCount = 0) {
    this.channelCount = channelCount
    this.maxCount = 0
    this.fixIndex = 0
    this.entropyModes = false
    this.initialized = false
    this.candidateReady = false
    this.modeledBits = 0
    this.candidateBits = 0
    this.accountedBits = 0
    for (let channel = 0; channel < this.states.length; channel++) {
      this.states[channel].clear()
      this.syntaxes[channel].clear()
      this.values[channel] = null
    }
    return this
  }

  /**
   * Snapshot only the cost states affected by one edit before repricing.
   *
   * @param {number} channel Changed channel ordinal.
   * @param {number} band Changed band index.
   * @param {number} value Candidate code-table value.
   */
  prepareCandidate(channel, band, value) {
    if (!this.initialized) {
      throw new RangeError(
        'ATRAC3plus code-table transaction is not initialized'
      )
    }
    this.states[channel].copyTo(this.candidateStates[channel])
    if (channel === 0) {
      for (let ordinal = 1; ordinal < this.channelCount; ordinal++) {
        this.states[ordinal].copyTo(this.candidateStates[ordinal])
      }
    }
    this.candidateChannel = channel
    this.candidateBand = band
    this.candidateValue = value
    this.candidateReady = true
  }

  /**
   * Promote the prepared candidate syntax and exact accounting to the incumbent transaction.
   *
   */
  acceptCandidate() {
    if (!this.candidateReady) {
      throw new RangeError('ATRAC3plus code-table candidate is not ready')
    }
    const first = this.candidateChannel === 0 ? 0 : this.candidateChannel
    const last = this.candidateChannel === 0 ? this.channelCount : first + 1
    for (let channel = first; channel < last; channel++) {
      let accepted = this.states[channel]
      this.states[channel] = this.candidateStates[channel]
      this.candidateStates[channel] = accepted
      accepted = this.syntaxes[channel]
      this.syntaxes[channel] = this.candidateSyntaxes[channel]
      this.candidateSyntaxes[channel] = accepted
    }
    this.values[this.candidateChannel][this.candidateBand] = this.candidateValue
    this.modeledBits = this.candidateBits
    this.accountedBits = this.candidateBits
    this.candidateReady = false
  }

  /**
   * Retain incumbent wire accounting while the current value model changes.
   *
   * @param {number} bits Exact accepted width to preserve.
   * @returns {CodeTableAccountingTransaction} This transaction.
   */
  retainAccountedBits(bits) {
    if (!this.initialized || !Number.isInteger(bits) || bits < 0) {
      throw new RangeError('ATRAC3plus code-table accounted bits are invalid')
    }
    this.accountedBits = bits
    return this
  }

  /**
   * Invalidate the prepared candidate while leaving incumbent syntax and accounting untouched.
   *
   * @returns {void}
   */
  discardCandidate() {
    this.candidateReady = false
  }

  /**
   * Return the exact serialized width of the accepted code-table section.
   *
   * @returns {number} Exact accepted wire width.
   */
  get bits() {
    return this.accountedBits
  }
}

/**
 * Validate the local mono/stereo channel view used by code-table syntax.
 *
 * @param {EncodeChannelState[]} blocks Coding-unit channels in ordinal order.
 * @returns {void}
 */
export function validateCodeTableChannels(blocks) {
  if (
    !Array.isArray(blocks) ||
    blocks.length < 1 ||
    blocks.length > CODING_UNIT_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus code tables require one or two channels')
  }
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    if (
      !block ||
      block.channelOrdinal !== channel ||
      block.primaryChannelOrdinal >= blocks.length
    ) {
      throw new RangeError('ATRAC3plus code-table channel topology is invalid')
    }
  }
}
