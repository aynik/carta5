/** Canonical ATRAC3plus entropy-symbol cost helpers. */

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

/**
 * Materialize canonical Huffman codes for the supplied code-length vector.
 *
 * @param {ArrayLike<number>} codeLengths
 * @returns {{codes: Uint32Array, maximum: number}}
 */
function tableFor(codeLengths) {
  let table = canonicalTables.get(codeLengths)
  if (table) return table
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
  table = { codes, maximum }
  canonicalTables.set(codeLengths, table)
  return table
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
 * @param {BitReader} reader Bit reader exposing `peek` and `skip`.
 * @returns {number} Decoded symbol index.
 */
export function readCanonicalSymbol(codeLengths, reader) {
  if (
    !(codeLengths instanceof Uint8Array) ||
    typeof reader?.peek !== 'function' ||
    !Number.isInteger(reader.bitPosition)
  ) {
    throw new TypeError('ATRAC3plus canonical decode request is invalid')
  }
  const table = tableFor(codeLengths)
  const maximum = table.maximum
  const prefix = reader.peek(maximum)
  const codes = table.codes
  let selected = 0
  for (let symbol = 0; symbol < codeLengths.length; symbol++) {
    const bits = codeLengths[symbol]
    if (
      bits !== 0 &&
      bits !== 0xff &&
      prefix >>> (maximum - bits) === codes[symbol]
    ) {
      selected = symbol
      break
    }
  }
  const bits = codeLengths[selected]
  if (bits !== 0 && bits !== 0xff) reader.bitPosition += bits
  return selected
}
