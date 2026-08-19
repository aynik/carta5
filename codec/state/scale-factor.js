/** Reusable state for ATRAC3plus scale-factor representation planning. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  SCALE_FACTOR_MODE_BITS,
} from '../core/constants.js'

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
