/** Bounded ATRAC3plus tone gate, window, budget, and spectral-mask policy. */

import {
  TONE_SCALE_FACTOR_VALUES,
  TONE_MAGNITUDE_LIMIT,
  TONE_SYNTHESIS_SINE,
} from '../core/tables.js'
import { powerSpectrum256 } from '../transforms/dft.js'

import { absoluteMaximum, float64MultiplyAdd } from '../utils.js'
import {
  ANALYSIS_TONE_DETECTION_BANDS,
  DFT_BINS,
  ANALYSIS_TONE_DETECTION_FRAME_SAMPLES,
  MAX_ENTRIES,
  NATURAL_LOG_TO_DECIBELS,
  TONE_BUDGET,
  TONE_MAGNITUDE_SCALE,
  TONE_PHASE_BUCKET_SCALE,
  TONE_PRE_GATE_PEAK_RATIO,
  TONE_RETENTION_RATIO,
} from '../core/constants.js'

/**
 * Compare floating-point candidates while treating NaN as unordered and therefore not greater.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function orderedGreater(left, right) {
  return !Number.isNaN(left) && !Number.isNaN(right) && left > right
}

/**
 * Return the one- or two-band extraction prefix selected by frame power.
 *
 * @param {boolean} enabled Whether tone extraction is enabled.
 * @param {Float32Array} bandPowerSum Combined power by band.
 * @param {number} bandCount Active band count.
 * @returns {number} Selected extraction prefix length.
 */
export function selectToneBandCount(enabled, bandPowerSum, bandCount) {
  const activeBands = Math.min(
    Math.max(bandCount | 0, 0),
    ANALYSIS_TONE_DETECTION_BANDS
  )
  const includeSecond =
    enabled &&
    activeBands > 1 &&
    orderedGreater(bandPowerSum[1], Math.fround(bandPowerSum[0] * 16))
  return Math.min(1 + (includeSecond ? 1 : 0), activeBands)
}

/**
 * Stable shell-sort the selected band prefix by descending power.
 *
 * @param {Float32Array} bandPowerSum Combined power by band.
 * @param {number} bandCount Active band count.
 * @param {Int32Array} destination Caller-owned band ordering.
 * @returns {Int32Array} The destination ordering.
 */
export function orderToneBands(bandPowerSum, bandCount, destination) {
  const count = Math.min(
    Math.max(bandCount | 0, 0),
    ANALYSIS_TONE_DETECTION_BANDS
  )
  destination.fill(0)
  for (let band = 0; band < count; band++) destination[band] = band
  let gap = 1
  while (gap <= count) gap = gap * 3 + 1
  for (;;) {
    gap = Math.trunc(gap / 3)
    if (gap === 0) break
    for (let index = gap; index < count; index++) {
      const item = destination[index]
      let slot = index
      while (
        slot >= gap &&
        orderedGreater(
          bandPowerSum[item],
          bandPowerSum[destination[slot - gap]]
        )
      ) {
        destination[slot] = destination[slot - gap]
        slot -= gap
      }
      destination[slot] = item
    }
  }
  return destination
}

/**
 * Distribute the fixed extraction budget across channels and bands.
 *
 * @param {number} bandCount Active band count.
 * @param {Int32Array} jointFlags Joint-tone flags by band.
 * @param {Int32Array} bandOrder Descending power order.
 * @param {Float32Array[]} bandPower Per-channel band powers.
 * @param {ToneDetectionScratch} scratch Reusable budget work.
 * @returns {Int32Array[]} Per-channel candidate limits.
 */
