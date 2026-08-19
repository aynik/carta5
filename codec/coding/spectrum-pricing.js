/** Allocation-owned ATRAC3plus spectral codebook pricing and memoization. */

import { groupSpectrumCoefficients } from './spectrum.js'
import { spectrumPricingPlan } from './spectrum-pricing-plan.js'
import { spectrumQuantizedKey } from '../state/spectrum-pricing.js'

import { quantizeSpectrumCoefficients } from './spectrum-quantization.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import {
  SPECTRUM_PRICING_BAND_COUNT,
  SPECTRUM_PRICING_CACHE_SLOTS,
  SPECTRUM_PRICING_CANDIDATE_COUNT,
  SPECTRUM_PRICING_EMPTY_KEY,
  SPECTRUM_PRICING_MODE_COUNT,
} from '../core/constants.js'
import { repriceCodeTableSection } from '../io/code-table-syntax.js'

/**
 * Map a context, band, and mode to its first pricing-cache entry.
 *
 * @param {number} context
 * @param {number} band
 * @param {number} mode
 * @returns {number}
 */
function firstCacheEntry(context, band, mode) {
  return (
    ((context * SPECTRUM_PRICING_BAND_COUNT + band) *
      SPECTRUM_PRICING_MODE_COUNT +
      mode -
      1) *
    SPECTRUM_PRICING_CACHE_SLOTS
  )
}

/**
 * Map a pricing-cache entry and code table to its flat cost cell.
 *
 * @param {number} entry
 * @returns {number}
 */
function cacheCostOffset(entry) {
  return entry * SPECTRUM_PRICING_CANDIDATE_COUNT
}

/**
 * Index the lowest-cost table by pricing context and quantization mode.
 *
 * @param {ArrayLike<number>} costs
 * @param {number} limit
 * @returns {number}
 */
function lowestCostIndex(costs, limit) {
  let selected = 0
  for (let index = 1; index < limit; index++) {
    if (costs[index] < costs[selected]) selected = index
  }
  return selected
}

/**
 * Interpret the low 16 bits of a cache key as a signed integer.
 *
 * @param {number} value
 * @returns {number}
 */
function signed16(value) {
  return (value << 16) >> 16
}

/**
 * Write absolute quantized magnitudes and count their sign-bit payloads.
 *
 * @param {SpectrumPricingState} state
 * @param {number} rowStart
 * @param {number} count
 * @returns {number}
 */
function prepareMagnitudeRow(state, rowStart, count) {
  let nonzero = 0
  for (let index = 0; index < count; index++) {
    const value = signed16(state.quantizedRows[rowStart + index])
    nonzero += Number(value !== 0)
    state.magnitudeCoefficients[index] = Math.abs(value)
  }
  return nonzero
}

/**
 * Measure one candidate's entropy cost over an already prepared symbol row.
 *
 * @param {ArrayLike<number>} data Prepared symbol storage.
 * @param {number} dataStart First prepared symbol.
 * @param {number} packedCount Number of prepared symbols to price.
 * @param {SpectrumDescriptor} descriptor Candidate entropy descriptor.
 * @param {boolean} masksSymbols Whether direct symbols require masking.
 * @param {number} symbolMask Direct-symbol mask.
 * @param {number} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @returns {number}
 */
function measurePreparedSpectrumCost(
  data,
  dataStart,
  packedCount,
  descriptor,
  masksSymbols,
  symbolMask,
  nonzeroCount
) {
  const chunk = Math.max(descriptor.zeroRunChunk, 1)
  let entropyBits = 0
  for (let chunkStart = 0; chunkStart < packedCount; chunkStart += chunk) {
    const chunkEnd = Math.min(chunkStart + chunk, packedCount)
    if (chunk > 1) {
      entropyBits++
      let anyNonzero = false
      let chunkBits = 0
      for (let index = chunkStart; index < chunkEnd; index++) {
        let symbol = data[dataStart + index]
        if (masksSymbols) symbol &= symbolMask
        anyNonzero ||= symbol !== 0
        chunkBits += descriptor.codeLengths[symbol] ?? 0
      }
      if (anyNonzero) entropyBits += chunkBits
    } else {
      let symbol = data[dataStart + chunkStart]
      if (masksSymbols) symbol &= symbolMask
      entropyBits += descriptor.codeLengths[symbol] ?? 0
    }
  }
  return entropyBits + (descriptor.hasSignBits ? nonzeroCount : 0)
}

/**
 * Price all code-table candidates while sharing identical symbol preparation.
 *
 * Candidate slots retain their original order so lowest-cost tie behavior is
 * unchanged. Only coefficient grouping and direct-symbol transformation are
 * shared; each descriptor still applies its own code lengths and zero-run rule.
 *
 * @param {SpectrumPricingState} state Per-channel pricing workspace.
 * @param {number} rowStart First coefficient in the retained quantized row.
 * @param {number} count Coefficients in the quantization unit.
 * @param {object} plan Read-only context/mode pricing plan.
 * @param {number} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @param {PricedSpectrumBand} destination Candidate costs to overwrite.
 */
function pricePreparedSpectrumCandidates(
  state,
  rowStart,
  count,
  plan,
  nonzeroCount,
  destination
) {
  for (const preparation of plan.preparations) {
    let data = preparation.usesMagnitudes
      ? state.magnitudeCoefficients
      : state.quantizedRows
    let dataStart = preparation.usesMagnitudes ? 0 : rowStart
    let dataCount = count
    if (preparation.packsGroups) {
      dataCount = groupSpectrumCoefficients(
        data,
        dataStart,
        count,
        preparation.valuesPerSymbol,
        preparation.valueBits,
        state.groupedSymbols
      )
      data = state.groupedSymbols
      dataStart = 0
    }
    const packedCount = Math.min(
      Math.trunc(count / preparation.valuesPerSymbol),
      dataCount,
      128
    )
    for (const slot of preparation.candidateSlots) {
      const descriptor = plan.descriptors[slot]
      destination.costs[slot] = measurePreparedSpectrumCost(
        data,
        dataStart,
        packedCount,
        descriptor,
        preparation.masksSymbols,
        preparation.symbolMask,
        nonzeroCount
      )
    }
  }
}

