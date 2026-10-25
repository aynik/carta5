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
  SPECTRUM_PRICING_SYMBOL_COUNT,
  SPECTRUM_TABLE_INDEX,
} from '../core/constants.js'
import { repriceCodeTableSection } from '../syntax/code-table/writer.js'

/**
 * @typedef {object} SpectrumSymbolPreparation
 * @property {boolean} packsGroups Whether coefficients share a packed symbol.
 * @property {boolean} usesMagnitudes Whether signs are priced separately.
 * @property {i32} valuesPerSymbol Coefficients in each entropy symbol.
 * @property {i32} valueBits Width of one grouped coefficient.
 * @property {boolean} masksSymbols Whether direct symbols need a bit mask.
 * @property {i32} symbolMask Mask for one prepared symbol.
 * @property {i32[]} candidateSlots Code tables sharing this preparation.
 * @property {Uint8Array} [nonRunSlots] Candidates without zero-run coding.
 * @property {Uint8Array} [zeroRunSlots] Candidates with zero-run coding.
 * @property {Int32Array} [packedCosts] Two independent 16-bit cost lanes.
 */

/**
 * @typedef {object} SpectrumPricingPlan
 * @property {SpectrumDescriptor[]} descriptors Candidates in code-table order.
 * @property {SpectrumSymbolPreparation[]} preparations Shared symbol layouts.
 * @property {boolean} requiresMagnitudes Whether to prepare unsigned magnitudes.
 * @property {Uint16Array} zeroCosts Exact all-zero candidate costs, indexed by band.
 */

/**
 * Resolve all candidate descriptors for one entropy context and quantization mode.
 *
 * Candidate order is part of allocation behavior because equal costs select the
 * lowest slot. The returned array therefore always retains code-table slot order.
 *
 * @param {number} context Entropy-table context.
 * @param {i32} mode Quantization mode.
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
 * @param {i32} mode Quantization mode.
 * @param {boolean} directMagnitudes Whether direct magnitude reuse is legal for the mode.
 * @returns {SpectrumSymbolPreparation}
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
 * @param {SpectrumSymbolPreparation} left
 * @param {SpectrumSymbolPreparation} right
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
 * Pack two candidate costs into independent 16-bit lanes.
 *
 * A band contains at most 128 symbols with byte-sized costs. Each lane
 * sums to at most 32640, so a packed sum is at most 0x7f807f80 and fits i32.
 * Summing one packed cost per symbol cannot carry into the adjacent lane.
 *
 * @param {Uint8Array} slots Candidates sharing one prepared symbol row.
 * @param {SpectrumDescriptor[]} descriptors Candidate codebooks.
 * @returns {Int32Array} Packed costs in symbol-major order.
 */
function buildPackedCandidateCosts(slots, descriptors) {
  const groups = Math.ceil(slots.length / 2)
  const packed = new Int32Array(SPECTRUM_PRICING_SYMBOL_COUNT * groups)
  for (let candidate = 0; candidate < slots.length; candidate++) {
    const group = candidate >> 1
    const shift = (candidate & 1) * 16
    const lengths = descriptors[slots[candidate]].costLengths
    for (let symbol = 0; symbol < SPECTRUM_PRICING_SYMBOL_COUNT; symbol++) {
      packed[symbol * groups + group] += lengths[symbol] << shift
    }
  }
  return packed
}

/**
 * Group candidate slots that can price the same prepared symbol row.
 *
 * @param {SpectrumDescriptor[]} descriptors
 * @param {i32} mode Quantization mode.
 * @returns {SpectrumSymbolPreparation[]}
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
    preparation.nonRunSlots = Uint8Array.from(
      preparation.candidateSlots.filter(
        (slot) => descriptors[slot].zeroRunChunk <= 1
      )
    )
    preparation.zeroRunSlots = Uint8Array.from(
      preparation.candidateSlots.filter(
        (slot) => descriptors[slot].zeroRunChunk > 1
      )
    )
    if (preparation.nonRunSlots.length > 1) {
      preparation.packedCosts = buildPackedCandidateCosts(
        preparation.nonRunSlots,
        descriptors
      )
    }
  }
  return preparations
}

/**
 * Precompute exact costs for a zero quantized band, including zero-run flags.
 *
 * Zero rows need no grouping, magnitude preparation, or histogram traversal.
 * Candidate order is retained so equal-cost choices remain unchanged.
 *
 * @param {SpectrumDescriptor[]} descriptors Candidates in code-table order.
 * @returns {Uint16Array} Band-major candidate costs.
 */