export function planToneExtractionBudget(
  bandCount,
  jointFlags,
  bandOrder,
  bandPower,
  scratch
) {
  const count = Math.min(
    Math.max(bandCount | 0, 0),
    ANALYSIS_TONE_DETECTION_BANDS
  )
  const combined = scratch.combinedBandPower
  const logarithms = scratch.logBandPower
  combined.fill(0)
  logarithms.fill(0)
  scratch.perBandUnits.fill(0)
  scratch.candidateLimits[0].fill(0)
  scratch.candidateLimits[1].fill(0)
  for (let band = 0; band < count; band++) {
    combined[band] = Math.fround(bandPower[0][band] + bandPower[1][band])
  }
  let logPowerSum = 0
  for (let band = 0; band < count; band++) {
    const power = combined[band]
    let logPower = 0
    if (!orderedGreater(1, power)) {
      logPower = -160
      if (orderedGreater(power, 0)) {
        logPower = Math.fround(
          Math.fround(Math.log(power)) * NATURAL_LOG_TO_DECIBELS
        )
      }
    }
    logarithms[band] = logPower
    logPowerSum = Math.fround(logPowerSum + logPower)
  }
  if (!orderedGreater(logPowerSum, 0)) return scratch.candidateLimits

  const minimumAdjustment = count * -4
  const distributionUnits = (TONE_BUDGET + minimumAdjustment - 4) >>> 0
  const distributionScale = Math.fround(distributionUnits)
  let totalUnits = 0
  for (let band = 0; band < count; band++) {
    const weighted = Math.floor(
      Math.fround(
        Math.fround(
          Math.fround(distributionScale * logarithms[band]) / logPowerSum
        ) + 0.5
      )
    )
    let units = Math.floor(Math.fround(weighted + 0.5)) + 4
    if (units < 4) units = 4
    units &= ~1
    scratch.perBandUnits[band] = units >>> 0
    totalUnits += units
  }
  const remaining = TONE_BUDGET - totalUnits
  if (remaining > 1 && count > 0) {
    scratch.perBandUnits[0] =
      (scratch.perBandUnits[0] + (remaining >>> 0)) >>> 0
  }
  for (let order = 0; order < count; order++) {
    const band = bandOrder[order]
    if (band < 0 || band >= count) continue
    let units = scratch.perBandUnits[band]
    if (units > TONE_BUDGET) {
      units = TONE_BUDGET
      scratch.perBandUnits[band] = units
    }
    if (jointFlags[band] === 0) {
      const primary = units - (units >> 1)
      scratch.candidateLimits[0][band] = primary
      scratch.candidateLimits[1][band] = units - primary
    } else {
      scratch.candidateLimits[0][band] = units - (units >> 1)
    }
    scratch.candidateLimits[0][band] = Math.min(
      Math.max(scratch.candidateLimits[0][band], 0),
      15
    )
    scratch.candidateLimits[1][band] = Math.min(
      Math.max(scratch.candidateLimits[1][band], 0),
      15
    )
  }
  return scratch.candidateLimits
}

/**
 * Compute a power spectrum over one explicit tone window.
 *
 * @param {Float32Array} source Tone source samples.
 * @param {number} start Window start.
 * @param {number} end Window end.
 * @param {Float32Array} destination Caller-owned spectrum.
 * @param {ToneDetectionScratch} scratch Reusable DFT work.
 * @returns {Float32Array} The destination spectrum.
 */
export function writeToneWindowedSpectrum(
  source,
  start,
  end,
  destination,
  scratch
) {
  const span = (end - start) & 0x3fffffff
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    span < 0 ||
    start + span > ANALYSIS_TONE_DETECTION_FRAME_SAMPLES ||
    source.length < start + span
  ) {
    throw new RangeError('ATRAC3plus tone window is invalid')
  }
  scratch.windowSamples.fill(0)
  if (span > 0) {
    scratch.windowSamples.set(source.subarray(start, start + span), start)
  }
  destination.fill(0)
  return powerSpectrum256(
    scratch.windowSamples,
    ANALYSIS_TONE_DETECTION_FRAME_SAMPLES,
    destination,
    scratch.dftWork
  )
}

/**
 * Select bins whose stereo power ratio permits joint extraction.
 *
 * @param {Float32Array} primary Primary-channel power spectrum.
 * @param {Float32Array} secondary Secondary-channel power spectrum.
 * @param {Float32Array} destination Caller-owned binary mask.
 * @returns {Float32Array} The destination mask.
 */
export function writeToneJointRatioMask(primary, secondary, destination) {
  destination.fill(0)
  for (let bin = 0; bin < DFT_BINS; bin++) {
    const denominator = secondary[bin]
    if (!orderedGreater(denominator, 0)) continue
    const ratio = Math.fround(primary[bin] / denominator)
    if (orderedGreater(ratio, 0.25) && orderedGreater(4, ratio)) {
      destination[bin] = 1
    }
  }
  return destination
}

