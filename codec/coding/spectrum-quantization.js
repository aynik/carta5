/** ATRAC3plus normalized-spectrum quantization and reconstruction evidence. */

import {
  INVERSE_QUANTIZER_SCALES,
  QUANTIZATION_THRESHOLDS,
  QUANTIZATION_UNIT_OFFSETS,
  QUANTIZER_SCALES,
} from '../core/tables.js'
import { float32ToBits } from '../utils.js'
import { FLOAT_ROUNDING_BIAS } from '../core/constants.js'

/**
 * Scale and round one transform coefficient into its signed quantized value.
 *
 * @param {number} sample
 * @param {number} quantizerScale
 * @param {number} threshold
 * @returns {number}
 */
function quantizeSample(sample, quantizerScale, threshold) {
  const distance = Math.fround(threshold - Math.abs(sample))
  const product = Math.fround(sample * quantizerScale)
  const roundedBits = float32ToBits(Math.fround(product + FLOAT_ROUNDING_BIAS))
  const distanceMask = float32ToBits(distance) >> 31 === 0 ? 0 : 0xffffffff
  return roundedBits & distanceMask & 0xffff
}

/**
 * Report whether a quantization mode and offset fall inside their maintained table domains.
 *
 * @param {number} mode
 * @param {number} offset
 * @returns {boolean}
 */
function validateModeOffset(mode, offset) {
  return (
    Number.isInteger(mode) &&
    mode >= 0 &&
    mode < QUANTIZER_SCALES.length &&
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset < 16
  )
}

/**
 * Quantize one multiple-of-four normalized coefficient row into wire bits.
 *
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {number} sourceStart First source coefficient.
 * @param {number} mode Quantization mode.
 * @param {number} offset Quantizer offset.
 * @param {number} thresholdScale Band threshold scale.
 * @param {number} count Coefficient count.
 * @param {Uint16Array|Int16Array} output Caller-owned symbols.
 * @param {number} [outputStart=0] First output symbol.
 * @returns {number} Quantized coefficient count.
 */
export function quantizeSpectrumCoefficients(
  spectrum,
  sourceStart,
  mode,
  offset,
  thresholdScale,
  count,
  output,
  outputStart = 0
) {
  if (
    !(spectrum instanceof Float32Array) ||
    (!(output instanceof Uint16Array) && !(output instanceof Int16Array)) ||
    !validateModeOffset(mode, offset) ||
    !Number.isFinite(thresholdScale) ||
    thresholdScale < 0 ||
    !Number.isInteger(sourceStart) ||
    !Number.isInteger(outputStart) ||
    !Number.isInteger(count) ||
    sourceStart < 0 ||
    outputStart < 0 ||
    count < 0 ||
    count % 4 !== 0 ||
    sourceStart + count > spectrum.length ||
    outputStart + count > output.length
  ) {
    throw new RangeError('ATRAC3plus spectrum quantization geometry is invalid')
  }
  const thresholdScaleF32 = Math.fround(thresholdScale)
  const quantizerScale = QUANTIZER_SCALES[mode]
  const threshold =
    QUANTIZATION_THRESHOLDS[mode * 16 + offset] * thresholdScaleF32
  for (let coefficient = 0; coefficient < count; coefficient++) {
    output[outputStart + coefficient] = quantizeSample(
      spectrum[sourceStart + coefficient],
      quantizerScale,
      threshold
    )
  }
  return count
}

/**
 * Quantize one quantization unit into its absolute output band.
 *
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {Float32Array} thresholdScales Threshold scale by band.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Quantization mode.
 * @param {number} offset Quantizer offset.
 * @param {Int16Array} output Absolute channel symbol storage.
 * @returns {number} Quantized coefficient count.
 */
export function quantizeSpectrumBand(
  spectrum,
  thresholdScales,
  band,
  mode,
  offset,
  output
) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  const thresholdScale = thresholdScales?.[band]
  if (start === undefined || end === undefined) {
    throw new RangeError('ATRAC3plus quantization band is out of range')
  }
  return quantizeSpectrumCoefficients(
    spectrum,
    start,
    mode,
    offset,
    thresholdScale,
    end - start,
    output,
    start
  )
}

