/** Shared deterministic reconstruction-noise preparation. */

import {
  CODING_UNIT_MAX_CHANNELS,
  GROUP_COUNT,
  QUANTIZATION_UNIT_COUNT,
  SLOT_COUNT,
  SPECTRAL_NOISE_SEED_MASK,
  SPECTRAL_NOISE_SEED_STEP,
} from '../core/constants.js'

/**
 * Shared deterministic noise, evidence, and measurement work for sequential reconstruction refinements.
 */
export class ReconstructionRefinementScratch {
  /**
   * Allocate the complete fixed workspace once for both refinement phases.
   */
  constructor() {
    this.levels = new Int32Array(CODING_UNIT_MAX_CHANNELS * SLOT_COUNT)
    this.noiseEvidence = new Float32Array(
      CODING_UNIT_MAX_CHANNELS * GROUP_COUNT
    )
    this.levelEvidence = new Float32Array(
      CODING_UNIT_MAX_CHANNELS * GROUP_COUNT
    )
    this.weights = new Uint32Array(CODING_UNIT_MAX_CHANNELS * GROUP_COUNT)
    this.seeds = new Uint16Array(QUANTIZATION_UNIT_COUNT)
    this.randomSamples = new Float32Array(128)
    this.clearSpectralNoise()
    this.clearScaleFactors()
  }

  /**
   * Reset spectral-noise evidence without clearing rows overwritten before use.
   *
   * @returns {ReconstructionRefinementScratch}
   */
  clearSpectralNoise() {
    this.noiseEvidence.fill(0)
    this.levelEvidence.fill(0)
    this.weights.fill(0)
    this.slotStart = 0
    this.slotEnd = 0
    this.expandedMapIndex = -1
    return this
  }

  /**
   * Reset scale-factor measurement scalars without touching retained spectral-noise rows.
   *
   * @returns {ReconstructionRefinementScratch}
   */
  clearScaleFactors() {
    this.wide = false
    this.expandedMapIndex = -1
    this.noiseSampleCount = 0
    this.noiseScale = 0
    return this
  }
}

/**
 * Derive the deterministic map seeds used by reconstruction-aware refinement.
 *
 * @param {CodingUnitAllocationTransaction} transaction Active allocation transaction.
 * @param {SharedState} shared Shared coded-band and map geometry.
 * @param {Uint16Array} seeds Destination seed workspace.
 */
export function prepareReconstructionNoiseSeeds(transaction, shared, seeds) {
  let sum = 0
  for (let channel = 0; channel < transaction.channelCount; channel++) {
    const factors = transaction.channelBlocks[channel].syntax.scaleFactors
    for (let band = 0; band < shared.scaleFactorCount; band++) {
      const index = factors[band]
      if (index < 0 || index >= 64) {
        throw new RangeError('ATRAC3plus reconstruction-noise seed is invalid')
      }
      sum += index
    }
  }
  let seed = sum & SPECTRAL_NOISE_SEED_MASK
  for (let map = 0; map < shared.mapCount; map++) {
    seeds[map] = seed
    seed = (seed + SPECTRAL_NOISE_SEED_STEP) & SPECTRAL_NOISE_SEED_MASK
  }
}
