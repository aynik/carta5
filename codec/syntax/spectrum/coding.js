/** ATRAC3plus spectral descriptor selection and entropy payload traversal. */

import { canonicalCodes, readCanonicalSymbol } from '../entropy.js'
import { BitReader, BitWriter, writeBitsAt } from '../bitstream.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  SPECTRUM_BAND_LIMITS,
  SPECTRUM_CODE_TABLE_INDICES,
  SPECTRAL_CODEBOOK_CODE_LENGTHS,
  SPECTRAL_CODEBOOK_GROUPING_METADATA,
  SPECTRAL_CODEBOOK_SYMBOL_METADATA,
  SPECTRAL_CODEBOOK_VALUE_METADATA,
} from '../../core/tables.js'

import {
  SpectrumSymbolScratch,
  SpectrumSyntaxScratch,
} from '../../state/spectrum/syntax.js'
import {
  CODE_TABLE_CONTEXT_STRIDE,
  CODE_TABLE_MODE_STRIDE,
  DESCRIPTORS_PER_CONTEXT,
  SPECTRUM_GROUP4_DIRECT_MIN_COUNT,
  SPECTRUM_CODE_TABLE_COUNT,
  SPECTRUM_MODE_COUNT,
} from '../../core/constants.js'

const bitWriterWrite = BitWriter.prototype.write

/**
 * Immutable description of one packed spectrum symbol and its optional escape payload.
 *
 * @property {i32} index Maintained codebook index.
 * @property {i32} symbolCount Number of symbols in the codebook.
 * @property {i32} maximumCodeBits Maximum entropy width, at most 32.
 * @property {i32} valuesPerCodeword Coefficients represented by one symbol.
 * @property {i32} zeroRunChunk Symbols represented by one zero-run flag.
 * @property {i32} valueBits Width of one grouped coefficient.
 * @property {i32} valueMask Mask for one grouped coefficient.
 * @property {boolean} hasSignBits Whether nonzero magnitudes carry escape sign bits.
 * @property {Uint8Array} costLengths Zero-padded symbol costs for bounded pricing lookups.
 * @nativeStable Own data descriptors and field order stay fixed after construction.
 */
class SpectrumDescriptor {
  /**
   * Allocate fixed coefficient, group, and sign views used to describe one entropy-coded spectrum band.
   *
   * @param {number} index
   */
  constructor(index) {
    const grouping = SPECTRAL_CODEBOOK_GROUPING_METADATA[index]
    const value = SPECTRAL_CODEBOOK_VALUE_METADATA[index]
    this.index = index
    this.codeLengths = SPECTRAL_CODEBOOK_CODE_LENGTHS[index]
    this.costLengths = new Uint8Array(Math.max(256, this.codeLengths.length))
    this.costLengths.set(this.codeLengths)
    this.codes = canonicalCodes(this.codeLengths)
    this.symbolCount = SPECTRAL_CODEBOOK_SYMBOL_METADATA[index] & 0xffff
    this.maximumCodeBits = grouping & 0xff
    this.valuesPerCodeword = (grouping >>> 8) & 0xff
    this.zeroRunChunk = (grouping >>> 16) & 0xff
    this.valueBits = (value >>> 8) & 0xff
    this.valueMask = (value >>> 16) & 0xff
    this.hasSignBits = (value & 0xff) !== 0
    Object.freeze(this)
  }
}

const spectrumDescriptors = Object.freeze(
  Array.from(
    { length: SPECTRAL_CODEBOOK_CODE_LENGTHS.length },
    (_unused, index) => new SpectrumDescriptor(index)
  )
)

/**
 * Return the descriptor at one context/mode/code-table coordinate.
 *
 * @param {number} tableContext Entropy-table context.
 * @param {number} mode Quantization mode.
 * @param {number} codeTableIndex Code-table selector.
 * @returns {SpectrumDescriptor|null} Matching descriptor, or `null`.
 */
