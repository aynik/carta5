/** ATRAC3plus word-length sidechain pricing, transactions, and emission. */

import { writeCanonicalSymbol } from '../coding/entropy.js'
import {
  WORD_LENGTH_CODEBOOKS,
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
  SQUARED_DELTAS,
  WORD_LENGTH_DELTA_CURVES,
  WORD_LENGTH_SHAPE_CODEBOOK,
} from '../core/tables.js'

import {
  QUANTIZATION_UNIT_COUNT,
  WORD_LENGTH_MODE_BITS,
  WORD_LENGTH_SIDE_DATA_BANDS,
  IO_WORD_LENGTH_SYNTAX_CODEBOOK_HEADER_BITS,
  CURVE_BITS,
  CURVE_HEADER_BITS,
  DELTA_HEADER_BITS,
  RAW_BITS,
  IO_WORD_LENGTH_SYNTAX_SHAPE_BASE_STRIDE,
  SHAPE_HEADER_BITS,
  IO_WORD_LENGTH_SYNTAX_SHAPE_SHIFT_STRIDE,
  TAIL_MODE_NONE,
  TAIL_MODE_ONES_OR_BITS,
  TAIL_MODE_RUN,
  WORD_LENGTH_FORBIDDEN_BITS,
  WORD_MASK,
} from '../core/constants.js'
import {
  WordLengthAccountingTransaction,
  validateWordLengthChannels,
} from '../state/word-length.js'

/**
 * Map a channel and delta-mode variant into the flat cost table.
 *
 * @param {number} row
 * @param {number} column
 * @param {number} codebook
 * @returns {number}
 */
function deltaModeCostIndex(row, column, codebook) {
  return (row * 16 + column * 4 + codebook) | 0
}

/**
 * Map a channel and syntax mode into the flat comparison table.
 *
 * @param {number} relation
 * @param {number} group
 * @param {number} codebook
 * @returns {number}
 */
function channelCostIndex(relation, group, codebook) {
  return (relation * 16 + group * 4 + codebook) | 0
}

/**
 * Set or clear one band bit in a 32-bit activity mask.
 *
 * @param {number} mask
 * @param {number} index
 * @param {boolean} enabled
 * @returns {number}
 */
function updateMask(mask, index, enabled) {
  const bit = 2 ** index
  return ((mask & ~bit) | (enabled ? bit : 0)) >>> 0
}

/**
 * Return the first inactive band after a mask's contiguous low-order prefix.
 *
 * @param {number} mask
 * @param {number} count
 * @returns {number}
 */
function prefixEnd(mask, count) {
  const prefix = count >= 32 ? 0xffffffff : (2 ** count - 1) >>> 0
  const value = (mask & prefix) >>> 0
  return value === 0 ? 0 : 32 - Math.clz32(value)
}

/**
 * Return the first candidate mode attaining the minimum cost within the requested prefix.
 *
 * @param {ArrayLike<number>} costs
 * @param {number} [count]
 * @returns {number}
 */
function lowestCostMode(costs, count = costs.length) {
  let selected = 0
  for (let mode = 1; mode < count; mode++) {
    if (costs[mode] < costs[selected]) selected = mode
  }
  return selected
}

/**
 * Return the fixed-width payload cost for one coded word length.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @returns {number}
 */
function wordLengthBits(codebook, symbol) {
  return WORD_LENGTH_CODEBOOKS[codebook][symbol & WORD_MASK]
}

/**
 * Wrap a predictor-relative value into the fixed-width unsigned syntax domain.
 *
 * @param {number} value
 * @param {number} reference
 * @returns {number}
 */
function maskedDelta(value, reference) {
  return (value - reference) & WORD_MASK
}

/**
 * Evaluate the word-length predictor curve at one quantization band.
 *
 * @param {number} channelOrdinal
 * @param {number} delta
 * @param {number} band
 * @returns {number}
 */
function deltaCurveValue(channelOrdinal, delta, band) {
  if (delta === 0) return 0
  const row = (channelOrdinal & 1) * 3 + delta - 1
  return WORD_LENGTH_DELTA_CURVES[row * QUANTIZATION_UNIT_COUNT + band]
}

/**
 * Map a quantization band to its word-length shape slot.
 *
 * @param {number} band
 * @returns {number}
 */
function shapeSlotForBand(band) {
  return SHAPE_INDEX_BY_QUANTIZATION_UNIT[band] ?? 0
}

/**
 * Return the number of shape slots needed for the active band count.
 *
 * @param {number} count
 * @returns {number}
 */
function shapeSlotCount(count) {
  return count === 0 ? 0 : shapeSlotForBand(count - 1) + 1
}

/**
 * Evaluate the selected shape adjustment for one quantization band.
 *
 * @param {number} base
 * @param {number} shift
 * @param {number} slot
 * @returns {number}
 */
function shapeAdjustment(base, shift, slot) {
  if (slot === 0) return 0
  const table =
    base * IO_WORD_LENGTH_SYNTAX_SHAPE_BASE_STRIDE +
    shift * IO_WORD_LENGTH_SYNTAX_SHAPE_SHIFT_STRIDE
  return WORD_LENGTH_SHAPE_CODEBOOK[table + slot - 1]
}

/**
 * Reconstruct the base word length represented by one shape slot.
 *
 * @param {number} base
 * @param {number} shift
 * @param {number} band
 * @returns {number}
 */
function shapeBaseValue(base, shift, band) {
  return base - shapeAdjustment(base, shift, shapeSlotForBand(band))
}

/**
 * Compute escape-bit overhead for a word-length tail value.
 *
 * @param {number} mode
 * @returns {number}
 */
function tailExtraBits(mode) {
  return mode === TAIL_MODE_NONE ? 0 : mode === TAIL_MODE_RUN ? 7 : 5
}

/**
 * Compute the complete literal cost of the uncoded word-length tail.
 *
 * @param {number} mode
 * @param {number} count
 * @param {number} channelOrdinal
 * @param {number} limit
 * @returns {number}
 */
function tailLiteralBits(mode, count, channelOrdinal, limit) {
  return channelOrdinal === 1 && mode === TAIL_MODE_ONES_OR_BITS
    ? limit - count
    : 0
}

/**
 * Convert a channel value to the predictor-relative symbol used by the selected syntax mode.
 *
 * @param {number} relation
 * @param {number} band
 * @param {number} value
 * @param {number} base
 * @param {number} previousValue
 * @param {number} previousBase
 * @returns {number}
 */
function channelSymbol(
  relation,
  band,
  value,
  base,
  previousValue,
  previousBase
) {
  const delta = maskedDelta(value, base)
  if (relation === 0 || band === 0) return delta
  return (delta - maskedDelta(previousValue, previousBase)) & WORD_MASK
}

/**
 * Validate the coded-band limit and the bounded side-data prefix used by word-length modes.
 *
 * @param {number} bandLimit
 * @param {number} sideDataBandCount
 */
function validateGeometry(bandLimit, sideDataBandCount) {
  if (
    !Number.isInteger(bandLimit) ||
    bandLimit < 0 ||
    bandLimit > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(sideDataBandCount) ||
    sideDataBandCount < 0 ||
    sideDataBandCount > WORD_LENGTH_SIDE_DATA_BANDS
  ) {
    throw new RangeError('ATRAC3plus word-length geometry is out of range')
  }
}

/**
 * Refresh the active-band mask after a word-length row changes.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} row
 * @param {number} band
 * @param {number} value
 */
