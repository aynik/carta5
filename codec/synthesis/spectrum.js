/** ATRAC3plus spectral synthesis. */

import {
  FRAME_SAMPLES,
  MDCT_COEFFICIENT_COUNT,
  MDCT_TIME_SAMPLE_COUNT,
} from '../core/constants.js'
import { MDCT_REVERSE_FLAGS_BY_SUBBAND } from '../core/tables.js'
import { IMDCT } from '../signal/mdct.js'
import { applyInverseGainScale, gainPairIsActive } from '../signal/gain.js'
import { selectMdctWindow } from '../signal/window.js'

const inverseMdct = new IMDCT(MDCT_TIME_SAMPLE_COUNT)

/**
 * Transform and overlap one ATRAC3plus subband.
 *
 * @param {Float32Array} spectrum Complete channel spectrum.
 * @param {number} spectrumOffset First coefficient of this subband.
 * @param {Float32Array} destination Caller-owned subband samples.
 * @param {number} destinationOffset First output sample.
 * @param {Float32Array} overlap Persistent overlap state.
 * @param {object} previousGain Previous gain record.
 * @param {object} currentGain Current gain record.
 * @param {number} previousTransient Previous transient flag.
 * @param {number} currentTransient Current transient flag.
 * @param {number} subband Subband index.
 * @param {object} scratch Reusable transform storage.
 * @returns {boolean} Whether the inverse gain syntax was valid.
 */
function synthesizeMdctSubband(
  spectrum,
  spectrumOffset,
  destination,
  destinationOffset,
  overlap,
  previousGain,
  currentGain,
  previousTransient,
  currentTransient,
  subband,
  scratch
) {
  const reversed = MDCT_REVERSE_FLAGS_BY_SUBBAND[subband] !== 0
  for (let line = 0; line < MDCT_COEFFICIENT_COUNT; line++) {
    const sourceLine = reversed ? MDCT_COEFFICIENT_COUNT - 1 - line : line
    scratch.spectrum[line] = spectrum[spectrumOffset + sourceLine]
  }
  inverseMdct.transform(scratch.spectrum, scratch.buffers, scratch.timeSamples)

  const window = selectMdctWindow(previousTransient, currentTransient)
  for (let sample = 0; sample < MDCT_TIME_SAMPLE_COUNT; sample++) {
    scratch.timeSamples[sample] *= window[sample]
  }
  if (
    gainPairIsActive(previousGain, currentGain) &&
    applyInverseGainScale(
      previousGain,
      currentGain,
      scratch.timeSamples,
      scratch.gainScale
    ) === null
  ) {
    return false
  }
  for (let sample = 0; sample < MDCT_COEFFICIENT_COUNT; sample++) {
    destination[destinationOffset + sample] = Math.fround(
      scratch.timeSamples[sample] + overlap[destinationOffset + sample]
    )
    overlap[destinationOffset + sample] =
      scratch.timeSamples[MDCT_COEFFICIENT_COUNT + sample]
  }
  return true
}

/**
 * Invert active ATRAC3plus subbands into detached sample blocks.
 *
 * @param {Float32Array} spectrum Dequantized channel spectrum.
 * @param {Float32Array} destination Caller-owned subband samples.
 * @param {object[]} previousGainRecords Previous-frame gain records.
 * @param {object[]} currentGainRecords Current-frame gain records.
 * @param {Uint8Array} previousWindowFlags Previous transient flags.
 * @param {Uint8Array} currentWindowFlags Current transient flags.
 * @param {number} activeSubbandCount Active transform subbands.
 * @param {Float32Array} overlap Staged overlap state.
 * @param {object} scratch Reusable transform storage.
 * @returns {Float32Array|null} Destination samples, or `null` if invalid.
 */
export function inverseMdctFrame(
  spectrum,
  destination,
  previousGainRecords,
  currentGainRecords,
  previousWindowFlags,
  currentWindowFlags,
  activeSubbandCount,
  overlap,
  scratch
) {
  if (
    !(spectrum instanceof Float32Array) ||
    spectrum.length < activeSubbandCount * MDCT_COEFFICIENT_COUNT ||
    !(destination instanceof Float32Array) ||
    destination.length < FRAME_SAMPLES ||
    !Number.isInteger(activeSubbandCount) ||
    activeSubbandCount < 0 ||
    activeSubbandCount > 16 ||
    previousGainRecords?.length < activeSubbandCount ||
    currentGainRecords?.length < activeSubbandCount ||
    previousWindowFlags?.length < activeSubbandCount ||
    currentWindowFlags?.length < activeSubbandCount ||
    !(overlap instanceof Float32Array) ||
    overlap.length < FRAME_SAMPLES ||
    !(scratch?.timeSamples instanceof Float32Array) ||
    scratch.timeSamples.length < MDCT_TIME_SAMPLE_COUNT ||
    !(scratch?.spectrum instanceof Float32Array) ||
    scratch.spectrum.length < MDCT_COEFFICIENT_COUNT
  ) {
    throw new RangeError('ATRAC3plus inverse MDCT geometry is invalid')
  }
  destination.fill(0)
  for (let subband = 0; subband < activeSubbandCount; subband++) {
    const offset = subband * MDCT_COEFFICIENT_COUNT
    if (
      !synthesizeMdctSubband(
        spectrum,
        offset,
        destination,
        offset,
        overlap,
        previousGainRecords[subband],
        currentGainRecords[subband],
        previousWindowFlags[subband],
        currentWindowFlags[subband],
        subband,
        scratch
      )
    ) {
      return null
    }
  }
  overlap.fill(0, activeSubbandCount * MDCT_COEFFICIENT_COUNT)
  return destination
}