/**
 * Return a cached quantized row or populate one in the retained pricing workspace.
 *
 * @param {SpectrumPricingState} state
 * @param {ArrayLike<number>} spectrum
 * @param {ArrayLike<number>} thresholdScales
 * @param {number} band
 * @param {number} mode
 * @param {number} offset
 * @returns {number}
 */
function ensureQuantizedRow(
  state,
  spectrum,
  thresholdScales,
  band,
  mode,
  offset
) {
  const key = spectrumQuantizedKey(mode, offset)
  const rowStart = QUANTIZATION_UNIT_OFFSETS[band]
  if (state.quantizedKeys[band] !== key) {
    const sourceStart = QUANTIZATION_UNIT_OFFSETS[band]
    const sourceEnd = QUANTIZATION_UNIT_OFFSETS[band + 1]
    quantizeSpectrumCoefficients(
      spectrum,
      sourceStart,
      mode,
      offset,
      thresholdScales[band],
      sourceEnd - sourceStart,
      state.quantizedRows,
      rowStart
    )
    state.quantizedKeys[band] = key
  }
  return rowStart
}

/**
 * Price every legal spectral code table into a caller-owned result image.
 *
 * @param {SpectrumPricingState} state Per-channel pricing state.
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {Float32Array} thresholdScales Threshold scale by band.
 * @param {number} entropyContext Entropy context to price.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Quantization mode.
 * @param {number} offset Quantizer offset.
 * @param {PricedSpectrumBand} destination Result image to overwrite.
 * @returns {PricedSpectrumBand} The destination result.
 */
export function priceSpectrumBand(
  state,
  spectrum,
  thresholdScales,
  entropyContext,
  band,
  mode,
  offset,
  destination
) {
  destination.band = band
  const key = offset
  const firstEntry = firstCacheEntry(entropyContext, band, mode)
  let entry =
    state.cacheKeys[firstEntry] === key
      ? firstEntry
      : state.cacheKeys[firstEntry + 1] === key
        ? firstEntry + 1
        : -1
  if (entry >= 0) {
    const cachedOffset = cacheCostOffset(entry)
    for (let slot = 0; slot < SPECTRUM_PRICING_CANDIDATE_COUNT; slot++) {
      destination.costs[slot] = state.cacheCosts[cachedOffset + slot]
    }
  } else {
    const rowStart = ensureQuantizedRow(
      state,
      spectrum,
      thresholdScales,
      band,
      mode,
      offset
    )
    const count =
      QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
    const nonzeroCount = prepareMagnitudeRow(state, rowStart, count)
    const plan = spectrumPricingPlan(entropyContext, mode)
    pricePreparedSpectrumCandidates(
      state,
      rowStart,
      count,
      plan,
      nonzeroCount,
      destination
    )
    entry =
      state.cacheKeys[firstEntry] === SPECTRUM_PRICING_EMPTY_KEY
        ? firstEntry
        : state.cacheKeys[firstEntry + 1] === SPECTRUM_PRICING_EMPTY_KEY
          ? firstEntry + 1
          : firstEntry + (key % SPECTRUM_PRICING_CACHE_SLOTS)
    state.cacheKeys[entry] = key
    state.cacheCosts.set(destination.costs, cacheCostOffset(entry))
  }
  destination.selectedIndex = lowestCostIndex(
    destination.costs,
    SPECTRUM_PRICING_CANDIDATE_COUNT
  )
  return destination
}

/**
 * Select the cheapest compatible spectrum and code-table representation for one priced band.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation transaction.
 * @param {number} channel Candidate channel.
 * @param {PricedSpectrumBand} priced Candidate spectrum costs.
 * @returns {PricedSpectrumBand} Reused result with the selected representation and exact combined cost delta.
 */
export function selectSpectrumCodeTable(transaction, channel, priced) {
  const band = priced.band
  const pricing = transaction.spectrumPricingStates[channel]
  const syntax = transaction.channelBlocks[channel].syntax
  const context = syntax.codeTableContext & 1
  const oldIndex = syntax.codeTables[band]
  const oldSpectrumBits = pricing.selectedCost(context, band)
  const oldCodeTableBits = transaction.codeTableTransaction.bits
  const incumbentCombined = oldSpectrumBits + oldCodeTableBits
  const incumbentCandidateCombined = priced.costs[oldIndex] + oldCodeTableBits
  let selectedIndex = oldIndex
  let spectrumBits = priced.costs[oldIndex]
  let codeTableBits = oldCodeTableBits

  if (priced.selectedIndex !== oldIndex) {
    const selectedCost = priced.costs[priced.selectedIndex]
    const candidate = repriceCodeTableSection(
      channel,
      band,
      oldIndex,
      priced.selectedIndex,
      transaction.codeTableTransaction
    )
    if (candidate + selectedCost < incumbentCandidateCombined) {
      selectedIndex = priced.selectedIndex
      spectrumBits = selectedCost
      codeTableBits = candidate
    } else {
      transaction.codeTableTransaction.discardCandidate()
    }
  }
  priced.selectedIndex = selectedIndex
  priced.spectrumDelta = spectrumBits - oldSpectrumBits
  priced.codeTableBits = codeTableBits
  priced.delta = spectrumBits + codeTableBits - incumbentCombined
  return priced
}