function updateRowMask(scratch, row, band, value) {
  scratch.rowNonzeroMasks[row] = updateMask(
    scratch.rowNonzeroMasks[row],
    band,
    value !== 0
  )
  scratch.rowNononeMasks[row] = updateMask(
    scratch.rowNononeMasks[row],
    band,
    value !== 1
  )
  scratch.rowAboveOneMasks[row] = updateMask(
    scratch.rowAboveOneMasks[row],
    band,
    value > 1
  )
}

/**
 * Extract the uncoded word-length suffix and its literal/escape costs.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} row
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {ArrayLike<number>} destination
 */
function buildTailProfile(
  scratch,
  row,
  channelOrdinal,
  bandLimit,
  destination
) {
  const zeroStart = prefixEnd(scratch.rowNonzeroMasks[row], bandLimit)
  const oneStart = prefixEnd(scratch.rowNononeMasks[row], zeroStart)
  destination[0] = bandLimit
  destination[1] = zeroStart
  if (channelOrdinal === 0) {
    destination[2] = prefixEnd(scratch.rowNononeMasks[row], bandLimit)
    const zeroCount = bandLimit - zeroStart
    if (zeroCount >= 1 && zeroCount <= 4) {
      destination[3] = oneStart
      scratch.rowMeta[row] = zeroCount
    } else {
      destination[3] = bandLimit
      scratch.rowMeta[row] = 0
    }
    return
  }
  destination[2] = prefixEnd(scratch.rowAboveOneMasks[row], bandLimit)
  const onesBeforeZeroes = zeroStart - oneStart
  if (onesBeforeZeroes >= 3) {
    const codedOnes = Math.min(onesBeforeZeroes, 6)
    destination[3] = zeroStart - codedOnes
    scratch.rowMeta[row] = codedOnes
  } else {
    destination[3] = bandLimit
    scratch.rowMeta[row] = 0
  }
}

/**
 * Build the word-length shape-map indices for every active quantization band.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} baseSlot
 */
function buildMapIndices(scratch, baseSlot) {
  for (let column = 0; column < 4; column++) {
    scratch.mapIndices[baseSlot + column] = -1
    for (let previous = 0; previous < column; previous++) {
      if (
        scratch.bandCounts[baseSlot + previous] ===
        scratch.bandCounts[baseSlot + column]
      ) {
        scratch.mapIndices[baseSlot + column] = previous
        break
      }
    }
  }
}

/**
 * Determine the coded-prefix and literal-tail split candidates for one word-length row.
 *
 * @param {WordLengthScratch} scratch
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCostWork} work
 */
function buildRowSplits(scratch, values, channelOrdinal, bandLimit, work) {
  scratch.rows[0].set(values)
  scratch.rowNegativeCounts[0] = 0
  scratch.rowNonzeroMasks[0] = 0
  scratch.rowNononeMasks[0] = 0
  scratch.rowAboveOneMasks[0] = 0
  for (let band = 0; band < QUANTIZATION_UNIT_COUNT; band++) {
    updateRowMask(scratch, 0, band, scratch.rows[0][band])
  }
  for (let row = 1; row < 4; row++) {
    scratch.rowNegativeCounts[row] = 0
    scratch.rowNonzeroMasks[row] = 0
    scratch.rowNononeMasks[row] = 0
    scratch.rowAboveOneMasks[row] = 0
    for (let band = 0; band < bandLimit; band++) {
      const value = values[band] - deltaCurveValue(channelOrdinal, row, band)
      scratch.rows[row][band] = value
      updateRowMask(scratch, row, band, value)
      if (value < 0) scratch.rowNegativeCounts[row]++
    }
  }
  for (let row = 0; row < 4; row++) {
    const baseSlot = row * 4
    if (scratch.rowNegativeCounts[row] !== 0) {
      scratch.rowMeta[row] = 0
      for (let column = 0; column < 4; column++) {
        scratch.bandCounts[baseSlot + column] = bandLimit
        scratch.mapIndices[baseSlot + column] = -1
      }
      continue
    }
    buildTailProfile(scratch, row, channelOrdinal, bandLimit, work.tempCosts)
    for (let column = 0; column < 4; column++) {
      scratch.bandCounts[baseSlot + column] = work.tempCosts[column]
    }
    buildMapIndices(scratch, baseSlot)
  }
}

/**
 * Return a rounded three-value average for local shape estimation.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
function averageOfThree(a, b, c) {
  return Math.trunc((a + b + c + 1) / 3)
}

/**
 * Return a rounded five-value average for local shape estimation.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {number} e
 * @returns {number}
 */
function averageOfFive(a, b, c, d, e) {
  return Math.trunc((a + b + c + d + e + 2) / 5)
}

/**
 * Choose the shape bias that minimizes word-length residual magnitudes.
 *
 * @param {number} base
 * @param {number} shapeCountValue
 * @param {ArrayLike<number>} averages
 * @returns {number}
 */
function selectShapeShift(base, shapeCountValue, averages) {
  if (shapeCountValue <= 1) return 0
  let bestShift = 0
  let bestCost = Infinity
  for (let shift = 0; shift < 16; shift++) {
    let cost = 0
    for (let slot = 1; slot < shapeCountValue; slot++) {
      const delta = Math.abs(
        averages[slot] - shapeAdjustment(base, shift, slot)
      )
      cost += SQUARED_DELTAS[delta]
    }
    if (cost < bestCost) {
      bestCost = cost
      bestShift = shift
    }
  }
  return bestShift
}

/**
 * Reduce word lengths to grouped shape values and their local residuals.
 *
 * @param {ArrayLike<number>} values
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} sideDataBandCount
 * @param {number} bandLimit
 */
function buildShapeGroups(values, scratch, work, sideDataBandCount, bandLimit) {
  let band = 0
  for (let group = 0; group < sideDataBandCount; group++) {
    work.shapeAverages[group] = averageOfThree(
      values[band],
      values[band + 1],
      values[band + 2]
    )
    band += 3
  }
  if (sideDataBandCount === 10) {
    work.shapeAverages[9] = averageOfFive(
      values[27],
      values[28],
      values[29],
      values[30],
      values[31]
    )
  }
  const baseAverage = work.shapeAverages[0]
  for (let group = 1; group < sideDataBandCount; group++) {
    work.shapeAverages[group] = baseAverage - work.shapeAverages[group]
  }

  for (let group = 0; group < 4; group++) {
    const mapped = scratch.mapIndices[group]
    if (mapped >= 0) {
      work.shapeRows[group].set(work.shapeRows[mapped])
      work.shapeCounts[group] = work.shapeCounts[mapped]
      work.shapeBases[group] = work.shapeBases[mapped]
      work.shapeShifts[group] = work.shapeShifts[mapped]
      continue
    }
    const count = scratch.bandCounts[group]
    const slots = count > 0 ? shapeSlotCount(count) : 0
    let source = -1
    for (let previous = 0; previous < group; previous++) {
      if (work.shapeCounts[previous] === slots) {
        source = previous
        break
      }
    }
    if (source >= 0) {
      work.shapeRows[group].set(work.shapeRows[source])
      work.shapeCounts[group] = work.shapeCounts[source]
      work.shapeBases[group] = work.shapeBases[source]
      work.shapeShifts[group] = work.shapeShifts[source]
      continue
    }
    const shift = selectShapeShift(baseAverage, slots, work.shapeAverages)
    work.shapeCounts[group] = slots
    work.shapeBases[group] = baseAverage
    work.shapeShifts[group] = shift
    work.predicted.fill(baseAverage)
    for (let slot = 1; slot < WORD_LENGTH_SIDE_DATA_BANDS; slot++) {
      work.predicted[slot] =
        baseAverage - shapeAdjustment(baseAverage, shift, slot)
    }
    const row = work.shapeRows[group]
    row[0] = (values[0] - baseAverage) & WORD_MASK
    row[1] = (values[1] - baseAverage) & WORD_MASK
    row[2] = (values[2] - baseAverage) & WORD_MASK
    let item = 3
    for (let slot = 1; slot < sideDataBandCount; slot++) {
      const predicted = work.predicted[slot]
      row[item] = (values[item] - predicted) & WORD_MASK
      row[item + 1] = (values[item + 1] - predicted) & WORD_MASK
      row[item + 2] = (values[item + 2] - predicted) & WORD_MASK
      item += 3
    }
    if (sideDataBandCount === 10 && bandLimit > 27) {
      for (let index = 27; index < bandLimit; index++) {
        row[index] = (values[index] - work.predicted[9]) & WORD_MASK
      }
    }
  }
}

