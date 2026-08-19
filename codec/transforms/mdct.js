/** Exact ATRAC3plus forward and inverse MDCT kernels. */

import {
  FRAME_SAMPLES,
  MDCT_COEFFICIENTS,
  MDCT_SCALE,
  MDCT_TIME_SAMPLES,
} from '../core/constants.js'
import {
  MDCT_COSINE_COEFFICIENTS,
  MDCT_REORDER_INDICES,
  MDCT_REVERSE_FLAGS_BY_SUBBAND,
  MDCT_SINE_COEFFICIENTS,
  MDCT_WINDOW_BOTH_TRANSIENT,
  MDCT_WINDOW_CURRENT_TRANSIENT,
  MDCT_WINDOW_PREVIOUS_TRANSIENT,
  MDCT_WINDOW_STEADY,
} from '../core/tables.js'
import {
  applyForwardGainScale,
  applyInverseGainScale,
  gainPairIsActive,
} from './gain-scale.js'
import {
  float32Add,
  float32Multiply,
  float32MultiplyAdd,
  float32Negate,
  float32Subtract,
} from '../utils.js'

/**
 * Select the overlap window for adjacent transient flags.
 *
 * @param {number|boolean} previousTransient Previous-window flag.
 * @param {number|boolean} currentTransient Current-window flag.
 * @returns {Float32Array} Selected fixed overlap window.
 */
export function mdctWindow(previousTransient, currentTransient) {
  if (!previousTransient && !currentTransient) return MDCT_WINDOW_STEADY
  if (!previousTransient) return MDCT_WINDOW_CURRENT_TRANSIENT
  if (!currentTransient) return MDCT_WINDOW_PREVIOUS_TRANSIENT
  return MDCT_WINDOW_BOTH_TRANSIENT
}

/**
 * Transform one 256-sample ATRAC3plus subband window into 128 coefficients.
 * Arithmetic is rounded at explicit float32 boundaries.
 *
 * @param {Float32Array} timeSamples Time-domain input window.
 * @param {Float32Array} destination Caller-owned coefficient output.
 * @param {Float32Array} window Selected MDCT window.
 * @param {boolean} reverseOutput Whether to reverse coefficient order.
 * @param {MdctScratch} scratch Reusable MDCT work.
 * @param {number} [destinationOffset=0] First output coefficient.
 * @returns {Float32Array} The destination coefficients.
 */
export function forwardMdct128(
  timeSamples,
  destination,
  window,
  reverseOutput,
  scratch,
  destinationOffset = 0
) {
  if (
    !(timeSamples instanceof Float32Array) ||
    timeSamples.length < MDCT_TIME_SAMPLES ||
    !(destination instanceof Float32Array) ||
    !Number.isInteger(destinationOffset) ||
    destinationOffset < 0 ||
    destinationOffset + MDCT_COEFFICIENTS > destination.length ||
    !(window instanceof Float32Array) ||
    window.length < MDCT_TIME_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus MDCT buffers have invalid geometry')
  }
  const fftWork = scratch?.fftWork
  if (!(fftWork instanceof Float32Array) || fftWork.length < 128) {
    throw new RangeError('ATRAC3plus MDCT scratch has invalid geometry')
  }

  for (let sample = 0; sample < 64; sample++) {
    const firstIndex = MDCT_REORDER_INDICES[64 + sample]
    const secondIndex = MDCT_REORDER_INDICES[63 - sample]
    const windowedHead = float32Multiply(window[sample], timeSamples[sample])
    const windowedTail = float32Multiply(
      window[127 - sample],
      timeSamples[127 - sample]
    )
    fftWork[firstIndex] = float32Subtract(windowedHead, windowedTail)

    const windowedMiddle = float32Multiply(
      window[128 + sample],
      timeSamples[128 + sample]
    )
    const windowedEnd = float32Multiply(
      window[255 - sample],
      timeSamples[255 - sample]
    )
    fftWork[secondIndex] = float32Negate(
      float32Add(windowedMiddle, windowedEnd)
    )
  }

  let twiddleBase = 0
  for (let stage = 0; stage < 6; stage++) {
    const step = 1 << stage
    const butterflySpan = step << 1
    const groups = 128 / (step * 4)
    let base = 0
    for (let group = 0; group < groups; group++) {
      let twiddle = twiddleBase
      for (let butterfly = 0; butterfly < step; butterfly++) {
        const firstIndex = base + butterfly * 2
        const secondIndex = firstIndex + butterflySpan
        const firstReal = fftWork[firstIndex]
        const firstImaginary = fftWork[firstIndex + 1]
        const secondReal = fftWork[secondIndex]
        const secondImaginary = fftWork[secondIndex + 1]
        const cosine = MDCT_COSINE_COEFFICIENTS[twiddle]
        const sine = MDCT_SINE_COEFFICIENTS[twiddle]
        const rotatedReal = float32Add(
          float32Multiply(sine, secondImaginary),
          float32Multiply(cosine, secondReal)
        )
        const rotatedImaginary = float32Subtract(
          float32Multiply(secondReal, sine),
          float32Multiply(secondImaginary, cosine)
        )
        fftWork[firstIndex] = float32Add(firstReal, rotatedReal)
        fftWork[firstIndex + 1] = float32Add(firstImaginary, rotatedImaginary)
        fftWork[secondIndex] = float32Subtract(firstReal, rotatedReal)
        fftWork[secondIndex + 1] = float32Subtract(
          firstImaginary,
          rotatedImaginary
        )
        twiddle++
      }
      base += butterflySpan * 2
    }
    twiddleBase += step
  }

  let twiddle = twiddleBase
  for (let pair = 0; pair < 64; pair++) {
    const real = fftWork[pair * 2]
    const imaginary = fftWork[pair * 2 + 1]
    const cosine = MDCT_COSINE_COEFFICIENTS[twiddle]
    const sine = MDCT_SINE_COEFFICIENTS[twiddle]
    const direct = float32Multiply(
      float32MultiplyAdd(sine, imaginary, float32Multiply(cosine, real)),
      MDCT_SCALE
    )
    const reflected = float32Multiply(
      float32MultiplyAdd(real, sine, -float32Multiply(imaginary, cosine)),
      MDCT_SCALE
    )
    const evenIndex = destinationOffset + pair * 2
    const reflectedIndex = destinationOffset + 127 - pair * 2
    if (reverseOutput) {
      destination[reflectedIndex] = direct
      destination[evenIndex] = reflected
    } else {
      destination[evenIndex] = direct
      destination[reflectedIndex] = reflected
    }
    twiddle++
  }
  return destination
}