function buildZeroSpectrumCosts(descriptors) {
  const costs = new Uint16Array(
    SPECTRUM_PRICING_BAND_COUNT * SPECTRUM_PRICING_CANDIDATE_COUNT
  )
  for (let band = 0; band < SPECTRUM_PRICING_BAND_COUNT; band++) {
    const count =
      QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
    for (let slot = 0; slot < descriptors.length; slot++) {
      const descriptor = descriptors[slot]
      const symbols = Math.trunc(count / descriptor.valuesPerCodeword)
      const chunk = descriptor.zeroRunChunk
      costs[band * SPECTRUM_PRICING_CANDIDATE_COUNT + slot] =
        chunk > 1
          ? Math.ceil(symbols / chunk)
          : symbols * descriptor.costLengths[0]
    }
  }
  return costs
}

/**
 * Build one context/mode plan at module initialization.
 *
 * @param {number} context Entropy-table context.
 * @param {i32} mode Quantization mode.
 * @returns {SpectrumPricingPlan|null}
 */
function buildSpectrumPricingPlan(context, mode) {
  if (mode === 0) return null
  const descriptors = buildCandidateDescriptors(context, mode)
  const preparations = buildSymbolPreparations(descriptors, mode)
  const requiresMagnitudes = preparations.some(
    (preparation) => preparation.usesMagnitudes
  )
  const zeroCosts = buildZeroSpectrumCosts(descriptors)
  return { descriptors, preparations, requiresMagnitudes, zeroCosts }
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
 * @param {i32} mode Quantization mode.
 * @returns {SpectrumPricingPlan|null}
 */
export function spectrumPricingPlan(context, mode) {
  return spectrumPricingPlans[context][mode]
}

/**
 * Map a context, band, and mode to its first pricing-cache entry.
 *
 * @param {i32} context
 * @param {i32} band
 * @param {i32} mode
 * @returns {i32}
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
 * @param {i32} entry
 * @returns {i32}
 */
function cacheCostOffset(entry) {
  return entry * SPECTRUM_PRICING_CANDIDATE_COUNT
}

/**
 * Index the lowest-cost table by pricing context and quantization mode.
 *
 * @param {Uint16Array} costs
 * @param {i32} limit
 * @returns {i32}
 * @nativeUnchecked Internal callers supply a full candidate row and matching limit.
 */
function lowestCostIndex(costs, limit) {
  /** @type {i32} */
  let selected = 0
  for (let index = 1; index < limit; index++) {
    if (costs[index] < costs[selected]) selected = index
  }
  return selected
}

/**
 * Interpret the low 16 bits of a cache key as a signed integer.
 *
 * @param {i32} value
 * @returns {i32}
 */
function signed16(value) {
  return (value << 16) >> 16
}

/**
 * Write absolute quantized magnitudes and count their sign-bit payloads.
 *
 * @param {SpectrumPricingState} state
 * @param {i32} rowStart
 * @param {i32} count
 * @returns {i32} Number of nonzero coefficients, bounded by the band length.
 * @nativeUnchecked The caller bounds the quantization band and magnitude scratch.
 */
function prepareMagnitudeRow(state, rowStart, count) {
  const quantizedRows = state.quantizedRows
  const magnitudes = state.magnitudeCoefficients
  /** @type {i32} At most one nonzero value per coefficient in the bounded band. */
  let nonzeroCount = 0
  for (let index = 0; index < count; index++) {
    const value = signed16(quantizedRows[rowStart + index])
    nonzeroCount += Number(value !== 0)
    /** @type {i32} Absolute signed-16 magnitude, from zero through 32768. */
    const magnitude = Math.abs(value)
    magnitudes[index] = magnitude
  }
  return nonzeroCount
}

/**
 * Measure one candidate's entropy cost over an already prepared symbol row.
 *
 * @param {Uint16Array} data Prepared symbol storage.
 * @param {i32} dataStart First prepared symbol.
 * @param {i32} packedCount Number of prepared symbols to price.
 * @param {SpectrumDescriptor} descriptor Candidate entropy descriptor.
 * @param {boolean} masksSymbols Whether direct symbols require masking.
 * @param {i32} symbolMask Direct-symbol mask.
 * @param {i32} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @returns {i32} Bounded sum of stored symbol costs and sign bits.
 * @nativeUnchecked Prepared symbols and padded cost rows share the 256-symbol domain.
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
  const codeLengths = descriptor.costLengths
  const chunk = Math.max(descriptor.zeroRunChunk, 1)
  /** @type {i32} At most 128 symbols, each with an eight-bit stored cost. */
  let entropyBits = 0
  for (let chunkStart = 0; chunkStart < packedCount; chunkStart += chunk) {
    const chunkEnd = Math.min(chunkStart + chunk, packedCount)
    if (chunk > 1) {
      entropyBits++
      let anyNonzero = false
      let chunkBits = 0
      for (let index = chunkStart; index < chunkEnd; index++) {
        /** @type {i32} */
        let symbol = data[dataStart + index]
        if (masksSymbols) symbol &= symbolMask
        anyNonzero ||= symbol !== 0
        chunkBits += codeLengths[symbol]
      }
      if (anyNonzero) entropyBits += chunkBits
    } else {
      /** @type {i32} */
      let symbol = data[dataStart + chunkStart]
      if (masksSymbols) symbol &= symbolMask
      entropyBits += codeLengths[symbol]
    }
  }
  return entropyBits + (descriptor.hasSignBits ? nonzeroCount : 0)
}