/**
 * Suppress band-0 upper bins when lower-frequency energy dominates.
 *
 * @param {number} band Analysis-band index.
 * @param {Float32Array} spectrum Power spectrum.
 * @param {Float32Array} frequencyMask Mutable frequency mask.
 * @returns {Float32Array} The frequency mask.
 */
export function applyToneBand0UpperMask(band, spectrum, frequencyMask) {
  if (band !== 0) return frequencyMask
  let lowerPower = 0
  let upperPower = 0
  for (let bin = 0; bin < 64; bin++) {
    lowerPower = Math.fround(lowerPower + spectrum[bin])
  }
  for (let bin = 64; bin < 128; bin++) {
    upperPower = Math.fround(upperPower + spectrum[bin])
  }
  let ratio = 0
  if (orderedGreater(lowerPower, 0) && orderedGreater(upperPower, 0)) {
    ratio = Math.fround(lowerPower / upperPower)
  }
  if (orderedGreater(ratio, 16)) frequencyMask.fill(0, 64, DFT_BINS)
  return frequencyMask
}

/**
 * Apply a mask in place and return the first strongest ordered bin.
 *
 * @param {Float32Array} spectrum Mutable power spectrum.
 * @param {Float32Array} frequencyMask Per-bin multiplier mask.
 * @returns {number} Strongest bin, or `-1` when none is active.
 */
export function selectToneMaskedPeakBin(spectrum, frequencyMask) {
  let peakBin = -1
  let peakValue = 0
  for (let bin = 0; bin < DFT_BINS; bin++) {
    spectrum[bin] = Math.fround(spectrum[bin] * frequencyMask[bin])
    if (orderedGreater(spectrum[bin], peakValue)) {
      peakValue = spectrum[bin]
      peakBin = bin
    }
  }
  return peakBin
}

/**
 * Detect current-frame attack/release boundaries into a reusable gate.
 *
 * @param {Float32Array} samples Complete 320-sample tone analysis row.
 * @param {ToneDetectionScratch} scratch Reusable gate measurements.
 * @param {ToneGate} [destination] Gate to overwrite.
 * @returns {ToneGate} The destination gate.
 */
export function planToneGate(samples, scratch, destination = scratch.gate) {
  if (!(samples instanceof Float32Array) || samples.length < 320) {
    throw new RangeError('ATRAC3plus tone gate requires 320 samples')
  }
  const precedingPeak = absoluteMaximum(samples, 64, 128)
  const precedingEndPeak = absoluteMaximum(samples, 120, 128)
  const futureMax = absoluteMaximum(samples, 256, 320)
  const futureStartMax = absoluteMaximum(samples, 256, 260)
  for (let group = 0; group < 32; group++) {
    const start = 128 + group * 4
    scratch.groupMax[group] = absoluteMaximum(samples, start, start + 4)
  }
  let peak = 0
  let peakGroup = 0
  for (let group = 0; group < 32; group++) {
    if (orderedGreater(scratch.groupMax[group], peak)) {
      peak = scratch.groupMax[group]
      peakGroup = group
    }
  }
  let pivot = peakGroup
  if (orderedGreater(futureMax, peak)) pivot = 32
  scratch.attackRatio.fill(0)
  let running = precedingPeak
  for (let group = 0; group < 32; group++) {
    const groupPeak = scratch.groupMax[group]
    if (orderedGreater(groupPeak, running)) running = groupPeak
    const threshold = Math.fround(4 * running)
    if (group < 31) {
      const next = scratch.groupMax[group + 1]
      if (orderedGreater(next, threshold) && orderedGreater(peak, 0)) {
        scratch.attackRatio[group] = Math.fround(groupPeak / peak)
      }
    } else if (
      orderedGreater(futureStartMax, threshold) &&
      orderedGreater(peak, 0)
    ) {
      scratch.attackRatio[group] = Math.fround(groupPeak / futureStartMax)
    }
  }
  let startValid = 0
  let startIndex = -1
  if (pivot > 0) {
    for (let group = 0; group < pivot; group++) {
      if (orderedGreater(scratch.attackRatio[group], 0)) {
        startValid = 1
        startIndex = group
      }
    }
    if (startValid) {
      if (startIndex < 30) startIndex += 2
      else if (startIndex < 31) startIndex++
    }
  }
  if (orderedGreater(precedingPeak, peak)) pivot = 0
  for (let group = 0; group < 32; group += 2) {
    const even = scratch.groupMax[group]
    const odd = scratch.groupMax[group + 1]
    const chosen = orderedGreater(odd, even) ? odd : even
    scratch.pairMax[group] = chosen
    scratch.pairMax[group + 1] = chosen
  }
  scratch.releaseRatio.fill(0)
  let tailMax = futureMax
  if (pivot < 32) {
    for (let group = 31; group >= pivot; group--) {
      const current = scratch.pairMax[group]
      if (orderedGreater(current, tailMax)) tailMax = current
      const threshold = Math.fround(tailMax + tailMax)
      if (group >= 1) {
        const previous = scratch.pairMax[group - 1]
        if (orderedGreater(previous, threshold) && orderedGreater(peak, 0)) {
          scratch.releaseRatio[group] = Math.fround(current / peak)
        }
      } else if (orderedGreater(precedingEndPeak, threshold)) {
        scratch.releaseRatio[group] = Math.fround(current / precedingEndPeak)
      }
    }
  }
  let endValid = 0
  let endIndex = 32
  if (pivot < 32) {
    for (let group = 31; group >= pivot; group--) {
      if (orderedGreater(scratch.releaseRatio[group], 0)) {
        endValid = 1
        endIndex = group
      }
    }
    if (endValid && endIndex > 29) endIndex = 31
  }
  return destination.set(
    startValid,
    endValid,
    startValid ? startIndex : -1,
    endValid ? endIndex : 32
  )
}