/**
 * Run the inverse MDCT and overlap-add one subband into caller-owned output storage.
 *
 * @param {ArrayLike<number>} spectrum
 * @param {number} spectrumOffset
 * @param {Float32Array} destination
 * @param {number} destinationOffset
 * @param {ArrayLike<number>} overlap
 * @param {number} previousGain
 * @param {number} currentGain
 * @param {number} previousTransient
 * @param {number} currentTransient
 * @param {number} subband
 * @param {MdctScratch} scratch
 * @returns {boolean}
 */
function inverseMdctSubband(
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
  const timeSamples = scratch.timeSamples
  const fftWork = scratch.fftWork
  const window = mdctWindow(previousTransient, currentTransient)
  timeSamples.fill(0)
  fftWork.fill(0)

  let twiddle = 63
  const reverse = MDCT_REVERSE_FLAGS_BY_SUBBAND[subband] !== 0
  for (let pair = 0; pair < 64; pair++) {
    const index = pair * 2
    const head = spectrum[spectrumOffset + index]
    const tail = spectrum[spectrumOffset + 127 - index]
    const cosine = MDCT_COSINE_COEFFICIENTS[twiddle]
    const sine = MDCT_SINE_COEFFICIENTS[twiddle]
    if (reverse) {
      fftWork[index] = cosine * tail + sine * head
      fftWork[index + 1] = tail * sine - head * cosine
    } else {
      fftWork[index] = cosine * head + sine * tail
      fftWork[index + 1] = head * sine - tail * cosine
    }
    twiddle++
  }

  let twiddleBase = 63
  for (let stage = 5; stage >= 0; stage--) {
    const step = 1 << stage
    const half = step * 2
    const groupStride = step * 4
    const groups = MDCT_COEFFICIENTS / groupStride
    for (let group = 0; group < groups; group++) {
      let twiddleIndex = twiddleBase - step
      const base = group * groupStride
      for (let butterfly = 0; butterfly < step; butterfly++) {
        const firstIndex = base + butterfly * 2
        const secondIndex = base + half + butterfly * 2
        const firstReal = fftWork[firstIndex]
        const firstImaginary = fftWork[firstIndex + 1]
        const secondReal = fftWork[secondIndex]
        const secondImaginary = fftWork[secondIndex + 1]
        const differenceReal = firstReal - secondReal
        const differenceImaginary = firstImaginary - secondImaginary
        const cosine = MDCT_COSINE_COEFFICIENTS[twiddleIndex]
        const sine = MDCT_SINE_COEFFICIENTS[twiddleIndex]
        fftWork[firstIndex] = firstReal + secondReal
        fftWork[firstIndex + 1] = firstImaginary + secondImaginary
        fftWork[secondIndex] =
          differenceReal * cosine + differenceImaginary * sine
        fftWork[secondIndex + 1] =
          differenceReal * sine - differenceImaginary * cosine
        twiddleIndex++
      }
    }
    twiddleBase -= step
  }

  for (let sample = 0; sample < 64; sample++) {
    const firstIndex = MDCT_REORDER_INDICES[64 + sample]
    timeSamples[sample] = window[sample] * fftWork[firstIndex]
    const lastIndex = MDCT_REORDER_INDICES[sample]
    timeSamples[192 + sample] = -fftWork[lastIndex] * window[192 + sample]
  }
  for (let sample = 0; sample < 128; sample++) {
    const fftIndex = MDCT_REORDER_INDICES[127 - sample]
    timeSamples[64 + sample] = -fftWork[fftIndex] * window[64 + sample]
  }

  if (
    gainPairIsActive(previousGain, currentGain) &&
    applyInverseGainScale(
      previousGain,
      currentGain,
      timeSamples,
      scratch.gainScale
    ) === null
  ) {
    return false
  }
  for (let sample = 0; sample < 128; sample++) {
    destination[destinationOffset + sample] = Math.fround(
      timeSamples[sample] + overlap[destinationOffset + sample]
    )
    overlap[destinationOffset + sample] = timeSamples[128 + sample]
  }
  return true
}

