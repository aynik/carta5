/** ATRAC3plus spectral code-table pricing, transactions, and emission. */

import { writeCanonicalSymbol } from '../coding/entropy.js'
import {
  codeTableBandType,
  maskedCodeTableDelta,
} from '../coding/code-table.js'
import {
  CODE_TABLE_FIXED_WIDTHS,
  CODE_TABLE_CODEBOOKS,
} from '../core/tables.js'
import {
  CODE_TABLE_CONTEXT_BITS,
  CODE_TABLE_COUNT_FLAG_BITS,
  CODE_TABLE_EXPLICIT_COUNT_BITS,
  CODE_TABLE_GAIN_MODE_BITS,
  CODE_TABLE_MODE_BITS,
  CHANNEL_HEADER_BITS,
  QUANTIZATION_UNIT_COUNT,
  CODE_TABLE_MODE_DIFF,
  CODE_TABLE_MODE_DIRECT,
  CODE_TABLE_MODE_FIXED,
  CODE_TABLE_MODE_PAIR,
  CODE_TABLE_TYPE_ONE_BIT,
  CODE_TABLE_TYPE_VALUE,
} from '../core/constants.js'
import {
  CodeTableAccountingTransaction,
  validateCodeTableChannels,
} from '../state/code-table.js'

/**
 * Capture one channel's values, classify its active bands, and initialize its exact cost state.
 *
 * @param {EncodeChannelState[]} blocks
 * @param {number} channel
 * @param {CodeTableAccountingTransaction} transaction
 */
function initializeChannelCostState(blocks, channel, transaction) {
  let valueMask = 0
  let oneBitMask = 0
  const current = blocks[channel].syntax.wordLengths
  const primary = blocks[0].syntax.wordLengths
  for (let band = 0; band < transaction.maxCount; band++) {
    const bit = (2 ** band) >>> 0
    if (current[band] > 0) valueMask = (valueMask | bit) >>> 0
    else if (channel !== 0 && primary[band] > 0) {
      oneBitMask = (oneBitMask | bit) >>> 0
    }
  }
  const values = blocks[channel].syntax.codeTables
  transaction.values[channel] = values
  transaction.states[channel].initialize(
    valueMask,
    oneBitMask,
    values,
    channel === 0 ? null : transaction.values[0],
    transaction.maxCount,
    channel,
    transaction.fixIndex,
    transaction.entropyModes
  )
}

/**
 * Validate the shared coded-band count and gain-mode flag used by code-table syntax planning.
 *
 * @param {SharedState} shared
 */
function validateShared(shared) {
  if (
    !shared ||
    !Number.isInteger(shared.scaleFactorCount) ||
    shared.scaleFactorCount < 0 ||
    shared.scaleFactorCount > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(shared.gainModeFlag) ||
    shared.gainModeFlag < 0 ||
    shared.gainModeFlag > 1
  ) {
    throw new RangeError('ATRAC3plus code-table shared geometry is invalid')
  }
}

/**
 * Choose the lowest-cost legal code-table syntax independently for every channel.
 *
 * @param {CodeTableAccountingTransaction} transaction
 * @returns {number} Exact section width.
 */
function selectAllSyntaxes(transaction) {
  let bits =
    CODE_TABLE_GAIN_MODE_BITS + transaction.channelCount * CHANNEL_HEADER_BITS
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    transaction.states[channel].selectSyntax(transaction.syntaxes[channel])
    bits += transaction.syntaxes[channel].bits
  }
  return bits
}

/**
 * Re-select only syntax affected by the prepared edit and replace its modeled cost.
 *
 * @param {CodeTableAccountingTransaction} transaction
 * @returns {number} Exact candidate section width.
 */
