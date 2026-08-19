/** ATRAC3plus spectral code-table pricing and incremental cost state. */

import { packableSymbolBits } from './entropy.js'
import {
  CODE_TABLE_CODEBOOKS,
  CODE_TABLE_FIXED_WIDTHS,
} from '../core/tables.js'
import {
  CODE_TABLE_COUNT_FLAG_BITS,
  CODE_TABLE_EXPLICIT_COUNT_BITS,
  CODE_TABLE_FORBIDDEN_BITS,
  CODE_TABLE_MODE_DIFF,
  CODE_TABLE_MODE_DIRECT,
  CODE_TABLE_MODE_FIXED,
  CODE_TABLE_MODE_PAIR,
  CODE_TABLE_TYPE_ONE_BIT,
  CODE_TABLE_TYPE_VALUE,
} from '../core/constants.js'

/**
 * Create a low-bit mask without overflowing JavaScript's 32-bit shift semantics.
 *
 * @param {number} count
 * @returns {number}
 */
function limitedMask(count) {
  return count === 32 ? 0xffffffff : (2 ** count - 1) >>> 0
}

/**
 * Resolve the payload category selected for one quantization band.
 *
 * @param {number} valueMask Bands carrying full code-table values.
 * @param {number} oneBitMask Bands carrying a one-bit secondary value.
 * @param {number} band Quantization-band index.
 * @returns {number} One of the `CODE_TABLE_TYPE_*` values, or zero.
 */
export function codeTableBandType(valueMask, oneBitMask, band) {
  const bit = (2 ** band) >>> 0
  if ((valueMask & bit) !== 0) return CODE_TABLE_TYPE_VALUE
  if ((oneBitMask & bit) !== 0) return CODE_TABLE_TYPE_ONE_BIT
  return 0
}

/**
 * Return the encoded width of one symbol, treating an unavailable symbol as zero.
 *
 * @param {ArrayLike<number>} codebook
 * @param {number} symbol
 * @returns {number}
 */
function huffmanBits(codebook, symbol) {
  return packableSymbolBits(codebook, symbol) ?? 0
}

/**
 * Wrap a signed value difference into one codebook's symbol domain.
 *
 * @param {number} value Current table value.
 * @param {number} reference Predictor value.
 * @param {ArrayLike<number>} codebook Power-of-two-sized codebook.
 * @returns {number} Wrapped nonnegative symbol.
 */
export function maskedCodeTableDelta(value, reference, codebook) {
  return (value - reference) & (codebook.length - 1)
}

/**
 * Return the first mode attaining the minimum measured cost, preserving deterministic ties.
 *
 * @param {ArrayLike<number>} costs
 * @returns {number}
 */
function lowestCostMode(costs) {
  let selected = 0
  for (let mode = 1; mode < costs.length; mode++) {
    if (costs[mode] < costs[selected]) selected = mode
  }
  return selected
}

/**
 * Derive the coded value prefix length from its nonzero-band mask.
 *
 * @param {number} positiveValueMask
 * @param {number} maxCount
 * @returns {number}
 */
function usedValueCount(positiveValueMask, maxCount) {
  if (maxCount === 0) return 0
  if (positiveValueMask === 0) return maxCount
  return 32 - Math.clz32(positiveValueMask)
}

/**
 * Measure every legal code-table payload mode for one band and store the per-mode costs.
 *
 * @param {string} type
 * @param {number} band
 * @param {number} value
 * @param {number} reference
 * @param {number} previous
 * @param {boolean} pairAvailable
 * @param {number} fixIndex
 * @param {ArrayLike<number>} destination
 */
function payloadBitsForBand(
  type,
  band,
  value,
  reference,
  previous,
  pairAvailable,
  fixIndex,
  destination
) {
  if (type === CODE_TABLE_TYPE_VALUE) {
    const tables = CODE_TABLE_CODEBOOKS[fixIndex]
    destination[CODE_TABLE_MODE_FIXED] = CODE_TABLE_FIXED_WIDTHS[fixIndex]
    destination[CODE_TABLE_MODE_DIRECT] = huffmanBits(tables.direct, value)
    destination[CODE_TABLE_MODE_DIFF] = huffmanBits(
      band === 0 ? tables.direct : tables.diff,
      band === 0 ? value : maskedCodeTableDelta(value, previous, tables.diff)
    )
    destination[CODE_TABLE_MODE_PAIR] = pairAvailable
      ? huffmanBits(
          tables.pair,
          maskedCodeTableDelta(value, reference, tables.pair)
        )
      : 0
  } else if (type === CODE_TABLE_TYPE_ONE_BIT) {
    destination.fill(1)
  } else {
    destination.fill(0)
  }
}

