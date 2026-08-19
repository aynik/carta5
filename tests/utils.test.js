import { describe, it, expect } from 'vitest'
import {
  absoluteMaximum,
  float32Add,
  float32FromBits,
  float32Multiply,
  float32MultiplyAdd,
  float32Negate,
  float32Round,
  float32Subtract,
  float32ToBits,
  float64FromBits,
  float64MultiplyAdd,
  float64TotalOrderKey,
  float64ToBits,
  pipe,
  reverseLowBits,
  roundAwayFromZero,
  saturatingInt32FromFloat,
  throwError,
} from '../codec/utils'

describe('Utilities', () => {
  it('shares exact float arithmetic and bit reinterpretation primitives', () => {
    expect(float32Add(1 / 3, 1 / 7)).toBe(Math.fround(1 / 3 + 1 / 7))
    expect(float32Subtract(1 / 3, 1 / 7)).toBe(Math.fround(1 / 3 - 1 / 7))
    expect(float32Multiply(1 / 3, 1 / 7)).toBe(Math.fround((1 / 3) * (1 / 7)))
    expect(float32MultiplyAdd(0.5, 0.25, 0.125)).toBe(0.25)
    expect(float32Round(1 / 3)).toBe(Math.fround(1 / 3))
    expect(float32FromBits(0x3f800000)).toBe(1)
    expect(float32ToBits(-1)).toBe(0xbf800000)
    expect(float64FromBits(0x3ff0000000000000n)).toBe(1)
    expect(float64ToBits(-1)).toBe(0xbff0000000000000n)
    expect(float32ToBits(float32Negate(0))).toBe(0x80000000)
  })

  it('shares exact float ordering, ranges, and conversions', () => {
    const offset = 2 ** -27
    expect(float64MultiplyAdd(1 + offset, 1 - offset, -1)).toBe(-(2 ** -54))
    expect(float64MultiplyAdd(Number.POSITIVE_INFINITY, 1, 0)).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(float64TotalOrderKey(-1)).toBeLessThan(float64TotalOrderKey(-0))
    expect(float64TotalOrderKey(-0)).toBeLessThan(float64TotalOrderKey(0))
    expect(float64TotalOrderKey(0)).toBeLessThan(float64TotalOrderKey(1))
    expect(absoluteMaximum(new Float32Array([-2, 7, -11, 5]), 1, 4)).toBe(11)
    expect(roundAwayFromZero(1.5)).toBe(2)
    expect(roundAwayFromZero(-1.5)).toBe(-2)
    expect(saturatingInt32FromFloat(Number.NaN)).toBe(0)
    expect(saturatingInt32FromFloat(Number.POSITIVE_INFINITY)).toBe(2147483647)
    expect(saturatingInt32FromFloat(Number.NEGATIVE_INFINITY)).toBe(-2147483648)
    expect(saturatingInt32FromFloat(-12.75)).toBe(-12)
  })

  it('reverses bounded low bit fields', () => {
    expect(reverseLowBits(0b1101, 4)).toBe(0b1011)
    expect(reverseLowBits(0xffffffff, 0)).toBe(0)
    expect(() => reverseLowBits(0, 33)).toThrow(RangeError)
  })

  describe('throwError', () => {
    it('should throw an error with the specified message', () => {
      const errorMessage = 'This is a test error'
      expect(() => throwError(errorMessage)).toThrow(errorMessage)
    })
  })

  describe('pipe', () => {
    it('should compose functions correctly', () => {
      const context = {}
      const add = () => (x) => x + 1
      const multiply = () => (x) => x * 2
      const subtract = () => (x) => x - 3

      const pipeline = pipe(context, add, multiply, subtract)
      // (5 + 1) * 2 - 3 = 9
      expect(pipeline(5)).toBe(9)
    })

    it('should pass context to all stages', () => {
      const context = { value: 10 }
      const stage1 = (ctx) => (x) => x + ctx.value
      const stage2 = (ctx) => (x) => x * ctx.value

      const pipeline = pipe(context, stage1, stage2)
      // (5 + 10) * 10 = 150
      expect(pipeline(5)).toBe(150)
    })
  })
})
