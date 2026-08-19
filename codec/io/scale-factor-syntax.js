/** ATRAC3plus scale-factor representation pricing and wire emission. */

import { packableSymbolBits, writeCanonicalSymbol } from '../coding/entropy.js'
import {
  SCALE_FACTOR_DIRECT_CODEBOOKS,
  SCALE_FACTOR_GROUP_CODEBOOKS,
  SCALE_FACTOR_MODE_2_DELTAS,
  SCALE_FACTOR_SHAPE_CODEBOOK,
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
  SQUARED_DELTAS,
} from '../core/tables.js'

import {
  QUANTIZATION_UNIT_COUNT,
  SCALE_FACTOR_MODE_BITS,
  SCALE_FACTOR_RANGE_MAX_WIDTH,
  IO_SCALE_FACTOR_SYNTAX_CODEBOOK_HEADER_BITS,
  FIVE_BAND_AVERAGE_SCALE,
  IO_SCALE_FACTOR_SYNTAX_GROUP_FIRST_BIAS,
  IO_SCALE_FACTOR_SYNTAX_GROUP_MASK,
  MODE1_RAW_HEADER_BITS,
  MODE1_SHAPE_HEADER_BITS,
  MODE3_RAW_HEADER_BITS,
  MODE3_SHAPE_HEADER_BITS_EXCLUDING_FIRST_DELTA,
  SCALE_FACTOR_FORBIDDEN_BITS,
  SCALE_FACTOR_MASK,
  IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS,
  IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS,
  SHAPE_CODEBOOK_COUNT,
  IO_SCALE_FACTOR_SYNTAX_SHAPE_CODEBOOK_STRIDE,
} from '../core/constants.js'
import {
  ScaleFactorCodingPlan,
  validateScaleFactorChannels,
} from '../state/scale-factor.js'

/**
 * Validate active scale-factor and shape counts and return the coded band count.
 *
 * @param {SharedState} shared
 * @returns {number}
 */
function validateGeometry(shared) {
  const count = shared?.scaleFactorCount
  const groupCount = shared?.shapeCount
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > QUANTIZATION_UNIT_COUNT ||
    !Number.isInteger(groupCount) ||
    groupCount < 1 ||
    groupCount > 16
  ) {
    throw new RangeError('ATRAC3plus scale-factor geometry is out of range')
  }
  return count
}

/**
 * Interpret an unsigned byte as a signed two's-complement delta.
 *
 * @param {number} value
 * @returns {number}
 */
function signedByte(value) {
  return (value << 24) >> 24
}

/**
 * Wrap a signed scale-factor delta into the six-bit coded domain.
 *
 * @param {number} value
 * @returns {number}
 */
function wrapSigned6(value) {
  if (value > 31) return value - 64
  if (value < -32) return value + 64
  return value
}

/**
 * Return the number of scale-factor shape values required by the active band count.
 *
 * @param {number} count
 * @returns {number}
 */
function shapeCount(count) {
  if (count < 1 || count > SHAPE_INDEX_BY_QUANTIZATION_UNIT.length) {
    return 0
  }
  return SHAPE_INDEX_BY_QUANTIZATION_UNIT[count - 1] + 1
}

/**
 * Map a quantization band to its scale-factor shape group.
 *
 * @param {number} band
 * @returns {number}
 */
function shapeGroupForBand(band) {
  return SHAPE_INDEX_BY_QUANTIZATION_UNIT[band] ?? 0
}

/**
 * Compute the representative scale-factor average for one shape group.
 *
 * @param {ArrayLike<number>} values
 * @param {number} groupCount
 * @param {number} group
 * @returns {number}
 */
function shapeAverage(values, groupCount, group) {
  if (group < 0 || group >= groupCount) return 0
  const special = groupCount === 10 && group === 9
  const start = special ? 27 : group * 3
  const end = special ? 32 : start + 3
  let sum = 0
  for (let band = start; band < end; band++) sum += values[band]
  return Math.trunc(
    (end - start === 5 ? sum * FIVE_BAND_AVERAGE_SCALE : sum / 3) + 0.5
  )
}

