/** Allocation-owned ATRAC3plus spectral codebook pricing and memoization. */

import {
  groupSpectrumCoefficients,
  spectrumCostCodeTableIndex,
  spectrumDescriptor,
} from '../syntax/spectrum/coding.js'
import { spectrumQuantizedKey } from '../state/spectrum/pricing.js'

import { quantizeSpectrumCoefficients } from '../quantization/spectrum.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  SPECTRUM_GROUP_VALUE_BITS_BY_MODE,
} from '../core/tables.js'
import {
  SPECTRUM_PRICING_BAND_COUNT,
  SPECTRUM_PRICING_CACHE_SLOTS,
  SPECTRUM_PRICING_CANDIDATE_COUNT,
  SPECTRUM_PRICING_EMPTY_KEY,
  SPECTRUM_PRICING_MODE_COUNT,
  SPECTRUM_TABLE_INDEX,
} from '../core/constants.js'
import { repriceCodeTableSection } from '../syntax/code-table/writer.js'

/**
 * Resolve all candidate descriptors for one entropy context and quantization mode.
 *
 * Candidate order is part of allocation behavior because equal costs select the
 * lowest slot. The returned array therefore always retains code-table slot order.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {SpectrumDescriptor[]}
 */
function buildCandidateDescriptors(context, mode) {
  return Array.from(
    { length: SPECTRUM_PRICING_CANDIDATE_COUNT },
    (_unused, slot) =>
      spectrumDescriptor(
        context,
        mode,
        spectrumCostCodeTableIndex(context, mode, slot, SPECTRUM_TABLE_INDEX)
      )
  )
}

/**
 * Determine whether every sign-bearing candidate consumes direct magnitudes.
 *
 * A mode can use the direct magnitude row only when group size one is the sole
 * sign-bearing representation. Other modes must retain grouped preparation.
 *
 * @param {SpectrumDescriptor[]} descriptors
 * @returns {boolean}
 */
function usesOnlyDirectMagnitudes(descriptors) {
  let groupMask = 0
  for (const descriptor of descriptors) {
    if (descriptor.hasSignBits) {
      groupMask |= 1 << descriptor.valuesPerCodeword
    }
  }
  return groupMask === 1 << 1
}

/**
 * Describe the symbol row required by one spectrum code-table candidate.
 *
 * @param {SpectrumDescriptor} descriptor
 * @param {number} mode Quantization mode.
 * @param {boolean} directMagnitudes Whether direct magnitude reuse is legal for the mode.
 * @returns {object}
 */
function candidatePreparation(descriptor, mode, directMagnitudes) {
  const group = descriptor.valuesPerCodeword
  const directSigned = !descriptor.hasSignBits && group === 1
  const directMagnitude =
    descriptor.hasSignBits && group === 1 && directMagnitudes
  const masksSymbols = directSigned || directMagnitude
  const valueBits =
    SPECTRUM_GROUP_VALUE_BITS_BY_MODE[mode + Number(descriptor.hasSignBits) * 8]
  return {
    packsGroups: !directSigned && !directMagnitude && group !== 1,
    usesMagnitudes: descriptor.hasSignBits,
    valuesPerSymbol: group,
    valueBits,
    masksSymbols,
    symbolMask: masksSymbols ? 2 ** valueBits - 1 : 0xff,
    candidateSlots: [],
  }
}

/**
 * Test whether two candidates can reuse the same prepared symbol row.
 *
 * Code lengths and zero-run behavior are excluded because they consume the
 * prepared row without changing how it is produced.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function hasSamePreparation(left, right) {
  return (
    left.packsGroups === right.packsGroups &&
    left.usesMagnitudes === right.usesMagnitudes &&
    left.valuesPerSymbol === right.valuesPerSymbol &&
    left.valueBits === right.valueBits &&
    left.masksSymbols === right.masksSymbols &&
    left.symbolMask === right.symbolMask
  )
}

/**
 * Group candidate slots that can price the same prepared symbol row.
 *
 * @param {SpectrumDescriptor[]} descriptors
 * @param {number} mode Quantization mode.
 * @returns {object[]}
 */