export function spectrumDescriptor(tableContext, mode, codeTableIndex) {
  if (
    !Number.isInteger(tableContext) ||
    !Number.isInteger(mode) ||
    !Number.isInteger(codeTableIndex) ||
    mode < 0 ||
    mode > SPECTRUM_MODE_COUNT ||
    codeTableIndex < 0 ||
    codeTableIndex >= SPECTRUM_CODE_TABLE_COUNT
  ) {
    return null
  }
  if (mode === 0) return spectrumDescriptors[0]
  const index =
    (tableContext & 1) * DESCRIPTORS_PER_CONTEXT +
    codeTableIndex * SPECTRUM_MODE_COUNT +
    mode -
    1
  return spectrumDescriptors[index] ?? null
}

/**
 * Strict bitstream remap for one stored code-table selector.
 *
 * @param {number} tableContext Entropy-table context.
 * @param {number} mode Quantization mode.
 * @param {number} codeTableValue Stored selector.
 * @param {number} spectrumTableIndex Spectrum table family.
 * @returns {number|null} Bitstream selector, or `null` if invalid.
 */
export function spectrumBitstreamCodeTableIndex(
  tableContext,
  mode,
  codeTableValue,
  spectrumTableIndex
) {
  if (
    !Number.isInteger(mode) ||
    mode < 1 ||
    mode > SPECTRUM_MODE_COUNT ||
    !Number.isInteger(codeTableValue) ||
    codeTableValue < 0
  ) {
    return null
  }
  if (spectrumTableIndex !== 0) {
    return codeTableValue < SPECTRUM_CODE_TABLE_COUNT ? codeTableValue : null
  }
  if (codeTableValue >= CODE_TABLE_MODE_STRIDE) return null
  const index =
    (mode - 1) * CODE_TABLE_MODE_STRIDE +
    codeTableValue +
    (tableContext & 1) * CODE_TABLE_CONTEXT_STRIDE
  return SPECTRUM_CODE_TABLE_INDICES[index] ?? null
}

/**
 * Permissive candidate-pricing remap used by allocation search.
 *
 * @param {number} tableContext Entropy-table context.
 * @param {number} mode Quantization mode.
 * @param {number} codeTableValue Stored selector.
 * @param {number} spectrumTableIndex Spectrum table family.
 * @returns {number} Candidate-pricing selector.
 */
export function spectrumCostCodeTableIndex(
  tableContext,
  mode,
  codeTableValue,
  spectrumTableIndex
) {
  if (spectrumTableIndex !== 0) return codeTableValue
  const index =
    ((tableContext & 1) * SPECTRUM_MODE_COUNT + mode - 1) *
      CODE_TABLE_MODE_STRIDE +
    codeTableValue
  return SPECTRUM_CODE_TABLE_INDICES[index] ?? 0
}

/**
 * Group signed low-byte coefficients into packed entropy symbols.
 *
 * @param {Uint16Array} source Unsigned coefficient symbols.
 * @param {i32} sourceStart First source coefficient.
 * @param {i32} count Active coefficient count.
 * @param {i32} group Values per codeword.
 * @param {i32} valueBits Bits per grouped value.
 * @param {Uint16Array} destination Caller-owned grouped symbols.
 * @returns {i32} Grouped symbol count.
 * @nativeUnchecked Pricing supplies full channel storage and scratch capacity for four-symbol batches.
 */
