/** Initial ATRAC3plus allocation materialization. */

import {
  QUANTIZATION_UNIT_OFFSETS,
  SCALE_FACTOR_VALUES,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  NORMALIZATION_CLAMP_HIGH,
  NORMALIZATION_CLAMP_LOW,
  SPECTRUM_FORBIDDEN_BITS,
} from '../core/constants.js'
import { priceSpectrumBand } from './spectrum-pricing.js'
import { measureInvariantAllocationBits } from '../io/allocation-syntax.js'
import { planCodeTableSection } from '../io/code-table-syntax.js'
import { selectGainSyntax } from '../io/gain-syntax.js'
import { planScaleFactorSection } from '../io/scale-factor-syntax.js'
import { planToneSection } from '../io/tone-syntax.js'
import { planRawWordLengthSection } from '../io/word-length-syntax.js'
import { CodeTableAccountingTransaction } from '../state/code-table.js'
import { GainCodingPlan } from '../state/gain.js'
import { ScaleFactorCodingPlan } from '../state/scale-factor.js'
import { ToneCodingPlan, ToneSwapGate } from '../state/tone.js'
import { WordLengthAccountingTransaction } from '../state/word-length.js'

/**
 * Copy and normalize all spectral bands into transaction-owned storage.
 *
 * @param {Float32Array} source Gain-scaled source spectrum.
 * @param {Int32Array} scaleFactorIndices Per-band scale factors.
 * @param {Float32Array} destination Normalized spectrum output.
 * @param {number} bandCount Active quantization-band count.
 * @returns {Float32Array} The destination spectrum.
 */
export function normalizeAllocationSpectrum(
  source,
  scaleFactorIndices,
  destination,
  bandCount
) {
  const coefficientCount = QUANTIZATION_UNIT_OFFSETS[bandCount]
  if (
    !(source instanceof Float32Array) ||
    coefficientCount === undefined ||
    source.length < coefficientCount ||
    !(scaleFactorIndices instanceof Int32Array) ||
    scaleFactorIndices.length < bandCount ||
    !(destination instanceof Float32Array) ||
    destination.length < coefficientCount
  ) {
    throw new RangeError('ATRAC3plus spectrum normalization is invalid')
  }
  for (let band = 0; band < bandCount; band++) {
    const scaleFactorIndex = scaleFactorIndices[band]
    if (
      scaleFactorIndex < 0 ||
      scaleFactorIndex >= SCALE_FACTOR_VALUES.length
    ) {
      throw new RangeError('ATRAC3plus normalization scale factor is invalid')
    }
    const scale = Math.fround(1 / SCALE_FACTOR_VALUES[scaleFactorIndex])
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    for (let coefficient = start; coefficient < end; coefficient += 4) {
      destination[coefficient] = Math.fround(source[coefficient] * scale)
      destination[coefficient + 1] = Math.fround(
        source[coefficient + 1] * scale
      )
      destination[coefficient + 2] = Math.fround(
        source[coefficient + 2] * scale
      )
      destination[coefficient + 3] = Math.fround(
        source[coefficient + 3] * scale
      )
    }
    if (scaleFactorIndex > 0x3e) {
      for (let coefficient = start; coefficient < end; coefficient++) {
        destination[coefficient] = Math.max(
          NORMALIZATION_CLAMP_LOW,
          Math.min(NORMALIZATION_CLAMP_HIGH, destination[coefficient])
        )
      }
    }
  }
  return destination
}

/**
 * Verify that the coding-unit analysis sources and rollback snapshots are bound before constructing the first candidate.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function validateInitialAllocation(transaction, shared) {
  const bandCount = transaction.bandCount
  if (
    !shared ||
    transaction.channelCount < 1 ||
    transaction.channelCount > CODING_UNIT_MAX_CHANNELS ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT ||
    !(
      transaction.wordLengthTransaction instanceof
      WordLengthAccountingTransaction
    ) ||
    !(transaction.scaleFactorPlan instanceof ScaleFactorCodingPlan) ||
    !(
      transaction.codeTableTransaction instanceof CodeTableAccountingTransaction
    ) ||
    !(transaction.gainPlan instanceof GainCodingPlan) ||
    !(transaction.tonePlan instanceof ToneCodingPlan) ||
    !(transaction.toneSwapGate instanceof ToneSwapGate) ||
    !Number.isInteger(transaction.coreMode)
  ) {
    throw new RangeError('ATRAC3plus initial allocation geometry is invalid')
  }
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    if (
      !transaction.channelBlocks[channel]?.syntax ||
      !transaction.gainScaledSpectra[channel] ||
      !transaction.spectrumPricingStates[channel] ||
      !transaction.spectrumPricedBands[channel]
    ) {
      throw new RangeError('ATRAC3plus initial allocation binding is invalid')
    }
    for (let band = 0; band < bandCount; band++) {
      const mode =
        transaction.initialWordLengths[channel * QUANTIZATION_UNIT_COUNT + band]
      const threshold =
        transaction.sourceChannels[channel].quantizationThresholdScales[band]
      if (
        mode < 0 ||
        mode > 7 ||
        !Number.isFinite(threshold) ||
        threshold < 0
      ) {
        throw new RangeError('ATRAC3plus initial allocation input is invalid')
      }
    }
  }
}

/**
 * Normalize all measured spectra once before candidate mutation begins.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 */