/**
 * Fixed exact payload-cost ledger for one channel.
 */
export class CodeTableCodingCostState {
  /**
   * Allocate fixed four-mode cost ledgers for one channel.
   */
  constructor() {
    this.prefixBits = new Int32Array(4)
    this.fullBits = new Int32Array(4)
    this.bandBits = new Int32Array(4)
    this.clear()
  }

  /**
   * Reset the reusable code table coding cost state to its empty state without reallocating its storage.
   *
   * @returns {CodeTableCodingCostState} This cleared reusable state.
   */
  clear() {
    this.prefixBits.fill(0)
    this.fullBits.fill(0)
    this.bandBits.fill(0)
    this.valueMask = 0
    this.oneBitMask = 0
    this.positiveValueMask = 0
    this.maxCount = 0
    this.usedCount = 0
    this.channelOrdinal = 0
    this.fixIndex = 0
    this.entropyModes = false
    return this
  }

  /**
   * Copy this exact cost image into preallocated candidate storage.
   *
   * @param {CodeTableCodingCostState} destination State to overwrite.
   * @returns {CodeTableCodingCostState} The destination state.
   */
  copyTo(destination) {
    destination.prefixBits.set(this.prefixBits)
    destination.fullBits.set(this.fullBits)
    destination.valueMask = this.valueMask
    destination.oneBitMask = this.oneBitMask
    destination.positiveValueMask = this.positiveValueMask
    destination.maxCount = this.maxCount
    destination.usedCount = this.usedCount
    destination.channelOrdinal = this.channelOrdinal
    destination.fixIndex = this.fixIndex
    destination.entropyModes = this.entropyModes
    return destination
  }

  /**
   * Build all mode costs from one channel's current code-table values.
   *
   * @param {number} valueMask Bands carrying full values.
   * @param {number} oneBitMask Bands carrying one-bit secondary values.
   * @param {Int32Array} values Current channel values.
   * @param {Int32Array|null} referenceValues Primary-channel predictors.
   * @param {number} maxCount Active band limit.
   * @param {number} channelOrdinal Coding-unit channel ordinal.
   * @param {number} fixIndex Fixed-width/codebook family selector.
   * @param {boolean} entropyModes Whether entropy modes may be selected.
   * @returns {CodeTableCodingCostState} This initialized state.
   */
  initialize(
    valueMask,
    oneBitMask,
    values,
    referenceValues,
    maxCount,
    channelOrdinal,
    fixIndex,
    entropyModes
  ) {
    this.clear()
    const mask = limitedMask(maxCount)
    this.valueMask = (valueMask & mask) >>> 0
    this.oneBitMask = (oneBitMask & mask) >>> 0
    this.maxCount = maxCount
    this.channelOrdinal = channelOrdinal
    this.fixIndex = fixIndex
    this.entropyModes = entropyModes
    for (let band = 0; band < maxCount; band++) {
      if (values[band] > 0) {
        this.positiveValueMask =
          (this.positiveValueMask | ((2 ** band) >>> 0)) >>> 0
      }
    }
    this.usedCount = entropyModes
      ? usedValueCount(this.positiveValueMask, maxCount)
      : maxCount
    let previous = 0
    for (let band = 0; band < maxCount; band++) {
      const type = codeTableBandType(this.valueMask, this.oneBitMask, band)
      const value = values[band]
      payloadBitsForBand(
        type,
        band,
        value,
        referenceValues?.[band] ?? 0,
        previous,
        channelOrdinal !== 0,
        fixIndex,
        this.bandBits
      )
      for (let mode = 0; mode < 4; mode++) {
        this.fullBits[mode] += this.bandBits[mode]
        if (band < this.usedCount) {
          this.prefixBits[mode] += this.bandBits[mode]
        }
      }
      if (type === CODE_TABLE_TYPE_VALUE) previous = value
    }
    return this
  }

  /**
   * Find the previous full value used by differential coding.
   *
   * @param {Int32Array} values Current channel values.
   * @param {number} band Current band index.
   * @returns {number} Previous coded value, or zero.
   */
  previousValue(values, band) {
    if (band === 0) return 0
    const lowerMask = (2 ** band - 1) >>> 0
    const lower = (this.valueMask & lowerMask) >>> 0
    if (lower === 0) return 0
    return values[31 - Math.clz32(lower)]
  }