/**
 * Price paired entropy candidates in a single traversal of their shared symbols.
 *
 * Each packed table entry has two independent cost lanes. Summing the entries
 * directly avoids building and clearing a symbol histogram for every query.
 *
 * @param {Uint16Array} data Prepared symbol storage.
 * @param {i32} dataStart First prepared symbol.
 * @param {i32} packedCount Number of prepared symbols to price.
 * @param {SpectrumSymbolPreparation} preparation Shared symbol preparation.
 * @param {i32} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @param {PricedSpectrumBand} destination Candidate costs to overwrite.
 * @nativeUnchecked Prepared rows, packed costs and candidate slots are bounded by the plan.
 */
function pricePackedCandidates(
  data,
  dataStart,
  packedCount,
  preparation,
  nonzeroCount,
  destination
) {
  const slots = preparation.nonRunSlots
  const packed = preparation.packedCosts
  const groups = Math.ceil(slots.length / 2)
  /** @type {i32} Two independent 16-bit cost lanes, bounded by 0x7f807f80. */
  let cost0 = 0
  /** @type {i32} */
  let cost1 = 0
  /** @type {i32} */
  let cost2 = 0
  /** @type {i32} */
  let cost3 = 0
  const masksSymbols = preparation.masksSymbols
  const symbolMask = preparation.symbolMask
  for (let index = 0; index < packedCount; index++) {
    /** @type {i32} */
    let symbol = data[dataStart + index]
    if (masksSymbols) symbol &= symbolMask
    const first = symbol * groups
    cost0 += packed[first]
    if (groups > 1) cost1 += packed[first + 1]
    if (groups > 2) cost2 += packed[first + 2]
    if (groups > 3) cost3 += packed[first + 3]
  }
  const signBits = preparation.usesMagnitudes ? nonzeroCount : 0
  const costs = destination.costs
  for (let first = 0; first < slots.length; first += 2) {
    const pair =
      first === 0 ? cost0 : first === 2 ? cost1 : first === 4 ? cost2 : cost3
    costs[slots[first]] = (pair & 0xffff) + signBits
    if (first + 1 < slots.length) {
      costs[slots[first + 1]] = (pair >> 16) + signBits
    }
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
 * @param {i32} rowStart First coefficient in the retained quantized row.
 * @param {i32} count Coefficients in the quantization unit.
 * @param {SpectrumPricingPlan} plan Read-only context/mode pricing plan.
 * @param {i32} nonzeroCount Sign-bit payload count for magnitude codebooks.
 * @param {PricedSpectrumBand} destination Candidate costs to overwrite.
 * @nativeUnchecked The plan bounds all prepared rows, candidate slots and scratch capacities.
 */
function pricePreparedSpectrumCandidates(
  state,
  rowStart,
  count,
  plan,
  nonzeroCount,
  destination
) {
  const costs = destination.costs
  const descriptors = plan.descriptors
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
    if (preparation.nonRunSlots.length > 1) {
      pricePackedCandidates(
        data,
        dataStart,
        packedCount,
        preparation,
        nonzeroCount,
        destination
      )
    } else {
      for (const slot of preparation.nonRunSlots) {
        const descriptor = descriptors[slot]
        costs[slot] = measurePreparedSpectrumCost(
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
    for (const slot of preparation.zeroRunSlots) {
      const descriptor = descriptors[slot]
      costs[slot] = measurePreparedSpectrumCost(
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
 * @param {Float32Array} spectrum
 * @param {Float32Array} thresholdScales
 * @param {i32} band
 * @param {i32} mode
 * @param {i32} offset
 * @returns {i32}
 * @nativeUnchecked Allocation supplies a valid band and complete spectrum workspace.
 */
function ensureQuantizedRow(
  state,
  spectrum,
  thresholdScales,
  band,
  mode,
  offset
) {
  const quantizedKeys = state.quantizedKeys
  const quantizedRows = state.quantizedRows
  const key = spectrumQuantizedKey(mode, offset)
  const rowStart = QUANTIZATION_UNIT_OFFSETS[band]
  if (quantizedKeys[band] !== key) {
    const sourceStart = QUANTIZATION_UNIT_OFFSETS[band]
    const sourceEnd = QUANTIZATION_UNIT_OFFSETS[band + 1]
    quantizeSpectrumCoefficients(
      spectrum,
      sourceStart,
      mode,
      offset,
      thresholdScales[band],
      sourceEnd - sourceStart,
      quantizedRows,
      rowStart
    )
    quantizedKeys[band] = key
  }
  return rowStart
}

/**
 * Price every legal spectral code table into a caller-owned result image.
 *
 * @param {SpectrumPricingState} state Per-channel pricing state.
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {Float32Array} thresholdScales Threshold scale by band.
 * @param {i32} entropyContext Entropy context to price.
 * @param {i32} band Quantization-unit index.
 * @param {i32} mode Quantization mode.
 * @param {i32} offset Quantizer offset.
 * @param {PricedSpectrumBand} destination Result image to overwrite.
 * @returns {PricedSpectrumBand} The destination result.
 * @nativeUnchecked Allocation supplies valid band, mode, context and full workspace capacities.
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
  const cacheKeys = state.cacheKeys
  const cacheCosts = state.cacheCosts
  const costs = destination.costs
  destination.band = band
  const key = offset
  const firstEntry = firstCacheEntry(entropyContext, band, mode)
  let entry =
    cacheKeys[firstEntry] === key
      ? firstEntry
      : cacheKeys[firstEntry + 1] === key
        ? firstEntry + 1
        : -1
  if (entry >= 0) {
    const cachedOffset = cacheCostOffset(entry)
    costs.set(
      cacheCosts.subarray(
        cachedOffset,
        cachedOffset + SPECTRUM_PRICING_CANDIDATE_COUNT
      )
    )
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
    if (plan.requiresMagnitudes && nonzeroCount === 0) {
      const zeroOffset = band * SPECTRUM_PRICING_CANDIDATE_COUNT
      costs.set(
        plan.zeroCosts.subarray(
          zeroOffset,
          zeroOffset + SPECTRUM_PRICING_CANDIDATE_COUNT
        )
      )
    } else {
      pricePreparedSpectrumCandidates(
        state,
        rowStart,
        count,
        plan,
        nonzeroCount,
        destination
      )
    }
    entry =
      cacheKeys[firstEntry] === SPECTRUM_PRICING_EMPTY_KEY
        ? firstEntry
        : cacheKeys[firstEntry + 1] === SPECTRUM_PRICING_EMPTY_KEY
          ? firstEntry + 1
          : firstEntry + (key % SPECTRUM_PRICING_CACHE_SLOTS)
    cacheKeys[entry] = key
    cacheCosts.set(costs, cacheCostOffset(entry))
  }
  destination.selectedIndex = lowestCostIndex(
    costs,
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