function prepareCandidateSpectra(transaction) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    normalizeAllocationSpectrum(
      transaction.gainScaledSpectra[channel],
      transaction.channelBlocks[channel].syntax.scaleFactors,
      transaction.normalizedSpectra[channel],
      transaction.bandCount
    )
  }
}

/**
 * Establish the sidechain defaults required by a newly materialized candidate.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function initializeCandidateSidechains(transaction, shared) {
  shared.muteFlag = 0
  shared.noisePresent = 0
  shared.noiseLevelIndex = 0
  shared.noiseTableIndex = 0
  shared.gainModeFlag = 1
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    transaction.channelBlocks[channel].syntax.codeTableContext = 0
  }
}

/**
 * Materialize the prepared seed into syntax and publish its active geometry.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState} shared
 */
function commitCandidateSeed(transaction, shared) {
  const { channelBlocks, channelCount, bandCount, initialWordLengths } =
    transaction
  let scaleFactorCount = 0
  for (let channel = 0; channel < channelCount; channel++) {
    const row = channel * QUANTIZATION_UNIT_COUNT
    for (let band = 0; band < bandCount; band++) {
      const mode = initialWordLengths[row + band]
      channelBlocks[channel].syntax.wordLengths[band] = mode
      if (mode !== 0) scaleFactorCount = Math.max(scaleFactorCount, band + 1)
    }
  }
  if (channelCount === 2) {
    for (let band = 0; band < bandCount; band++) {
      const primary = channelBlocks[0].syntax.wordLengths[band]
      const secondary = channelBlocks[1].syntax.wordLengths[band]
      if (primary === 0 || secondary === 0) {
        transaction.intensityStereoBandMask[band] = 0
      } else if (transaction.intensityStereoBandMask[band] === 1) {
        channelBlocks[1].syntax.wordLengths[band] = 0
      }
    }
  }
  shared.scaleFactorCount = scaleFactorCount
  shared.bandLimit = bandCount >= 29 ? QUANTIZATION_UNIT_COUNT : bandCount
}

/**
 * Price every active band in the provisional context-zero candidate.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 */
function priceCandidateContextZero(transaction) {
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const pricing = transaction.spectrumPricingStates[channel]
    const priced = transaction.spectrumPricedBands[channel]
    const thresholds =
      transaction.sourceChannels[channel].quantizationThresholdScales
    let sum = 0
    for (let band = 0; band < transaction.bandCount; band++) {
      const mode = transaction.channelBlocks[channel].syntax.wordLengths[band]
      if (mode < 1) continue
      priceSpectrumBand(
        pricing,
        transaction.normalizedSpectra[channel],
        thresholds,
        0,
        band,
        mode,
        0,
        priced
      )
      sum += pricing.commit(priced, 0)
    }
    transaction.spectrumBits[channel][0] = sum
    transaction.spectrumBits[channel][1] = SPECTRUM_FORBIDDEN_BITS
  }
}

/**
 * Select every initial sidechain and publish its exact aggregate accounting.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @returns {number} Exact initial allocation width.
 */
function planInitialSidechains(transaction, shared) {
  const scaleFactorCount = shared.scaleFactorCount
  planRawWordLengthSection(
    transaction.channelBlocks,
    shared.bandLimit,
    transaction.wordLengthTransaction
  )
  if (scaleFactorCount > 0) {
    planScaleFactorSection(
      transaction.channelBlocks,
      shared,
      transaction.scaleFactorPlan
    )
  } else {
    transaction.scaleFactorPlan.clear(transaction.channelCount)
  }
  planCodeTableSection(
    transaction.channelBlocks,
    shared,
    false,
    transaction.codeTableTransaction
  )
  selectGainSyntax(
    transaction.channelBlocks,
    shared.codedSubbandCount,
    transaction.coreMode,
    transaction.gainPlan
  )
  planToneSection(
    transaction.channelBlocks,
    transaction.toneSwapGate,
    transaction.tonePlan
  )
  transaction.fixedBits = measureInvariantAllocationBits(
    shared,
    transaction.channelCount,
    transaction.gainPlan.bits,
    transaction.tonePlan.totalBits
  )
  transaction.wordLengthBits = transaction.wordLengthTransaction.bits
  transaction.scaleFactorBits =
    scaleFactorCount > 0 ? transaction.scaleFactorPlan.bits : 0
  transaction.codeTableBits = transaction.codeTableTransaction.bits
  return transaction.recomputeBits()
}

/**
 * Materialize the prepared seed, initial spectrum prices, and exact sidechains as one complete allocation image.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active transaction.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @returns {number} Exact initial allocation width.
 */
export function initializeAllocation(transaction, shared) {
  validateInitialAllocation(transaction, shared)
  prepareCandidateSpectra(transaction)
  initializeCandidateSidechains(transaction, shared)
  commitCandidateSeed(transaction, shared)
  priceCandidateContextZero(transaction)
  return planInitialSidechains(transaction, shared)
}