/**
 * Wrap a shape residual into the selected scale-factor codebook domain.
 *
 * @param {number} codebook
 * @param {number} group
 * @returns {number}
 */
function shapeCodebookDelta(codebook, group) {
  if (group === 0) return 0
  return signedByte(
    SCALE_FACTOR_SHAPE_CODEBOOK[
      codebook * IO_SCALE_FACTOR_SYNTAX_SHAPE_CODEBOOK_STRIDE + group - 1
    ]
  )
}

/**
 * Choose the scale-factor shape codebook with the lowest valid residual cost.
 *
 * @param {ArrayLike<number>} values
 * @param {number} offset
 * @param {number} count
 * @param {number} groupCount
 * @param {number} primaryAverage
 * @returns {number}
 */
function selectShapeCodebook(values, count, groupCount, primaryAverage) {
  const groups = shapeCount(count)
  if (groups <= 1) return 0
  let bestCodebook = 0
  let bestCost = Infinity
  for (let codebook = 0; codebook < SHAPE_CODEBOOK_COUNT; codebook++) {
    let cost = 0
    for (let group = 1; group < groups; group++) {
      const actual =
        group < groupCount
          ? primaryAverage - shapeAverage(values, groupCount, group)
          : 0
      const delta = Math.abs(actual - shapeCodebookDelta(codebook, group))
      cost += SQUARED_DELTAS[delta]
    }
    if (cost < bestCost) {
      bestCost = cost
      bestCodebook = codebook
    }
  }
  return bestCodebook
}

/**
 * Convert an absolute scale factor to the biased value stored by syntax mode two.
 *
 * @param {number} raw
 * @param {number} submode
 * @param {number} band
 * @returns {number}
 */
function mode2StoredValue(raw, submode, band) {
  if (submode === 1 || submode === 2) {
    return raw + (SCALE_FACTOR_MODE_2_DELTAS[submode - 1][band] ?? 0)
  }
  return raw
}

/**
 * Compute the predictor residual between a scale factor and its shape value.
 *
 * @param {number} value
 * @param {number} groupCount
 * @param {number} baseValue
 * @param {number} codebook
 * @param {number} band
 * @returns {number}
 */
function shapeResidual(value, groupCount, baseValue, codebook, band) {
  const group = shapeGroupForBand(band)
  if (group >= groupCount) return 0
  const base = baseValue - shapeCodebookDelta(codebook, group)
  return wrapSigned6(value - base)
}

/**
 * Wrap a predictor-relative value into the fixed-width unsigned syntax domain.
 *
 * @param {number} value
 * @param {number} reference
 * @returns {number}
 */
function maskedDelta(value, reference) {
  return (value - reference) & SCALE_FACTOR_MASK
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
  return (delta - maskedDelta(previousValue, previousBase)) & SCALE_FACTOR_MASK
}

/**
 * Measure one symbol against every candidate scale-factor codebook.
 *
 * @param {ArrayLike<number>[]} codebooks
 * @param {ArrayLike<number>} symbols
 * @param {number} symbolCount
 * @param {ArrayLike<number>} costs
 * @returns {ArrayLike<number>}
 */
function symbolBitsByCodebook(codebooks, symbols, symbolCount, costs) {
  costs.fill(0)
  for (let index = 0; index < symbolCount; index++) {
    const symbol = symbols[index]
    for (let codebook = 0; codebook < 4; codebook++) {
      const bits = packableSymbolBits(codebooks[codebook], symbol)
      if (bits === null) {
        costs[codebook] = SCALE_FACTOR_FORBIDDEN_BITS
      } else if (costs[codebook] < SCALE_FACTOR_FORBIDDEN_BITS) {
        costs[codebook] += bits
      }
    }
  }
  return costs
}