  /**
   * Find the next higher band carrying a full value.
   *
   * @param {number} band Current band index.
   * @returns {number} Next band index, or `-1`.
   */
  nextValueBand(band) {
    if (band + 1 >= this.maxCount) return -1
    const lowerMask = (2 ** (band + 1) - 1) >>> 0
    const higher = (this.valueMask & ~lowerMask) >>> 0
    return higher === 0 ? -1 : 31 - Math.clz32(higher & -higher)
  }

  /**
   * Apply an incremental payload cost to full and active-prefix ledgers.
   *
   * @param {number} mode Code-table packing mode.
   * @param {number} band Changed band index.
   * @param {number} delta Signed bit-cost change.
   * @returns {void}
   */
  applyModeDelta(mode, band, delta) {
    this.fullBits[mode] += delta
    if (band < this.usedCount) this.prefixBits[mode] += delta
  }

  /**
   * Rebuild active-prefix costs after the last positive value moves.
   *
   * @param {Int32Array} values Incumbent channel values.
   * @param {Int32Array|null} referenceValues Primary-channel predictors.
   * @param {number} changedBand Candidate band index.
   * @param {number} newValue Candidate value.
   * @param {number} newUsedCount Candidate active-prefix length.
   * @returns {void}
   */
  rebuildPrefix(values, referenceValues, changedBand, newValue, newUsedCount) {
    this.prefixBits.fill(0)
    let previous = 0
    for (let band = 0; band < newUsedCount; band++) {
      const type = codeTableBandType(this.valueMask, this.oneBitMask, band)
      const value = band === changedBand ? newValue : values[band]
      payloadBitsForBand(
        type,
        band,
        value,
        referenceValues?.[band] ?? 0,
        previous,
        this.channelOrdinal !== 0,
        this.fixIndex,
        this.bandBits
      )
      for (let mode = 0; mode < 4; mode++) {
        this.prefixBits[mode] += this.bandBits[mode]
      }
      if (type === CODE_TABLE_TYPE_VALUE) previous = value
    }
    this.usedCount = newUsedCount
  }

  /**
   * Incrementally reprice one channel value change.
   *
   * @param {Int32Array} values Incumbent channel values.
   * @param {Int32Array|null} referenceValues Primary-channel predictors.
   * @param {number} band Changed band index.
   * @param {number} oldValue Incumbent value.
   * @param {number} newValue Candidate value.
   * @returns {CodeTableCodingCostState} This updated candidate state.
   */
  changeValue(values, referenceValues, band, oldValue, newValue) {
    if (!this.entropyModes || band >= this.maxCount) return this
    const type = codeTableBandType(this.valueMask, this.oneBitMask, band)
    if (type === CODE_TABLE_TYPE_VALUE) {
      const tables = CODE_TABLE_CODEBOOKS[this.fixIndex]
      this.applyModeDelta(
        CODE_TABLE_MODE_DIRECT,
        band,
        huffmanBits(tables.direct, newValue) -
          huffmanBits(tables.direct, oldValue)
      )
      const previous = this.previousValue(values, band)
      const diffTable = band === 0 ? tables.direct : tables.diff
      const oldDiff =
        band === 0
          ? oldValue
          : maskedCodeTableDelta(oldValue, previous, tables.diff)
      const newDiff =
        band === 0
          ? newValue
          : maskedCodeTableDelta(newValue, previous, tables.diff)
      this.applyModeDelta(
        CODE_TABLE_MODE_DIFF,
        band,
        huffmanBits(diffTable, newDiff) - huffmanBits(diffTable, oldDiff)
      )
      if (this.channelOrdinal !== 0) {
        const reference = referenceValues?.[band] ?? 0
        this.applyModeDelta(
          CODE_TABLE_MODE_PAIR,
          band,
          huffmanBits(
            tables.pair,
            maskedCodeTableDelta(newValue, reference, tables.pair)
          ) -
            huffmanBits(
              tables.pair,
              maskedCodeTableDelta(oldValue, reference, tables.pair)
            )
        )
      }
      const nextBand = this.nextValueBand(band)
      if (nextBand >= 0) {
        const nextValue = values[nextBand]
        this.applyModeDelta(
          CODE_TABLE_MODE_DIFF,
          nextBand,
          huffmanBits(
            tables.diff,
            maskedCodeTableDelta(nextValue, newValue, tables.diff)
          ) -
            huffmanBits(
              tables.diff,
              maskedCodeTableDelta(nextValue, oldValue, tables.diff)
            )
        )
      }
    }
    const bit = (2 ** band) >>> 0
    this.positiveValueMask =
      newValue > 0
        ? (this.positiveValueMask | bit) >>> 0
        : (this.positiveValueMask & ~bit) >>> 0
    const nextUsedCount = usedValueCount(this.positiveValueMask, this.maxCount)
    if (nextUsedCount !== this.usedCount) {
      this.rebuildPrefix(values, referenceValues, band, newValue, nextUsedCount)
    }
    return this
  }

