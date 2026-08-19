/** Shared ATRAC3plus spectral-noise reconstruction primitives. */

import {
  INVERSE_QUANTIZER_SCALES,
  NOISE_VALUES,
  QUANTIZATION_UNIT_BOUNDARIES,
  QUANTIZATION_UNIT_OFFSETS,
  SCALE_FACTOR_VALUES,
  SPECTRAL_NOISE_LEVEL_SCALES,
  SPECTRAL_NOISE_START_BAND_BY_MAP,
  SPECTRUM_BAND_LIMITS,
} from '../core/tables.js'
import {
  FRAME_SAMPLES,
  NOISE_INDEX_MASK,
  TRANSFORMS_SPECTRAL_RECONSTRUCTION_NOISE_SCALE,
  SPECTRAL_NOISE_SEED_MASK,
  SPECTRAL_NOISE_SEED_STEP,
} from '../core/constants.js'
import { SpectralReconstructionScratch } from '../state/transform.js'

/**
 * Expand one deterministic 10-bit spectral-noise seed.
 *
 * @param {number} seed Ten-bit noise-table seed.
 * @param {number} count Requested sample count.
 * @param {Float32Array} output Caller-owned noise output.
 * @returns {Float32Array} The noise output.
 */
export function fillSpectralNoise(seed, count, output) {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > NOISE_INDEX_MASK ||
    !Number.isInteger(count) ||
    count < 0 ||
    !(output instanceof Float32Array) ||
    count > output.length
  ) {
    throw new RangeError('ATRAC3plus spectral-noise expansion is invalid')
  }
  for (let sample = 0; sample < count; sample++) {
    output[sample] = Math.fround(
      Math.fround(NOISE_VALUES[(seed + sample) & NOISE_INDEX_MASK]) *
        TRANSFORMS_SPECTRAL_RECONSTRUCTION_NOISE_SCALE
    )
  }
  return count
}

/**
 * Select the gain exponent that best aligns reconstructed noise with the target scale.
 *
 * @param {GainRecord} current
 * @param {GainRecord} previous
 * @returns {number}
 */
function bestGainShift(current, previous) {
  const currentCount = current?.entries
  const previousCount = previous?.entries
  if (
    !Number.isInteger(currentCount) ||
    !Number.isInteger(previousCount) ||
    currentCount < 0 ||
    previousCount < 0 ||
    currentCount > current.levels.length ||
    previousCount > previous.levels.length
  ) {
    return null
  }
  const initialLevel = currentCount > 0 ? current.levels[0] : 6
  if (initialLevel < 0 || initialLevel >= 16) return null
  const base = 6 - initialLevel
  let best = 0
  for (let index = 0; index < previousCount; index++) {
    const level = previous.levels[index]
    if (level < 0 || level >= 16) return null
    best = Math.max(best, 6 - level + base)
  }
  for (let index = 0; index < currentCount; index++) {
    const level = current.levels[index]
    if (level < 0 || level >= 16) return null
    best = Math.max(best, 6 - level)
  }
  return best
}

/**
 * Return the power-of-two denominator associated with a gain shift.
 *
 * @param {number} shift
 * @returns {number}
 */
function shiftDenominator(shift) {
  return Math.fround(2 ** (shift & 31))
}

/**
 * Derive the deterministic reconstruction-noise amplitude for one band.
 *
 * @param {number} level
 * @param {number} gainShift
 * @param {number} scaleFactor
 * @param {number} inverseQuantizer
 * @param {number} wordLength
 * @returns {number}
 */
function reconstructionNoiseScale(
  level,
  gainShift,
  scaleFactor,
  inverseQuantizer,
  wordLength
) {
  let scale = Math.fround(level / shiftDenominator(gainShift))
  scale = Math.fround(scale * scaleFactor)
  scale = Math.fround(scale * inverseQuantizer)
  return Math.fround(scale / shiftDenominator(wordLength))
}