/**
 * Combine a current gate with previous syntax into one synthesis window.
 *
 * @param {ToneGate} gate Current detector gate.
 * @param {ToneSynthesisRecord} history Previous tone syntax record.
 * @param {ToneWindow} destination Window to overwrite.
 * @returns {ToneWindow} The destination window.
 */
export function planToneWindow(gate, history, destination) {
  let leftIndex
  let hasLeftFade
  if (gate.startValid === 0 || gate.endIndex <= gate.startIndex) {
    if (history.gateStartValid !== 0) {
      leftIndex = history.gateStartIndex << 2
      hasLeftFade = 1
    } else {
      leftIndex = 0
      hasLeftFade = 0
    }
  } else {
    leftIndex = gate.startIndex * 4 + 128
    hasLeftFade = 1
  }
  let endValue = history.gateEndIndex * 4
  let hasRightFade
  if (history.gateEndValid === 0 || endValue < leftIndex) {
    if (gate.endValid !== 0) {
      endValue = gate.endIndex * 4 + 128
      hasRightFade = 1
    } else {
      endValue = 256
      hasRightFade = 0
    }
  } else {
    hasRightFade = 1
  }
  const rightIndex = Math.min(endValue + 4, 256)
  return destination.set(hasLeftFade, hasRightFade, leftIndex, rightIndex)
}

/**
 * Return the analysis-window coefficient for one tone-fitting sample.
 *
 * @param {number} count
 * @returns {number}
 */
function toneWindowScale(count) {
  if (count === 256) return 1
  if (count > 223) return Math.fround(0.9)
  if (count > 191) return Math.fround(0.8)
  if (count > 159) return Math.fround(0.7)
  if (count > 127) return Math.fround(0.6)
  return Math.fround(0.5)
}

/**
 * Find the nearest encodable tone scale factor for a measured magnitude.
 *
 * @param {number} scaled
 * @returns {number}
 */
function searchToneScaleFactorIndex(scaled) {
  let position = 0x20
  let step = 0x10
  while (step > 0) {
    if (TONE_SCALE_FACTOR_VALUES[position] > scaled) position -= step
    else position += step
    step >>= 1
  }
  if (position <= 0x3e && scaled > TONE_SCALE_FACTOR_VALUES[position]) {
    position++
  }
  return position
}

/**
 * Convert a fitted sinusoid magnitude to its coded scale-factor index.
 *
 * @param {number} magnitude
 * @returns {number}
 */