/**
 * Choose the coded prefix and literal tail split with the lowest exact cost.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {WordLengthCostWork} work
 */
function selectPrefixRange(values, count, work) {
  work.rangeLeads.fill(count)
  work.rangeBases.fill(0)
  let minimum = 0
  let maximum = 0
  for (let band = count - 1; band >= 0; band--) {
    const value = values[band]
    if (band === count - 1) {
      minimum = value
      maximum = value
    } else {
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    const range = maximum - minimum
    for (let width = 0; width <= 2; width++) {
      if (range <= (1 << width) - 1) {
        work.rangeLeads[width] = band
        work.rangeBases[width] = minimum
      }
    }
  }
  let lead = count
  let width = RAW_BITS
  let base = 0
  let bits = count * RAW_BITS
  for (let candidateWidth = 0; candidateWidth <= 2; candidateWidth++) {
    const candidateLead = work.rangeLeads[candidateWidth]
    const candidateBits =
      candidateLead * RAW_BITS + (count - candidateLead) * candidateWidth
    if (candidateBits < bits) {
      lead = candidateLead
      width = candidateWidth
      base = work.rangeBases[candidateWidth]
      bits = candidateBits
    }
  }
  work.mode1Lead = lead
  work.mode1Width = width
  work.mode1Base = base
  work.mode1PayloadBits = bits
}

/**
 * Search curve predictor, lead, width, base, and tail combinations and retain the lowest exact cost.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @returns {number}
 */
function priceCurveMode(scratch, work, channelOrdinal, bandLimit) {
  work.rowCosts.fill(0)
  work.rowPlanLeads.fill(0)
  work.rowPlanWidths.fill(0)
  work.rowPlanBases.fill(0)
  work.rowPlanPayloadBits.fill(0)
  let bestSlot = 0
  let bestCost = Infinity
  let bestLead = 0
  let bestWidth = 0
  let bestBase = 0
  let bestPayload = 0
  for (let slot = 0; slot < 16; slot++) {
    const row = Math.trunc(slot / 4)
    const column = slot & 3
    if (scratch.rowNegativeCounts[row] !== 0) continue
    const mapped = scratch.mapIndices[slot]
    const count = scratch.bandCounts[slot]
    let cost = 0
    let lead = 0
    let width = 0
    let base = 0
    let payload = 0
    if (mapped >= 0) {
      cost = work.rowCosts[mapped]
      lead = work.rowPlanLeads[mapped]
      width = work.rowPlanWidths[mapped]
      base = work.rowPlanBases[mapped]
      payload = work.rowPlanPayloadBits[mapped]
    } else if (count > 0) {
      selectPrefixRange(scratch.rows[row], count, work)
      lead = work.mode1Lead
      width = work.mode1Width
      base = work.mode1Base
      payload = work.mode1PayloadBits
      cost = payload + CURVE_HEADER_BITS
    }
    work.rowCosts[column] = cost
    work.rowPlanLeads[column] = lead
    work.rowPlanWidths[column] = width
    work.rowPlanBases[column] = base
    work.rowPlanPayloadBits[column] = payload
    let adjusted = cost
    if (cost > 0 && column !== 0) {
      adjusted += tailExtraBits(column)
      adjusted += tailLiteralBits(column, count, channelOrdinal, bandLimit)
    }
    if ((slot === 0 || adjusted > 0) && adjusted < bestCost) {
      bestSlot = slot
      bestCost = adjusted
      bestLead = lead
      bestWidth = width
      bestBase = base
      bestPayload = payload
    }
  }
  const bestRow = Math.trunc(bestSlot / 4)
  const bestColumn = bestSlot & 3
  work.directFields[0] = 0
  work.directFields[1] = bestColumn
  work.directFields[2] = scratch.bandCounts[bestRow * 4 + bestColumn]
  work.directFields[3] = scratch.rowMeta[bestRow]
  work.directFields[4] = bestRow
  work.mode1Lead = bestLead
  work.mode1Width = bestWidth
  work.mode1Base = bestBase
  work.mode1PayloadBits = bestPayload
  return bestCost + CURVE_BITS + WORD_LENGTH_MODE_BITS
}

/**
 * Measure all legal word-length shape payload variants for one row.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {number} pairFlag
 * @param {ArrayLike<number>} destination
 */
function shapePayloadCosts(values, count, pairFlag, destination) {
  destination[0] = 0
  destination[1] = 0
  if (!pairFlag) {
    for (let band = 0; band < count; band++) {
      const symbol = values[band]
      destination[0] += wordLengthBits(0, symbol)
      destination[1] += wordLengthBits(1, symbol)
    }
    return
  }
  let band = 0
  const pairEnd = count & ~1
  while (band < pairEnd) {
    const first = values[band]
    const second = values[band + 1]
    destination[0]++
    destination[1]++
    if (first !== 0 || second !== 0) {
      destination[0] += wordLengthBits(0, first)
      destination[0] += wordLengthBits(0, second)
      destination[1] += wordLengthBits(1, first)
      destination[1] += wordLengthBits(1, second)
    }
    band += 2
  }
  if (band < count) {
    destination[0] += wordLengthBits(0, values[band])
    destination[1] += wordLengthBits(1, values[band])
  }
}

/**
 * Price direct and paired residual codebooks for one shape group, rejecting its forbidden value range.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} group
 * @returns {boolean}
 */
function priceShapeGroup(scratch, work, group) {
  const count = scratch.bandCounts[group]
  if (count <= 0) return false
  const values = work.shapeRows[group]
  for (let band = 0; band < count; band++) {
    if (values[band] >= 3 && values[band] <= 5) return false
  }
  shapePayloadCosts(values, count, false, work.payloadCosts)
  shapePayloadCosts(values, count, true, work.pairPayloadCosts)
  work.tempCosts[0] = work.payloadCosts[0]
  work.tempCosts[1] = work.payloadCosts[1]
  work.tempCosts[2] = work.pairPayloadCosts[0]
  work.tempCosts[3] = work.pairPayloadCosts[1]
  let selection = 3
  for (let candidate = 2; candidate >= 0; candidate--) {
    if (work.tempCosts[candidate] < work.tempCosts[selection]) {
      selection = candidate
    }
  }
  work.baseCosts[group] = work.tempCosts[selection] + SHAPE_HEADER_BITS
  work.selectors[group] = selection
  return true
}

/**
 * Price the complete predefined-shape mode across mapped groups and retain its selected residual plans.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 */
function priceShapeMode(scratch, work, channelOrdinal, bandLimit) {
  work.baseCosts.fill(0)
  work.adjustedCosts.fill(0)
  work.selectors.fill(0)
  for (let group = 0; group < 4; group++) {
    const mapped = scratch.mapIndices[group]
    if (mapped < 0) {
      priceShapeGroup(scratch, work, group)
    } else {
      work.baseCosts[group] = work.baseCosts[mapped]
      work.selectors[group] = work.selectors[mapped]
    }
    const base = work.baseCosts[group]
    if (base <= 0) {
      work.adjustedCosts[group] = 0
    } else if (group === 0) {
      work.adjustedCosts[group] = base
    } else {
      const count = scratch.bandCounts[group]
      work.adjustedCosts[group] =
        base +
        tailExtraBits(group) +
        tailLiteralBits(group, count, channelOrdinal, bandLimit)
    }
  }
  let bestGroup = 0
  let bestCost = WORD_LENGTH_FORBIDDEN_BITS
  for (let group = 0; group < 4; group++) {
    const cost = work.adjustedCosts[group]
    if (cost > 0 && cost < bestCost) {
      bestGroup = group
      bestCost = cost
    }
  }
  if (bestCost <= 0x3fff) {
    work.predictiveFields[0] = work.selectors[bestGroup]
    work.predictiveFields[1] = bestGroup
    work.predictiveFields[2] = scratch.bandCounts[bestGroup]
    work.predictiveFields[3] = scratch.rowMeta[0]
    work.predictiveFields[4] = 0
    work.costs[2] = bestCost + WORD_LENGTH_MODE_BITS
  } else {
    work.costs[2] = WORD_LENGTH_FORBIDDEN_BITS
  }
}

/**
 * Recompute delta-mode word-length costs for one row after its values change.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} row
 * @param {WordLengthCostWork} work
 */
function refreshDeltaModeRow(scratch, row, work) {
  const baseSlot = row * 4
  if (scratch.rowNegativeCounts[row] !== 0) {
    for (let column = 0; column < 4; column++) {
      for (let codebook = 0; codebook < 4; codebook++) {
        scratch.deltaModeHuffmanBits[
          deltaModeCostIndex(row, column, codebook)
        ] = 0
      }
    }
    return
  }
  work.tempCosts.fill(0)
  let processed = 0
  let accumulatedCount = 1
  for (let step = 0; step < 4; step++) {
    let column = -1
    for (let candidate = 0; candidate < 4; candidate++) {
      if ((processed & (1 << candidate)) !== 0) continue
      if (
        column < 0 ||
        scratch.bandCounts[baseSlot + candidate] <
          scratch.bandCounts[baseSlot + column] ||
        (scratch.bandCounts[baseSlot + candidate] ===
          scratch.bandCounts[baseSlot + column] &&
          candidate < column)
      ) {
        column = candidate
      }
    }
    processed |= 1 << column
    const mapped = scratch.mapIndices[baseSlot + column]
    if (mapped >= 0) {
      for (let codebook = 0; codebook < 4; codebook++) {
        scratch.deltaModeHuffmanBits[
          deltaModeCostIndex(row, column, codebook)
        ] =
          scratch.deltaModeHuffmanBits[
            deltaModeCostIndex(row, mapped, codebook)
          ]
      }
      continue
    }
    const count = scratch.bandCounts[baseSlot + column]
    if (count === 0) continue
    for (let band = accumulatedCount; band < count; band++) {
      const symbol = maskedDelta(
        scratch.rows[row][band],
        scratch.rows[row][band - 1]
      )
      for (let codebook = 0; codebook < 4; codebook++) {
        work.tempCosts[codebook] += wordLengthBits(codebook, symbol)
      }
    }
    accumulatedCount = count
    for (let codebook = 0; codebook < 4; codebook++) {
      scratch.deltaModeHuffmanBits[deltaModeCostIndex(row, column, codebook)] =
        work.tempCosts[codebook]
    }
  }
}

/**
 * Recompute delta-mode candidates for every active channel row.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 */
function refreshDeltaMode(scratch, work) {
  for (let row = 0; row < 4; row++) refreshDeltaModeRow(scratch, row, work)
}

/**
 * Update delta-mode costs after one band edit, rebuilding only rows whose tail partition changed.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} changedBand
 * @param {number} refreshMask Rows requiring complete reconstruction.
 * @param {WordLengthCostWork} work
 */
function refreshDeltaModeIncremental(scratch, changedBand, refreshMask, work) {
  for (let row = 0; row < 4; row++) {
    if ((refreshMask & (1 << row)) !== 0) {
      refreshDeltaModeRow(scratch, row, work)
      continue
    }
    if (scratch.rowNegativeCounts[row] !== 0) continue
    const values = scratch.rows[row]
    const oldValue = work.rowCosts[row]
    const newValue = values[changedBand]
    if (oldValue === newValue) continue
    const leftOld =
      changedBand > 0 ? maskedDelta(oldValue, values[changedBand - 1]) : 0
    const leftNew =
      changedBand > 0 ? maskedDelta(newValue, values[changedBand - 1]) : 0
    const rightOld =
      changedBand + 1 < QUANTIZATION_UNIT_COUNT
        ? maskedDelta(values[changedBand + 1], oldValue)
        : 0
    const rightNew =
      changedBand + 1 < QUANTIZATION_UNIT_COUNT
        ? maskedDelta(values[changedBand + 1], newValue)
        : 0
    const baseSlot = row * 4
    for (let column = 0; column < 4; column++) {
      const mapped = scratch.mapIndices[baseSlot + column]
      if (mapped >= 0) {
        for (let codebook = 0; codebook < 4; codebook++) {
          scratch.deltaModeHuffmanBits[
            deltaModeCostIndex(row, column, codebook)
          ] =
            scratch.deltaModeHuffmanBits[
              deltaModeCostIndex(row, mapped, codebook)
            ]
        }
        continue
      }
      const count = scratch.bandCounts[baseSlot + column]
      for (let codebook = 0; codebook < 4; codebook++) {
        const index = deltaModeCostIndex(row, column, codebook)
        let bits = scratch.deltaModeHuffmanBits[index]
        if (changedBand > 0 && changedBand < count) {
          bits +=
            wordLengthBits(codebook, leftNew) -
            wordLengthBits(codebook, leftOld)
        }
        if (changedBand + 1 < count) {
          bits +=
            wordLengthBits(codebook, rightNew) -
            wordLengthBits(codebook, rightOld)
        }
        scratch.deltaModeHuffmanBits[index] = bits
      }
    }
  }
}

/**
 * Search adjacent-band delta codebooks and tail choices for the lowest exact channel cost.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCostWork} work
 * @returns {number}
 */
function priceDeltaMode(scratch, channelOrdinal, bandLimit, work) {
  let bestSlot = 0
  let bestCodebook = 0
  let bestCost = Infinity
  for (let slot = 0; slot < 16; slot++) {
    const row = Math.trunc(slot / 4)
    const column = slot & 3
    if (scratch.rowNegativeCounts[row] !== 0) continue
    const count = scratch.bandCounts[slot]
    let cost = 0
    let codebook = 0
    if (count > 0) {
      for (let candidate = 0; candidate < 4; candidate++) {
        work.tempCosts[candidate] =
          scratch.deltaModeHuffmanBits[
            deltaModeCostIndex(row, column, candidate)
          ]
      }
      codebook = lowestCostMode(work.tempCosts, 4)
      cost = work.tempCosts[codebook] + DELTA_HEADER_BITS
    }
    let adjusted = cost
    if (column !== 0) {
      adjusted += tailExtraBits(column)
      adjusted += tailLiteralBits(column, count, channelOrdinal, bandLimit)
    }
    if ((slot === 0 || adjusted > 0) && adjusted < bestCost) {
      bestSlot = slot
      bestCodebook = codebook
      bestCost = adjusted
    }
  }
  const row = Math.trunc(bestSlot / 4)
  const column = bestSlot & 3
  work.huffmanFields[0] = bestCodebook
  work.huffmanFields[1] = column
  work.huffmanFields[2] = scratch.bandCounts[row * 4 + column]
  work.huffmanFields[3] = scratch.rowMeta[row]
  work.huffmanFields[4] = row
  return bestCost + CURVE_BITS + WORD_LENGTH_MODE_BITS
}

/**
 * Refresh primary/secondary word-length relation costs after either channel changes.
 *
 * @param {WordLengthScratch} scratch
 * @param {ArrayLike<number>} baseValues
 * @param {WordLengthCostWork} work
 */
function refreshChannelComparisons(scratch, baseValues, work) {
  const current = scratch.rows[0]
  for (let group = 0; group < 4; group++) {
    const mapped = scratch.mapIndices[group]
    if (mapped >= 0) {
      for (let relation = 0; relation < 2; relation++) {
        for (let codebook = 0; codebook < 4; codebook++) {
          scratch.channelHuffmanBits[
            channelCostIndex(relation, group, codebook)
          ] =
            scratch.channelHuffmanBits[
              channelCostIndex(relation, mapped, codebook)
            ]
        }
      }
      continue
    }
    const count = Math.max(scratch.bandCounts[group], 0)
    for (let relation = 0; relation < 2; relation++) {
      work.tempCosts.fill(0)
      let previousValue = 0
      let previousBase = 0
      for (let band = 0; band < count; band++) {
        const value = current[band]
        const base = baseValues[band]
        const symbol = channelSymbol(
          relation,
          band,
          value,
          base,
          previousValue,
          previousBase
        )
        for (let codebook = 0; codebook < 4; codebook++) {
          work.tempCosts[codebook] += wordLengthBits(codebook, symbol)
        }
        previousValue = value
        previousBase = base
      }
      for (let codebook = 0; codebook < 4; codebook++) {
        scratch.channelHuffmanBits[
          channelCostIndex(relation, group, codebook)
        ] = work.tempCosts[codebook]
      }
    }
  }
}

/**
 * Update channel-relation costs after one primary or secondary word length changes.
 *
 * @param {WordLengthScratch} scratch Secondary-channel scratch.
 * @param {ArrayLike<number>} baseValues Current primary word lengths.
 * @param {number} changedBand Changed quantization band.
 * @param {number} oldValue Replaced primary or secondary word length.
 * @param {boolean} changedBase Whether the primary channel changed.
 */
function refreshChannelComparisonsIncremental(
  scratch,
  baseValues,
  changedBand,
  oldValue,
  changedBase
) {
  const current = scratch.rows[0]
  const oldCurrent = changedBase ? current[changedBand] : oldValue
  const newCurrent = current[changedBand]
  const oldBase = changedBase ? oldValue : baseValues[changedBand]
  const newBase = baseValues[changedBand]
  const previousCurrent = changedBand > 0 ? current[changedBand - 1] : 0
  const previousBase = changedBand > 0 ? baseValues[changedBand - 1] : 0
  const oldDirectSymbol = channelSymbol(
    0,
    changedBand,
    oldCurrent,
    oldBase,
    previousCurrent,
    previousBase
  )
  const newDirectSymbol = channelSymbol(
    0,
    changedBand,
    newCurrent,
    newBase,
    previousCurrent,
    previousBase
  )
  const oldPredictiveSymbol = channelSymbol(
    1,
    changedBand,
    oldCurrent,
    oldBase,
    previousCurrent,
    previousBase
  )
  const newPredictiveSymbol = channelSymbol(
    1,
    changedBand,
    newCurrent,
    newBase,
    previousCurrent,
    previousBase
  )
  let oldNextPredictiveSymbol = 0
  let newNextPredictiveSymbol = 0
  if (changedBand + 1 < QUANTIZATION_UNIT_COUNT) {
    const nextCurrent = current[changedBand + 1]
    const nextBase = baseValues[changedBand + 1]
    oldNextPredictiveSymbol = channelSymbol(
      1,
      changedBand + 1,
      nextCurrent,
      nextBase,
      oldCurrent,
      oldBase
    )
    newNextPredictiveSymbol = channelSymbol(
      1,
      changedBand + 1,
      nextCurrent,
      nextBase,
      newCurrent,
      newBase
    )
  }
  for (let group = 0; group < 4; group++) {
    const mapped = scratch.mapIndices[group]
    if (mapped >= 0) {
      for (let relation = 0; relation < 2; relation++) {
        for (let codebook = 0; codebook < 4; codebook++) {
          scratch.channelHuffmanBits[
            channelCostIndex(relation, group, codebook)
          ] =
            scratch.channelHuffmanBits[
              channelCostIndex(relation, mapped, codebook)
            ]
        }
      }
      continue
    }
    const count = Math.max(scratch.bandCounts[group], 0)
    for (let relation = 0; relation < 2; relation++) {
      const oldSymbol = relation === 0 ? oldDirectSymbol : oldPredictiveSymbol
      const newSymbol = relation === 0 ? newDirectSymbol : newPredictiveSymbol
      for (let codebook = 0; codebook < 4; codebook++) {
        const index = channelCostIndex(relation, group, codebook)
        let bits = scratch.channelHuffmanBits[index]
        if (changedBand < count) {
          bits +=
            wordLengthBits(codebook, newSymbol) -
            wordLengthBits(codebook, oldSymbol)
        }
        if (relation === 1 && changedBand + 1 < count) {
          bits +=
            wordLengthBits(codebook, newNextPredictiveSymbol) -
            wordLengthBits(codebook, oldNextPredictiveSymbol)
        }
        scratch.channelHuffmanBits[index] = bits
      }
    }
  }
}

/**
 * Price one secondary-to-primary predictor relation across all active word-length groups.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} relation
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCostWork} work
 * @returns {number}
 */
function priceChannelRelation(
  scratch,
  relation,
  channelOrdinal,
  bandLimit,
  work
) {
  work.baseCosts.fill(0)
  work.adjustedCosts.fill(0)
  work.selectors.fill(0)
  for (let group = 0; group < 4; group++) {
    const mapped = scratch.mapIndices[group]
    const count = scratch.bandCounts[group]
    if (mapped >= 0) {
      work.baseCosts[group] = work.baseCosts[mapped]
      work.selectors[group] = work.selectors[mapped]
    } else if (count > 0) {
      for (let codebook = 0; codebook < 4; codebook++) {
        work.tempCosts[codebook] =
          scratch.channelHuffmanBits[
            channelCostIndex(relation, group, codebook)
          ]
      }
      const codebook = lowestCostMode(work.tempCosts, 4)
      work.selectors[group] = codebook
      work.baseCosts[group] =
        work.tempCosts[codebook] + IO_WORD_LENGTH_SYNTAX_CODEBOOK_HEADER_BITS
    }
    if (group === 0) {
      work.adjustedCosts[group] = work.baseCosts[group]
    } else {
      work.adjustedCosts[group] =
        work.baseCosts[group] +
        tailExtraBits(group) +
        tailLiteralBits(group, count, channelOrdinal, bandLimit)
    }
  }
  const selected = lowestCostMode(work.adjustedCosts, 4)
  const fields = relation === 0 ? work.directFields : work.predictiveFields
  fields[0] = work.selectors[selected]
  fields[1] = selected
  fields[2] = scratch.bandCounts[selected]
  fields[3] = scratch.rowMeta[0]
  fields[4] = 0
  return work.adjustedCosts[selected] + WORD_LENGTH_MODE_BITS
}

/**
 * Reconstruct the literal word-length tail from the selected plan fields.
 *
 * @param {WordLengthCodingPlan} plan
 * @param {ArrayLike<number>} fields
 */
function populateTailFromFields(plan, fields) {
  plan.tailMode = fields[1]
  plan.tailCount = fields[2]
  plan.tailExtra = fields[1] === TAIL_MODE_RUN ? fields[3] : 0
}

/**
 * Materialize the winning word-length modes, predictors, and exact section costs.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} channelOrdinal
 * @param {number} selected
 * @param {WordLengthCodingPlan} plan
 * @returns {WordLengthCodingPlan}
 */
function buildSelectedPlan(scratch, work, channelOrdinal, selected, plan) {
  plan.clear()
  if (selected === 0) return plan
  if (selected === 1 && channelOrdinal === 0) {
    plan.kind = 1
    plan.delta = work.directFields[4]
    populateTailFromFields(plan, work.directFields)
    plan.lead = work.mode1Lead
    plan.width = work.mode1Width
    plan.base = work.mode1Base
    return plan
  }
  if (selected === 2 && channelOrdinal === 0) {
    const group = work.predictiveFields[1]
    const selection = work.predictiveFields[0]
    plan.kind = 2
    populateTailFromFields(plan, work.predictiveFields)
    plan.pairFlag = selection > 1 ? 1 : 0
    plan.codebook = selection & 1
    plan.shapeBase = work.shapeBases[group]
    plan.shapeShift = work.shapeShifts[group]
    return plan
  }
  if ((selected === 1 || selected === 2) && channelOrdinal === 1) {
    const fields = selected === 1 ? work.directFields : work.predictiveFields
    plan.kind = 4
    plan.channelMode = selected - 1
    populateTailFromFields(plan, fields)
    plan.codebook = fields[0]
    return plan
  }
  const row = work.huffmanFields[4]
  plan.kind = 3
  plan.delta = row
  populateTailFromFields(plan, work.huffmanFields)
  plan.codebook = work.huffmanFields[0]
  plan.first = scratch.rows[row][0] >>> 0
  return plan
}

/**
 * Finalize word-length mode choices and publish their exact section accounting.
 *
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} channelOrdinal
 * @param {WordLengthCodingPlan} destination
 * @returns {number}
 */
function finishSelection(scratch, work, channelOrdinal, destination) {
  const selected = lowestCostMode(work.costs, 4)
  buildSelectedPlan(scratch, work, channelOrdinal, selected, destination)
  destination.bits = work.costs[selected]
  return destination.bits
}

/**
 * Build and select the cheapest complete word-length plan for one primary or secondary channel.
 *
 * @param {EncodeChannelState} block
 * @param {EncodeChannelState|null} primary
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} bandLimit
 * @param {number} sideDataBandCount
 * @param {WordLengthCodingPlan} destination
 * @returns {number}
 */
function priceChannelInitial(
  block,
  primary,
  scratch,
  work,
  bandLimit,
  sideDataBandCount,
  destination
) {
  const channelOrdinal = block.channelOrdinal
  const values = block.syntax.wordLengths
  buildRowSplits(scratch, values, channelOrdinal, bandLimit, work)
  refreshDeltaMode(scratch, work)
  if (channelOrdinal === 1) {
    refreshChannelComparisons(scratch, primary.syntax.wordLengths, work)
  } else {
    buildShapeGroups(values, scratch, work, sideDataBandCount, bandLimit)
  }
  work.costs[0] = bandLimit * RAW_BITS
  if (channelOrdinal === 0) {
    work.costs[1] = priceCurveMode(scratch, work, channelOrdinal, bandLimit)
    priceShapeMode(scratch, work, channelOrdinal, bandLimit)
  } else {
    work.costs[1] = priceChannelRelation(
      scratch,
      0,
      channelOrdinal,
      bandLimit,
      work
    )
    work.costs[2] = priceChannelRelation(
      scratch,
      1,
      channelOrdinal,
      bandLimit,
      work
    )
  }
  work.costs[3] = priceDeltaMode(scratch, channelOrdinal, bandLimit, work)
  return finishSelection(scratch, work, channelOrdinal, destination)
}

/**
 * Fully initialize exact entropy plans without publishing channel state.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {number} bandLimit Active word-length count.
 * @param {number} sideDataBandCount Side-data predictor count.
 * @param {WordLengthAccountingTransaction} destination Transaction to overwrite.
 * @returns {WordLengthAccountingTransaction} The destination transaction.
 */
export function planWordLengthSection(
  blocks,
  bandLimit,
  sideDataBandCount,
  destination
) {
  validateWordLengthChannels(blocks)
  validateGeometry(bandLimit, sideDataBandCount)
  if (!(destination instanceof WordLengthAccountingTransaction)) {
    throw new TypeError(
      'ATRAC3plus word-length planning requires fixed storage'
    )
  }
  const transaction = destination.clear(blocks.length)
  transaction.bandLimit = bandLimit
  transaction.sideDataBandCount = sideDataBandCount
  const primary = blocks[0]
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    priceChannelInitial(
      block,
      primary,
      transaction.scratch[channel],
      transaction.work,
      bandLimit,
      sideDataBandCount,
      transaction.plans[channel]
    )
  }
  transaction.initialized = true
  transaction.rawOnly = false
  return transaction
}