/**
 * Validate one decoded channel's quantized spectrum, gain history, and active syntax before reconstruction.
 *
 * @param {DecodeChannelState} channel
 * @param {number} bandCount
 */
function validateReconstructionChannel(channel, bandCount) {
  if (
    !channel?.syntax ||
    !(channel.quantizedSpectrum instanceof Int16Array) ||
    channel.quantizedSpectrum.length < FRAME_SAMPLES ||
    !channel.gain?.records ||
    !channel.previousGainRecords
  ) {
    throw new TypeError('ATRAC3plus decoded channel storage is invalid')
  }
  for (let band = 0; band < bandCount; band++) {
    const wordLength = channel.syntax.wordLengths[band]
    const scaleFactor = channel.syntax.scaleFactors[band]
    if (
      !Number.isInteger(wordLength) ||
      wordLength < 0 ||
      wordLength >= INVERSE_QUANTIZER_SCALES.length ||
      !Number.isInteger(scaleFactor) ||
      scaleFactor < 0 ||
      scaleFactor >= SCALE_FACTOR_VALUES.length
    ) {
      throw new RangeError(
        'ATRAC3plus spectral reconstruction syntax is out of range'
      )
    }
  }
}

/**
 * Generate deterministic per-band seeds used by spectral power compensation.
 *
 * @param {DecodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} bandCount
 * @param {number} mapCount
 * @param {Uint16Array} output
 */
function fillNoiseSeeds(channelBlocks, channels, bandCount, mapCount, output) {
  let scaleFactorSum = 0
  for (let ordinal = 0; ordinal < channels.length; ordinal++) {
    const channel = channelBlocks[channels.at(ordinal)]
    for (let band = 0; band < bandCount; band++) {
      scaleFactorSum += channel.syntax.scaleFactors[band]
    }
  }
  let seed = scaleFactorSum & SPECTRAL_NOISE_SEED_MASK
  for (let map = 0; map < mapCount; map++) {
    output[map] = seed
    seed = (seed + SPECTRAL_NOISE_SEED_STEP) & SPECTRAL_NOISE_SEED_MASK
  }
}

/**
 * Copy reconstructed primary-channel bands into the secondary channel where intensity mapping requires them.
 *
 * @param {DecodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} bandCount
 */
function reusePrimaryBands(channelBlocks, channels, bandCount) {
  if (channels.length !== 2) return
  const leftIndex = channels.at(0)
  const rightIndex = channels.at(1)
  const left = channelBlocks[leftIndex]
  const right = channelBlocks[rightIndex]
  if (right.primaryChannelIndex !== leftIndex) {
    throw new RangeError(
      'ATRAC3plus secondary channel has the wrong primary channel'
    )
  }
  for (let band = 0; band < bandCount; band++) {
    const leftWordLength = left.syntax.wordLengths[band]
    if (
      right.syntax.wordLengths[band] !== 0 ||
      leftWordLength <= 0 ||
      right.syntax.codeTables[band] !== 0
    ) {
      continue
    }
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    right.quantizedSpectrum.set(
      left.quantizedSpectrum.subarray(start, end),
      start
    )
    right.syntax.wordLengths[band] = leftWordLength
  }
}

/**
 * Expand quantized coefficients into the channel spectrum using its scale factors and word lengths.
 *
 * @param {DecodeChannelState} channel
 * @param {ArrayLike<number>} spectrum
 * @param {number} bandCount
 */
function dequantizeChannel(channel, spectrum, bandCount) {
  spectrum.fill(0)
  for (let band = 0; band < bandCount; band++) {
    const wordLength = channel.syntax.wordLengths[band]
    if (wordLength <= 0) continue
    const scaleFactor = SCALE_FACTOR_VALUES[channel.syntax.scaleFactors[band]]
    const inverseQuantizer = INVERSE_QUANTIZER_SCALES[wordLength]
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    for (let coefficient = start; coefficient < end; coefficient++) {
      spectrum[coefficient] = Math.fround(
        Math.fround(channel.quantizedSpectrum[coefficient] * scaleFactor) *
          inverseQuantizer
      )
    }
  }
}