function toneScaleFactorIndexFromMagnitude(magnitude) {
  const scaled = magnitude * TONE_MAGNITUDE_SCALE
  return Number.isNaN(scaled) || TONE_MAGNITUDE_LIMIT <= scaled
    ? searchToneScaleFactorIndex(scaled)
    : 0
}

/**
 * Quantize a fitted sinusoid phase into the codec's phase bucket.
 *
 * @param {number} phase
 * @returns {number}
 */
function tonePhaseBucket(phase) {
  const scaled = Math.floor(
    Math.fround(Math.fround(phase) * TONE_PHASE_BUCKET_SCALE) + 0.5
  )
  return scaled & 0x1f
}

/**
 * Compute a float32-rounded dot product for deterministic sinusoid fitting.
 *
 * @param {Float32Array} source
 * @param {number} start
 * @param {number} count
 * @returns {number}
 */
function dotProductF32(source, start, count) {
  let lane0 = 0
  let lane1 = 0
  let lane2 = 0
  let lane3 = 0
  for (let offset = 0; offset < count; offset += 4) {
    const index = start + offset
    lane0 = Math.fround(lane0 + Math.fround(source[index] * source[index]))
    lane2 = Math.fround(
      lane2 + Math.fround(source[index + 2] * source[index + 2])
    )
    lane1 = Math.fround(
      lane1 + Math.fround(source[index + 1] * source[index + 1])
    )
    lane3 = Math.fround(
      lane3 + Math.fround(source[index + 3] * source[index + 3])
    )
  }
  return Math.fround(Math.fround(Math.fround(lane0 + lane1) + lane2) + lane3)
}

/**
 * Evaluate the residual gradient with respect to sinusoid magnitude.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} start
 * @param {number} end
 * @param {number} omega
 * @returns {number}
 */
function toneMagnitudeGradient(samples, start, end, omega) {
  const sineStep = Math.sin(omega)
  const cosineStep = Math.cos(omega)
  let sine
  let cosine
  if (start === 0) {
    sine = 0
    cosine = 1
  } else {
    const startAngle = omega * start
    sine = Math.sin(startAngle)
    cosine = Math.cos(startAngle)
  }
  let sineProjection = 0
  let cosineProjection = 0
  let sineDerivative = 0
  let cosineDerivative = 0
  let samplePosition = start
  for (let index = start; index < end; index++) {
    const sample = samples[index]
    const weightedSample = samplePosition * sample
    sineProjection = float64MultiplyAdd(sample, sine, sineProjection)
    cosineProjection = float64MultiplyAdd(sample, cosine, cosineProjection)
    sineDerivative = float64MultiplyAdd(weightedSample, cosine, sineDerivative)
    cosineDerivative = float64MultiplyAdd(
      -weightedSample,
      sine,
      cosineDerivative
    )
    const nextSine = float64MultiplyAdd(sine, cosineStep, cosine * sineStep)
    cosine = float64MultiplyAdd(cosine, cosineStep, -(sine * sineStep))
    sine = nextSine
    samplePosition += 1
  }
  return sineProjection * sineDerivative + cosineProjection * cosineDerivative
}

/**
 * Convert a coded tone frequency into its emitted angular step.
 *
 * @param {number} omega
 * @returns {number}
 */
function emittedToneStep(omega) {
  return Math.min(
    Math.max(Math.floor((omega * 1024) / Math.PI + 0.5), 1),
    0x3ff
  )
}

/**
 * Refine a coarse tone frequency by minimizing residual energy locally.
 *
 * @param {number} initialAngularFrequency
 * @param {ArrayLike<number>} samples
 * @param {number} start
 * @param {number} end
 * @param {number} iterations
 * @param {boolean} stopOnEmittedGrid
 * @param {{omega: number, emittedStep: number}} destination
 * @returns {{omega: number, emittedStep: number}}
 */
