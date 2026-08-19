/** ATRAC3plus word-length wire decoding into detached channel syntax. */

import { readCanonicalSymbol } from '../coding/entropy.js'
import {
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
  WORD_LENGTH_DELTA_CURVES,
  WORD_LENGTH_SHAPE_CODEBOOK,
  WORD_LENGTH_CODEBOOKS,
} from '../core/tables.js'

import { ChannelSyntaxState } from '../state/shared.js'
import { WordLengthDecodeScratch } from '../state/decoder-syntax.js'
import { BitReader } from './bitstream.js'
import {
  IO_WORD_LENGTH_DECODER_MASK,
  IO_WORD_LENGTH_DECODER_SHAPE_BASE_STRIDE,
  IO_WORD_LENGTH_DECODER_SHAPE_SHIFT_STRIDE,
  TAIL_NONE,
  TAIL_ONES_OR_BITS,
  TAIL_RUN,
  TAIL_ZERO,
} from '../core/constants.js'

/**
 * Error raised when word length decode input violates the decoder or bitstream contract.
 */
export class WordLengthDecodeError extends RangeError {
  /**
   * Attach codec context to a word length decode error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus word-length decode failed: ${kind}`)
    this.name = 'WordLengthDecodeError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Verify predictor topology, coded band limit, reader, and reusable scratch before decoding word lengths.
 *
 * @param {ChannelSyntaxState} syntax
 * @param {ChannelSyntaxState|null} base
 * @param {number} channelOrdinal
 * @param {number} limit
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 */
function validateRequest(syntax, base, channelOrdinal, limit, reader, scratch) {
  if (
    !(syntax instanceof ChannelSyntaxState) ||
    (base !== null && !(base instanceof ChannelSyntaxState)) ||
    !Number.isInteger(channelOrdinal) ||
    channelOrdinal < 0 ||
    channelOrdinal > 1 ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 32 ||
    !(reader instanceof BitReader) ||
    !(scratch instanceof WordLengthDecodeScratch) ||
    (channelOrdinal === 1 && base === null)
  ) {
    throw new RangeError('ATRAC3plus word-length decode geometry is invalid')
  }
}

/**
 * Decode the shared trailing-run descriptor and retain its mode, count, and fill value in scratch.
 *
 * @param {number} channelOrdinal
 * @param {number} limit
 * @param {boolean} zeroCountIsFull
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 * @returns {{count: number, value: number}}
 */
function readTail(channelOrdinal, limit, zeroCountIsFull, reader, scratch) {
  const mode = reader.read(2)
  scratch.tailMode = mode
  scratch.tailExtra = 0
  if (mode === TAIL_NONE) {
    scratch.tailCount = limit
    return scratch
  }
  const packedCount = reader.read(5)
  const count = zeroCountIsFull && packedCount === 0 ? limit : packedCount
  if (count > limit) {
    throw new WordLengthDecodeError('count exceeds limit', {
      packedCount,
      decodedCount: count,
      limit,
    })
  }
  scratch.tailCount = count
  if (mode === TAIL_RUN) {
    scratch.tailExtra = reader.read(2) + (channelOrdinal === 0 ? 1 : 3)
  }
  return scratch
}

/**
 * Fill the uncoded word-length suffix with the predictor value selected for the current mode.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} limit
 * @param {WordLengthDecodeScratch} tail
 * @param {BitReader} reader
 */
function fillTail(values, channelOrdinal, limit, tail, reader) {
  const count = tail.tailCount
  if (tail.tailMode === TAIL_ZERO) {
    values.fill(0, count, limit)
  } else if (tail.tailMode === TAIL_ONES_OR_BITS) {
    if (channelOrdinal === 0) values.fill(1, count, limit)
    else {
      for (let band = count; band < limit; band++) values[band] = reader.read(1)
    }
  } else if (tail.tailMode === TAIL_RUN) {
    const end =
      channelOrdinal === 0 ? limit - tail.tailExtra : count + tail.tailExtra
    if (
      (channelOrdinal === 0 && (count > end || end >= limit)) ||
      (channelOrdinal === 1 && (count >= end || end > limit))
    ) {
      throw new WordLengthDecodeError(
        channelOrdinal === 0 ? 'primary tail end' : 'secondary tail end',
        { count, end, limit, extra: tail.tailExtra }
      )
    }
    values.fill(1, count, end)
    values.fill(0, end, limit)
  }
}

/**
 * Evaluate the word-length predictor curve at one quantization band.
 *
 * @param {number} channelOrdinal
 * @param {number} delta
 * @param {number} band
 * @returns {number}
 */
function deltaCurveValue(channelOrdinal, delta, band) {
  if (delta === 0) return 0
  const row = channelOrdinal * 3 + delta - 1
  return WORD_LENGTH_DELTA_CURVES[row * 32 + band]
}

/**
 * Expand a word-length predictor curve into absolute per-band values.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} limit
 * @param {number} delta
 */
function applyDeltaCurve(values, channelOrdinal, limit, delta) {
  if (delta === 0) return
  for (let band = 0; band < limit; band++) {
    values[band] += deltaCurveValue(channelOrdinal, delta, band)
  }
}

/**
 * Reconstruct the base word length represented by one shape slot.
 *
 * @param {number} base
 * @param {number} shift
 * @param {number} band
 * @returns {number}
 */
function shapeBaseValue(base, shift, band) {
  const slot = SHAPE_INDEX_BY_QUANTIZATION_UNIT[band]
  if (slot === 0) return base
  const table =
    base * IO_WORD_LENGTH_DECODER_SHAPE_BASE_STRIDE +
    shift * IO_WORD_LENGTH_DECODER_SHAPE_SHIFT_STRIDE
  return base - WORD_LENGTH_SHAPE_CODEBOOK[table + slot - 1]
}

/**
 * Add a wrapped predictor delta and mask the result to the syntax value domain.
 *
 * @param {number} symbol
 * @param {number} reference
 * @returns {number}
 */
function applyMaskedDelta(symbol, reference) {
  return (symbol + reference) & IO_WORD_LENGTH_DECODER_MASK
}

/**
 * Read one literal three-bit word length for every coded band.
 *
 * @param {ArrayLike<number>} values
 * @param {number} limit
 * @param {BitReader} reader
 */
function decodeRaw(values, limit, reader) {
  for (let band = 0; band < limit; band++) values[band] = reader.read(3)
}

/**
 * Reconstruct primary word lengths from a literal lead, linear predictor curve, residuals, and optional tail.
 *
 * @param {ArrayLike<number>} values
 * @param {number} limit
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 */
function decodePrimaryCurve(values, limit, reader, scratch) {
  const delta = reader.read(2)
  const tail = readTail(0, limit, true, reader, scratch)
  const count = tail.tailCount
  if (count > 0) {
    const lead = reader.read(5)
    if (lead > count) {
      throw new WordLengthDecodeError('lead exceeds count', { lead, count })
    }
    const width = reader.read(2)
    const base = reader.read(3)
    for (let band = 0; band < lead; band++) values[band] = reader.read(3)
    for (let band = lead; band < count; band++) {
      values[band] = width === 0 ? base : reader.read(width) + base
    }
  }
  fillTail(values, 0, limit, tail, reader)
  applyDeltaCurve(values, 0, limit, delta)
}

/**
 * Reconstruct primary word lengths from a predefined shape, grouped residuals, and optional tail.
 *
 * @param {ArrayLike<number>} values
 * @param {number} limit
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 */
function decodePrimaryShape(values, limit, reader, scratch) {
  const tail = readTail(0, limit, false, reader, scratch)
  const count = tail.tailCount
  if (count > 0) {
    const pairFlag = reader.read(1)
    const codebook = reader.read(1)
    const base = reader.read(3)
    const shift = reader.read(4)
    for (let band = 0; band < count; band++) {
      values[band] = shapeBaseValue(base, shift, band)
    }
    if (pairFlag !== 0) {
      const pairCount = count >> 1
      for (let pair = 0; pair < pairCount; pair++) {
        if (reader.read(1) !== 0) continue
        const band = pair * 2
        values[band] = applyMaskedDelta(
          readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
          values[band]
        )
        values[band + 1] = applyMaskedDelta(
          readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
          values[band + 1]
        )
      }
      for (let band = pairCount * 2; band < count; band++) {
        values[band] = applyMaskedDelta(
          readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
          values[band]
        )
      }
    } else {
      for (let band = 0; band < count; band++) {
        values[band] = applyMaskedDelta(
          readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
          values[band]
        )
      }
    }
  }
  fillTail(values, 0, limit, tail, reader)
}

/**
 * Reconstruct a channel from its first literal value and wrapped adjacent-band deltas.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} limit
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 */
function decodeDelta(values, channelOrdinal, limit, reader, scratch) {
  const delta = reader.read(2)
  const tail = readTail(channelOrdinal, limit, false, reader, scratch)
  const count = tail.tailCount
  if (count > 0) {
    const codebook = reader.read(2)
    values[0] = reader.read(3)
    for (let band = 1; band < count; band++) {
      values[band] = applyMaskedDelta(
        readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
        values[band - 1]
      )
    }
  }
  fillTail(values, channelOrdinal, limit, tail, reader)
  applyDeltaCurve(values, channelOrdinal, limit, delta)
}

/**
 * Reconstruct secondary word lengths from primary-channel values and optional propagated deltas.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} baseValues
 * @param {number} mode
 * @param {number} limit
 * @param {BitReader} reader
 * @param {WordLengthDecodeScratch} scratch
 */
function decodeSecondary(values, baseValues, mode, limit, reader, scratch) {
  const tail = readTail(1, limit, false, reader, scratch)
  const count = tail.tailCount
  if (count > 0) {
    const codebook = reader.read(2)
    for (let band = 0; band < count; band++) {
      let reference = baseValues[band]
      if (mode === 2 && band !== 0) {
        const previousDelta =
          (values[band - 1] - baseValues[band - 1]) &
          IO_WORD_LENGTH_DECODER_MASK
        reference = (reference + previousDelta) & IO_WORD_LENGTH_DECODER_MASK
      }
      values[band] = applyMaskedDelta(
        readCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], reader),
        reference
      )
    }
  }
  fillTail(values, 1, limit, tail, reader)
}

