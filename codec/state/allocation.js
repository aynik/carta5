/** Fixed ownership and ledgers for one ATRAC3plus allocation transaction. */

import {
  CODING_UNIT_MAX_CHANNELS,
  FRAME_SAMPLES,
  QUANTIZATION_UNIT_COUNT,
} from '../core/constants.js'
import { AllocationBandOrder } from '../coding/allocation-order.js'
import { ReconstructionRefinementScratch } from '../coding/reconstruction-noise.js'
import { PricedSpectrumBand, SpectrumPricingState } from './spectrum-pricing.js'

/**
 * Candidate-invariant measurement and policy rows for one channel.
 */
export class AllocationSourceChannel {
  /**
   * Allocate the fixed per-band rows used throughout allocation for one channel.
   */
  constructor() {
    this.quantizationThresholdScales = new Float32Array(QUANTIZATION_UNIT_COUNT)
    this.bandLevels = new Float32Array(QUANTIZATION_UNIT_COUNT)
    this.maximumQuantizationModes = new Int16Array(QUANTIZATION_UNIT_COUNT)
    this.bitAllocationMode = 0
  }
}

/**
 * Reusable scratch for the one coding unit being allocated synchronously.
 */
export class CodingUnitAllocationWorkspace {
  /**
   * Allocate every source-dependent row, cache, and refinement workspace once.
   */
  constructor() {
    this.quantizationOffsets = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Int32Array(QUANTIZATION_UNIT_COUNT)
    )
    this.sourceChannels = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new AllocationSourceChannel()
    )
    this.baseAllocationScores = new Float32Array(
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT
    )
    this.initialWordLengths = new Int32Array(
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT
    )
    this.quantizationUnits = new Int32Array(
      CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT
    )
    this.allocationBandOrder = new AllocationBandOrder()
    this.reconstructionRefinement = new ReconstructionRefinementScratch()
    this.normalizedSpectra = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Float32Array(FRAME_SAMPLES)
    )
    this.checkpointWordLengths = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Int32Array(QUANTIZATION_UNIT_COUNT)
    )
    this.checkpointSpectrumBits = new Int32Array(CODING_UNIT_MAX_CHANNELS)
    this.spectrumPricingStates = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new SpectrumPricingState()
    )
    this.spectrumPricedBands = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new PricedSpectrumBand()
    )
  }
}

/**
 * Complete stable identity root for one coding-unit allocation transaction.
 */
export class CodingUnitAllocationTransaction {
  /**
   * Bind detached source, candidate, syntax, and accounting state for one coding-unit allocation.
   */
  constructor(workspace = new CodingUnitAllocationWorkspace()) {
    if (!(workspace instanceof CodingUnitAllocationWorkspace)) {
      throw new TypeError('ATRAC3plus allocation workspace is invalid')
    }
    this.intensityStereoBandMask = new Uint16Array(QUANTIZATION_UNIT_COUNT)
    this.spectrumBits = Array.from(
      { length: CODING_UNIT_MAX_CHANNELS },
      () => new Int32Array(2)
    )
    this.quantizationOffsets = workspace.quantizationOffsets
    this.sourceChannels = workspace.sourceChannels
    this.baseAllocationScores = workspace.baseAllocationScores
    this.initialWordLengths = workspace.initialWordLengths
    this.quantizationUnits = workspace.quantizationUnits
    this.allocationBandOrder = workspace.allocationBandOrder
    this.reconstructionRefinement = workspace.reconstructionRefinement
    this.normalizedSpectra = workspace.normalizedSpectra
    this.checkpointWordLengths = workspace.checkpointWordLengths
    this.checkpointSpectrumBits = workspace.checkpointSpectrumBits
    this.channelBlocks = new Array(CODING_UNIT_MAX_CHANNELS)
    this.gainScaledSpectra = new Array(CODING_UNIT_MAX_CHANNELS)
    this.gainUnscaledSpectra = new Array(CODING_UNIT_MAX_CHANNELS)
    this.spectrumPricingStates = workspace.spectrumPricingStates
    this.spectrumPricedBands = workspace.spectrumPricedBands
    this.wordLengthTransaction = null
    this.scaleFactorPlan = null
    this.codeTableTransaction = null
    this.gainPlan = null
    this.tonePlan = null
    this.toneSwapGate = null
    this.reset(0)
  }