/**
 * Invert the active 128-line ATRAC3plus subbands into detached 128-sample blocks.
 * The overlap array belongs to staged synthesis state and advances in place.
 *
 * @param {Float32Array} spectrum Dequantized channel spectrum.
 * @param {Float32Array} destination Caller-owned subband samples.
 * @param {GainRecord[]} previousGainRecords Previous-frame gain records.
 * @param {GainRecord[]} currentGainRecords Current-frame gain records.
 * @param {Uint8Array} previousWindowFlags Previous transient flags.
 * @param {Uint8Array} currentWindowFlags Current transient flags.
 * @param {number} activeSubbandCount Active transform subbands.
 * @param {Float32Array} overlap Staged overlap state.
 * @param {MdctScratch} scratch Reusable inverse-MDCT work.
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
    spectrum.length < activeSubbandCount * MDCT_COEFFICIENTS ||
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
    scratch.timeSamples.length < MDCT_TIME_SAMPLES ||
    !(scratch?.fftWork instanceof Float32Array) ||
    scratch.fftWork.length < MDCT_COEFFICIENTS
  ) {
    throw new RangeError('ATRAC3plus inverse MDCT geometry is invalid')
  }
  destination.fill(0)
  for (let subband = 0; subband < activeSubbandCount; subband++) {
    const offset = subband * MDCT_COEFFICIENTS
    if (
      !inverseMdctSubband(
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
  overlap.fill(0, activeSubbandCount * MDCT_COEFFICIENTS)
  return destination
}

/**
 * Publish gain-scaled and unscaled spectra for one staged ATRAC3plus channel.
 * `analysis` supplies the oldest 256 samples in each delayed band ring.
 *
 * @param {EncodeAnalysisState} analysis Staged QMF analysis state.
 * @param {number} bandCount Active analysis-band count.
 * @param {GainRecord[]} previousGainRecords Previous-frame gain records.
 * @param {GainRecord[]} currentGainRecords Current-frame gain records.
 * @param {Float32Array} gainScaledSpectrum Gain-scaled output spectrum.
 * @param {Float32Array} gainUnscaledSpectrum Unscaled output spectrum.
 * @param {MdctScratch} scratch Reusable MDCT work.
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
    gainScaledSpectrum.length < bandCount * MDCT_COEFFICIENTS ||
    !(gainUnscaledSpectrum instanceof Float32Array) ||
    gainUnscaledSpectrum.length < bandCount * MDCT_COEFFICIENTS ||
    typeof analysis?.copyBandSamples !== 'function' ||
    !(scratch?.timeSamples instanceof Float32Array) ||
    scratch.timeSamples.length < MDCT_TIME_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus MDCT analysis geometry is invalid')
  }

  for (let band = 0; band < bandCount; band++) {
    const previous = previousGainRecords[band]
    const current = currentGainRecords[band]
    analysis.copyBandSamples(band, 0, scratch.timeSamples)
    if (
      gainPairIsActive(previous, current) &&
      applyForwardGainScale(
        previous,
        current,
        scratch.timeSamples,
        scratch.gainScale
      ) === null
    ) {
      return null
    }
    forwardMdct128(
      scratch.timeSamples,
      gainScaledSpectrum,
      MDCT_WINDOW_STEADY,
      MDCT_REVERSE_FLAGS_BY_SUBBAND[band] !== 0,
      scratch,
      band * MDCT_COEFFICIENTS
    )
  }

  for (let band = 0; band < bandCount; band++) {
    const offset = band * MDCT_COEFFICIENTS
    const previous = previousGainRecords[band]
    const current = currentGainRecords[band]
    if (!gainPairIsActive(previous, current)) {
      for (let line = 0; line < MDCT_COEFFICIENTS; line++) {
        gainUnscaledSpectrum[offset + line] = gainScaledSpectrum[offset + line]
      }
      continue
    }
    analysis.copyBandSamples(band, 0, scratch.timeSamples)
    forwardMdct128(
      scratch.timeSamples,
      gainUnscaledSpectrum,
      MDCT_WINDOW_STEADY,
      MDCT_REVERSE_FLAGS_BY_SUBBAND[band] !== 0,
      scratch,
      offset
    )
  }
  return gainScaledSpectrum
}