function selectCandidateSyntaxes(transaction) {
  const first =
    transaction.candidateChannel === 0 ? 0 : transaction.candidateChannel
  const last =
    transaction.candidateChannel === 0 ? transaction.channelCount : first + 1
  let bits = transaction.modeledBits
  for (let channel = first; channel < last; channel++) {
    transaction.candidateStates[channel].selectSyntax(
      transaction.candidateSyntaxes[channel]
    )
    bits +=
      transaction.candidateSyntaxes[channel].bits -
      transaction.syntaxes[channel].bits
  }
  return bits
}

/**
 * Fully initialize exact code-table plans without publishing channel state.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {SharedState} shared Shared coding-unit syntax state.
 * @param {boolean} entropyModes Whether entropy modes may be selected.
 * @param {CodeTableAccountingTransaction} destination Reusable transaction.
 * @returns {CodeTableAccountingTransaction} Initialized transaction.
 */
export function planCodeTableSection(
  blocks,
  shared,
  entropyModes,
  destination
) {
  validateCodeTableChannels(blocks)
  validateShared(shared)
  if (!(destination instanceof CodeTableAccountingTransaction)) {
    throw new TypeError('ATRAC3plus code-table planning requires fixed storage')
  }
  const transaction = destination.clear(blocks.length)
  transaction.maxCount = shared.scaleFactorCount
  transaction.fixIndex = shared.gainModeFlag
  transaction.entropyModes = Boolean(entropyModes)
  const enabled = transaction.maxCount > 0
  if (enabled) {
    for (let channel = 0; channel < blocks.length; channel++) {
      initializeChannelCostState(blocks, channel, transaction)
    }
    transaction.modeledBits = selectAllSyntaxes(transaction)
  }
  transaction.initialized = true
  transaction.accountedBits = transaction.modeledBits
  return transaction
}

/**
 * Price one base-index edit into a discardable transaction image.
 *
 * @param {number} changedChannel Coding-unit channel ordinal.
 * @param {number} changedBand Changed quantization band.
 * @param {number} oldValue Incumbent table value.
 * @param {number} newValue Candidate table value.
 * @param {CodeTableAccountingTransaction} transaction Initialized transaction.
 * @returns {number} Exact discardable candidate width.
 */
export function repriceCodeTableSection(
  changedChannel,
  changedBand,
  oldValue,
  newValue,
  transaction
) {
  if (
    !(transaction instanceof CodeTableAccountingTransaction) ||
    !transaction.initialized ||
    !Number.isInteger(changedChannel) ||
    changedChannel < 0 ||
    changedChannel >= transaction.channelCount ||
    !Number.isInteger(changedBand) ||
    changedBand < 0 ||
    changedBand >= transaction.maxCount ||
    !Number.isInteger(oldValue) ||
    !Number.isInteger(newValue) ||
    transaction.values[changedChannel][changedBand] !== oldValue
  ) {
    throw new RangeError('ATRAC3plus incremental code-table request is invalid')
  }
  transaction.prepareCandidate(changedChannel, changedBand, newValue)
  const values = transaction.values[changedChannel]
  const reference = changedChannel === 0 ? null : transaction.values[0]
  transaction.candidateStates[changedChannel].changeValue(
    values,
    reference,
    changedBand,
    oldValue,
    newValue
  )
  if (changedChannel === 0) {
    for (let channel = 1; channel < transaction.channelCount; channel++) {
      transaction.candidateStates[channel].changeReference(
        transaction.values[channel],
        changedBand,
        oldValue,
        newValue
      )
    }
  }
  transaction.candidateBits = selectCandidateSyntaxes(transaction)
  return transaction.candidateBits
}

/**
 * Emit one code-table symbol and reject values absent from the selected canonical codebook.
 *
 * @param {ArrayLike<number>} codebook
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function writeCanonical(codebook, symbol, sink) {
  if (!writeCanonicalSymbol(codebook, symbol, sink)) {
    throw new RangeError('ATRAC3plus code-table symbol is not packable')
  }
}

/**
 * Emit the implicit-full or explicit code-table band count and return the effective count.
 *
 * @param {CodeTableCodingSyntax} syntax
 * @param {number} maxCount
 * @param {BitWriter|BitCounter} sink
 * @returns {number}
 */