/**
 * Inject deterministic noise that restores spectral power lost during quantization.
 *
 * @param {DecodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {SharedState} shared
 * @param {number} targetOrdinal
 * @param {ArrayLike<number>} map
 * @param {number} seed
 * @param {ArrayLike<number>} spectrum
 * @param {ArrayLike<number>} noise
 */
function applySpectralPowerCompensation(
  channelBlocks,
  channels,
  shared,
  targetOrdinal,
  map,
  seed,
  spectrum,
  noise
) {
  const sourceOrdinal =
    channels.length === 2 && shared.presenceFlags[1][map] !== 0
      ? 1 - targetOrdinal
      : targetOrdinal
  const source = channelBlocks[channels.at(sourceOrdinal)]
  const levelSlot = SPECTRUM_BAND_LIMITS[map]
  const levelIndex = source.syntax.spectralNoiseLevelIndices[levelSlot]
  const level = SPECTRAL_NOISE_LEVEL_SCALES[levelIndex]
  const gainShift = bestGainShift(
    source.gain.records[map],
    source.previousGainRecords[map]
  )
  if (!(level > 0) || gainShift === null) return

  fillSpectralNoise(seed, noise.length, noise)
  const target = channelBlocks[channels.at(targetOrdinal)]
  const startBand = SPECTRAL_NOISE_START_BAND_BY_MAP[map]
  const endBand = QUANTIZATION_UNIT_BOUNDARIES[map + 1]
  for (let band = startBand; band < endBand; band++) {
    const wordLength = target.syntax.wordLengths[band]
    if (wordLength <= 0) continue
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    const scale = reconstructionNoiseScale(
      level,
      gainShift,
      SCALE_FACTOR_VALUES[target.syntax.scaleFactors[band]],
      INVERSE_QUANTIZER_SCALES[wordLength],
      wordLength
    )
    for (let coefficient = start; coefficient < end; coefficient++) {
      spectrum[coefficient] = Math.fround(
        spectrum[coefficient] + Math.fround(scale * noise[coefficient - start])
      )
    }
  }
}

/**
 * Apply intensity and primary-channel reuse maps after both channels are dequantized.
 *
 * @param {DecodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {SharedState} shared
 * @param {ArrayLike<number>} spectra
 */
function applyStereoMaps(channelBlocks, channels, shared, spectra) {
  if (channels.length !== 2) return
  const left = spectra[channels.at(0)]
  const right = spectra[channels.at(1)]
  for (let map = 0; map < shared.mapCount; map++) {
    if (shared.presenceFlags[1][map] !== 0) {
      const offset = map * 128
      for (let sample = 0; sample < 128; sample++) {
        const value = left[offset + sample]
        left[offset + sample] = right[offset + sample]
        right[offset + sample] = value
      }
    }
    if (shared.presenceFlags[0][map] !== 0) {
      const startBand = QUANTIZATION_UNIT_BOUNDARIES[map]
      const endBand = QUANTIZATION_UNIT_BOUNDARIES[map + 1]
      const start = QUANTIZATION_UNIT_OFFSETS[startBand]
      const end = QUANTIZATION_UNIT_OFFSETS[endBand]
      for (let coefficient = start; coefficient < end; coefficient++) {
        right[coefficient] = -right[coefficient]
      }
    }
  }
}

/**
 * Reconstruct one detached coding unit into its pool-owned float spectra.
 * Secondary symbol reuse deliberately updates only the staged channel image.
 *
 * @param {DecodeChannelState[]} channelBlocks Detached decoder channel blocks.
 * @param {CodingUnitChannels|ArrayLike<number>} channels Coding-unit channel indices.
 * @param {SharedState} shared Shared coding-unit syntax.
 * @param {Float32Array[]} spectra Pool-owned float spectra.
 * @param {SpectralReconstructionScratch} scratch Reusable reconstruction work.
 * @returns {number} Reconstructed channel count.
 */
