/** ATRAC3plus channel-spectrum decoding and syntax publication. */

import {
  spectrumBitstreamCodeTableIndex,
  spectrumDescriptor,
  unpackSpectrumPayload,
} from '../coding/spectrum.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { ChannelSyntaxState, SharedState } from '../state/shared.js'
import { BitReader } from './bitstream.js'
import { spectralNoiseLevelFieldCount } from './spectrum-syntax.js'

/**
 * Error raised when spectrum decode input violates the decoder or bitstream contract.
 */
export class SpectrumDecodeError extends RangeError {
  /**
   * Attach codec context to a spectrum decode error before it crosses the public boundary.
   *
   * @param {number} band
   * @param {number} context
   * @param {number} wordLength
   * @param {number} codeTable
   * @param {number} gainMode
   */
  constructor(band, context, wordLength, codeTable, gainMode) {
    super(`ATRAC3plus spectrum descriptor is invalid for band ${band}`)
    this.name = 'SpectrumDecodeError'
    this.band = band
    this.context = context
    this.wordLength = wordLength
    this.codeTable = codeTable
    this.gainMode = gainMode
  }
}

/**
 * Verify spectrum storage and decoded sidechain ranges before reading coefficient symbols.
 *
 * @param {ChannelSyntaxState} syntax
 * @param {Int32Array} quantizedSpectrum
 * @param {SharedState} shared
 * @param {BitReader} reader
 */
function validateRequest(syntax, quantizedSpectrum, shared, reader) {
  if (
    !(syntax instanceof ChannelSyntaxState) ||
    !(quantizedSpectrum instanceof Int16Array) ||
    quantizedSpectrum.length < 2048 ||
    !(shared instanceof SharedState) ||
    !Number.isInteger(shared.scaleFactorCount) ||
    shared.scaleFactorCount < 0 ||
    shared.scaleFactorCount > 32 ||
    !Number.isInteger(shared.gainModeFlag) ||
    shared.gainModeFlag < 0 ||
    shared.gainModeFlag > 1 ||
    !(reader instanceof BitReader)
  ) {
    throw new RangeError('ATRAC3plus spectrum decode geometry is invalid')
  }
}

/**
 * Decode one channel's coefficient bands and spectral-noise trailer.
 *
 * @param {ChannelSyntaxState} syntax Destination channel syntax.
 * @param {Int16Array} quantizedSpectrum Destination coefficient storage.
 * @param {SharedState} shared Shared coding-unit syntax.
 * @param {BitReader} reader Source bit reader.
 * @returns {void}
 */
export function unpackChannelSpectrum(
  syntax,
  quantizedSpectrum,
  shared,
  reader
) {
  validateRequest(syntax, quantizedSpectrum, shared, reader)
  quantizedSpectrum.fill(0)
  syntax.spectralNoiseLevelIndices.fill(0x0f)
  for (let band = 0; band < shared.scaleFactorCount; band++) {
    const wordLength = syntax.wordLengths[band]
    if (wordLength === 0) continue
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    if (start === undefined || end === undefined || start === end) continue
    const codeTable = syntax.codeTables[band]
    const context = syntax.codeTableContext & 1
    const descriptorIndex = spectrumBitstreamCodeTableIndex(
      context,
      wordLength,
      codeTable,
      shared.gainModeFlag
    )
    const descriptor =
      descriptorIndex === null
        ? null
        : spectrumDescriptor(context, wordLength, descriptorIndex)
    if (descriptor === null) {
      throw new SpectrumDecodeError(
        band,
        context,
        wordLength,
        codeTable,
        shared.gainModeFlag
      )
    }
    unpackSpectrumPayload(
      quantizedSpectrum,
      start,
      end - start,
      descriptor,
      reader
    )
  }

  const noiseCount = spectralNoiseLevelFieldCount(
    shared.scaleFactorCount,
    shared.mapCount
  )
  for (let slot = 0; slot < noiseCount; slot++) {
    syntax.spectralNoiseLevelIndices[slot] = reader.read(4)
  }
}
