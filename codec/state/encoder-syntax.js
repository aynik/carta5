/** Reusable encoder-selected syntax value images. */

import { QUANTIZATION_UNIT_COUNT } from '../core/constants.js'

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
 * Fixed field image for the selected word-length plan; kind 0 is raw.
 */
export class WordLengthCodingPlan {
  /**
   * Allocate fixed-size word-length fields for every supported syntax mode and quantization band.
   */
  constructor() {
    this.clear()
  }

  /**
   * Reset the reusable word length coding plan to its empty state without reallocating its storage.
   *
   * @returns {WordLengthCodingPlan}
   */
  clear() {
    this.bits = 0
    this.kind = 0
    this.delta = 0
    this.tailMode = 0
    this.tailCount = 0
    this.tailExtra = 0
    this.lead = 0
    this.width = 0
    this.base = 0
    this.pairFlag = 0
    this.codebook = 0
    this.shapeBase = 0
    this.shapeShift = 0
    this.first = 0
    this.channelMode = 0
    return this
  }

  /**
   * Return the word-length packing mode selected for one channel.
   *
   * @returns {number|string}
   */
  get packMode() {
    return this.kind === 4 ? this.channelMode + 1 : this.kind
  }

  /**
   * Copy all active word length coding plan fields into caller-owned destination storage.
   *
   * @param {WordLengthCodingPlan} destination
   * @returns {WordLengthCodingPlan}
   */
  copyTo(destination) {
    Object.assign(destination, this)
    return destination
  }
}

/**
 * Optional code-table classification and exact count/mode plan.
 */
export class CodeTableCodingSyntax {
  /**
   * Allocate code-table indices and mode fields for one channel's entropy syntax plan.
   */
  constructor() {
    this.clear()
  }

  /**
   * Reset the reusable code table coding syntax to its empty state without reallocating its storage.
   *
   * @returns {CodeTableCodingSyntax}
   */
  clear() {
    this.valueMask = 0
    this.oneBitMask = 0
    this.mode = 0
    this.count = 0
    this.explicit = false
    this.bits = 0
    return this
  }

  /**
   * Copy all active code table coding syntax fields into caller-owned destination storage.
   *
   * @param {CodeTableCodingSyntax} destination
   * @returns {CodeTableCodingSyntax}
   */
  copyTo(destination) {
    Object.assign(destination, this)
    return destination
  }
}
