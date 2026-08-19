import { describe, it, expect } from 'vitest'
import { packBits, unpackBits, unpackSignedBits } from '../codec/io/bitstream'

describe('Bitstream Operations', () => {
  describe('packBits and unpackBits', () => {
    it('should pack and unpack a single byte aligned value', () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 0b10101010, 8)
      expect(buffer[0]).toBe(0b10101010)
      expect(unpackBits(buffer, 0, 8)).toBe(0b10101010)
    })

    it('should pack and unpack a value that crosses a byte boundary', () => {
      const buffer = new Uint8Array(2)
      packBits(buffer, 4, 0b11110000, 8)
      expect(buffer[0]).toBe(0b00001111)
      expect(buffer[1]).toBe(0b00000000)
      expect(unpackBits(buffer, 4, 8)).toBe(0b11110000)
    })

    it('should handle a zero bit count edge case', () => {
      const buffer = new Uint8Array(1)
      buffer[0] = 0xff
      packBits(buffer, 0, 123, 0)
      expect(buffer[0]).toBe(0xff)
      expect(unpackBits(buffer, 0, 0)).toBe(0)
    })

    const bitCounts = Array.from({ length: 30 }, (_, i) => i + 1)
    it.each(bitCounts)(
      'should correctly pack and unpack %i bits',
      (bitCount) => {
        const buffer = new Uint8Array(Math.ceil(bitCount / 8))
        const value = (1 << bitCount) - 1 // All bits set to 1
        packBits(buffer, 0, value, bitCount)
        expect(unpackBits(buffer, 0, bitCount)).toBe(value)
      }
    )
  })

  describe('unpackSignedBits', () => {
    it('should correctly unpack a positive signed value', () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 5, 4)
      expect(unpackSignedBits(buffer, 0, 4)).toBe(5)
    })

    it("should correctly unpack a negative signed value (two's complement)", () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 0b1011, 4) // -5 in 4-bit two's complement
      expect(unpackSignedBits(buffer, 0, 4)).toBe(-5)
    })

    it('should handle the minimum negative value', () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 0b1000, 4) // -8 in 4-bit two's complement
      expect(unpackSignedBits(buffer, 0, 4)).toBe(-8)
    })

    it('should handle the maximum positive value', () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 0b0111, 4) // 7 in 4-bit two's complement
      expect(unpackSignedBits(buffer, 0, 4)).toBe(7)
    })

    it('should handle zero', () => {
      const buffer = new Uint8Array(1)
      packBits(buffer, 0, 0, 4)
      expect(unpackSignedBits(buffer, 0, 4)).toBe(0)
    })
  })
})
