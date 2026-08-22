/** Reusable state for ATRAC3plus scale-factor representation planning. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  SCALE_FACTOR_MODE_BITS,
} from '../core/constants.js'

/**
 * Encoder-selected scale-factor representation and derived mode rows.
 */
export class ScaleFactorEncodeState {
  /**
   * Allocate scale-factor values and predictor metadata for one channel's selected syntax plan.
   */
  constructor() {
    this.mode2Values = new Uint32Array(4 * QUANTIZATION_UNIT_COUNT)
    this.clear()
  }

  /**
   * Reset the reusable scale factor encode state to its empty state without reallocating its storage.
   *
   * @returns {ScaleFactorEncodeState}
   */
  clear() {
    this.modeSelect = 0
    this.lead = 0
    this.width = 0
    this.base = 0
    this.mode = 0
    this.mode2 = 0
    this.codebookIndex = 0
    this.baseValue = 0
    this.mode2Values.fill(0)
    return this
  }

  /**
   * Copy all active scale factor encode state fields into caller-owned destination storage.
   *
   * @param {ScaleFactorEncodeState} destination
   */
  copyTo(destination) {
    destination.modeSelect = this.modeSelect
    destination.lead = this.lead
    destination.width = this.width
    destination.base = this.base
    destination.mode = this.mode
    destination.mode2 = this.mode2
    destination.codebookIndex = this.codebookIndex
    destination.baseValue = this.baseValue
    destination.mode2Values.set(this.mode2Values)
  }
}

/**
 * Validate the local mono/stereo channel view used by scale-factor syntax.
 *
 * @param {EncodeChannelState[]} blocks Coding-unit channels in ordinal order.
 * @returns {void}
 */
export function validateScaleFactorChannels(blocks) {
  if (
    !Array.isArray(blocks) ||
    blocks.length < 1 ||
    blocks.length > CODING_UNIT_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus scale factors require one or two channels')
  }
  for (let channel = 0; channel < blocks.length; channel++) {
    if (!blocks[channel] || blocks[channel].channelOrdinal !== channel) {
      throw new RangeError('ATRAC3plus scale-factor channel index is invalid')
    }
  }
}

/**
 * Candidate rows and predictor-cost work for allocation-time scale-factor syntax selection.
 */
class ScaleFactorPricingWorkspace {
  /**
   * Allocate candidate rows, predictor deltas, and bit costs for both channel scale-factor searches.
   */
  constructor() {
    this.costs = new Int32Array(4)
    this.choiceBits = new Int32Array(4)
    this.rangeLeads = new Int32Array(4)
    this.rangeWidths = new Int32Array(4)
    this.rangeBases = new Int32Array(4)
    this.rangeCosts = new Int32Array(4)
    this.deltaCosts = new Int32Array(4)
    this.deltaCodebooks = new Int32Array(4)
    this.symbols = new Uint8Array(QUANTIZATION_UNIT_COUNT)
  }
}

/**
 * Sequential scale-factor syntax pricing and reusable candidate scratch.
 */
export class ScaleFactorCodingPlan {
  /**
   * Allocate exact mono/stereo accounting and shared planning scratch.
   */
  constructor() {
    this.scratch = new ScaleFactorPricingWorkspace()
    this.bits = 0
  }

  /**
   * Reset the plan for one coding unit.
   *
   * @param {number} channelCount Active channel count.
   * @returns {ScaleFactorCodingPlan} This reusable plan.
   */
  clear(channelCount = 0) {
    this.bits = channelCount * SCALE_FACTOR_MODE_BITS
    return this
  }
}