function refineToneFrequency(
  initialAngularFrequency,
  samples,
  start,
  end,
  iterations,
  stopOnEmittedGrid,
  destination
) {
  const halfBinWidth = Math.PI / 256
  let lowerBound = Math.max(initialAngularFrequency - halfBinWidth, 0)
  let upperBound = Math.min(initialAngularFrequency + halfBinWidth, Math.PI)
  destination.emittedStep = -1
  if (iterations === 0) {
    destination.omega = 0.5 * (lowerBound + upperBound)
    return destination
  }
  let midpoint = 0.5 * (lowerBound + upperBound)
  if (toneMagnitudeGradient(samples, start, end, midpoint) > 0) {
    lowerBound = midpoint
  } else {
    upperBound = midpoint
  }
  if (stopOnEmittedGrid) {
    const lowerStep = emittedToneStep(lowerBound)
    if (lowerStep === emittedToneStep(upperBound)) {
      destination.omega = 0.5 * (lowerBound + upperBound)
      destination.emittedStep = lowerStep
      return destination
    }
  }
  for (let iteration = 1; iteration < iterations; iteration++) {
    midpoint = 0.5 * (lowerBound + upperBound)
    if (toneMagnitudeGradient(samples, start, end, midpoint) > 0) {
      lowerBound = midpoint
    } else {
      upperBound = midpoint
    }
    if (stopOnEmittedGrid) {
      const lowerStep = emittedToneStep(lowerBound)
      if (lowerStep === emittedToneStep(upperBound)) {
        destination.omega = 0.5 * (lowerBound + upperBound)
        destination.emittedStep = lowerStep
        return destination
      }
    }
  }
  destination.omega = 0.5 * (lowerBound + upperBound)
  return destination
}

/**
 * Solve the sine/cosine least-squares fit for one candidate frequency.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} start
 * @param {number} end
 * @param {number} omega
 * @param {{magnitude: number, step: number, phase: number}} destination
 * @returns {boolean}
 */
function fitToneLeastSquares(samples, start, end, omega, destination) {
  const sineStep = Math.sin(omega)
  const cosineStep = Math.cos(omega)
  let sine
  let cosine
  if (start === 0) {
    sine = 0
    cosine = 1
  } else {
    const startAngle = omega * start
    sine = Math.sin(startAngle)
    cosine = Math.cos(startAngle)
  }
  let sampleCosineProjection = 0
  let sampleSineProjection = 0
  let cosineEnergy = 0
  let sineEnergy = 0
  let crossEnergy = 0
  for (let index = start; index < end; index++) {
    const sample = samples[index]
    sampleCosineProjection = float64MultiplyAdd(
      sample,
      cosine,
      sampleCosineProjection
    )
    sampleSineProjection = float64MultiplyAdd(
      sample,
      sine,
      sampleSineProjection
    )
    cosineEnergy = float64MultiplyAdd(cosine, cosine, cosineEnergy)
    sineEnergy = float64MultiplyAdd(sine, sine, sineEnergy)
    crossEnergy = float64MultiplyAdd(cosine, sine, crossEnergy)
    const nextSine = float64MultiplyAdd(sine, cosineStep, cosine * sineStep)
    cosine = float64MultiplyAdd(cosine, cosineStep, -(sine * sineStep))
    sine = nextSine
  }
  const determinant = cosineEnergy * sineEnergy - crossEnergy * crossEnergy
  if (Number.isNaN(determinant) || determinant <= 1e-9) return false
  const cosineCoefficient =
    (sineEnergy * sampleCosineProjection - crossEnergy * sampleSineProjection) /
    determinant
  const sineCoefficient =
    (cosineEnergy * sampleSineProjection -
      crossEnergy * sampleCosineProjection) /
    determinant
  destination.magnitude = Math.fround(
    Math.sqrt(
      cosineCoefficient * cosineCoefficient + sineCoefficient * sineCoefficient
    )
  )
  const phase = Math.atan2(cosineCoefficient, sineCoefficient)
  destination.step = Math.min(
    Math.max(Math.floor((omega * 1024) / Math.PI + 0.5), 1),
    0x3ff
  )
  const phaseTableIndex = Math.floor((phase * 1024) / Math.PI + 0.5)
  destination.phase = (phaseTableIndex + destination.step * 128) & 0x7ff
  return true
}

/**
 * Fit frequency, magnitude, and phase for the strongest sinusoid candidate.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} peakBin
 * @param {number} start
 * @param {number} end
 * @param {boolean} fitEmittedFrequency
 * @param {ToneDetectionScratch} scratch
 * @returns {boolean}
 */
