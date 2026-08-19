/** Shared, end-exclusive ATRAC3plus spectral-band geometry. */

import {
  FRAME_HEADER_BITS,
  FRAME_TAG_BITS,
  MAX_CODING_UNITS,
  MAX_FRAME_BYTES,
} from './constants.js'
import {
  BAND_INDEX_BY_QUANTIZATION_UNIT,
  QUANTIZATION_UNIT_OFFSETS,
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
} from './tables.js'

/**
 * Apply the 48 kHz allocation-table band shift.
 *
 * @param {number} band Source band index.
 * @param {number} sampleRateHz Stream sample rate.
 * @param {number} bandCount Active band count.
 * @returns {number} Effective table band.
 */
export function effectiveAllocationBand(band, sampleRateHz, bandCount) {
  return sampleRateHz === 48000 &&
    band >= 0x12 &&
    band < Math.min(bandCount, 0x1f)
    ? band + 1
    : band
}

/**
 * Return coding-unit payload capacity after header, tags, and terminator.
 *
 * @param {number} frameBytes Encoded frame byte length.
 * @param {number} codingUnitCount Serialized coding-unit count.
 * @returns {number} Available coding-unit payload bits.
 */
export function framePayloadCapacityBits(frameBytes, codingUnitCount) {
  if (
    !Number.isInteger(frameBytes) ||
    frameBytes < 1 ||
    frameBytes > MAX_FRAME_BYTES ||
    !Number.isInteger(codingUnitCount) ||
    codingUnitCount < 1 ||
    codingUnitCount > MAX_CODING_UNITS
  ) {
    throw new RangeError('ATRAC3plus frame capacity geometry is invalid')
  }
  const reserved = FRAME_HEADER_BITS + (codingUnitCount + 1) * FRAME_TAG_BITS
  const payload = frameBytes * 8 - reserved
  if (payload < 0) {
    throw new RangeError('ATRAC3plus reserved syntax exceeds frame capacity')
  }
  return payload
}

/**
 * Return one quantization unit's end-exclusive coefficient range.
 *
 * @param {number} unit Quantization-unit index.
 * @returns {{start: number, end: number}|null} Immutable range, or `null`.
 */
export function quantizationUnitRange(unit) {
  if (
    !Number.isInteger(unit) ||
    unit < 0 ||
    unit + 1 >= QUANTIZATION_UNIT_OFFSETS.length
  ) {
    return null
  }
  return Object.freeze({
    start: QUANTIZATION_UNIT_OFFSETS[unit],
    end: QUANTIZATION_UNIT_OFFSETS[unit + 1],
  })
}

/**
 * Return the coefficient prefix covered by `unitCount` quantization units.
 *
 * @param {number} unitCount Active quantization-unit count.
 * @returns {number|null} Coefficient prefix length, or `null`.
 */
export function quantizationUnitPrefixLength(unitCount) {
  if (
    !Number.isInteger(unitCount) ||
    unitCount < 0 ||
    unitCount >= QUANTIZATION_UNIT_OFFSETS.length
  ) {
    return null
  }
  return QUANTIZATION_UNIT_OFFSETS[unitCount]
}

/**
 * Return the quantization units needed to cover a coefficient limit.
 *
 * @param {number} limit End-exclusive coefficient limit.
 * @returns {number|null} Required quantization-unit count, or `null`.
 */
export function quantizationUnitCountForCoefficientLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0) return null
  const last = QUANTIZATION_UNIT_OFFSETS.length - 1
  for (let unitCount = 1; unitCount < last; unitCount++) {
    if (QUANTIZATION_UNIT_OFFSETS[unitCount] >= limit) return unitCount
  }
  return last
}

/**
 * Return the scale-factor maps represented by a selected prefix.
 *
 * @param {number} scaleFactorCount Active scale-factor count.
 * @returns {number} Represented map count, or zero outside the table.
 */
export function mapCount(scaleFactorCount) {
  const lastMap = BAND_INDEX_BY_QUANTIZATION_UNIT[scaleFactorCount]
  return lastMap === undefined ? 0 : lastMap + 1
}

/**
 * Return word-length shapes represented by active quantization units.
 *
 * @param {number} quantizationUnitCount Active quantization-unit count.
 * @returns {number} Represented shape count, or zero outside the table.
 */
export function shapeCount(quantizationUnitCount) {
  if (quantizationUnitCount < 1) return 0
  const lastShape = SHAPE_INDEX_BY_QUANTIZATION_UNIT[quantizationUnitCount - 1]
  return lastShape === undefined ? 0 : lastShape + 1
}

/**
 * Return coded QMF subbands represented by active quantization units.
 *
 * @param {number} quantizationUnitCount Active quantization-unit count.
 * @returns {number} Represented subband count, or zero outside the table.
 */
export function codedSubbandCount(quantizationUnitCount) {
  const lastSubband = BAND_INDEX_BY_QUANTIZATION_UNIT[quantizationUnitCount]
  return lastSubband === undefined ? 0 : lastSubband + 1
}
