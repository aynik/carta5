/** Coding-unit allocation, exact frame fitting, and bounded retry. */

import { prepareAllocationSource } from './allocation-seed.js'
import { usesSinglePostScaleFactorFill } from './allocation-policy.js'
import { fillRemainingBitBudget } from './budget-fill.js'
import { initializeAllocation } from './initial-allocation.js'
import { reduceCommittedAllocationToBudget } from './offset-refinement.js'
import { quantizeTrial } from './active-quantization.js'
import { refineScaleFactors } from './scale-factor-refinement.js'
import { searchAllocation } from './second-pass-allocation.js'
import { refineSpectralNoiseLevels } from './spectral-noise-refinement.js'
import {
  BUDGET_RETRY_LIMIT,
  BUDGET_RETRY_STEP_BITS,
} from '../core/constants.js'
import { FramePackError, measureFrame } from '../io/frame.js'

/**
 * Reduce an over-budget retained selection.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @param {SharedState} shared Detached shared syntax.
 */
function reduce(transaction, shared) {
  if (transaction.bitsTotal > transaction.allocationBudgetBits) {
    reduceCommittedAllocationToBudget(transaction, shared)
  }
}

/**
 * Refresh trial symbols after a retained decision changes.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 */
function refresh(transaction) {
  if (transaction.quantizationDirty) quantizeTrial(transaction)
}

/**
 * Solve a main coding unit with fills on both sides of refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @param {SharedState} shared Detached shared syntax.
 * @param {number} bitrateKbps Stream bitrate.
 */
