/** Exact ATRAC3plus coding-unit sidechain finalization and immutable emission. */

import { packGainSection } from '../gain/writer.js'
import { GainCodingPlan } from '../../state/gain.js'
import { packWordLengthSection } from '../word-length/writer.js'
import { WordLengthAccountingTransaction } from '../../state/word-length.js'
import { packScaleFactorSection } from '../scale-factor/writer.js'
import { ScaleFactorCodingPlan } from '../../state/scale-factor.js'
import { packCodeTableSection } from '../code-table/writer.js'
import { CodeTableAccountingTransaction } from '../../state/code-table.js'
import { packChannelSpectrum } from '../spectrum/coding.js'
import { SpectrumSyntaxScratch } from '../../state/spectrum.js'
import { packToneSection } from '../tone/writer.js'
import { ToneCodingPlan } from '../../state/tone.js'
import { BlockHeaderSyntax, NoiseSyntax, PresenceSyntax } from '../records.js'

/**
 * Verify that every planned sidechain and accounting owner is bound to a valid mono or stereo transaction.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function validateTransaction(transaction, shared) {
  if (
    !shared ||
    !Number.isInteger(transaction?.channelCount) ||
    transaction.channelCount < 1 ||
    transaction.channelCount > 2 ||
    !(
      transaction.wordLengthTransaction instanceof
      WordLengthAccountingTransaction
    ) ||
    !(transaction.scaleFactorPlan instanceof ScaleFactorCodingPlan) ||
    !(
      transaction.codeTableTransaction instanceof CodeTableAccountingTransaction
    ) ||
    !(transaction.gainPlan instanceof GainCodingPlan) ||
    !(transaction.tonePlan instanceof ToneCodingPlan)
  ) {
    throw new RangeError('ATRAC3plus coding-unit transaction is not packable')
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    if (!transaction.channelBlocks[channel]?.syntax) {
      throw new RangeError('ATRAC3plus coding-unit channel is missing')
    }
  }
}

/**
 * Emit both shared stereo presence planes in their required reverse header order.
 *
 * @param {SharedState} shared
 * @param {BitWriter|BitCounter} sink
 */
function packStereoPresence(shared, sink) {
  for (const index of [1, 0]) {
    new PresenceSyntax(
      shared.presenceEnabled[index],
      shared.presenceMixed[index],
      shared.presenceFlags[index]
    ).pack(shared.mapCount, sink)
  }
}

/**
 * Traverse one selected coding unit using explicit coefficient rows.
 *
 * @param {CodingUnitAllocationTransaction} transaction Selected transaction.
 * @param {Int16Array[]} spectra Final or trial coefficient rows.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {SpectrumSyntaxScratch} scratch Reusable spectrum syntax work.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {number} Exact written bit length.
 */
function writeCodingUnit(transaction, spectra, shared, scratch, sink) {
  validateTransaction(transaction, shared)
  if (
    !Array.isArray(spectra) ||
    spectra.length < transaction.channelCount ||
    !(scratch instanceof SpectrumSyntaxScratch) ||
    typeof sink?.write !== 'function' ||
    !Number.isInteger(sink.bitPosition)
  ) {
    throw new TypeError('ATRAC3plus coding-unit pack sink is invalid')
  }
  const start = sink.bitPosition
  new BlockHeaderSyntax(shared.bandLimit, shared.muteFlag).pack(sink)
  packWordLengthSection(
    transaction.channelBlocks,
    transaction.wordLengthTransaction,
    sink
  )
  if (shared.scaleFactorCount > 0) {
    packScaleFactorSection(
      transaction.channelBlocks,
      shared.scaleFactorCount,
      sink
    )
    packCodeTableSection(
      transaction.channelBlocks,
      transaction.codeTableTransaction,
      sink
    )
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    packChannelSpectrum(
      transaction.channelBlocks[channel],
      spectra[channel],
      shared,
      scratch,
      sink
    )
  }
  if (transaction.channelCount === 2) packStereoPresence(shared, sink)
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    sink.write(0, 1)
  }
  packGainSection(transaction.gainPlan, sink)
  packToneSection(transaction.channelBlocks, transaction.tonePlan, sink)
  new NoiseSyntax(
    shared.noisePresent,
    shared.noiseLevelIndex,
    shared.noiseTableIndex
  ).pack(sink)
  return sink.bitPosition - start
}

/**
 * Measure one coding unit with allocation-local trial symbols.
 *
 * @param {CodingUnitAllocationTransaction} transaction Selected transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {SpectrumSyntaxScratch} scratch Reusable spectrum syntax work.
 * @param {BitCounter} sink Counting sink.
 * @returns {number} Exact measured bit length.
 */
export function measureCodingUnit(transaction, shared, scratch, sink) {
  return writeCodingUnit(
    transaction,
    transaction.trialSpectra,
    shared,
    scratch,
    sink
  )
}

/**
 * Pack one coding unit with retained coefficient symbols.
 *
 * @param {CodingUnitAllocationTransaction} transaction Selected transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {SpectrumSyntaxScratch} scratch Reusable spectrum syntax work.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {number} Exact written bit length.
 */
export function packCodingUnit(transaction, shared, scratch, sink) {
  return writeCodingUnit(
    transaction,
    transaction.symbols,
    shared,
    scratch,
    sink
  )
}
