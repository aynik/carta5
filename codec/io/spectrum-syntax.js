/** ATRAC3plus per-channel spectral payload and noise-trailer emission. */

import {
  spectrumBitstreamCodeTableIndex,
  spectrumDescriptor,
  packSpectrumPayload,
} from '../coding/spectrum.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  SPECTRUM_BAND_LIMITS,
} from '../core/tables.js'
import { SpectrumSyntaxScratch } from '../state/spectrum.js'

/**
 * Return the number of four-bit noise fields after one channel's coefficients.
 *
 * @param {number} bandCount Active scale-factor band count.
 * @param {number} mapCount Active spectral-noise map count.
 * @returns {number} Serialized spectral-noise field count.
 */
export function spectralNoiseLevelFieldCount(bandCount, mapCount) {
  if (bandCount <= 2 || mapCount === 0) return 0
  const maximum = SPECTRUM_BAND_LIMITS[mapCount - 1]
  return maximum === undefined || maximum === 0xff ? 0 : maximum + 1
}

/**
 * Verify finalized channel syntax, quantized coefficients, shared band geometry, and bit sink before packing spectrum data.
 *
 * @param {EncodeChannelState} block
 * @param {SharedState} shared
 * @param {SpectrumSyntaxScratch} scratch
 * @param {BitWriter|BitCounter} sink
 */
function validateRequest(block, shared, scratch, sink) {
  if (
    !block?.syntax ||
    !(block.quantizedSpectrum instanceof Int16Array) ||
    !shared ||
    !Number.isInteger(shared.scaleFactorCount) ||
    shared.scaleFactorCount < 0 ||
    shared.scaleFactorCount > 32 ||
    !(scratch instanceof SpectrumSyntaxScratch) ||
    typeof sink?.write !== 'function'
  ) {
    throw new TypeError('ATRAC3plus channel spectrum arguments are invalid')
  }
}

/**
 * Emit only the per-channel spectral-noise fields following coefficients.
 *
 * @param {EncodeChannelState} block Encoder channel block.
 * @param {SharedState} shared Shared coding-unit syntax state.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packSpectralNoiseTrailer(block, shared, sink) {
  if (!block?.syntax || !shared || typeof sink?.write !== 'function') {
    throw new TypeError('ATRAC3plus spectral-noise trailer is invalid')
  }
  const noiseCount = spectralNoiseLevelFieldCount(
    shared.scaleFactorCount,
    shared.mapCount
  )
  for (let slot = 0; slot < noiseCount; slot++) {
    sink.write(block.syntax.spectralNoiseLevelIndices[slot], 4)
  }
}

/**
 * Emit one channel's coefficients followed by its spectral-noise trailer.
 *
 * @param {EncodeChannelState} block Encoder channel block.
 * @param {SharedState} shared Shared coding-unit syntax state.
 * @param {SpectrumSyntaxScratch} scratch Reusable symbol storage.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packChannelSpectrum(block, shared, scratch, sink) {
  validateRequest(block, shared, scratch, sink)
  const syntax = block.syntax
  for (let band = 0; band < shared.scaleFactorCount; band++) {
    const mode = syntax.wordLengths[band]
    if (mode === 0) continue
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    if (start === undefined || end === undefined || start === end) continue
    const codeTable = spectrumBitstreamCodeTableIndex(
      syntax.codeTableContext,
      mode,
      syntax.codeTables[band],
      shared.gainModeFlag
    )
    const descriptor =
      codeTable === null
        ? null
        : spectrumDescriptor(syntax.codeTableContext, mode, codeTable)
    if (descriptor === null) {
      throw new RangeError(
        `ATRAC3plus spectrum descriptor is invalid for band ${band}`
      )
    }
    packSpectrumPayload(
      block.quantizedSpectrum,
      start,
      end - start,
      descriptor,
      scratch.symbol,
      sink
    )
  }
  packSpectralNoiseTrailer(block, shared, sink)
}
