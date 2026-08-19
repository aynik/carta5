/** ATRAC3plus spectral code-table wire decoding. */

import { readCanonicalSymbol } from '../coding/entropy.js'
import {
  CODE_TABLE_CODEBOOKS,
  CODE_TABLE_FIXED_WIDTHS,
} from '../core/tables.js'
import { ChannelSyntaxState, SharedState } from '../state/shared.js'
import { BitReader } from './bitstream.js'
import {
  MODE_DIFF,
  MODE_DIRECT,
  MODE_FIXED,
  MODE_PAIR,
  TYPE_NONE,
  TYPE_ONE_BIT,
  TYPE_VALUE,
} from '../core/constants.js'

/**
 * Error raised when code table decode input violates the decoder or bitstream contract.
 */
export class CodeTableDecodeError extends RangeError {
  /**
   * Attach codec context to a code table decode error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus code-table decode failed: ${kind}`)
    this.name = 'CodeTableDecodeError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Verify channel syntax, shared band geometry, and reader state before decoding code-table modes.
 *
 * @param {DecodeChannelState[]} channels
 * @param {SharedState} shared
 * @param {BitReader} reader
 */
function validateRequest(channels, shared, reader) {
  if (
    !Array.isArray(channels) ||
    channels.length < 1 ||
    channels.length > 2 ||
    !channels.every((channel) => channel instanceof ChannelSyntaxState) ||
    !(shared instanceof SharedState) ||
    !Number.isInteger(shared.scaleFactorCount) ||
    shared.scaleFactorCount < 0 ||
    shared.scaleFactorCount > 32 ||
    !(reader instanceof BitReader)
  ) {
    throw new RangeError('ATRAC3plus code-table decode geometry is invalid')
  }
}

/**
 * Resolve whether a band carries a full code-table value, a one-bit value, or no payload.
 *
 * @param {ChannelSyntaxState} channel
 * @param {ChannelSyntaxState|null} primary
 * @param {number} band
 * @returns {number}
 */
function bandType(channel, primary, band) {
  if (channel.wordLengths[band] > 0) return TYPE_VALUE
  if (primary !== null && primary.wordLengths[band] > 0) return TYPE_ONE_BIT
  return TYPE_NONE
}

/**
 * Decode the compact full-range-or-explicit code-table band count.
 *
 * @param {number} maximum
 * @param {BitReader} reader
 * @returns {number}
 */
function readCount(maximum, reader) {
  if (reader.read(1) === 0) return maximum
  const packedCount = reader.read(5)
  if (packedCount > maximum) {
    throw new CodeTableDecodeError('count exceeds maximum', {
      packedCount,
      maximum,
    })
  }
  return packedCount
}

/**
 * Add a wrapped predictor delta and mask the result to the syntax value domain.
 *
 * @param {number} symbol
 * @param {number} reference
 * @param {ArrayLike<number>} codebook
 * @returns {number}
 */
function applyMaskedDelta(symbol, reference, codebook) {
  return (symbol + reference) & (codebook.length - 1)
}

/**
 * Reconstruct one channel's code-table indices from fixed, direct, differential, or paired syntax.
 *
 * @param {ChannelSyntaxState} channel
 * @param {ChannelSyntaxState|null} primary
 * @param {number} mode
 * @param {number} maximum
 * @param {number} fixIndex
 * @param {BitReader} reader
 */
function decodeChannel(channel, primary, mode, maximum, fixIndex, reader) {
  const values = channel.codeTables
  values.fill(0)
  if (mode === MODE_PAIR && primary === null) return
  const count = readCount(maximum, reader)
  const tables = CODE_TABLE_CODEBOOKS[fixIndex]
  let previous = 0
  for (let band = 0; band < count; band++) {
    const type = bandType(channel, primary, band)
    if (type === TYPE_ONE_BIT) {
      values[band] = reader.read(1)
    } else if (type === TYPE_VALUE) {
      if (mode === MODE_FIXED) {
        values[band] = reader.read(CODE_TABLE_FIXED_WIDTHS[fixIndex])
      } else if (mode === MODE_DIRECT) {
        values[band] = readCanonicalSymbol(tables.direct, reader)
      } else if (mode === MODE_DIFF) {
        if (band === 0) {
          values[band] = readCanonicalSymbol(tables.direct, reader)
          previous = values[band]
        } else {
          const symbol = readCanonicalSymbol(tables.diff, reader)
          values[band] = applyMaskedDelta(symbol, previous, tables.diff)
          previous = values[band]
        }
      } else {
        const symbol = readCanonicalSymbol(tables.pair, reader)
        values[band] = applyMaskedDelta(
          symbol,
          primary.codeTables[band],
          tables.pair
        )
      }
    }
  }
}

/**
 * Decode the gain selector and every channel's code-table section.
 *
 * @param {ChannelSyntaxState[]} channels Detached coding-unit channel syntax rows.
 * @param {SharedState} shared Shared coding-unit syntax.
 * @param {BitReader} reader Source bit reader.
 * @returns {number} Decoded fixed-width/codebook family selector.
 */
export function unpackCodeTableSection(channels, shared, reader) {
  validateRequest(channels, shared, reader)
  const maximum = shared.scaleFactorCount
  if (maximum === 0) {
    shared.gainModeFlag = 0
    for (const channel of channels) {
      channel.codeTables.fill(0)
      channel.codeTableContext = 0
    }
    return 0
  }

  const fixIndex = reader.read(1)
  shared.gainModeFlag = fixIndex
  const maximumValue = fixIndex === 0 ? 4 : 8
  for (let ordinal = 0; ordinal < channels.length; ordinal++) {
    const channel = channels[ordinal]
    const primary = ordinal === 0 ? null : channels[0]
    channel.codeTableContext = reader.read(1)
    const mode = reader.read(2)
    decodeChannel(channel, primary, mode, maximum, fixIndex, reader)
    for (let band = 0; band < maximum; band++) {
      if (channel.codeTables[band] >= maximumValue) {
        throw new CodeTableDecodeError('value exceeds table range', {
          ordinal,
          band,
          value: channel.codeTables[band],
          maximumValue,
        })
      }
    }
  }
  return fixIndex
}