function estimateToneSinusoid(
  samples,
  peakBin,
  start,
  end,
  fitEmittedFrequency,
  scratch
) {
  if (end <= start) return false
  const seededBin = Math.max(peakBin, 1)
  const initialAngularFrequency = (Math.PI * seededBin) / 128
  const fit = refineToneFrequency(
    initialAngularFrequency,
    samples,
    start,
    end,
    fitEmittedFrequency ? 5 : 9,
    fitEmittedFrequency,
    scratch.frequencyFit
  )
  let omega = fit.omega
  if (fitEmittedFrequency) {
    const step = fit.emittedStep < 0 ? emittedToneStep(omega) : fit.emittedStep
    omega = (Math.PI * step) / 1024
  }
  return fitToneLeastSquares(samples, start, end, omega, scratch.estimate)
}

/**
 * Subtract a fitted tone candidate and return the resulting residual power.
 *
 * @param {ArrayLike<number>} residual
 * @param {number} scaleFactorIndex
 * @param {number} phaseBase
 * @param {number} frequency
 * @param {number} start
 * @param {number} end
 * @param {ArrayLike<number>} sourceGroupPeaks
 * @param {number} protectedGroupCount
 * @returns {number}
 */
function lowerToneCandidateResidual(
  residual,
  scaleFactorIndex,
  phaseBase,
  frequency,
  start,
  end,
  sourceGroupPeaks,
  protectedGroupCount
) {
  let phase = (Math.imul((start - 0x81) | 0, frequency) + (phaseBase << 6)) | 0
  const amplitude = TONE_SCALE_FACTOR_VALUES[scaleFactorIndex]
  let lane0 = 0
  let lane1 = 0
  let lane2 = 0
  let lane3 = 0
  for (let index = start; index < end; index += 4) {
    phase = (phase + frequency) | 0
    residual[index] = Math.fround(
      residual[index] -
        Math.fround(amplitude * TONE_SYNTHESIS_SINE[phase & 0x7ff])
    )
    lane0 = Math.fround(lane0 + Math.fround(residual[index] * residual[index]))
    phase = (phase + frequency) | 0
    residual[index + 1] = Math.fround(
      residual[index + 1] -
        Math.fround(amplitude * TONE_SYNTHESIS_SINE[phase & 0x7ff])
    )
    phase = (phase + frequency) | 0
    residual[index + 2] = Math.fround(
      residual[index + 2] -
        Math.fround(amplitude * TONE_SYNTHESIS_SINE[phase & 0x7ff])
    )
    lane2 = Math.fround(
      lane2 + Math.fround(residual[index + 2] * residual[index + 2])
    )
    lane1 = Math.fround(
      lane1 + Math.fround(residual[index + 1] * residual[index + 1])
    )
    phase = (phase + frequency) | 0
    residual[index + 3] = Math.fround(
      residual[index + 3] -
        Math.fround(amplitude * TONE_SYNTHESIS_SINE[phase & 0x7ff])
    )
    lane3 = Math.fround(
      lane3 + Math.fround(residual[index + 3] * residual[index + 3])
    )
  }
  const powerAfter = Math.fround(
    Math.fround(Math.fround(lane0 + lane1) + lane2) + lane3
  )
  for (let group = 0; group < protectedGroupCount; group++) {
    let residualPeak = 0
    const base = group * 32
    for (let index = base; index < base + 32; index++) {
      const magnitude = Math.abs(residual[index])
      if (orderedGreater(magnitude, residualPeak)) residualPeak = magnitude
    }
    const limit = Math.fround(
      TONE_PRE_GATE_PEAK_RATIO * sourceGroupPeaks[group]
    )
    if (orderedGreater(residualPeak, limit)) return -1
  }
  return powerAfter
}

/**
 * Greedily fit and quantize one bounded tone-window entry plan.
 *
 * @param {Float32Array} source Tone source samples.
 * @param {ToneWindow} window Selected synthesis window.
 * @param {number} initialPeakBin Initial strongest spectral bin.
 * @param {Float32Array} weights Per-bin extraction weights.
 * @param {number} candidateLimit Maximum retained tone entries.
 * @param {boolean} fitEmittedFrequency Whether to fit the emitted step.
 * @param {ToneDetectionScratch} scratch Reusable candidate work.
 * @param {ToneEntryPlan} [destination] Entry plan to overwrite.
 * @returns {ToneEntryPlan} The destination plan.
 */