export function reconstructCodingUnitSpectra(
  channelBlocks,
  channels,
  shared,
  spectra,
  scratch
) {
  if (
    !channels ||
    (channels.length !== 1 && channels.length !== 2) ||
    !shared ||
    !Array.isArray(spectra) ||
    !(scratch instanceof SpectralReconstructionScratch)
  ) {
    throw new TypeError('ATRAC3plus spectral reconstruction storage is invalid')
  }
  const bandCount = shared.scaleFactorCount
  const mapCount = shared.mapCount
  if (
    !Number.isInteger(bandCount) ||
    bandCount < 0 ||
    bandCount > 32 ||
    mapCount < 0 ||
    mapCount > scratch.noiseSeeds.length
  ) {
    throw new RangeError(
      'ATRAC3plus spectral reconstruction geometry is invalid'
    )
  }
  const allocationBandCount = Math.max(
    bandCount,
    QUANTIZATION_UNIT_BOUNDARIES[mapCount]
  )
  for (let ordinal = 0; ordinal < channels.length; ordinal++) {
    const channelIndex = channels.at(ordinal)
    const spectrum = spectra[channelIndex]
    if (
      !Number.isInteger(channelIndex) ||
      channelIndex < 0 ||
      channelIndex >= channelBlocks.length ||
      !(spectrum instanceof Float32Array) ||
      spectrum.length < FRAME_SAMPLES
    ) {
      throw new RangeError('ATRAC3plus reconstruction channel is out of range')
    }
    validateReconstructionChannel(
      channelBlocks[channelIndex],
      allocationBandCount
    )
  }

  fillNoiseSeeds(
    channelBlocks,
    channels,
    bandCount,
    mapCount,
    scratch.noiseSeeds
  )
  reusePrimaryBands(channelBlocks, channels, bandCount)
  for (let ordinal = 0; ordinal < channels.length; ordinal++) {
    const channelIndex = channels.at(ordinal)
    const spectrum = spectra[channelIndex]
    dequantizeChannel(channelBlocks[channelIndex], spectrum, bandCount)
    for (let map = 0; map < mapCount; map++) {
      applySpectralPowerCompensation(
        channelBlocks,
        channels,
        shared,
        ordinal,
        map,
        scratch.noiseSeeds[map],
        spectrum,
        scratch.noise
      )
    }
  }
  applyStereoMaps(channelBlocks, channels, shared, spectra)
  if (shared.muteFlag === 1) {
    for (let ordinal = 0; ordinal < channels.length; ordinal++) {
      spectra[channels.at(ordinal)].fill(0)
    }
  }
  return channels.length
}

/**
 * Noise scale in the quantized-coefficient domain, or null when disabled.
 *
 * @param {number} levelIndex Spectral-noise level index.
 * @param {GainRecord} currentGain Current-frame gain record.
 * @param {GainRecord} previousGain Previous-frame gain record.
 * @param {number} quantizationMode Spectrum quantization mode.
 * @returns {number|null} Quantized noise scale, or `null` when disabled.
 */
export function quantizedSpectralNoiseScale(
  levelIndex,
  currentGain,
  previousGain,
  quantizationMode
) {
  const level = SPECTRAL_NOISE_LEVEL_SCALES[levelIndex]
  const gainShift = bestGainShift(currentGain, previousGain)
  if (
    !(level > 0) ||
    gainShift === null ||
    !Number.isInteger(quantizationMode)
  ) {
    return null
  }
  const denominator = shiftDenominator(gainShift + quantizationMode)
  return Math.fround(Math.fround(level) / denominator)
}
