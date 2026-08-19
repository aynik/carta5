import { describe, expect, it } from 'vitest'

import {
  readCanonicalSymbol,
  writeCanonicalSymbol,
} from '../codec/coding/entropy.js'
import { BitReader, BitWriter } from '../codec/io/bitstream.js'

describe('ATRAC3plus canonical entropy tables', () => {
  it('writes and reads the exact canonical bit sequence', () => {
    const codeLengths = Uint8Array.from([1, 2, 3, 3])
    const bytes = new Uint8Array(2)
    const writer = new BitWriter(bytes)
    for (let symbol = 0; symbol < codeLengths.length; symbol++) {
      expect(writeCanonicalSymbol(codeLengths, symbol, writer)).toBe(true)
    }
    expect(writer.bitPosition).toBe(9)
    expect([...bytes]).toEqual([0x5b, 0x80])

    const reader = new BitReader(bytes)
    expect(
      Array.from({ length: codeLengths.length }, () =>
        readCanonicalSymbol(codeLengths, reader)
      )
    ).toEqual([0, 1, 2, 3])
    expect(reader.bitPosition).toBe(9)
  })
})