function buildSymbolPreparations(descriptors, mode) {
  const preparations = []
  const directMagnitudes = usesOnlyDirectMagnitudes(descriptors)
  for (let slot = 0; slot < descriptors.length; slot++) {
    const candidate = candidatePreparation(
      descriptors[slot],
      mode,
      directMagnitudes
    )
    let shared = preparations.find((entry) =>
      hasSamePreparation(entry, candidate)
    )
    if (!shared) {
      shared = candidate
      preparations.push(shared)
    }
    shared.candidateSlots.push(slot)
  }
  for (const preparation of preparations) {
    preparation.histogramSlots = preparation.candidateSlots.filter(
      (slot) => descriptors[slot].zeroRunChunk <= 1
    )
    preparation.sequenceSlots = preparation.candidateSlots.filter(
      (slot) => descriptors[slot].zeroRunChunk > 1
    )
  }
  return preparations
}

/**
 * Build one context/mode plan at module initialization.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {object|null}
 */
function buildSpectrumPricingPlan(context, mode) {
  if (mode === 0) return null
  const descriptors = buildCandidateDescriptors(context, mode)
  const preparations = buildSymbolPreparations(descriptors, mode)
  const requiresMagnitudes = preparations.some(
    (preparation) => preparation.usesMagnitudes
  )
  return { descriptors, preparations, requiresMagnitudes }
}

const spectrumPricingPlans = Array.from({ length: 2 }, (_unused, context) =>
  Array.from({ length: 8 }, (_empty, mode) =>
    buildSpectrumPricingPlan(context, mode)
  )
)

/**
 * Return the module-owned, read-only candidate and preparation plan for one query.
 *
 * Callers validate context and mode as part of the public pricing boundary.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {object}
 */
export function spectrumPricingPlan(context, mode) {
  return spectrumPricingPlans[context][mode]
}

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
 * @returns {number} Number of nonzero coefficients.
 */
function prepareMagnitudeRow(state, rowStart, count) {
  let nonzeroCount = 0
  for (let index = 0; index < count; index++) {
    const value = signed16(state.quantizedRows[rowStart + index])
    nonzeroCount += Number(value !== 0)
    state.magnitudeCoefficients[index] = Math.abs(value)
  }
  return nonzeroCount
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
 * Price simple entropy candidates from one exact prepared-symbol histogram.
 *
 * Codebooks without zero-run chunks depend only on symbol multiplicity. Building
 * that sufficient statistic once avoids traversing the same coefficient row for
 * every compatible code table.
 *
 * @param {SpectrumPricingState} state Per-channel pricing workspace.
 * @param {ArrayLike<number>} data Prepared symbol storage.
 * @param {number} dataStart First prepared symbol.
 * @param {number} packedCount Number of prepared symbols to price.
 * @param {object} preparation Shared symbol preparation.
 * @param {object} plan Read-only context/mode pricing plan.
 * @param {number} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @param {PricedSpectrumBand} destination Candidate costs to overwrite.
 */
function priceHistogramCandidates(
  state,
  data,
  dataStart,
  packedCount,
  preparation,
  plan,
  nonzeroCount,
  destination
) {
  const counts = state.symbolCounts
  const usedSymbols = state.usedSymbols
  let usedCount = 0
  for (let index = 0; index < packedCount; index++) {
    let symbol = data[dataStart + index]
    if (preparation.masksSymbols) symbol &= preparation.symbolMask
    if (counts[symbol] === 0) usedSymbols[usedCount++] = symbol
    counts[symbol]++
  }
  for (const slot of preparation.histogramSlots) {
    const descriptor = plan.descriptors[slot]
    let entropyBits = descriptor.hasSignBits ? nonzeroCount : 0
    for (let index = 0; index < usedCount; index++) {
      const symbol = usedSymbols[index]
      entropyBits += (descriptor.codeLengths[symbol] ?? 0) * counts[symbol]
    }
    destination.costs[slot] = entropyBits
  }
  for (let index = 0; index < usedCount; index++) {
    counts[usedSymbols[index]] = 0
  }
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
    if (preparation.histogramSlots.length > 1) {
      priceHistogramCandidates(
        state,
        data,
        dataStart,
        packedCount,
        preparation,
        plan,
        nonzeroCount,
        destination
      )
    } else {
      for (const slot of preparation.histogramSlots) {
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
    for (const slot of preparation.sequenceSlots) {
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
    const plan = spectrumPricingPlan(entropyContext, mode)
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
    const nonzeroCount = plan.requiresMagnitudes
      ? prepareMagnitudeRow(state, rowStart, count)
      : 0
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