function packCountHeader(syntax, maxCount, sink) {
  sink.write(syntax.explicit ? 1 : 0, CODE_TABLE_COUNT_FLAG_BITS)
  if (syntax.explicit) sink.write(syntax.count, CODE_TABLE_EXPLICIT_COUNT_BITS)
  return syntax.explicit ? syntax.count : maxCount
}

/**
 * Emit one channel's fixed, direct, differential, or primary-paired code-table sequence.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>|null} reference
 * @param {number} channel
 * @param {CodeTableCodingSyntax} syntax
 * @param {number} fixIndex
 * @param {number} maxCount
 * @param {BitWriter|BitCounter} sink
 */
function packChannel(
  values,
  reference,
  channel,
  syntax,
  fixIndex,
  maxCount,
  sink
) {
  sink.write(syntax.mode, CODE_TABLE_MODE_BITS)
  if (syntax.mode === CODE_TABLE_MODE_PAIR && channel === 0) return
  const count = packCountHeader(syntax, maxCount, sink)
  const tables = CODE_TABLE_CODEBOOKS[fixIndex]
  let previous = 0
  for (let band = 0; band < count; band++) {
    const type = codeTableBandType(syntax.valueMask, syntax.oneBitMask, band)
    const value = values[band]
    if (type === CODE_TABLE_TYPE_ONE_BIT) {
      sink.write(value, 1)
    } else if (type === CODE_TABLE_TYPE_VALUE) {
      switch (syntax.mode) {
        case CODE_TABLE_MODE_FIXED:
          sink.write(value, CODE_TABLE_FIXED_WIDTHS[fixIndex])
          break
        case CODE_TABLE_MODE_DIRECT:
          writeCanonical(tables.direct, value, sink)
          break
        case CODE_TABLE_MODE_DIFF:
          if (band === 0) writeCanonical(tables.direct, value, sink)
          else {
            writeCanonical(
              tables.diff,
              maskedCodeTableDelta(value, previous, tables.diff),
              sink
            )
          }
          break
        case CODE_TABLE_MODE_PAIR:
          writeCanonical(
            tables.pair,
            maskedCodeTableDelta(value, reference[band], tables.pair),
            sink
          )
          break
        default:
          throw new RangeError('ATRAC3plus code-table mode is invalid')
      }
      previous = value
    }
  }
}

/**
 * Emit the measured code-table plans for every channel and assert that serialization matches exact accounting.
 *
 * @param {EncodeChannelState[]} blocks
 * @param {CodeTableAccountingTransaction} transaction
 * @param {BitWriter|BitCounter} sink
 */
function packTransaction(blocks, transaction, sink) {
  validateCodeTableChannels(blocks)
  if (
    !(transaction instanceof CodeTableAccountingTransaction) ||
    !transaction.initialized ||
    transaction.channelCount !== blocks.length ||
    typeof sink?.write !== 'function'
  ) {
    throw new TypeError('ATRAC3plus code-table pack arguments are invalid')
  }
  if (transaction.maxCount === 0) return
  sink.write(transaction.fixIndex, CODE_TABLE_GAIN_MODE_BITS)
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    sink.write(blocks[channel].syntax.codeTableContext, CODE_TABLE_CONTEXT_BITS)
    packChannel(
      blocks[channel].syntax.codeTables,
      blocks[0].syntax.codeTables,
      channel,
      transaction.syntaxes[channel],
      transaction.fixIndex,
      transaction.maxCount,
      sink
    )
  }
}

/**
 * Emit the accepted code-table section in coding-unit wire order.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {CodeTableAccountingTransaction} transaction Accepted transaction.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packCodeTableSection(blocks, transaction, sink) {
  packTransaction(blocks, transaction, sink)
}
