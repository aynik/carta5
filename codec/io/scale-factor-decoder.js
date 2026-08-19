/** ATRAC3plus scale-factor wire decoding into detached channel syntax. */

import { readCanonicalSymbol } from '../coding/entropy.js'
import {
  SCALE_FACTOR_MODE_2_DELTAS,
  SCALE_FACTOR_SHAPE_CODEBOOK,
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
  SCALE_FACTOR_DIRECT_CODEBOOKS,
  SCALE_FACTOR_GROUP_CODEBOOKS,
} from '../core/tables.js'

import { ChannelSyntaxState } from '../state/shared.js'
import { ScaleFactorDecodeScratch } from '../state/decoder-syntax.js'
import { BitReader } from './bitstream.js'
import {
  IO_SCALE_FACTOR_DECODER_GROUP_FIRST_BIAS,
  IO_SCALE_FACTOR_DECODER_GROUP_MASK,
  IO_SCALE_FACTOR_DECODER_MASK,
  IO_SCALE_FACTOR_DECODER_SHAPE_BIAS,
  IO_SCALE_FACTOR_DECODER_SHAPE_CODEBOOK_STRIDE,
} from '../core/constants.js'

/**
 * Error raised when scale factor decode input violates the decoder or bitstream contract.
 */
export class ScaleFactorDecodeError extends RangeError {
  /**
   * Attach codec context to a scale factor decode error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus scale-factor decode failed: ${kind}`)
    this.name = 'ScaleFactorDecodeError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Verify primary/secondary predictor topology, band count, reader, and scratch before decoding scale factors.
 *
 * @param {ChannelSyntaxState} syntax
 * @param {ChannelSyntaxState|null} primary
 * @param {number} channelOrdinal
 * @param {number} count
 * @param {BitReader} reader
 * @param {ScaleFactorDecodeScratch} scratch
 */
function validateRequest(
  syntax,
  primary,
  channelOrdinal,
  count,
  reader,
  scratch
) {
  if (
    !(syntax instanceof ChannelSyntaxState) ||
    (primary !== null && !(primary instanceof ChannelSyntaxState)) ||
    !Number.isInteger(channelOrdinal) ||
    channelOrdinal < 0 ||
    channelOrdinal > 1 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 32 ||
    !(reader instanceof BitReader) ||
    !(scratch instanceof ScaleFactorDecodeScratch) ||
    (channelOrdinal === 1 && primary === null)
  ) {
    throw new RangeError('ATRAC3plus scale-factor decode geometry is invalid')
  }
}

/**
 * Interpret an unsigned byte as a signed two's-complement delta.
 *
 * @param {number} value
 * @returns {number}
 */
function signedByte(value) {
  return (value << 24) >> 24
}

/**
 * Interpret a grouped scale-factor symbol as its signed predictor delta.
 *
 * @param {number} symbol
 * @returns {number}
 */
function signedGroupDelta(symbol) {
  const value = symbol & IO_SCALE_FACTOR_DECODER_GROUP_MASK
  return value & 8 ? value - 16 : value
}

/**
 * Add a wrapped predictor delta and mask the result to the syntax value domain.
 *
 * @param {number} symbol
 * @param {number} reference
 * @returns {number}
 */
function applyMaskedDelta(symbol, reference) {
  return (symbol + reference) & IO_SCALE_FACTOR_DECODER_MASK
}

/**
 * Wrap a shape residual into the selected scale-factor codebook domain.
 *
 * @param {number} codebook
 * @param {number} group
 * @returns {number}
 */
function shapeCodebookDelta(codebook, group) {
  if (group === 0) return 0
  return signedByte(
    SCALE_FACTOR_SHAPE_CODEBOOK[
      codebook * IO_SCALE_FACTOR_DECODER_SHAPE_CODEBOOK_STRIDE + group - 1
    ]
  )
}

/**
 * Expand the selected scale-factor shape into the destination row before residual decoding.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {number} baseValue
 * @param {number} codebook
 */
function initializeShape(values, count, baseValue, codebook) {
  for (let band = 0; band < count; band++) {
    const group = SHAPE_INDEX_BY_QUANTIZATION_UNIT[band] ?? 0
    values[band] = baseValue - shapeCodebookDelta(codebook, group)
  }
}

/**
 * Reconstruct a mode-two scale-factor row from its base value and coded ramp.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {number} mode2
 */
function applyMode2Ramp(values, count, mode2) {
  if (mode2 !== 1 && mode2 !== 2) return
  const ramp = SCALE_FACTOR_MODE_2_DELTAS[mode2 - 1]
  for (let band = 0; band < count; band++) {
    values[band] = (values[band] - (ramp[band] ?? 0)) >>> 0
  }
}

/**
 * Read one literal six-bit scale factor for every coded band.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {BitReader} reader
 */
function decodeRaw(values, count, reader) {
  for (let band = 0; band < count; band++) values[band] = reader.read(6)
}

/**
 * Reconstruct primary scale factors from a bounded range, optional literal lead, and mode ramp.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {BitReader} reader
 */
function decodePrimaryRange(values, count, reader) {
  const mode2 = reader.read(2)
  if (mode2 !== 3) {
    const lead = reader.read(5)
    const width = reader.read(3)
    const base = reader.read(6)
    if (lead > count) {
      throw new ScaleFactorDecodeError('lead exceeds count', { lead, count })
    }
    if (width > 6) {
      throw new ScaleFactorDecodeError('width exceeds six bits', { width })
    }
    for (let band = 0; band < lead; band++) values[band] = reader.read(6)
    for (let band = lead; band < count; band++) {
      values[band] = reader.read(width) + base
    }
    applyMode2Ramp(values, count, mode2)
    return
  }

  const baseValue = reader.read(6)
  const codebook = reader.read(6)
  const lead = reader.read(5)
  const width = reader.read(2)
  const base = reader.read(4) - IO_SCALE_FACTOR_DECODER_SHAPE_BIAS
  initializeShape(values, count, baseValue, codebook)
  if (lead > count) {
    throw new ScaleFactorDecodeError('shape lead exceeds count', {
      lead,
      count,
    })
  }
  for (let band = 0; band < lead; band++) {
    values[band] += reader.read(4) - IO_SCALE_FACTOR_DECODER_SHAPE_BIAS
  }
  for (let band = lead; band < count; band++) {
    values[band] += reader.read(width) + base
  }
  for (let band = 0; band < count; band++)
    values[band] &= IO_SCALE_FACTOR_DECODER_MASK
}

/**
 * Initialize a predefined scale-factor shape and apply one wrapped residual per band.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {BitReader} reader
 */
function decodePrimaryShapeDelta(values, count, reader) {
  const codebook = reader.read(2)
  const baseValue = reader.read(6)
  const shapeCodebook = reader.read(6)
  initializeShape(values, count, baseValue, shapeCodebook)
  for (let band = 0; band < count; band++) {
    const symbol = readCanonicalSymbol(
      SCALE_FACTOR_GROUP_CODEBOOKS[codebook],
      reader
    )
    values[band] = applyMaskedDelta(signedGroupDelta(symbol), values[band])
  }
}

/**
 * Reconstruct primary scale factors from adjacent-band deltas or grouped residuals and a mode ramp.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {BitReader} reader
 * @param {ScaleFactorDecodeScratch} scratch
 */
function decodePrimaryDelta(values, count, reader, scratch) {
  const mode2 = reader.read(2)
  const codebook = reader.read(2)
  if (mode2 !== 3) {
    values[0] = reader.read(6)
    for (let band = 1; band < count; band++) {
      values[band] = applyMaskedDelta(
        readCanonicalSymbol(SCALE_FACTOR_DIRECT_CODEBOOKS[codebook], reader),
        values[band - 1]
      )
    }
    applyMode2Ramp(values, count, mode2)
    return
  }

  const baseValue = reader.read(6)
  const shapeCodebook = reader.read(6)
  initializeShape(values, count, baseValue, shapeCodebook)
  const deltas = scratch.deltas
  deltas.fill(0)
  deltas[0] =
    (reader.read(4) - IO_SCALE_FACTOR_DECODER_GROUP_FIRST_BIAS) &
    IO_SCALE_FACTOR_DECODER_MASK
  for (let band = 1; band < count; band++) {
    const symbol = readCanonicalSymbol(
      SCALE_FACTOR_GROUP_CODEBOOKS[codebook],
      reader
    )
    deltas[band] = applyMaskedDelta(signedGroupDelta(symbol), deltas[band - 1])
  }
  for (let band = 0; band < count; band++) {
    values[band] = applyMaskedDelta(deltas[band], values[band])
  }
}

/**
 * Reconstruct secondary scale factors from primary values and optional propagated inter-channel deltas.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} primaryValues
 * @param {number} count
 * @param {number} relation
 * @param {BitReader} reader
 */
function decodeSecondary(values, primaryValues, count, relation, reader) {
  const codebook = reader.read(2)
  for (let band = 0; band < count; band++) {
    let reference = primaryValues[band]
    if (relation === 1 && band !== 0) {
      const previousDelta =
        (values[band - 1] - primaryValues[band - 1]) &
        IO_SCALE_FACTOR_DECODER_MASK
      reference = (reference + previousDelta) & IO_SCALE_FACTOR_DECODER_MASK
    }
    values[band] = applyMaskedDelta(
      readCanonicalSymbol(SCALE_FACTOR_DIRECT_CODEBOOKS[codebook], reader),
      reference
    )
  }
}

/**
 * Read the two-bit channel mode and its complete selected payload.
 *
 * @param {ChannelSyntaxState} syntax Destination channel syntax.
 * @param {ChannelSyntaxState|null} primary Optional primary-channel syntax.
 * @param {number} channelOrdinal Coding-unit channel ordinal.
 * @param {number} count Active scale-factor count.
 * @param {BitReader} reader Source bit reader.
 * @param {ScaleFactorDecodeScratch} scratch Reusable decoder work.
 * @returns {number} Decoded scale-factor packing mode.
 */
export function unpackScaleFactorChannel(
  syntax,
  primary,
  channelOrdinal,
  count,
  reader,
  scratch
) {
  validateRequest(syntax, primary, channelOrdinal, count, reader, scratch)
  const values = syntax.scaleFactors
  values.fill(0)
  const mode = reader.read(2) & 3
  if (mode === 0) decodeRaw(values, count, reader)
  else if (channelOrdinal === 0) {
    if (mode === 1) decodePrimaryRange(values, count, reader)
    else if (mode === 2) decodePrimaryShapeDelta(values, count, reader)
    else decodePrimaryDelta(values, count, reader, scratch)
  } else if (mode === 3) {
    values.set(primary.scaleFactors.subarray(0, count), 0)
  } else {
    decodeSecondary(values, primary.scaleFactors, count, mode - 1, reader)
  }
  return mode
}