/**
 * Read the two-bit channel mode and its complete selected payload.
 *
 * @param {ChannelSyntaxState} syntax Destination channel syntax.
 * @param {ChannelSyntaxState|null} base Optional primary-channel syntax.
 * @param {number} channelOrdinal Coding-unit channel ordinal.
 * @param {number} limit Active word-length count.
 * @param {BitReader} reader Source bit reader.
 * @param {WordLengthDecodeScratch} scratch Reusable decoder work.
 * @returns {number} Decoded word-length packing mode.
 */
export function unpackWordLengthChannel(
  syntax,
  base,
  channelOrdinal,
  limit,
  reader,
  scratch
) {
  validateRequest(syntax, base, channelOrdinal, limit, reader, scratch)
  const values = syntax.wordLengths
  values.fill(0)
  const mode = reader.read(2) & 3
  if (mode === 0) decodeRaw(values, limit, reader)
  else if (mode === 3) {
    decodeDelta(values, channelOrdinal, limit, reader, scratch)
  } else if (channelOrdinal === 0) {
    if (mode === 1) decodePrimaryCurve(values, limit, reader, scratch)
    else decodePrimaryShape(values, limit, reader, scratch)
  } else {
    decodeSecondary(values, base.wordLengths, mode, limit, reader, scratch)
  }
  return mode
}