  /**
   * Reset live allocation state and bindings without clearing producer-owned scratch that the next stage overwrites.
   *
   * @param {number} channelCount
   * @returns {CodingUnitAllocationTransaction}
   */
  reset(channelCount) {
    if (
      !Number.isInteger(channelCount) ||
      channelCount < 0 ||
      channelCount > CODING_UNIT_MAX_CHANNELS
    ) {
      throw new RangeError('ATRAC3plus allocation channel count is invalid')
    }
    this.channelCount = channelCount
    this.intensityStereoBandMask.fill(0)
    this.cbIterationLimit = 0
    this.cbStartBand = 0
    this.fixedBits = 0
    this.wordLengthBits = 0
    this.scaleFactorBits = 0
    this.codeTableBits = 0
    this.bitsTotal = 0
    for (const bits of this.spectrumBits) bits.fill(0)
    for (const offsets of this.quantizationOffsets) offsets.fill(0)
    this.codeTableCostAvailable = false
    this.quantizationDirty = true
    this.secondPassFrontiers = 0
    this.channelBlocks.length = channelCount
    this.channelBlocks.fill(null)
    this.gainScaledSpectra.fill(null)
    this.gainUnscaledSpectra.fill(null)
    this.toneSwapGate = null
    this.coreMode = 0
    this.bandCount = 0
    this.sampleRateHz = 0
    this.allocationBudgetBits = 0
    this.boundChannelCount = 0
    this.bindingComplete = false
    return this
  }

  /**
   * Sum invariant and mutable sidechain costs without spectrum payloads.
   *
   * @returns {number}
   */
  get sidechainBits() {
    return (
      this.fixedBits +
      this.wordLengthBits +
      this.scaleFactorBits +
      this.codeTableBits
    )
  }

  /**
   * Replace the retained word-length section cost and update the allocation total by its delta.
   *
   * @param {number} bits
   */
  replaceWordLengthBits(bits) {
    this.bitsTotal += bits - this.wordLengthBits
    this.wordLengthBits = bits
  }

  /**
   * Replace the retained scale-factor section cost and update the allocation total by its delta.
   *
   * @param {number} bits
   */
  replaceScaleFactorBits(bits) {
    this.bitsTotal += bits - this.scaleFactorBits
    this.scaleFactorBits = bits
  }

  /**
   * Replace the retained code-table section cost and update the allocation total by its delta.
   *
   * @param {number} bits
   */
  replaceCodeTableBits(bits) {
    this.bitsTotal += bits - this.codeTableBits
    this.codeTableBits = bits
  }

  /**
   * Recompute exact aggregate bits from retained sidechains and selected spectrum contexts.
   *
   * @returns {number} Recomputed allocation width.
   */
  recomputeBits() {
    let total = this.sidechainBits
    for (let channel = 0; channel < this.channelCount; channel++) {
      const context = this.channelBlocks[channel].syntax.codeTableContext & 1
      total += this.spectrumBits[channel][context]
    }
    this.bitsTotal = total
    return total
  }

  /**
   * Bind the stable plan owners associated with this pooled coding unit.
   * These owners survive reset() and every retry of the same frame storage.
   *
   * @param {object} wordLengthTransaction Word-length accounting owner.
   * @param {object} scaleFactorPlan Scale-factor syntax plan.
   * @param {object} codeTableTransaction Code-table accounting owner.
   * @param {object} gainPlan Gain syntax plan.
   * @param {object} tonePlan Tone syntax plan.
   * @returns {CodingUnitAllocationTransaction} This transaction.
   */
  bindPlans(
    wordLengthTransaction,
    scaleFactorPlan,
    codeTableTransaction,
    gainPlan,
    tonePlan
  ) {
    if (
      !wordLengthTransaction ||
      !scaleFactorPlan ||
      !codeTableTransaction ||
      !gainPlan ||
      !tonePlan
    ) {
      throw new RangeError('ATRAC3plus allocation plan binding is invalid')
    }
    this.wordLengthTransaction = wordLengthTransaction
    this.scaleFactorPlan = scaleFactorPlan
    this.codeTableTransaction = codeTableTransaction
    this.gainPlan = gainPlan
    this.tonePlan = tonePlan
    return this
  }

