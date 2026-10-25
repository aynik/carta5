/** Canonical ATRAC3plus entropy-symbol cost helpers. */

import { BitReader, peekBits } from './bitstream.js'

const bitReaderPeek = BitReader.prototype.peek

/**
 * Return the exact bit length of one canonical entropy symbol.
 *
 * ATRAC3plus code-length tables use both zero and 255 as absent markers. Keeping
 * that rule here gives syntax planners the same representability boundary the
 * eventual canonical writer will use.
 *
 * @param {Uint8Array} codeLengths Canonical length table.
 * @param {number} symbol Symbol index.
 * @returns {number|null} Encoded width, or `null` when absent.
 */
export function packableSymbolBits(codeLengths, symbol) {
  if (
    !(codeLengths instanceof Uint8Array) ||
    !Number.isInteger(symbol) ||
    symbol < 0 ||
    symbol >= codeLengths.length
  ) {
    return null
  }
  const bits = codeLengths[symbol]
  return bits === 0 || bits === 0xff ? null : bits
}

const canonicalTables = new WeakMap()
/** @type {Uint8Array|null} Most entropy symbols reuse the preceding codebook. */
let recentLengths = null
/** @type {CanonicalCodeTable|null} One strong cache entry; older rows stay weak. */
let recentTable = null

/**
 * @typedef {object} CanonicalCodeTable
 * @property {Uint32Array} codes Canonical code by symbol.
 * @property {i32} maximum Maximum code width.
 * @property {i32} prefixBits Width of the bounded direct lookup.
 * @property {Uint16Array} prefixSymbols Short-code symbols plus one; zero falls back.
 */

/**
 * Materialize canonical Huffman codes for the supplied code-length vector.
 *
 * @param {Uint8Array} codeLengths Immutable code-length vector.
 * @returns {CanonicalCodeTable} Canonical code table.
 */
function tableFor(codeLengths) {
  if (codeLengths === recentLengths) return recentTable
  let table = canonicalTables.get(codeLengths)
  if (table) {
    recentLengths = codeLengths
    recentTable = table
    return table
  }
  const counts = new Uint32Array(33)
  let maximum = 0
  for (const storedLength of codeLengths) {
    if (storedLength !== 0 && storedLength !== 0xff) {
      if (storedLength > 32) {
        throw new RangeError('ATRAC3plus canonical code exceeds 32 bits')
      }
      counts[storedLength]++
      if (storedLength > maximum) maximum = storedLength
    }
  }
  const next = new Uint32Array(33)
  /** @type {f64} The 32-bit code-space endpoint can equal 2 ** 32. */
  let code = 0
  for (let bits = 1; bits <= 32; bits++) {
    code = (code + counts[bits - 1]) * 2
    next[bits] = code >>> 0
  }
  const codes = new Uint32Array(codeLengths.length)
  for (let symbol = 0; symbol < codeLengths.length; symbol++) {
    const bits = codeLengths[symbol]
    if (bits === 0 || bits === 0xff) continue
    codes[symbol] = next[bits]
    next[bits]++
  }
  const prefixBits = Math.min(maximum, 8)
  const prefixSymbols = new Uint16Array(1 << prefixBits)
  // Incomplete trees work too; oversubscribed custom tables retain the scan.
  if (code + counts[32] <= 0x100000000 && codeLengths.length < 0x10000) {
    for (let symbol = 0; symbol < codeLengths.length; symbol++) {
      const bits = codeLengths[symbol]
      if (bits === 0 || bits > prefixBits) continue
      const shift = prefixBits - bits
      const start = codes[symbol] << shift
      prefixSymbols.fill(symbol + 1, start, start + (1 << shift))
    }
  }
  table = { codes, maximum, prefixBits, prefixSymbols }
  canonicalTables.set(codeLengths, table)
  recentLengths = codeLengths
  recentTable = table
  return table
}

/**
 * Return the immutable canonical code row paired with a code-length table.
 *
 * Format-specific descriptors can retain this row once instead of resolving
 * the same canonical table for every emitted symbol.
 *
 * @param {Uint8Array} codeLengths Canonical length table.
 * @returns {Uint32Array} Canonical code by symbol.
 */
export function canonicalCodes(codeLengths) {
  if (!(codeLengths instanceof Uint8Array)) {
    throw new TypeError('ATRAC3plus canonical lengths must be bytes')
  }
  return tableFor(codeLengths).codes
}

/**
 * Emit one canonical symbol, returning false when it is absent.
 *
 * @param {Uint8Array} codeLengths Canonical length table.
 * @param {number} symbol Symbol index.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {boolean} Whether the symbol was emitted.
 */
export function writeCanonicalSymbol(codeLengths, symbol, sink) {
  const bits = packableSymbolBits(codeLengths, symbol)
  if (bits === null || typeof sink?.write !== 'function') return false
  sink.write(tableFor(codeLengths).codes[symbol], bits)
  return true
}

/**
 * Read one canonical symbol through the reference's maximum-width prefix.
 *
 * @param {Uint8Array} codeLengths Canonical length table.
 * @param {BitReader} reader Bit reader exposing a prefix and bit cursor.
 * @returns {number} Decoded symbol index.
 * @nativeUnchecked Maintained tables are nonempty and share code and length bounds.
 */
export function readCanonicalSymbol(codeLengths, reader) {
  const peek = reader?.peek
  if (
    !(codeLengths instanceof Uint8Array) ||
    typeof peek !== 'function' ||
    !Number.isInteger(reader.bitPosition)
  ) {
    throw new TypeError('ATRAC3plus canonical decode request is invalid')
  }
  const table = tableFor(codeLengths)
  /** @type {i32} Maximum width in the maintained canonical table. */
  const maximum = table.maximum
  /** @type {i32} The reader's unsigned, at-most-24-bit prefix. */
  const prefix =
    peek === bitReaderPeek
      ? peekBits(reader.buffer, reader.bitPosition, maximum)
      : peek.call(reader, maximum)
  const codes = table.codes
  const prefixSymbols = table.prefixSymbols
  const cached = prefixSymbols[prefix >>> (maximum - table.prefixBits)]
  /** @type {i32} */
  let selected = cached - 1
  if (selected < 0) {
    selected = 0
    for (let symbol = 0; symbol < codeLengths.length; symbol++) {
      const bits = codeLengths[symbol]
      if (bits === 0 || bits === 0xff) continue
      const code = codes[symbol]
      if (prefix >>> (maximum - bits) === code) {
        selected = symbol
        break
      }
    }
  }
  const bits = codeLengths[selected]
  if (bits !== 0 && bits !== 0xff) reader.bitPosition += bits
  return selected
}