/**
 * Copy cached unsigned wire symbols into the channel's signed storage row.
 *
 * @param {Uint16Array} symbols Cached band-local symbols.
 * @param {number} band Quantization-unit index.
 * @param {Int16Array} output Absolute channel symbol storage.
 * @returns {void}
 */
export function writeQuantizedBand(symbols, band, output) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  if (
    !(symbols instanceof Uint16Array) ||
    !(output instanceof Int16Array) ||
    start === undefined ||
    end === undefined ||
    symbols.length < end - start ||
    output.length < end
  ) {
    throw new RangeError('ATRAC3plus quantized band copy is invalid')
  }
  for (let index = start; index < end; index++) {
    output[index] = symbols[index - start]
  }
}

/**
 * Reconstruct one unsigned wire symbol at a caller-defined source scale.
 *
 * @param {number} symbol Unsigned wire symbol.
 * @param {number} mode Quantization mode.
 * @param {number} reconstructionScale Source-domain scale.
 * @returns {number|null} Reconstructed coefficient, or `null` if invalid.
 */
export function reconstructSpectrumSymbol(symbol, mode, reconstructionScale) {
  if (
    !Number.isInteger(symbol) ||
    symbol < 0 ||
    symbol > 0xffff ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode >= INVERSE_QUANTIZER_SCALES.length ||
    !Number.isFinite(reconstructionScale) ||
    reconstructionScale <= 0
  ) {
    return null
  }
  const signed = (symbol << 16) >> 16
  const reconstructionScaleF32 = Math.fround(reconstructionScale)
  return signed * (INVERSE_QUANTIZER_SCALES[mode] * reconstructionScaleF32)
}

/**
 * Exact squared reconstruction error for one normalized quantization unit.
 *
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {Float32Array} thresholdScales Threshold scale by band.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Quantization mode.
 * @param {number} offset Quantizer offset.
 * @param {number} sourceScale Source normalization scale.
 * @param {number} reconstructionScale Reconstruction scale.
 * @param {Uint16Array|null} [quantizedSymbols] Optional cached symbols.
 * @returns {number|null} Squared reconstruction error, or `null` if invalid.
 */
export function measureSpectrumReconstructionNoise(
  spectrum,
  thresholdScales,
  band,
  mode,
  offset,
  sourceScale,
  reconstructionScale,
  quantizedSymbols = null
) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  const thresholdScale = thresholdScales?.[band]
  if (
    !(spectrum instanceof Float32Array) ||
    start === undefined ||
    end === undefined ||
    end > spectrum.length ||
    !validateModeOffset(mode, offset) ||
    !Number.isFinite(thresholdScale) ||
    thresholdScale < 0 ||
    !Number.isFinite(sourceScale) ||
    sourceScale <= 0 ||
    !Number.isFinite(reconstructionScale) ||
    reconstructionScale <= 0 ||
    (quantizedSymbols !== null &&
      (!(quantizedSymbols instanceof Uint16Array) ||
        quantizedSymbols.length < end - start))
  ) {
    return null
  }
  const thresholdScaleF32 = Math.fround(thresholdScale)
  const sourceScaleF32 = Math.fround(sourceScale)
  const reconstructionScaleF32 = Math.fround(reconstructionScale)
  const quantizerScale = QUANTIZER_SCALES[mode]
  const inverseScale = INVERSE_QUANTIZER_SCALES[mode]
  const threshold =
    QUANTIZATION_THRESHOLDS[mode * 16 + offset] * thresholdScaleF32
  let noise = 0
  for (let index = start; index < end; index++) {
    const sample = spectrum[index]
    const symbol =
      quantizedSymbols?.[index - start] ??
      quantizeSample(sample, quantizerScale, threshold)
    const signed = (symbol << 16) >> 16
    const sourceSample = sample * sourceScaleF32
    const reconstructed = signed * (inverseScale * reconstructionScaleF32)
    const error = sourceSample - reconstructed
    noise += error * error
  }
  return noise
}