  /**
   * Incrementally reprice a primary-channel predictor change.
   *
   * @param {Int32Array} values Secondary-channel values.
   * @param {number} band Changed band index.
   * @param {number} oldReference Incumbent predictor.
   * @param {number} newReference Candidate predictor.
   * @returns {CodeTableCodingCostState} This updated candidate state.
   */
  changeReference(values, band, oldReference, newReference) {
    if (
      !this.entropyModes ||
      this.channelOrdinal === 0 ||
      band >= this.maxCount ||
      codeTableBandType(this.valueMask, this.oneBitMask, band) !==
        CODE_TABLE_TYPE_VALUE
    ) {
      return this
    }
    const table = CODE_TABLE_CODEBOOKS[this.fixIndex].pair
    const value = values[band]
    const delta =
      huffmanBits(table, maskedCodeTableDelta(value, newReference, table)) -
      huffmanBits(table, maskedCodeTableDelta(value, oldReference, table))
    this.fullBits[CODE_TABLE_MODE_PAIR] += delta
    if (band < this.usedCount) {
      this.prefixBits[CODE_TABLE_MODE_PAIR] += delta
    }
    return this
  }

  /**
   * Select implicit-full or explicit-prefix counting for one mode.
   *
   * @param {number} mode Code-table packing mode.
   * @param {CodeTableCodingSyntax} syntax Destination syntax plan.
   * @returns {void}
   */
  countedPlan(mode, syntax) {
    const full = this.fullBits[mode] + CODE_TABLE_COUNT_FLAG_BITS
    const explicit =
      this.prefixBits[mode] +
      CODE_TABLE_COUNT_FLAG_BITS +
      CODE_TABLE_EXPLICIT_COUNT_BITS
    syntax.count = this.usedCount
    syntax.explicit = explicit < full
    syntax.bits = syntax.explicit ? explicit : full
  }

  /**
   * Select the lowest-cost valid syntax from the current ledgers.
   *
   * @param {CodeTableCodingSyntax} destination Reusable channel syntax plan.
   * @returns {CodeTableCodingSyntax} The selected destination plan.
   */
  selectSyntax(destination) {
    destination.clear()
    destination.valueMask = this.valueMask
    destination.oneBitMask = this.oneBitMask
    if (!this.entropyModes) {
      destination.mode = CODE_TABLE_MODE_FIXED
      destination.count = this.maxCount
      destination.explicit = false
      destination.bits =
        this.fullBits[CODE_TABLE_MODE_FIXED] + CODE_TABLE_COUNT_FLAG_BITS
      return destination
    }
    const costs = this.bandBits
    for (let mode = 0; mode < 3; mode++) {
      const full = this.fullBits[mode] + CODE_TABLE_COUNT_FLAG_BITS
      const explicit =
        this.prefixBits[mode] +
        CODE_TABLE_COUNT_FLAG_BITS +
        CODE_TABLE_EXPLICIT_COUNT_BITS
      costs[mode] = Math.min(full, explicit)
    }
    if (this.channelOrdinal === 0) {
      costs[CODE_TABLE_MODE_PAIR] =
        (this.positiveValueMask & this.valueMask) !== 0
          ? CODE_TABLE_FORBIDDEN_BITS
          : 0
    } else if (this.channelOrdinal !== 0) {
      const full =
        this.fullBits[CODE_TABLE_MODE_PAIR] + CODE_TABLE_COUNT_FLAG_BITS
      const explicit =
        this.prefixBits[CODE_TABLE_MODE_PAIR] +
        CODE_TABLE_COUNT_FLAG_BITS +
        CODE_TABLE_EXPLICIT_COUNT_BITS
      costs[CODE_TABLE_MODE_PAIR] = Math.min(full, explicit)
    }
    destination.mode = lowestCostMode(costs)
    if (
      destination.mode === CODE_TABLE_MODE_PAIR &&
      this.channelOrdinal === 0
    ) {
      destination.count = 0
      destination.explicit = false
      destination.bits = costs[destination.mode]
    } else {
      this.countedPlan(destination.mode, destination)
    }
    return destination
  }
}
