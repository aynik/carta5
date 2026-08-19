/** Fixed reusable storage for detached ATRAC3plus wire decoding. */

import {
  ANALYSIS_BANDS,
  BITSTREAM_PADDING_BYTES,
  CODING_UNIT_MAX_CHANNELS,
  MAX_CODING_UNITS,
  MAX_FRAME_BYTES,
  QUANTIZATION_UNIT_COUNT,
  TONE_ITEM_MAP_LENGTH,
} from '../core/constants.js'
import { ToneSynthesisRecord } from './tone.js'

/** Fixed header fields reused by word-length channel decoding. */

/**
 * Fixed header fields reused by word-length channel decoding.
 */
export class WordLengthDecodeScratch {
  /**
   * Initialize the reusable tail header fields.
   */
  constructor() {
    this.tailMode = 0
    this.tailCount = 0
    this.tailExtra = 0
  }
}

/**
 * Fixed temporary history for primary grouped scale-factor decoding.
 */
export class ScaleFactorDecodeScratch {
  /**
   * Allocate one full quantization-unit delta history.
   */
  constructor() {
    this.deltas = new Int32Array(QUANTIZATION_UNIT_COUNT)
  }
}

/**
 * Fixed item-map and record-swap storage shared across tone sections.
 */
export class ToneDecodeScratch {
  /**
   * Allocate tone item mapping and one in-place swap record.
   */
  constructor() {
    this.itemMap = new Int32Array(TONE_ITEM_MAP_LENGTH)
    this.temporary = new ToneSynthesisRecord()
  }
}

/**
 * Fixed leaf scratch and rebound channel views for one coding unit.
 */
export class CodingUnitDecodeScratch {
  /**
   * Allocate every leaf decoder scratch and rebound mono/stereo view.
   */
  constructor() {
    this.wordLength = new WordLengthDecodeScratch()
    this.scaleFactor = new ScaleFactorDecodeScratch()
    this.tone = new ToneDecodeScratch()
    this.gainWindowFlags = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Uint8Array(ANALYSIS_BANDS)
    )
    this.syntaxes = Array(CODING_UNIT_MAX_CHANNELS).fill(null)
    this.toneSlots = Array(CODING_UNIT_MAX_CHANNELS).fill(null)
  }
}

/**
 * Raw frame bytes and rebound views wrapped by one decoder parser context.
 *
 * This owner deliberately contains no bit-reader or traversal behavior. Those
 * I/O objects are created once by the decoder pipeline around this storage.
 */
export class FrameDecodeStorage {
  /**
   * Allocate complete frame bytes, coding-unit work, and rebound views.
   */
  constructor() {
    this.paddedFrame = new Uint8Array(MAX_FRAME_BYTES + BITSTREAM_PADDING_BYTES)
    this.codingUnit = new CodingUnitDecodeScratch()
    this.blockViews = Array.from({ length: MAX_CODING_UNITS }, () =>
      Array(CODING_UNIT_MAX_CHANNELS).fill(null)
    )
    this.primaryToneSlots = Array(CODING_UNIT_MAX_CHANNELS).fill(null)
    this.secondaryToneSlots = Array(CODING_UNIT_MAX_CHANNELS).fill(null)
  }
}
