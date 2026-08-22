/** Persistent ATRAC3plus intensity-stereo history. */

import { ANALYSIS_BANDS, INTENSITY_HISTORY_SLOTS } from '../core/constants.js'

/**
 * Per-channel intensity cutoff and five-frame correlation history.
 */
export class ChannelIntensityHistory {
  /**
   * Allocate delayed intensity decisions and per-band correlation evidence for one channel pair.
   */
  constructor() {
    this.intensityBandLimit = 0
    this.correlationMetrics = new Float32Array(
      INTENSITY_HISTORY_SLOTS * ANALYSIS_BANDS
    )
  }

  /** Rotate intensity-stereo correlation history and clear the newly current row. */
  shift() {
    this.correlationMetrics.copyWithin(
      0,
      ANALYSIS_BANDS,
      INTENSITY_HISTORY_SLOTS * ANALYSIS_BANDS
    )
    this.correlationMetrics.fill(
      0,
      (INTENSITY_HISTORY_SLOTS - 1) * ANALYSIS_BANDS
    )
  }

  /**
   * Read the retained inter-channel correlation for one intensity-stereo band.
   *
   * @param {number} slot
   * @param {number} band
   * @returns {number}
   */
  correlation(slot, band) {
    return this.correlationMetrics[slot * ANALYSIS_BANDS + band] ?? 0
  }

  /**
   * Store one measured inter-channel correlation in the current intensity history row.
   *
   * @param {number} slot
   * @param {number} band
   * @param {number} value
   */
  setCorrelation(slot, band, value) {
    if (
      slot >= 0 &&
      slot < INTENSITY_HISTORY_SLOTS &&
      band >= 0 &&
      band < ANALYSIS_BANDS
    ) {
      this.correlationMetrics[slot * ANALYSIS_BANDS + band] = value
    }
  }

  /**
   * Copy all active channel intensity history fields into caller-owned destination storage.
   *
   * @param {ChannelIntensityHistory} destination
   */
  copyTo(destination) {
    destination.intensityBandLimit = this.intensityBandLimit
    destination.correlationMetrics.set(this.correlationMetrics)
  }
}

/** Persistent cross-channel intensity-stereo history for one coding unit. */
export class IntensityStereoState {
  /** Allocate committed and staged intensity history for every maintained stereo coding unit. */
  constructor() {
    this.intensityBandLimit = 16
    this.correlationDecibels = new Float32Array(ANALYSIS_BANDS)
    this.mixHistory = new Float32Array(5 * ANALYSIS_BANDS)
    this.previousScales = new Float32Array(2 * ANALYSIS_BANDS)
    this.currentScales = new Float32Array(2 * ANALYSIS_BANDS)
  }

  /**
   * Copy all active intensity stereo state fields into caller-owned destination storage.
   *
   * @param {IntensityStereoState} destination
   */
  copyTo(destination) {
    destination.intensityBandLimit = this.intensityBandLimit
    destination.correlationDecibels.set(this.correlationDecibels)
    destination.mixHistory.set(this.mixHistory)
    destination.previousScales.set(this.previousScales)
    destination.currentScales.set(this.currentScales)
  }
}
