/** Fixed reusable storage for ATRAC3plus transform kernels. */

import {
  ANALYSIS_BANDS,
  ANALYSIS_TAIL_SAMPLES,
  FRAME_SAMPLES,
  GAIN_SCALE_SAMPLE_COUNT,
  GAIN_SCALE_STEP_COUNT,
  MDCT_COEFFICIENT_COUNT,
  MDCT_TIME_SAMPLE_COUNT,
  QMF_BANDS,
  SUBBAND_SAMPLES,
} from '../core/constants.js'

/**
 * Reusable step and sample envelopes for gain scaling.
 */
export class GainScaleScratch {
  /**
   * Allocate fixed step-domain and interpolated sample-domain envelopes.
   */
  constructor() {
    this.steps = new Int32Array(GAIN_SCALE_STEP_COUNT)
    this.scale = new Float32Array(GAIN_SCALE_SAMPLE_COUNT)
  }
}

/**
 * Fixed FFT, time-domain, and gain-envelope work for one MDCT call.
 */
export class MdctScratch {
  /**
   * Allocate one reusable MDCT kernel and its nested gain-scale storage.
   */
  constructor() {
    this.buffers = {
      [MDCT_COEFFICIENT_COUNT]: new Float32Array(MDCT_COEFFICIENT_COUNT),
    }
    this.spectrum = new Float32Array(MDCT_COEFFICIENT_COUNT)
    this.timeSamples = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.windowedSamples = new Float32Array(MDCT_TIME_SAMPLE_COUNT)
    this.gainScale = new GainScaleScratch()
  }
}

/**
 * Reusable window, polyphase, and band work for QMF analysis or synthesis.
 */
export class QmfScratch {
  /**
   * Allocate one full analysis window and all per-step accumulator rows.
   */
  constructor() {
    this.window = new Float32Array(ANALYSIS_TAIL_SAMPLES + FRAME_SAMPLES)
    this.polyphase = new Float32Array(QMF_BANDS)
    this.extended = new Float64Array(QMF_BANDS)
    this.bands = new Float32Array(QMF_BANDS)
  }
}

/**
 * Reusable waveform, crossfade window, and output storage for tones.
 */
export class ToneSynthesisScratch {
  /**
   * Allocate current/prior waveforms, crossfade window, and output row.
   */
  constructor() {
    this.previous = new Float32Array(SUBBAND_SAMPLES)
    this.current = new Float32Array(SUBBAND_SAMPLES)
    this.output = new Float32Array(SUBBAND_SAMPLES)
    this.window = new Float32Array(SUBBAND_SAMPLES * 2)
  }
}

/**
 * Fixed operation-local storage for one coding-unit reconstruction.
 */
export class SpectralReconstructionScratch {
  /**
   * Allocate one noise subband and all per-analysis-band seed values.
   */
  constructor() {
    this.noise = new Float32Array(SUBBAND_SAMPLES)
    this.noiseSeeds = new Uint16Array(ANALYSIS_BANDS)
  }
}