export function extractToneCandidates(
  source,
  window,
  initialPeakBin,
  weights,
  candidateLimit,
  fitEmittedFrequency,
  scratch,
  destination = scratch.entryPlan
) {
  const start = window?.leftIndex
  const end = window?.rightIndex
  const windowLength = end - start
  if (
    !(source instanceof Float32Array) ||
    source.length < ANALYSIS_TONE_DETECTION_FRAME_SAMPLES ||
    !(weights instanceof Float32Array) ||
    weights.length < DFT_BINS ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > ANALYSIS_TONE_DETECTION_FRAME_SAMPLES ||
    (windowLength & 3) !== 0 ||
    !Number.isInteger(initialPeakBin) ||
    initialPeakBin < -1 ||
    initialPeakBin >= DFT_BINS ||
    !Number.isInteger(candidateLimit)
  ) {
    throw new RangeError('ATRAC3plus tone candidate geometry is invalid')
  }

  destination.clear()
  const residual = scratch.candidateSamples
  const sourceGroupPeaks = scratch.sourceGroupPeaks
  residual.fill(0)
  sourceGroupPeaks.fill(0)
  const scale = toneWindowScale(windowLength)
  let dominantPeak = 0
  let dominantGroup = 0
  for (let group = 0; group < 8; group++) {
    let groupPeak = 0
    const base = group * 32
    for (let index = base; index < base + 32; index++) {
      const sample = source[index]
      if (windowLength > 0 && index >= start && index < end) {
        residual[index] = Math.fround(sample * scale)
      }
      const magnitude = Math.abs(sample)
      if (orderedGreater(magnitude, groupPeak)) groupPeak = magnitude
    }
    sourceGroupPeaks[group] = groupPeak
    if (orderedGreater(groupPeak, dominantPeak)) {
      dominantPeak = groupPeak
      dominantGroup = group
    }
  }

  let power = dotProductF32(residual, start, windowLength)
  let peakBin = initialPeakBin
  let searchContinues = initialPeakBin !== -1
  const limit = Math.min(Math.max(candidateLimit, 0), MAX_ENTRIES)
  while (searchContinues && destination.entryCount < limit) {
    if (destination.entryCount > 0) {
      const spectrum = scratch.candidateSpectrum
      spectrum.fill(0)
      powerSpectrum256(
        residual,
        ANALYSIS_TONE_DETECTION_FRAME_SAMPLES,
        spectrum,
        scratch.dftWork
      )
      let strongestBin = -1
      let strongestWeightedPower = 0
      for (let bin = 0; bin < DFT_BINS; bin++) {
        const weightedPower = Math.fround(spectrum[bin] * weights[bin])
        if (orderedGreater(weightedPower, strongestWeightedPower)) {
          strongestWeightedPower = weightedPower
          strongestBin = bin
        }
      }
      peakBin = strongestBin
      searchContinues = strongestBin !== -1
    }
    if (!searchContinues) break
    if (
      !estimateToneSinusoid(
        residual,
        peakBin,
        start,
        end,
        Boolean(fitEmittedFrequency),
        scratch
      )
    ) {
      break
    }
    const estimate = scratch.estimate
    const scaleFactorIndex = toneScaleFactorIndexFromMagnitude(
      estimate.magnitude
    )
    const phaseBase = tonePhaseBucket(estimate.phase)
    const powerAfter = lowerToneCandidateResidual(
      residual,
      scaleFactorIndex,
      phaseBase,
      estimate.step,
      start,
      end,
      sourceGroupPeaks,
      dominantGroup
    )
    if (powerAfter < 0) break
    if (orderedGreater(powerAfter, power)) break
    const retention = Math.fround(powerAfter / power)
    power = powerAfter
    searchContinues = !orderedGreater(retention, TONE_RETENTION_RATIO)
    destination.append(scaleFactorIndex, phaseBase, estimate.step)
  }
  return destination.sortByStep()
}