/**
 * Return the first scale-factor mode attaining the minimum measured cost.
 *
 * @param {ArrayLike<number>} costs
 * @returns {number}
 */
function lowestCostMode(costs) {
  let mode = 0
  let cost = costs[0]
  for (let candidate = 1; candidate < costs.length; candidate++) {
    if (costs[candidate] < cost) {
      mode = candidate
      cost = costs[candidate]
    }
  }
  return mode
}

/**
 * Choose the lowest positive-cost scale-factor mode while using the seed to break ties.
 *
 * @param {ArrayLike<number>} costs
 * @returns {number}
 */
function seededPositiveCostMode(costs) {
  let mode = 0
  let cost = costs[0]
  for (let candidate = 1; candidate < costs.length; candidate++) {
    if (costs[candidate] > 0 && costs[candidate] < cost) {
      mode = candidate
      cost = costs[candidate]
    }
  }
  return mode
}

/**
 * Construct the direct scale-factor range candidate and its exact payload cost.
 *
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {number} slot
 * @param {ScaleFactorPlanningScratch} scratch
 */
function rawRangePlan(values, offset, count, slot, scratch) {
  let bestLead = count
  let bestWidth = IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS
  let bestBase = 0
  let bestBits = count * 6
  for (let width = 0; width <= SCALE_FACTOR_RANGE_MAX_WIDTH; width++) {
    const limit = (1 << width) - 1
    let lead = count
    let base = 0
    let minimum = 0
    let maximum = 0
    for (let band = count - 1; band >= 0; band--) {
      const value = values[offset + band]
      if (band === count - 1) {
        minimum = value
        maximum = value
      } else {
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
      if (maximum - minimum > limit) break
      lead = band
      base = minimum
    }
    const bits = lead * 6 + (count - lead) * width
    if (bits < bestBits) {
      bestLead = lead
      bestWidth = width
      bestBase = base
      bestBits = bits
    }
  }
  scratch.rangeLeads[slot] = bestLead
  scratch.rangeWidths[slot] = bestWidth
  scratch.rangeBases[slot] = bestBase
  scratch.rangeCosts[slot] = bestBits + MODE1_RAW_HEADER_BITS
}

/**
 * Construct a scale-factor shape/range candidate and its exact payload cost.
 *
 * @param {ArrayLike<number>} values
 * @param {number} offset
 * @param {number} count
 * @param {number} slot
 * @param {ScaleFactorPlanningScratch} scratch
 * @returns {boolean}
 */
function shapeRangePlan(values, offset, count, slot, scratch) {
  let found = false
  let bestLead = 0
  let bestWidth = 0
  let bestBase = 0
  let bestBits = 0
  for (let lead = 0; lead < count; lead++) {
    let valid = true
    for (let band = 0; band < lead; band++) {
      if (
        ((values[offset + band] | 0) + IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS) >>>
          0 >
        IO_SCALE_FACTOR_SYNTAX_GROUP_MASK
      ) {
        valid = false
        break
      }
    }
    if (!valid) continue
    let minimum = values[offset + lead] | 0
    let maximum = minimum
    for (let band = lead + 1; band < count; band++) {
      const value = values[offset + band] | 0
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    if (
      (minimum + IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS) >>> 0 >
      IO_SCALE_FACTOR_SYNTAX_GROUP_MASK
    )
      continue
    const range = maximum - minimum
    const width =
      range === 0 ? 0 : range <= 1 ? 1 : range <= 3 ? 2 : range <= 7 ? 3 : -1
    if (width < 0) continue
    const bits = lead * 4 + (count - lead) * width
    if (!found || bits < bestBits) {
      found = true
      bestLead = lead
      bestWidth = width
      bestBase = minimum
      bestBits = bits
    }
  }
  if (found) {
    scratch.rangeLeads[slot] = bestLead
    scratch.rangeWidths[slot] = bestWidth
    scratch.rangeBases[slot] = bestBase
    scratch.rangeCosts[slot] = bestBits + MODE1_SHAPE_HEADER_BITS
  }
  return found
}

/**
 * Build predictor-relative scale-factor symbols for the direct-delta modes.
 *
 * @param {ArrayLike<number>} values
 * @param {number} offset
 * @param {number} count
 * @param {ArrayLike<number>} symbols
 * @returns {number}
 */
function directDeltaSymbols(values, offset, count, symbols) {
  for (let band = 1; band < count; band++) {
    symbols[band - 1] = maskedDelta(
      values[offset + band],
      values[offset + band - 1]
    )
  }
  return Math.max(count - 1, 0)
}

/**
 * Build secondary-channel scale-factor symbols predicted from the primary channel.
 *
 * @param {ArrayLike<number>} current
 * @param {ArrayLike<number>} primary
 * @param {number} count
 * @param {number} relation
 * @param {ArrayLike<number>} symbols
 * @returns {number}
 */
function pairedChannelSymbols(current, primary, count, relation, symbols) {
  let previousValue = 0
  let previousBase = 0
  for (let band = 0; band < count; band++) {
    const value = current[band]
    const base = primary[band]
    symbols[band] = channelSymbol(
      relation,
      band,
      value,
      base,
      previousValue,
      previousBase
    )
    previousValue = value
    previousBase = base
  }
  return count
}

/**
 * Measure scale-factor delta costs for every legal grouping of the active row.
 *
 * @param {ArrayLike<number>} values
 * @param {number} offset
 * @param {number} count
 * @param {ArrayLike<number>} costs
 * @returns {boolean}
 */
function groupedDeltaCosts(values, offset, count, costs) {
  if (count === 0) return false
  costs.fill(4)
  let previous = values[offset] | 0
  if (
    (previous + IO_SCALE_FACTOR_SYNTAX_GROUP_FIRST_BIAS) >>> 0 >
    IO_SCALE_FACTOR_SYNTAX_GROUP_MASK
  )
    return false
  for (let band = 1; band < count; band++) {
    const current = values[offset + band] | 0
    const full = (current - previous) & SCALE_FACTOR_MASK
    previous = current
    if ((full - IO_SCALE_FACTOR_SYNTAX_GROUP_FIRST_BIAS) >>> 0 <= 0x30)
      return false
    const code = full & IO_SCALE_FACTOR_SYNTAX_GROUP_MASK
    for (let codebook = 0; codebook < 4; codebook++) {
      const bits = packableSymbolBits(
        SCALE_FACTOR_GROUP_CODEBOOKS[codebook],
        code
      )
      if (bits === null) return false
      costs[codebook] += bits
    }
  }
  return true
}

/**
 * Choose the lowest-cost primary-channel scale-factor range and predictor modes.
 *
 * @param {EncodeChannelState} block
 * @param {number} count
 * @param {number} groupCount
 * @param {ScaleFactorEncodeState} destination
 * @param {ScaleFactorPlanningScratch} scratch
 * @returns {number}
 */
function planPrimary(block, count, groupCount, destination, scratch) {
  if (block.channelOrdinal !== 0) {
    throw new RangeError('ATRAC3plus primary scale-factor ordinal must be zero')
  }
  const syntaxValues = block.syntax.scaleFactors
  const average = shapeAverage(syntaxValues, groupCount, 0)
  const shapeCodebook = selectShapeCodebook(
    syntaxValues,
    count,
    groupCount,
    average
  )
  const encode = destination
  const rows = encode.mode2Values
  for (let band = 0; band < count; band++) {
    const raw = syntaxValues[band]
    rows[band] = mode2StoredValue(raw, 0, band) >>> 0
    rows[32 + band] = mode2StoredValue(raw, 1, band) >>> 0
    rows[64 + band] = mode2StoredValue(raw, 2, band) >>> 0
    rows[96 + band] =
      shapeResidual(raw, groupCount, average, shapeCodebook, band) >>> 0
  }
  encode.baseValue = average >>> 0
  encode.codebookIndex = shapeCodebook

  const choiceBits = scratch.choiceBits
  choiceBits[0] = count * IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS
  choiceBits[2] = SCALE_FACTOR_FORBIDDEN_BITS
  scratch.rangeCosts.fill(0)
  let validSubmodes = 0
  for (let submode = 0; submode <= 2; submode++) {
    const offset = submode * QUANTIZATION_UNIT_COUNT
    let valid = true
    for (let band = 0; band < count; band++) {
      if (rows[offset + band] > SCALE_FACTOR_MASK) {
        valid = false
        break
      }
    }
    if (!valid) continue
    validSubmodes |= 1 << submode
    rawRangePlan(rows, offset, count, submode, scratch)
  }
  shapeRangePlan(rows, 3 * QUANTIZATION_UNIT_COUNT, count, 3, scratch)
  const selectedRange = seededPositiveCostMode(scratch.rangeCosts)
  encode.lead = scratch.rangeLeads[selectedRange]
  encode.width = scratch.rangeWidths[selectedRange]
  encode.base = scratch.rangeBases[selectedRange] >>> 0
  choiceBits[1] = scratch.rangeCosts[selectedRange]

  scratch.deltaCosts.fill(0)
  for (let submode = 0; submode <= 2; submode++) {
    if ((validSubmodes & (1 << submode)) === 0) continue
    const symbolCount = directDeltaSymbols(
      rows,
      submode * QUANTIZATION_UNIT_COUNT,
      count,
      scratch.symbols
    )
    symbolBitsByCodebook(
      SCALE_FACTOR_DIRECT_CODEBOOKS,
      scratch.symbols,
      symbolCount,
      scratch.costs
    )
    for (let codebook = 0; codebook < 4; codebook++)
      scratch.costs[codebook] += MODE3_RAW_HEADER_BITS
    const selected = lowestCostMode(scratch.costs)
    scratch.deltaCosts[submode] = scratch.costs[selected]
    scratch.deltaCodebooks[submode] = selected
  }
  if (
    groupedDeltaCosts(rows, 3 * QUANTIZATION_UNIT_COUNT, count, scratch.costs)
  ) {
    const selected = lowestCostMode(scratch.costs)
    scratch.deltaCosts[3] =
      scratch.costs[selected] + MODE3_SHAPE_HEADER_BITS_EXCLUDING_FIRST_DELTA
    scratch.deltaCodebooks[3] = selected
  }
  const selectedDelta = seededPositiveCostMode(scratch.deltaCosts)
  choiceBits[3] = scratch.deltaCosts[selectedDelta]

  const selected = lowestCostMode(choiceBits)
  encode.modeSelect = selected
  encode.mode = selected === 3 ? scratch.deltaCodebooks[selectedDelta] : 0
  encode.mode2 =
    selected === 1 ? selectedRange : selected === 3 ? selectedDelta : 0
  return choiceBits[selected]
}

/**
 * Choose the lowest-cost secondary-channel modes relative to the retained primary plan.
 *
 * @param {EncodeChannelState} block
 * @param {EncodeChannelState[]} blocks
 * @param {number} count
 * @param {ScaleFactorEncodeState} destination
 * @param {ScaleFactorPlanningScratch} scratch
 * @returns {number}
 */
function planSecondary(block, blocks, count, destination, scratch) {
  const primaryOrdinal = block.primaryChannelOrdinal
  if (
    !Number.isInteger(primaryOrdinal) ||
    primaryOrdinal < 0 ||
    primaryOrdinal >= blocks.length
  ) {
    throw new RangeError('ATRAC3plus primary scale-factor channel is invalid')
  }
  const primary = blocks[primaryOrdinal]
  const currentValues = block.syntax.scaleFactors
  const primaryValues = primary.syntax.scaleFactors
  const encode = destination
  const choiceBits = scratch.choiceBits
  choiceBits[0] = count * IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS
  for (let relation = 0; relation < 2; relation++) {
    const symbolCount = pairedChannelSymbols(
      currentValues,
      primaryValues,
      count,
      relation,
      scratch.symbols
    )
    symbolBitsByCodebook(
      SCALE_FACTOR_DIRECT_CODEBOOKS,
      scratch.symbols,
      symbolCount,
      scratch.costs
    )
    const selected = lowestCostMode(scratch.costs)
    choiceBits[relation + 1] =
      scratch.costs[selected] + IO_SCALE_FACTOR_SYNTAX_CODEBOOK_HEADER_BITS
    scratch.deltaCodebooks[relation] = selected
  }
  let equal = true
  for (let band = 0; band < count; band++) {
    if (currentValues[band] !== primaryValues[band]) {
      equal = false
      break
    }
  }
  choiceBits[3] = equal ? 0 : SCALE_FACTOR_FORBIDDEN_BITS
  const selected = lowestCostMode(choiceBits)
  encode.modeSelect = selected
  encode.mode =
    selected === 1 || selected === 2 ? scratch.deltaCodebooks[selected - 1] : 0
  encode.mode2 = 0
  return choiceBits[selected]
}

/**
 * Select exact per-channel representations into bound channel state.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {SharedState} shared Shared coding-unit geometry.
 * @param {ScaleFactorCodingPlan} destination Reusable accounting and scratch storage.
 * @returns {ScaleFactorCodingPlan} Selected coding plan.
 */
export function planScaleFactorSection(blocks, shared, destination) {
  validateScaleFactorChannels(blocks)
  if (!(destination instanceof ScaleFactorCodingPlan)) {
    throw new TypeError(
      'ATRAC3plus scale-factor planning requires fixed storage'
    )
  }
  const count = validateGeometry(shared)
  const groupCount = shared.shapeCount
  const plan = destination.clear(blocks.length)
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    plan.bits +=
      block.channelOrdinal === 0
        ? planPrimary(
            block,
            count,
            groupCount,
            block.scaleFactorEncode,
            plan.scratch
          )
        : planSecondary(
            block,
            blocks,
            count,
            block.scaleFactorEncode,
            plan.scratch
          )
  }
  return plan
}

/**
 * Emit one scale-factor symbol from the selected canonical codebook, rejecting forbidden entries.
 *
 * @param {ArrayLike<number>[]} codebooks
 * @param {number} codebook
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function writeCanonical(codebooks, codebook, symbol, sink) {
  if (!writeCanonicalSymbol(codebooks[codebook], symbol, sink)) {
    throw new RangeError('ATRAC3plus scale-factor symbol is not packable')
  }
}

/**
 * Emit a range-coded scale-factor lead, base, residual row, and optional shape identifier.
 *
 * @param {ArrayLike<number>} values
 * @param {number} offset
 * @param {number} count
 * @param {ScaleFactorEncodeState} encode
 * @param {number} shape
 * @param {BitWriter|BitCounter} sink
 */
function packRangePayload(values, offset, count, encode, shape, sink) {
  const lead = encode.lead
  const width = encode.width
  const base = encode.base | 0
  for (let band = 0; band < count; band++) {
    const value = values[offset + band] | 0
    if (band < lead) {
      sink.write(
        shape ? value + IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS : value,
        shape ? 4 : 6
      )
    } else if (width !== 0) {
      sink.write(value - base, width)
    }
  }
}

/**
 * Emit the selected raw, range, shape, or adjacent-delta syntax for the primary channel.
 *
 * @param {EncodeChannelState} block
 * @param {number} count
 * @param {number} mode
 * @param {BitWriter|BitCounter} sink
 */
function packPrimary(block, count, mode, sink) {
  const encode = block.scaleFactorEncode
  const offset = encode.mode2 * 32
  const values = encode.mode2Values
  if (mode === 1) {
    if (encode.mode2 !== 3) {
      sink.write(encode.mode2, 2)
      sink.write(encode.lead, 5)
      sink.write(encode.width, 3)
      sink.write(encode.base, 6)
      packRangePayload(values, offset, count, encode, false, sink)
    } else {
      sink.write(3, 2)
      sink.write(encode.baseValue, 6)
      sink.write(encode.codebookIndex, 6)
      sink.write(encode.lead, 5)
      sink.write(encode.width, 2)
      sink.write((encode.base | 0) + IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS, 4)
      packRangePayload(values, offset, count, encode, true, sink)
    }
    return
  }
  if (mode !== 3) return
  if (encode.mode2 !== 3) {
    sink.write(encode.mode2, 2)
    sink.write(encode.mode, 2)
    sink.write(values[offset], 6)
    for (let band = 1; band < count; band++) {
      writeCanonical(
        SCALE_FACTOR_DIRECT_CODEBOOKS,
        encode.mode,
        maskedDelta(values[offset + band], values[offset + band - 1]),
        sink
      )
    }
    return
  }
  let previous = values[offset] | 0
  sink.write(3, 2)
  sink.write(encode.mode, 2)
  sink.write(encode.baseValue, 6)
  sink.write(encode.codebookIndex, 6)
  sink.write(previous + IO_SCALE_FACTOR_SYNTAX_GROUP_FIRST_BIAS, 4)
  for (let band = 1; band < count; band++) {
    const current = values[offset + band] | 0
    writeCanonical(
      SCALE_FACTOR_GROUP_CODEBOOKS,
      encode.mode,
      (current - previous) & IO_SCALE_FACTOR_SYNTAX_GROUP_MASK,
      sink
    )
    previous = current
  }
}

/**
 * Emit secondary-channel scale factors relative to the primary channel with optional propagated deltas.
 *
 * @param {EncodeChannelState} block
 * @param {EncodeChannelState} primary
 * @param {number} count
 * @param {number} mode
 * @param {BitWriter|BitCounter} sink
 */
function packSecondary(block, primary, count, mode, sink) {
  if (mode !== 1 && mode !== 2) return
  const encode = block.scaleFactorEncode
  sink.write(encode.mode, 2)
  const relation = mode - 1
  let previousValue = 0
  let previousBase = 0
  for (let band = 0; band < count; band++) {
    const value = block.syntax.scaleFactors[band]
    const base = primary.syntax.scaleFactors[band]
    const symbol = channelSymbol(
      relation,
      band,
      value,
      base,
      previousValue,
      previousBase
    )
    writeCanonical(SCALE_FACTOR_DIRECT_CODEBOOKS, encode.mode, symbol, sink)
    previousValue = value
    previousBase = base
  }
}

/**
 * Emit committed scale-factor syntax in coding-unit wire order.
 *
 * @param {EncodeChannelState[]} blocks All frame channel blocks.
 * @param {number} count Active scale-factor band count.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packScaleFactorSection(blocks, count, sink) {
  validateScaleFactorChannels(blocks)
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > QUANTIZATION_UNIT_COUNT ||
    typeof sink?.write !== 'function'
  ) {
    throw new TypeError('ATRAC3plus scale-factor pack arguments are invalid')
  }
  const primary = blocks[0]
  for (let channel = 0; channel < blocks.length; channel++) {
    const block = blocks[channel]
    const mode = block.scaleFactorEncode.modeSelect & 3
    sink.write(mode, SCALE_FACTOR_MODE_BITS)
    if (mode === 0) {
      for (let band = 0; band < count; band++) {
        sink.write(
          block.syntax.scaleFactors[band],
          IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS
        )
      }
    } else if (block.channelOrdinal === 0) {
      packPrimary(block, count, mode, sink)
    } else {
      packSecondary(block, primary, count, mode, sink)
    }
  }
}