/**
 * Initialize the reference allocator's raw three-bit starting image.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {number} bandLimit Active word-length count.
 * @param {WordLengthAccountingTransaction} destination Transaction to overwrite.
 * @returns {WordLengthAccountingTransaction} The destination transaction.
 */
export function planRawWordLengthSection(blocks, bandLimit, destination) {
  validateWordLengthChannels(blocks)
  validateGeometry(bandLimit, 0)
  if (!(destination instanceof WordLengthAccountingTransaction)) {
    throw new TypeError(
      'ATRAC3plus raw word-length planning requires fixed storage'
    )
  }
  const transaction = destination.clear(blocks.length)
  transaction.bandLimit = bandLimit
  for (let channel = 0; channel < blocks.length; channel++) {
    transaction.plans[channel].clear()
    transaction.plans[channel].bits = bandLimit * RAW_BITS
  }
  transaction.initialized = true
  transaction.rawOnly = true
  return transaction
}

/**
 * Recompute only the word-length row partitions invalidated by a candidate mutation.
 *
 * @param {WordLengthScratch} scratch
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {number} changedBand
 * @param {number} newValue
 * @param {WordLengthCostWork} work
 * @returns {number} Bit mask of rows requiring complete delta-mode refresh.
 */
function rebuildChangedRowSplits(
  scratch,
  channelOrdinal,
  bandLimit,
  changedBand,
  newValue,
  work
) {
  let refreshMask = 0
  const oldEnabledMask =
    (scratch.rowNegativeCounts[0] === 0 ? 1 : 0) |
    (scratch.rowNegativeCounts[1] === 0 ? 2 : 0) |
    (scratch.rowNegativeCounts[2] === 0 ? 4 : 0) |
    (scratch.rowNegativeCounts[3] === 0 ? 8 : 0)
  for (let row = 0; row < 4; row++) {
    work.rowCosts[row] = scratch.rows[row][changedBand]
  }
  scratch.rows[0][changedBand] = newValue
  updateRowMask(scratch, 0, changedBand, newValue)
  for (let row = 1; row < 4; row++) {
    const oldValue = work.rowCosts[row]
    const value = newValue - deltaCurveValue(channelOrdinal, row, changedBand)
    if (oldValue >= 0 && value < 0) scratch.rowNegativeCounts[row]++
    else if (oldValue < 0 && value >= 0) scratch.rowNegativeCounts[row]--
    scratch.rows[row][changedBand] = value
    updateRowMask(scratch, row, changedBand, value)
  }
  for (let row = 0; row < 4; row++) {
    const wasEnabled = (oldEnabledMask & (1 << row)) !== 0
    const baseSlot = row * 4
    if (scratch.rowNegativeCounts[row] !== 0) {
      if (wasEnabled) {
        refreshMask |= 1 << row
        scratch.rowMeta[row] = 0
        for (let column = 0; column < 4; column++) {
          scratch.bandCounts[baseSlot + column] = bandLimit
          scratch.mapIndices[baseSlot + column] = -1
        }
      }
      continue
    }
    let tailMayChange = !wasEnabled
    for (let column = 1; column < 4 && !tailMayChange; column++) {
      const count = scratch.bandCounts[baseSlot + column]
      tailMayChange = changedBand >= count - 1 || count === bandLimit
    }
    if (!tailMayChange) continue
    buildTailProfile(
      scratch,
      row,
      channelOrdinal,
      bandLimit,
      work.adjustedCosts
    )
    let countsChanged = !wasEnabled
    for (let column = 0; column < 4; column++) {
      if (
        scratch.bandCounts[baseSlot + column] !== work.adjustedCosts[column]
      ) {
        countsChanged = true
      }
    }
    if (countsChanged) {
      refreshMask |= 1 << row
      for (let column = 0; column < 4; column++) {
        scratch.bandCounts[baseSlot + column] = work.adjustedCosts[column]
      }
      buildMapIndices(scratch, baseSlot)
    }
  }
  return refreshMask
}