export function groupSpectrumCoefficients(
  source,
  sourceStart,
  count,
  group,
  valueBits,
  destination
) {
  /** @type {i32} Maintained codebooks use at most six bits per grouped value. */
  const base = 2 ** valueBits
  const mask = base - 1
  let output = 0
  if (group === 2) {
    for (let coefficient = 0; coefficient < count; coefficient += 8) {
      const start = sourceStart + coefficient
      destination[output++] =
        ((source[start] & mask) * base + (source[start + 1] & mask)) & 0xffff
      destination[output++] =
        ((source[start + 2] & mask) * base + (source[start + 3] & mask)) &
        0xffff
      destination[output++] =
        ((source[start + 4] & mask) * base + (source[start + 5] & mask)) &
        0xffff
      destination[output++] =
        ((source[start + 6] & mask) * base + (source[start + 7] & mask)) &
        0xffff
    }
    return output
  }
  // Direct packing removes the generic lane loop. Short four-value rows remain
  // faster on V8's compact generic path, while longer rows amortize this branch.
  if (group === 4 && count >= SPECTRUM_GROUP4_DIRECT_MIN_COUNT) {
    for (let coefficient = 0; coefficient < count; coefficient += 16) {
      const start = sourceStart + coefficient
      for (let symbol = 0; symbol < 4; symbol++) {
        const index = start + symbol * 4
        let packed = (source[index] & mask) * base + (source[index + 1] & mask)
        packed = packed * base + (source[index + 2] & mask)
        packed = packed * base + (source[index + 3] & mask)
        destination[output++] = packed & 0xffff
      }
    }
    return output
  }
  for (let coefficient = 0; coefficient < count; coefficient += group * 4) {
    for (let symbol = 0; symbol < 4; symbol++) {
      let packed = 0
      for (let lane = 0; lane < group; lane++) {
        packed =
          packed * base +
          (source[sourceStart + coefficient + symbol * group + lane] & mask)
      }
      destination[output++] = packed & 0xffff
    }
  }
  return output
}

/**
 * Prepare up to four entropy symbols and their escape fields in reusable scratch.
 *
 * @param {Int16Array|Uint16Array} coefficients
 * @param {i32} start
 * @param {SpectrumDescriptor} descriptor
 * @param {SpectrumSymbolScratch} scratch
 * @param {i32} count Number of complete groups, at most the scratch capacity.
 * @nativeUnchecked The caller supplies complete coefficient groups and bounded scratch capacity.
 */
function buildSpectrumSymbols(coefficients, start, descriptor, scratch, count) {
  const { valuesPerCodeword, valueBits, valueMask, hasSignBits } = descriptor
  const { symbols, extraBits: signs, extraCounts } = scratch
  for (let slot = 0; slot < count; slot++) {
    let symbol = 0
    /** @type {i32} At most one sign bit for each of four grouped coefficients. */
    let extraBits = 0
    let extraCount = 0
    const groupStart = start + slot * valuesPerCodeword
    for (let lane = 0; lane < valuesPerCodeword; lane++) {
      const coefficient = (coefficients[groupStart + lane] << 16) >> 16
      /** @type {i32} Signed 16-bit coefficient or its magnitude, at most 32768. */
      const magnitude = hasSignBits ? Math.abs(coefficient) : coefficient
      const encoded = magnitude & valueMask
      symbol = ((symbol << valueBits) | encoded) & 0xffff
      if (hasSignBits && encoded !== 0) {
        extraBits = (extraBits << 1) | (coefficient < 0 ? 1 : 0)
        extraCount++
      }
    }
    symbols[slot] = symbol
    signs[slot] = extraBits
    extraCounts[slot] = extraCount
  }
}

/**
 * Emit prepared spectrum symbols, reporting the position of any forbidden code.
 *
 * @param {Uint8Array} codeLengths Canonical widths, including absent markers.
 * @param {Uint32Array} codes Canonical codes in the same symbol order.
 * @param {SpectrumSymbolScratch} scratch
 * @param {i32} count Prepared symbols, starting at scratch slot zero.
 * @param {i32} packedIndex Position of the first prepared symbol.
 * @param {BitWriter|BitCounter} sink
 * @param {Uint8Array|null} buffer Cached bytes for the standard bit writer.
 * @param {i32} bitPosition Cached writer cursor; unused for custom sinks.
 * @returns {i32} Next standard-writer cursor.
 * @nativeUnchecked Scratch slots are bounded; the checked width rejects absent symbols before code lookup.
 */
