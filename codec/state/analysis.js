/** Fixed-capacity storage owned by encoder analysis stages. */

import {
  ANALYSIS_BANDS,
  GAIN_SLOT_COUNT,
  GAIN_WINDOW_BLOCKS,
  SUBBAND_SAMPLES,
} from '../core/constants.js'

/**
 * Stage-private buffers reused across gain-window measurements.
 */
export class GainMeasurementScratch {
  /**
   * Allocate detector spectra, peaks, and stable ordering work.
   */
  constructor() {
    this.spectrum = new Float32Array(16)
    this.magnitudes = new Float32Array(8)
    this.blockPeaks = new Float32Array(GAIN_WINDOW_BLOCKS)
    this.peakResult = { maximumIndex: 0, maximumValue: 0, activity: 0 }
    this.sortedOrder = {
      indices: new Int32Array(GAIN_WINDOW_BLOCKS * 2),
      length: 0,
    }
  }
}

/**
 * Stage-private lowering and reconstruction work for gain envelopes.
 */
export class GainEnvelopeScratch {
  /**
   * Allocate fixed-capacity gain-point and per-window vectors.
   */
  constructor() {
    this.locations = new Uint32Array(GAIN_SLOT_COUNT)
    this.levels = new Uint32Array(GAIN_SLOT_COUNT)
    this.idealLevels = new Int32Array(GAIN_WINDOW_BLOCKS)
    this.signalPower = new Float64Array(GAIN_WINDOW_BLOCKS)
    this.currentRawLevels = new Int32Array(GAIN_WINDOW_BLOCKS)
  }
}

/**
 * Stage-private buffers for one coding-unit intensity analysis pass.
 */
export class IntensityScratch {
  /**
   * Allocate mixed samples, band weights, scale proposals, and powers.
   */
  constructor() {
    this.combinedSamples = new Float32Array(SUBBAND_SAMPLES * 2)
    this.weights = new Float32Array(ANALYSIS_BANDS)
    this.nextScales = [
      new Float32Array(ANALYSIS_BANDS),
      new Float32Array(ANALYSIS_BANDS),
    ]
    this.powers = new Float32Array(3)
  }
}

/**
 * Mutable exact aligned-signal comparison result.
 */
export class SignalComparison {
  /**
   * Initialize all energy and shape measures to zero.
   */
  constructor() {
    this.referenceEnergy = 0
    this.candidateEnergy = 0
    this.differenceEnergy = 0
    this.relativeDifferenceEnergy = 0
    this.shapeError = 0
  }
}

/**
 * Fixed peak-envelope storage for temporal merge comparisons.
 */
export class PeakEnvelopeComparison {
  /**
   * Allocate paired peak vectors and their shared result object.
   *
   * @param {number} blockCount Positive envelope block count.
   */
  constructor(blockCount) {
    if (!Number.isInteger(blockCount) || blockCount < 1) {
      throw new RangeError('peak-envelope block count must be positive')
    }
    this.candidate = new Float32Array(blockCount)
    this.reference = new Float32Array(blockCount)
    this.result = new SignalComparison()
  }
}