/**
 * Reprice only the word-length groups affected by one changed channel-band value.
 *
 * @param {EncodeChannelState} block
 * @param {EncodeChannelState|null} primary
 * @param {WordLengthScratch} scratch
 * @param {WordLengthCostWork} work
 * @param {number} bandLimit
 * @param {number} sideDataBandCount
 * @param {number} changedChannel
 * @param {number} changedBand
 * @param {number} oldWordLength Replaced word length in the changed channel.
 * @param {WordLengthCodingPlan} destination
 * @returns {number}
 */
function repriceChannelIncremental(
  block,
  primary,
  scratch,
  work,
  bandLimit,
  sideDataBandCount,
  changedChannel,
  changedBand,
  oldWordLength,
  destination
) {
  const channelOrdinal = block.channelOrdinal
  work.costs[0] = bandLimit * RAW_BITS
  if (channelOrdinal === changedChannel) {
    const refreshMask = rebuildChangedRowSplits(
      scratch,
      channelOrdinal,
      bandLimit,
      changedBand,
      block.syntax.wordLengths[changedBand],
      work
    )
    refreshDeltaModeIncremental(scratch, changedBand, refreshMask, work)
    if (channelOrdinal === 0) {
      buildShapeGroups(
        block.syntax.wordLengths,
        scratch,
        work,
        sideDataBandCount,
        bandLimit
      )
    } else {
      if ((refreshMask & 1) !== 0) {
        refreshChannelComparisons(scratch, primary.syntax.wordLengths, work)
      } else {
        refreshChannelComparisonsIncremental(
          scratch,
          primary.syntax.wordLengths,
          changedBand,
          oldWordLength,
          false
        )
      }
    }
  } else if (channelOrdinal === 1 && changedChannel === 0) {
    refreshChannelComparisonsIncremental(
      scratch,
      primary.syntax.wordLengths,
      changedBand,
      oldWordLength,
      true
    )
  }

  if (channelOrdinal === 0) {
    work.costs[1] = priceCurveMode(scratch, work, channelOrdinal, bandLimit)
    priceShapeMode(scratch, work, channelOrdinal, bandLimit)
  } else {
    work.costs[1] = priceChannelRelation(
      scratch,
      0,
      channelOrdinal,
      bandLimit,
      work
    )
    work.costs[2] = priceChannelRelation(
      scratch,
      1,
      channelOrdinal,
      bandLimit,
      work
    )
  }
  work.costs[3] = priceDeltaMode(scratch, channelOrdinal, bandLimit, work)
  return finishSelection(scratch, work, channelOrdinal, destination)
}

