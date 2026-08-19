/** Fixed ownership for allocation-time spectrum pricing and memoization. */

import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import {
  FRAME_SAMPLES,
  SPECTRUM_PRICING_BAND_COUNT,
  SPECTRUM_PRICING_CACHE_SLOTS,
  SPECTRUM_PRICING_CANDIDATE_COUNT,
  SPECTRUM_PRICING_CONTEXT_COUNT,
  SPECTRUM_PRICING_EMPTY_KEY,
  SPECTRUM_PRICING_MODE_COUNT,
  SPECTRUM_PRICING_MAX_BAND_LENGTH,
} from '../core/constants.js'

/**
 * Translate a pricing context and band into flat selected-value storage.
 *
 * @param {number} context
 * @param {number} band
 * @returns {number}
 */
function spectrumWorkOffset(context, band) {
  return context * SPECTRUM_PRICING_BAND_COUNT + band
}

/**
 * Build the scalar cache key for one retained quantized spectrum row.
 *
 * @param {number} mode
 * @param {number} offset
 * @returns {number}
 */
export function spectrumQuantizedKey(mode, offset) {
  return (mode << 4) | offset
}

/**
 * Reusable value image for one candidate-pricing and code-table selection request.
 */
export class PricedSpectrumBand {
  /**
   * Allocate the candidate-cost row and initialize its winner.
   */
  constructor() {
    this.costs = new Uint16Array(SPECTRUM_PRICING_CANDIDATE_COUNT)
    this.band = 0
    this.selectedIndex = 0
    this.spectrumDelta = 0
    this.codeTableBits = 0
    this.delta = 0
  }
}

/**
 * Per-channel prepared-source spectrum pricing state.
 */
export class SpectrumPricingState {
  /**
   * Allocate work contexts, cache rows, and symbol scratch.
   */
  constructor() {
    this.selectedIndices = new Uint8Array(
      SPECTRUM_PRICING_CONTEXT_COUNT * SPECTRUM_PRICING_BAND_COUNT
    )
    this.selectedCosts = new Uint16Array(
      SPECTRUM_PRICING_CONTEXT_COUNT * SPECTRUM_PRICING_BAND_COUNT
    )
    const entryCount =
      SPECTRUM_PRICING_CONTEXT_COUNT *
      SPECTRUM_PRICING_BAND_COUNT *
      SPECTRUM_PRICING_MODE_COUNT *
      SPECTRUM_PRICING_CACHE_SLOTS
    this.cacheKeys = new Uint8Array(entryCount)
    this.cacheCosts = new Uint16Array(
      entryCount * SPECTRUM_PRICING_CANDIDATE_COUNT
    )
    this.quantizedKeys = new Uint8Array(SPECTRUM_PRICING_BAND_COUNT)
    this.quantizedRows = new Uint16Array(FRAME_SAMPLES)
    this.magnitudeCoefficients = new Uint16Array(
      SPECTRUM_PRICING_MAX_BAND_LENGTH
    )
    this.groupedSymbols = new Uint16Array(SPECTRUM_PRICING_MAX_BAND_LENGTH)
    this.reset()
  }

  /**
   * Reset per-candidate work and clear source-dependent memoized pricing.
   *
   * @returns {SpectrumPricingState} This reset pricing owner.
   */
  reset() {
    this.selectedIndices.fill(0)
    this.selectedCosts.fill(0)
    this.clearCache()
    return this
  }

  /**
   * Clear all memoized spectrum prices and quantized rows.
   */
  clearCache() {
    this.cacheKeys.fill(SPECTRUM_PRICING_EMPTY_KEY)
    this.quantizedKeys.fill(SPECTRUM_PRICING_EMPTY_KEY)
  }

  /**
   * Capture the selected work context into the now-disposable opposite row.
   *
   * @param {number} context Work-context index.
   * @returns {SpectrumPricingState} This pricing state.
   */
  captureWorkContext(context) {
    if (context < 0 || context >= SPECTRUM_PRICING_CONTEXT_COUNT) {
      throw new RangeError('ATRAC3plus spectrum work snapshot is invalid')
    }
    const workStart = spectrumWorkOffset(context, 0)
    const snapshotStart = spectrumWorkOffset(context ^ 1, 0)
    const workEnd = workStart + SPECTRUM_PRICING_BAND_COUNT
    this.selectedIndices.copyWithin(snapshotStart, workStart, workEnd)
    this.selectedCosts.copyWithin(snapshotStart, workStart, workEnd)
    return this
  }

  /**
   * Restore one work context from the disposable opposite row.
   *
   * @param {number} context Work-context index.
   */
  restoreWorkContext(context) {
    if (context < 0 || context >= SPECTRUM_PRICING_CONTEXT_COUNT) {
      throw new RangeError('ATRAC3plus spectrum work restore is invalid')
    }
    const workStart = spectrumWorkOffset(context, 0)
    const snapshotStart = spectrumWorkOffset(context ^ 1, 0)
    const snapshotEnd = snapshotStart + SPECTRUM_PRICING_BAND_COUNT
    this.selectedIndices.copyWithin(workStart, snapshotStart, snapshotEnd)
    this.selectedCosts.copyWithin(workStart, snapshotStart, snapshotEnd)
  }

  /**
   * Commit one priced band to a work context.
   *
   * @param {PricedSpectrumBand} priced Candidate-cost image.
   * @param {number} workContext Destination work-context index.
   * @param {number} [selectedIndex] Selected code-table candidate.
   * @returns {number} Selected candidate cost.
   */
  commit(priced, workContext, selectedIndex = priced.selectedIndex) {
    if (
      !(priced instanceof PricedSpectrumBand) ||
      workContext < 0 ||
      workContext >= SPECTRUM_PRICING_CONTEXT_COUNT ||
      selectedIndex < 0 ||
      selectedIndex >= SPECTRUM_PRICING_CANDIDATE_COUNT
    ) {
      throw new RangeError('ATRAC3plus spectrum commit is invalid')
    }
    const work = spectrumWorkOffset(workContext, priced.band)
    const cost = priced.costs[selectedIndex]
    this.selectedIndices[work] = selectedIndex
    this.selectedCosts[work] = cost
    return cost
  }

  /**
   * Return the selected candidate index for one context and band.
   *
   * @param {number} workContext
   * @param {number} band
   * @returns {number}
   */
  selectedIndex(workContext, band) {
    return this.selectedIndices[
      workContext * SPECTRUM_PRICING_BAND_COUNT + band
    ]
  }

  /**
   * Copy a memoized quantized row into absolute signed channel storage.
   *
   * @param {number} band
   * @param {number} mode
   * @param {number} offset
   * @param {Int16Array} output
   * @returns {boolean}
   */
  writeCachedQuantizedBand(band, mode, offset, output) {
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    if (
      !(output instanceof Int16Array) ||
      start === undefined ||
      end === undefined ||
      output.length < end ||
      this.quantizedKeys[band] !== spectrumQuantizedKey(mode, offset)
    ) {
      return false
    }
    for (let index = start; index < end; index++) {
      output[index] = this.quantizedRows[index]
    }
    return true
  }

  /**
   * Return the selected cost for one work context and band.
   *
   * @param {number} workContext
   * @param {number} band
   * @returns {number}
   */
  selectedCost(workContext, band) {
    return this.selectedCosts[spectrumWorkOffset(workContext, band)]
  }
}