  /**
   * Begin one allocation attempt using the stable plans and a fresh tone gate.
   * Channel-local resources must subsequently be supplied with bindChannel().
   *
   * @param {number} channelCount Active coding-unit channels.
   * @param {number} coreMode Profile core-mode selector.
   * @param {number} allocationBudgetBits Retry-adjusted coding-unit budget.
   * @param {object} toneSwapGate Per-frame tone swap gate.
   * @returns {CodingUnitAllocationTransaction} This reset and partially bound transaction.
   */
  beginAttempt(channelCount, coreMode, allocationBudgetBits, toneSwapGate) {
    if (
      !Number.isInteger(coreMode) ||
      coreMode < 0 ||
      coreMode >= 32 ||
      !Number.isInteger(allocationBudgetBits) ||
      allocationBudgetBits < 1 ||
      !this.wordLengthTransaction ||
      !this.scaleFactorPlan ||
      !this.codeTableTransaction ||
      !this.gainPlan ||
      !this.tonePlan ||
      !toneSwapGate
    ) {
      throw new RangeError('ATRAC3plus allocation attempt binding is invalid')
    }
    this.reset(channelCount)
    this.coreMode = coreMode
    this.allocationBudgetBits = allocationBudgetBits
    this.toneSwapGate = toneSwapGate
    return this
  }

  /**
   * Bind every resource belonging to one coding-unit-local channel as a unit.
   *
   * @param {number} ordinal Coding-unit-local channel ordinal.
   * @param {object} block Detached channel state.
   * @param {Float32Array} gainScaledSpectrum Gain-scaled MDCT spectrum.
   * @param {Float32Array} gainUnscaledSpectrum Gain-unscaled MDCT spectrum.
   * @returns {CodingUnitAllocationTransaction} This transaction.
   */
  bindChannel(ordinal, block, gainScaledSpectrum, gainUnscaledSpectrum) {
    const normalizedSpectrum = this.normalizedSpectra[ordinal]
    const spectrumPricingState = this.spectrumPricingStates[ordinal]
    const spectrumPricedBand = this.spectrumPricedBands[ordinal]
    if (
      this.bindingComplete ||
      ordinal !== this.boundChannelCount ||
      ordinal < 0 ||
      ordinal >= this.channelCount ||
      !block?.syntax ||
      !block.currentScaleHistory ||
      !block.previousScaleHistory ||
      !(gainScaledSpectrum instanceof Float32Array) ||
      gainScaledSpectrum.length < FRAME_SAMPLES ||
      !(gainUnscaledSpectrum instanceof Float32Array) ||
      gainUnscaledSpectrum.length < FRAME_SAMPLES ||
      !(normalizedSpectrum instanceof Float32Array) ||
      normalizedSpectrum.length < FRAME_SAMPLES ||
      typeof spectrumPricingState?.reset !== 'function' ||
      !spectrumPricedBand
    ) {
      throw new RangeError('ATRAC3plus allocation channel binding is invalid')
    }
    spectrumPricingState.reset()
    this.channelBlocks[ordinal] = block
    this.gainScaledSpectra[ordinal] = gainScaledSpectrum
    this.gainUnscaledSpectra[ordinal] = gainUnscaledSpectrum
    this.boundChannelCount++
    return this
  }

  /**
   * Seal a complete attempt binding before allocation measurement begins.
   *
   * @returns {CodingUnitAllocationTransaction} This completely bound transaction.
   */
  completeBinding() {
    if (
      this.bindingComplete ||
      this.channelCount < 1 ||
      this.boundChannelCount !== this.channelCount
    ) {
      throw new RangeError('ATRAC3plus allocation binding is incomplete')
    }
    this.bindingComplete = true
    return this
  }
}