/**
 * Price one already-applied word-length edit into a discardable candidate.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {number} changedChannel Changed channel ordinal.
 * @param {number} changedBand Changed band index.
 * @param {WordLengthAccountingTransaction} transaction Active transaction.
 * @returns {number} Exact candidate section width.
 */
export function repriceWordLengthSection(
  blocks,
  changedChannel,
  changedBand,
  transaction
) {
  if (
    !(transaction instanceof WordLengthAccountingTransaction) ||
    !transaction.initialized ||
    transaction.rawOnly ||
    transaction.channelCount !== blocks.length ||
    !Number.isInteger(changedChannel) ||
    changedChannel < 0 ||
    changedChannel >= blocks.length ||
    !Number.isInteger(changedBand) ||
    changedBand < 0 ||
    changedBand >= transaction.bandLimit
  ) {
    throw new RangeError(
      'ATRAC3plus incremental word-length request is invalid'
    )
  }
  const bandLimit = transaction.bandLimit
  const sideDataBandCount = transaction.sideDataBandCount
  const oldWordLength = transaction.scratch[changedChannel].rows[0][changedBand]
  transaction.prepareCandidate(changedChannel)
  let candidateBits = transaction.bits
  const primary = blocks[0]
  for (let channel = changedChannel; channel < blocks.length; channel++) {
    const scratch = transaction.candidateScratch[channel]
    const bits = repriceChannelIncremental(
      blocks[channel],
      primary,
      scratch,
      transaction.work,
      bandLimit,
      sideDataBandCount,
      changedChannel,
      changedBand,
      oldWordLength,
      transaction.candidatePlans[channel]
    )
    candidateBits += bits - transaction.plans[channel].bits
  }
  return candidateBits
}