function solveFull(transaction, shared, bitrateKbps) {
  initializeAllocation(transaction, shared)
  searchAllocation(transaction, shared)
  fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  quantizeTrial(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  refineScaleFactors(transaction, shared, transaction.reconstructionRefinement)
  reduce(transaction, shared)
  fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  reduce(transaction, shared)
  refresh(transaction)
}

/**
 * Solve a main coding unit with only its post-refinement fill.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @param {SharedState} shared Detached shared syntax.
 * @param {number} bitrateKbps Stream bitrate.
 */
function solveSingle(transaction, shared, bitrateKbps) {
  initializeAllocation(transaction, shared)
  searchAllocation(transaction, shared)
  quantizeTrial(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  refineScaleFactors(transaction, shared, transaction.reconstructionRefinement)
  reduce(transaction, shared)
  fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  reduce(transaction, shared)
  refresh(transaction)
}

/**
 * Solve an LFE coding unit with an initial fill.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @param {SharedState} shared Detached shared syntax.
 * @param {number} bitrateKbps Stream bitrate.
 */
function solveLfeFull(transaction, shared, bitrateKbps) {
  initializeAllocation(transaction, shared)
  searchAllocation(transaction, shared)
  fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  quantizeTrial(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  reduce(transaction, shared)
  // LFE retains both budget-reduction passes from the format application.
  reduce(transaction, shared)
  refresh(transaction)
}

/**
 * Solve an LFE coding unit without an initial fill.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation.
 * @param {SharedState} shared Detached shared syntax.
 */
function solveLfeSingle(transaction, shared) {
  initializeAllocation(transaction, shared)
  searchAllocation(transaction, shared)
  quantizeTrial(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  reduce(transaction, shared)
  // LFE retains both budget-reduction passes from the format application.
  reduce(transaction, shared)
  refresh(transaction)
}

/**
 * Select one stable coding-unit solver from configured policy.
 *
 * @param {number} channelMode Coding-unit channel mode.
 * @param {boolean} singleFill Whether allocation skips its initial fill.
 * @returns {function(CodingUnitAllocationTransaction, SharedState, number): void} Selected solver.
 */
function unitSolver(channelMode, singleFill) {
  if (channelMode === 4) return singleFill ? solveLfeSingle : solveLfeFull
  return singleFill ? solveSingle : solveFull
}

/**
 * Bind one stable topology unit to its construction-selected solver.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @param {number} unit Coding-unit index.
 * @returns {function(EncoderFrame, number): CodingUnitAllocationTransaction} Unit allocator.
 */
function createUnitAllocator(context, unit) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const channels = topology.codingUnitChannels[unit]
  const channelCount = channels.length
  const channelMode = topology.codingUnitProfiles.channelModes[unit]
  const coreMode = topology.codingUnitProfiles.coreModes[unit]
  const budgetBits = topology.codingUnitProfiles.budgetBits[unit]
  const bitrateKbps = context.profile.bitrateKbps
  const sampleRate = context.profile.sampleRate
  const singleFill = usesSinglePostScaleFactorFill(channelMode, bitrateKbps)
  const solve = unitSolver(channelMode, singleFill)

  return (frame, reductionBits) => {
    const budget = budgetBits - reductionBits
    if (budget < 1) {
      throw new RangeError('ATRAC3plus retry budget is exhausted')
    }
    const transaction = encoder.frame.allocationTransactions[unit].beginAttempt(
      channelCount,
      coreMode,
      budget,
      encoder.scratch.toneSwapGates[unit].beginFrame()
    )
    for (let ordinal = 0; ordinal < channelCount; ordinal++) {
      const channel = channels.at(ordinal)
      transaction.bindChannel(
        ordinal,
        frame.channelBlocks[channel],
        frame.gainScaledSpectra[channel],
        frame.gainUnscaledSpectra[channel]
      )
    }
    transaction.completeBinding()
    const shared =
      frame.sharedCodingUnits[transaction.channelBlocks[0].sharedIndex]
    prepareAllocationSource(
      transaction,
      shared.quantizationUnitCount,
      channelMode,
      sampleRate
    )
    solve(transaction, shared, bitrateKbps)
    return transaction
  }
}

/**
 * Apply every construction-bound unit allocator once.
 *
 * @param {Array<function(EncoderFrame, number): CodingUnitAllocationTransaction>} allocators Unit allocators.
 * @param {CodingUnitAllocationTransaction[]} transactions Active transaction view.
 * @returns {function(EncoderFrame, number): EncoderFrame} One allocation attempt.
 */
function allocationAttempt(allocators, transactions) {
  return (frame, reductionBits) => {
    for (const allocate of allocators) allocate(frame, reductionBits)
    frame.allocationTransactions = transactions
    return frame
  }
}

/**
 * Build exact frame measurement while preserving suppressed delay frames.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Frame measurement operation.
 */
function frameMeasurement(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const frameBytes = context.profile.bytesPerFrame
  return (frame) => {
    if (encoder.state.analysisToStreamDelay.remainingFrames !== 0) return frame
    measureFrame(
      frame.allocationTransactions,
      frame.sharedCodingUnits,
      topology.codingUnitCount,
      frameBytes,
      encoder.scratch.spectrumSyntax
    )
    return frame
  }
}

/**
 * Protect one allocation attempt and exact measurement with bounded retry.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @param {function(EncoderFrame, number): EncoderFrame} allocate One attempt.
 * @param {function(EncoderFrame): EncoderFrame} measure Exact measurement.
 * @returns {function(EncoderFrame): EncoderFrame} Retrying allocation protocol.
 */
function boundedRetry(context, allocate, measure) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const checkpoint = encoder.frame.allocationCheckpoint
  return (frame) => {
    checkpoint.capture(encoder.frame, topology)
    for (let attempt = 0; attempt < BUDGET_RETRY_LIMIT; attempt++) {
      if (attempt > 0) checkpoint.restore(encoder.frame, topology)
      try {
        allocate(frame, attempt * BUDGET_RETRY_STEP_BITS)
        measure(frame)
        frame.allocationAttempts = attempt + 1
        return frame
      } catch (error) {
        if (!(error instanceof FramePackError)) {
          checkpoint.restore(encoder.frame, topology)
          throw error
        }
      }
    }
    checkpoint.restore(encoder.frame, topology)
    throw new RangeError('ATRAC3plus frame packing retry limit was exhausted')
  }
}

/**
 * Create allocation and exact frame fitting for one configured stream.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation application.
 */
export function createAllocation(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const allocators = Array.from(
    { length: topology.codingUnitCount },
    (_, unit) => createUnitAllocator(context, unit)
  )
  const transactions =
    encoder.frame.allocationTransactionViews[topology.codingUnitCount]
  return boundedRetry(
    context,
    allocationAttempt(allocators, transactions),
    frameMeasurement(context)
  )
}