function writeSpectrumSymbols(
  codeLengths,
  codes,
  scratch,
  count,
  packedIndex,
  sink,
  buffer,
  bitPosition
) {
  for (let slot = 0; slot < count; slot++) {
    const symbol = scratch.symbols[slot]
    const bits = codeLengths[symbol] ?? 0
    if (bits === 0 || bits === 0xff) {
      throw new RangeError(
        `ATRAC3plus spectrum symbol ${symbol} at ${packedIndex + slot} is not packable`
      )
    }
    if (buffer) {
      bitPosition = writeBitsAt(sink, buffer, bitPosition, codes[symbol], bits)
    } else sink.write(codes[symbol], bits)
    const extraCount = scratch.extraCounts[slot]
    if (symbol !== 0 && extraCount !== 0) {
      if (buffer) {
        bitPosition = writeBitsAt(
          sink,
          buffer,
          bitPosition,
          scratch.extraBits[slot],
          extraCount
        )
      } else sink.write(scratch.extraBits[slot], extraCount)
    }
  }
  return bitPosition
}

/**
 * Emit one quantized band with grouping, zero runs, and sign extras.
 *
 * @param {Int16Array|Uint16Array} coefficients Quantized coefficients.
 * @param {number} start First coefficient.
 * @param {number} count Coefficient count.
 * @param {SpectrumDescriptor} descriptor Entropy descriptor.
 * @param {SpectrumSymbolScratch} scratch Reusable symbol work.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packSpectrumPayload(
  coefficients,
  start,
  count,
  descriptor,
  scratch,
  sink
) {
  if (
    (!(coefficients instanceof Int16Array) &&
      !(coefficients instanceof Uint16Array)) ||
    !(descriptor instanceof SpectrumDescriptor) ||
    !(scratch instanceof SpectrumSymbolScratch) ||
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > coefficients.length ||
    typeof sink?.write !== 'function'
  ) {
    throw new TypeError('ATRAC3plus spectrum payload arguments are invalid')
  }
  const { valuesPerCodeword: group, codeLengths, codes } = descriptor
  if (group !== 1 && group !== 2 && group !== 4) {
    throw new RangeError('ATRAC3plus spectrum grouping is invalid')
  }
  /** @type {i32} At most 128 complete coefficient groups. */
  const packedCount = Math.min(Math.trunc(count / group), 128)
  const chunk = Math.max(descriptor.zeroRunChunk, 1)
  /** @type {Uint8Array|null} Preserve custom sink methods through the generic path. */
  const buffer = sink.write === bitWriterWrite ? sink.buffer : null
  /** @type {i32} */
  let bitPosition = buffer ? sink.bitPosition : 0
  if (chunk === 1) {
    // Aliased destinations and custom sinks retain one-group read/write order.
    /** @type {i32} */
    const batch = buffer && buffer.buffer !== coefficients.buffer ? 4 : 1
    for (let packed = 0; packed < packedCount; packed += batch) {
      /** @type {i32} */
      const count = Math.min(batch, packedCount - packed)
      buildSpectrumSymbols(
        coefficients,
        start + packed * group,
        descriptor,
        scratch,
        count
      )
      bitPosition = writeSpectrumSymbols(
        codeLengths,
        codes,
        scratch,
        count,
        packed,
        sink,
        buffer,
        bitPosition
      )
    }
    return
  }
  for (let chunkStart = 0; chunkStart < packedCount; chunkStart += chunk) {
    const chunkEnd = Math.min(chunkStart + chunk, packedCount)
    buildSpectrumSymbols(
      coefficients,
      start + chunkStart * group,
      descriptor,
      scratch,
      chunkEnd - chunkStart
    )
    let anyNonzero = false
    for (let packed = chunkStart; packed < chunkEnd; packed++) {
      const slot = packed - chunkStart
      anyNonzero ||= scratch.symbols[slot] !== 0
    }
    if (buffer) {
      bitPosition = writeBitsAt(
        sink,
        buffer,
        bitPosition,
        Number(anyNonzero),
        1
      )
    } else sink.write(Number(anyNonzero), 1)
    if (!anyNonzero) continue
    bitPosition = writeSpectrumSymbols(
      codeLengths,
      codes,
      scratch,
      chunkEnd - chunkStart,
      chunkStart,
      sink,
      buffer,
      bitPosition
    )
  }
}