/**
 * Emit one word-length residual from the selected canonical codebook, rejecting forbidden symbols.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function writeCanonical(codebook, symbol, sink) {
  if (!writeCanonicalSymbol(WORD_LENGTH_CODEBOOKS[codebook], symbol, sink)) {
    throw new RangeError('ATRAC3plus word-length symbol is not packable')
  }
}

/**
 * Emit the optional trailing-run mode, bounded count, and fill value selected by the plan.
 *
 * @param {WordLengthCodingPlan} plan
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {boolean} zeroCountIsFull
 * @param {BitWriter|BitCounter} sink
 */
function packTail(plan, channelOrdinal, bandLimit, zeroCountIsFull, sink) {
  sink.write(plan.tailMode, 2)
  if (plan.tailMode === TAIL_MODE_NONE) return
  const packedCount =
    zeroCountIsFull && plan.tailCount === bandLimit ? 0 : plan.tailCount
  sink.write(packedCount, 5)
  if (plan.tailMode === TAIL_MODE_RUN) {
    sink.write(plan.tailExtra - (channelOrdinal === 0 ? 1 : 3), 2)
  }
}

/**
 * Emit secondary-channel literal tail values when they cannot be represented by a uniform run.
 *
 * @param {ArrayLike<number>} values
 * @param {WordLengthCodingPlan} plan
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {BitWriter|BitCounter} sink
 */
function packTailLiterals(values, plan, channelOrdinal, bandLimit, sink) {
  if (channelOrdinal !== 1 || plan.tailMode !== TAIL_MODE_ONES_OR_BITS) {
    return
  }
  for (let band = plan.tailCount; band < bandLimit; band++) {
    sink.write(values[band], 1)
  }
}

