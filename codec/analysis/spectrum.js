/** ATRAC3plus spectral analysis. */

import {
  MDCT_COEFFICIENT_COUNT,
  MDCT_TIME_SAMPLE_COUNT,
} from '../core/constants.js'
import {
  MDCT_REVERSE_FLAGS_BY_SUBBAND,
  MDCT_WINDOW_STEADY,
} from '../core/tables.js'
import { MDCT } from '../signal/mdct.js'
import { applyForwardGainScale, gainPairIsActive } from '../signal/gain.js'

/** @typedef {import('../state/transform.js').MdctScratch} MdctScratch */
/** @typedef {import('../state/gain/coding.js').GainRecord} GainRecord */

const forwardMdct = new MDCT(MDCT_TIME_SAMPLE_COUNT, 4)

/**
 * Window and transform one ATRAC3plus subband.
 *
 * @param {Float32Array} timeSamples Time-domain subband window.
 * @param {Float32Array} destination Caller-owned spectrum.
 * @param {Float32Array} window Transform window.
 * @param {boolean} reverseOutput Whether the codec reverses this subband.
 * @param {MdctScratch} scratch Reusable transform storage.
 * @param {number} [destinationOffset=0] First output coefficient.
 * @returns {Float32Array} Destination containing the transformed subband.
 * @nativeUnchecked Capacities are checked below; frame callsites supply nonnegative integral output offsets.
 */
export function transformMdctSubband(
  timeSamples,
  destination,
  window,
  reverseOutput,
  scratch,
  destinationOffset = 0
) {
  if (
    !(timeSamples instanceof Float32Array) ||
    timeSamples.length < MDCT_TIME_SAMPLE_COUNT ||
    !(destination instanceof Float32Array) ||
    destinationOffset + MDCT_COEFFICIENT_COUNT > destination.length ||
    !(window instanceof Float32Array) ||
    window.length < MDCT_TIME_SAMPLE_COUNT ||
    !(scratch?.windowedSamples instanceof Float32Array) ||
    scratch.windowedSamples.length < MDCT_TIME_SAMPLE_COUNT
  ) {
    throw new RangeError('ATRAC3plus MDCT buffers have invalid geometry')
  }
  const windowedSamples = scratch.windowedSamples
  for (let sample = 0; sample < MDCT_TIME_SAMPLE_COUNT; sample++) {
    windowedSamples[sample] = timeSamples[sample] * window[sample]
  }
  forwardMdct.transform(
    windowedSamples,
    scratch?.buffers,
    destination,
    destinationOffset
  )
  if (reverseOutput) {
    for (let line = 0; line < MDCT_COEFFICIENT_COUNT >> 1; line++) {
      const first = destinationOffset + line
      const second = destinationOffset + MDCT_COEFFICIENT_COUNT - 1 - line
      const value = destination[first]
      destination[first] = destination[second]
      destination[second] = value
    }
  }
  return destination
}

/**
 * Publish gain-scaled and unscaled spectra for one staged channel.
 *
 * @param {EncodeAnalysisState} analysis Staged QMF analysis state.
 * @param {number} bandCount Active analysis-band count.
 * @param {GainRecord[]} previousGainRecords Previous-frame gain records.
 * @param {GainRecord[]} currentGainRecords Current-frame gain records.
 * @param {Float32Array} gainScaledSpectrum Gain-scaled output spectrum.
 * @param {Float32Array} gainUnscaledSpectrum Unscaled output spectrum.
 * @param {MdctScratch} scratch Reusable transform storage.
 * @returns {Float32Array|null} Scaled spectrum, or `null` if gain is invalid.
 */
export function writeMdctOutputs(
  analysis,
  bandCount,
  previousGainRecords,
  currentGainRecords,
  gainScaledSpectrum,
  gainUnscaledSpectrum,
  scratch
) {
  if (
    !Number.isInteger(bandCount) ||
    bandCount < 0 ||
    bandCount > 16 ||
    previousGainRecords?.length < bandCount ||
    currentGainRecords?.length < bandCount ||
    !(gainScaledSpectrum instanceof Float32Array) ||
    gainScaledSpectrum.length < bandCount * MDCT_COEFFICIENT_COUNT ||
    !(gainUnscaledSpectrum instanceof Float32Array) ||
    gainUnscaledSpectrum.length < bandCount * MDCT_COEFFICIENT_COUNT ||
    typeof analysis?.copyBandSamples !== 'function' ||
    !(scratch?.timeSamples instanceof Float32Array) ||
    scratch.timeSamples.length < MDCT_TIME_SAMPLE_COUNT
  ) {
    throw new RangeError('ATRAC3plus MDCT analysis geometry is invalid')
  }

  const timeSamples = scratch.timeSamples
  const gainScale = scratch.gainScale
  for (let band = 0; band < bandCount; band++) {
    const previous = previousGainRecords[band]
    const current = currentGainRecords[band]
    analysis.copyBandSamples(band, 0, timeSamples)
    if (
      gainPairIsActive(previous, current) &&
      applyForwardGainScale(previous, current, timeSamples, gainScale) === null
    ) {
      return null
    }
    transformMdctSubband(
      timeSamples,
      gainScaledSpectrum,
      MDCT_WINDOW_STEADY,
      MDCT_REVERSE_FLAGS_BY_SUBBAND[band] !== 0,
      scratch,
      band * MDCT_COEFFICIENT_COUNT
    )
  }

  for (let band = 0; band < bandCount; band++) {
    const offset = band * MDCT_COEFFICIENT_COUNT
    const previous = previousGainRecords[band]
    const current = currentGainRecords[band]
    if (!gainPairIsActive(previous, current)) {
      gainUnscaledSpectrum.set(
        gainScaledSpectrum.subarray(offset, offset + MDCT_COEFFICIENT_COUNT),
        offset
      )
      continue
    }
    analysis.copyBandSamples(band, 0, timeSamples)
    transformMdctSubband(
      timeSamples,
      gainUnscaledSpectrum,
      MDCT_WINDOW_STEADY,
      MDCT_REVERSE_FLAGS_BY_SUBBAND[band] !== 0,
      scratch,
      offset
    )
  }
  return gainScaledSpectrum
}