/**
 * Decode one quantization unit directly into caller-owned fixed storage.
 *
 * @param {Int16Array} coefficients Destination coefficients.
 * @param {number} start First destination coefficient.
 * @param {number} count Coefficient count.
 * @param {SpectrumDescriptor} descriptor Entropy descriptor.
 * @param {BitReader} reader Source bit reader.
 * @returns {void}
 * @nativeUnchecked The entry guard bounds every complete coefficient group in the destination.
 */
export function unpackSpectrumPayload(
  coefficients,
  start,
  count,
  descriptor,
  reader
) {
  if (
    !(coefficients instanceof Int16Array) ||
    !(descriptor instanceof SpectrumDescriptor) ||
    !(reader instanceof BitReader) ||
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > coefficients.length
  ) {
    throw new TypeError('ATRAC3plus spectrum decode arguments are invalid')
  }
  const {
    valuesPerCodeword: group,
    valueBits,
    valueMask,
    hasSignBits,
    codeLengths,
  } = descriptor
  if (group !== 1 && group !== 2 && group !== 4) {
    throw new RangeError('ATRAC3plus spectrum grouping is invalid')
  }
  /** @type {i32} At most 128 complete coefficient groups. */
  const packedCount = Math.min(Math.trunc(count / group), 128)
  const chunk = Math.max(descriptor.zeroRunChunk, 1)
  for (let chunkStart = 0; chunkStart < packedCount; chunkStart += chunk) {
    const chunkEnd = Math.min(chunkStart + chunk, packedCount)
    if (chunk > 1 && reader.read(1) === 0) continue
    for (let packed = chunkStart; packed < chunkEnd; packed++) {
      /** @type {i32} Validated canonical symbol in this codebook. */
      const symbol = readCanonicalSymbol(codeLengths, reader)
      let extraCount = 0
      if (hasSignBits && symbol !== 0) {
        for (let lane = 0; lane < group; lane++) {
          const shift = valueBits * (group - lane - 1)
          if (((symbol >>> shift) & valueMask) !== 0) extraCount++
        }
      }
      const extraBits = extraCount === 0 ? 0 : reader.read(extraCount)
      let signMask = extraCount !== 0 ? 1 << (extraCount - 1) : 0
      for (let lane = 0; lane < group; lane++) {
        const shift = valueBits * (group - lane - 1)
        const raw = (symbol >>> shift) & valueMask
        let value = raw
        if (hasSignBits) {
          if (raw !== 0) {
            if ((extraBits & signMask) !== 0) value = -raw
            signMask >>= 1
          }
        } else if (valueBits !== 0 && raw >= 1 << (valueBits - 1)) {
          value = raw - (1 << valueBits)
        }
        coefficients[start + packed * group + lane] = value
      }
    }
  }
}

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
 * @param {Int16Array} symbols
 * @param {SharedState} shared
 * @param {SpectrumSyntaxScratch} scratch
 * @param {BitWriter|BitCounter} sink
 */
function validateRequest(block, symbols, shared, scratch, sink) {
  if (
    !block?.syntax ||
    !(symbols instanceof Int16Array) ||
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
 * @param {Int16Array} symbols Final or trial coefficient symbols.
 * @param {SharedState} shared Shared coding-unit syntax state.
 * @param {SpectrumSyntaxScratch} scratch Reusable symbol storage.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packChannelSpectrum(block, symbols, shared, scratch, sink) {
  validateRequest(block, symbols, shared, scratch, sink)
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
      symbols,
      start,
      end - start,
      descriptor,
      scratch.symbol,
      sink
    )
  }
  packSpectralNoiseTrailer(block, shared, sink)
}
