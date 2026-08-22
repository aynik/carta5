/** ATRAC3plus construction-selected coding-unit allocation. */

import { initializeAllocation } from './initial.js'
import { refineSpectralNoiseLevels } from './noise.js'
import { usesSinglePostScaleFactorFill } from './policy.js'
import { reduceCommittedAllocationToBudget } from './refine.js'
import { fillBudget } from './residual.js'
import { refineScaleFactors } from './scales.js'
import { searchAllocation } from './search.js'
import { prepareAllocationSource } from './source.js'
import { quantizeTrial } from '../quantization/symbols.js'

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
  fillBudget(transaction, shared, bitrateKbps >= 256)
  quantizeTrial(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  refineScaleFactors(transaction, shared, transaction.reconstructionRefinement)
  reduce(transaction, shared)
  fillBudget(transaction, shared, bitrateKbps >= 256)
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
  fillBudget(transaction, shared, bitrateKbps >= 256)
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
  fillBudget(transaction, shared, bitrateKbps >= 256)
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
function solveFrame(allocators, transactions) {
  return (frame, reductionBits) => {
    for (const allocate of allocators) allocate(frame, reductionBits)
    frame.allocationTransactions = transactions
    return frame
  }
}

/**
 * Bind the configured coding-unit solvers for one stream.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame, number): EncoderFrame} Frame solver.
 */
export function solve(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const allocators = Array.from(
    { length: topology.codingUnitCount },
    (_unused, unit) => createUnitAllocator(context, unit)
  )
  const transactions =
    encoder.frame.allocationTransactionViews[topology.codingUnitCount]
  return solveFrame(allocators, transactions)
}