/**
 * Convert an absolute word length to the residual emitted by the selected curve.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} delta
 * @param {number} band
 * @returns {number}
 */
function encodedCurveValue(values, channelOrdinal, delta, band) {
  return values[band] - deltaCurveValue(channelOrdinal, delta, band)
}

/**
 * Emit a primary curve predictor, literal lead, residual row, and optional tail.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCodingPlan} plan
 * @param {BitWriter|BitCounter} sink
 */
function packCurve(values, channelOrdinal, bandLimit, plan, sink) {
  sink.write(plan.delta, 2)
  packTail(plan, channelOrdinal, bandLimit, true, sink)
  const count = plan.tailCount
  if (count > 0) {
    sink.write(plan.lead, 5)
    sink.write(plan.width, 2)
    sink.write(plan.base, 3)
    for (let band = 0; band < plan.lead; band++) {
      sink.write(encodedCurveValue(values, channelOrdinal, plan.delta, band), 3)
    }
    if (plan.width > 0) {
      for (let band = plan.lead; band < count; band++) {
        sink.write(
          encodedCurveValue(values, channelOrdinal, plan.delta, band) -
            plan.base,
          plan.width
        )
      }
    }
  }
  if (channelOrdinal === 1 && plan.tailMode === TAIL_MODE_ONES_OR_BITS) {
    for (let band = count; band < bandLimit; band++) {
      sink.write(encodedCurveValue(values, channelOrdinal, plan.delta, band), 1)
    }
  }
}

/**
 * Emit a primary predefined shape, grouped residuals, and optional tail.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCodingPlan} plan
 * @param {BitWriter|BitCounter} sink
 */
function packShape(values, channelOrdinal, bandLimit, plan, sink) {
  packTail(plan, channelOrdinal, bandLimit, false, sink)
  const count = plan.tailCount
  if (count > 0) {
    sink.write(plan.pairFlag, 1)
    sink.write(plan.codebook, 1)
    sink.write(plan.shapeBase, 3)
    sink.write(plan.shapeShift, 4)
    if (plan.pairFlag === 0) {
      for (let band = 0; band < count; band++) {
        const symbol = maskedDelta(
          values[band],
          shapeBaseValue(plan.shapeBase, plan.shapeShift, band)
        )
        writeCanonical(plan.codebook, symbol, sink)
      }
    } else {
      let band = 0
      const pairEnd = count & ~1
      while (band < pairEnd) {
        const first = maskedDelta(
          values[band],
          shapeBaseValue(plan.shapeBase, plan.shapeShift, band)
        )
        const second = maskedDelta(
          values[band + 1],
          shapeBaseValue(plan.shapeBase, plan.shapeShift, band + 1)
        )
        const keep = first === 0 && second === 0 ? 1 : 0
        sink.write(keep, 1)
        if (keep === 0) {
          writeCanonical(plan.codebook, first, sink)
          writeCanonical(plan.codebook, second, sink)
        }
        band += 2
      }
      if (band < count) {
        writeCanonical(
          plan.codebook,
          maskedDelta(
            values[band],
            shapeBaseValue(plan.shapeBase, plan.shapeShift, band)
          ),
          sink
        )
      }
    }
  }
  packTailLiterals(values, plan, channelOrdinal, bandLimit, sink)
}

/**
 * Emit a first literal word length followed by wrapped adjacent-band deltas and an optional tail.
 *
 * @param {ArrayLike<number>} values
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCodingPlan} plan
 * @param {BitWriter|BitCounter} sink
 */
function packDelta(values, channelOrdinal, bandLimit, plan, sink) {
  sink.write(plan.delta, 2)
  packTail(plan, channelOrdinal, bandLimit, false, sink)
  const count = plan.tailCount
  if (count > 0) {
    sink.write(plan.codebook, 2)
    sink.write(plan.first, 3)
    let previous = plan.first
    for (let band = 1; band < count; band++) {
      const value = encodedCurveValue(values, channelOrdinal, plan.delta, band)
      writeCanonical(plan.codebook, maskedDelta(value, previous), sink)
      previous = value
    }
  }
  if (channelOrdinal === 1 && plan.tailMode === TAIL_MODE_ONES_OR_BITS) {
    for (let band = count; band < bandLimit; band++) {
      sink.write(encodedCurveValue(values, channelOrdinal, plan.delta, band), 1)
    }
  }
}

/**
 * Emit the selected raw or predicted word-length syntax for one primary or secondary channel.
 *
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>} baseValues
 * @param {number} channelOrdinal
 * @param {number} bandLimit
 * @param {WordLengthCodingPlan} plan
 * @param {BitWriter|BitCounter} sink
 */
function packChannel(
  values,
  baseValues,
  channelOrdinal,
  bandLimit,
  plan,
  sink
) {
  packTail(plan, channelOrdinal, bandLimit, false, sink)
  const count = plan.tailCount
  if (count > 0) {
    sink.write(plan.codebook, 2)
    let previousValue = 0
    let previousBase = 0
    for (let band = 0; band < count; band++) {
      const value = values[band]
      const base = baseValues[band]
      const symbol = channelSymbol(
        plan.channelMode,
        band,
        value,
        base,
        previousValue,
        previousBase
      )
      writeCanonical(plan.codebook, symbol, sink)
      previousValue = value
      previousBase = base
    }
  }
  packTailLiterals(values, plan, channelOrdinal, bandLimit, sink)
}

/**
 * Emit the selected private plan in coding-unit wire order.
 *
 * @param {EncodeChannelState[]} blocks
 * @param {number} bandLimit
 * @param {WordLengthCodingPlan[]} plans
 * @param {BitWriter|BitCounter} sink
 */
function packWordLengthPlans(blocks, bandLimit, plans, sink) {
  const primaryValues = blocks[0].syntax.wordLengths
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    const values = block.syntax.wordLengths
    const plan = plans[channel]
    sink.write(plan.packMode, WORD_LENGTH_MODE_BITS)
    switch (plan.kind) {
      case 0:
        for (let band = 0; band < bandLimit; band++) {
          sink.write(values[band], RAW_BITS)
        }
        break
      case 1:
        packCurve(values, block.channelOrdinal, bandLimit, plan, sink)
        break
      case 2:
        packShape(values, block.channelOrdinal, bandLimit, plan, sink)
        break
      case 3:
        packDelta(values, block.channelOrdinal, bandLimit, plan, sink)
        break
      case 4:
        packChannel(
          values,
          primaryValues,
          block.channelOrdinal,
          bandLimit,
          plan,
          sink
        )
        break
      default:
        throw new RangeError('ATRAC3plus word-length plan kind is invalid')
    }
  }
}

/**
 * Verify that a selected word-length plan matches its channel set, band limit, accounting, and output sink.
 *
 * @param {EncodeChannelState[]} blocks
 * @param {WordLengthAccountingTransaction} transaction
 * @param {BitWriter|BitCounter} sink
 */
function validatePackRequest(blocks, transaction, sink) {
  validateWordLengthChannels(blocks)
  if (
    !(transaction instanceof WordLengthAccountingTransaction) ||
    !transaction.initialized ||
    transaction.channelCount !== blocks.length ||
    typeof sink?.write !== 'function'
  ) {
    throw new TypeError('ATRAC3plus word-length pack arguments are invalid')
  }
}

/**
 * Emit the accepted private plan in coding-unit wire order.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {WordLengthAccountingTransaction} transaction Accepted transaction.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packWordLengthSection(blocks, transaction, sink) {
  validatePackRequest(blocks, transaction, sink)
  packWordLengthPlans(blocks, transaction.bandLimit, transaction.plans, sink)
}
