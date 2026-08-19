/** Shared numerical and composition helpers. */

const numericBits = new DataView(new ArrayBuffer(8))

/**
 * Round a value to IEEE-754 float32 precision.
 *
 * @param {number} value
 * @returns {number}
 */
export function float32Round(value) {
  return Math.fround(value)
}

/**
 * Add two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Add(left, right) {
  return Math.fround(left + right)
}

/**
 * Subtract two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Subtract(left, right) {
  return Math.fround(left - right)
}

/**
 * Multiply two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Multiply(left, right) {
  return Math.fround(left * right)
}

/**
 * Multiply and add with one final float32 rounding.
 *
 * @param {number} left
 * @param {number} right
 * @param {number} addend
 * @returns {number}
 */
export function float32MultiplyAdd(left, right, addend) {
  return Math.fround(left * right + addend)
}

/**
 * Multiply and add with one final float64 rounding.
 *
 * @param {number} left
 * @param {number} right
 * @param {number} addend
 * @returns {number}
 */
export function float64MultiplyAdd(left, right, addend) {
  const product = left * right
  if (!Number.isFinite(product) || !Number.isFinite(addend)) {
    return product + addend
  }
  const split = 134217729
  const leftSplit = split * left
  const leftHigh = leftSplit - (leftSplit - left)
  const leftLow = left - leftHigh
  const rightSplit = split * right
  const rightHigh = rightSplit - (rightSplit - right)
  const rightLow = right - rightHigh
  const productError =
    leftHigh * rightHigh -
    product +
    leftHigh * rightLow +
    leftLow * rightHigh +
    leftLow * rightLow
  const sum = product + addend
  const addendVirtual = sum - product
  const sumError = product - (sum - addendVirtual) + (addend - addendVirtual)
  return sum + (productError + sumError)
}

/**
 * Reinterpret one unsigned 32-bit word as an IEEE-754 float32 value.
 *
 * @param {number} bits
 * @returns {number}
 */
export function float32FromBits(bits) {
  numericBits.setUint32(0, bits, true)
  return numericBits.getFloat32(0, true)
}

/**
 * Reinterpret one float32-rounded value as an unsigned 32-bit word.
 *
 * @param {number} value
 * @returns {number}
 */
export function float32ToBits(value) {
  numericBits.setFloat32(0, value, true)
  return numericBits.getUint32(0, true)
}

/**
 * Reinterpret one unsigned 64-bit word as an IEEE-754 float64 value.
 *
 * @param {bigint|number} bits
 * @returns {number}
 */
export function float64FromBits(bits) {
  numericBits.setBigUint64(0, BigInt(bits), true)
  return numericBits.getFloat64(0, true)
}

/**
 * Reinterpret one float64 value as an unsigned 64-bit word.
 *
 * @param {number} value
 * @returns {bigint}
 */
export function float64ToBits(value) {
  numericBits.setFloat64(0, value, true)
  return numericBits.getBigUint64(0, true)
}

/**
 * Return a signed integer key that follows IEEE-754 total float64 order.
 *
 * @param {number} value
 * @returns {bigint}
 */
export function float64TotalOrderKey(value) {
  numericBits.setFloat64(0, value, true)
  let key = numericBits.getBigInt64(0, true)
  if (key < 0) key ^= 0x7fffffffffffffffn
  return key
}

/**
 * Flip the sign bit of a float32-rounded value.
 *
 * @param {number} value
 * @returns {number}
 */
export function float32Negate(value) {
  return float32FromBits(float32ToBits(value) ^ 0x80000000)
}

/**
 * Return the maximum absolute value in one half-open array range.
 *
 * @param {ArrayLike<number>} values
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number}
 */
export function absoluteMaximum(values, start = 0, end = values.length) {
  let maximum = 0
  for (let index = start; index < end; index++) {
    const magnitude = Math.abs(values[index])
    if (magnitude > maximum) maximum = magnitude
  }
  return maximum
}

/**
 * Round to the nearest integer, resolving ties away from zero.
 *
 * @param {number} value
 * @returns {number}
 */
export function roundAwayFromZero(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Convert a number to a signed 32-bit integer with saturating bounds.
 *
 * @param {number} value
 * @returns {number}
 */
export function saturatingInt32FromFloat(value) {
  if (Number.isNaN(value)) return 0
  if (value >= 2147483647) return 2147483647
  if (value <= -2147483648) return -2147483648
  return Math.trunc(value)
}

/**
 * Throw an expression-friendly error used by required-value fallbacks.
 *
 * @param {string} message Error message.
 * @returns {never} This function always throws.
 */
export function throwError(message) {
  throw new Error(message)
}

/**
 * Reverse the low `bitCount` bits of an unsigned integer.
 *
 * @param {number} value Unsigned source value.
 * @param {number} bitCount Number of low bits to reverse, from 0 through 32.
 * @returns {number} Unsigned reversed bit field.
 */
export function reverseLowBits(value, bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
    throw new RangeError(
      `Bit count must be an integer in 0..32, got ${bitCount}`
    )
  }
  let source = Number(value) >>> 0
  let reversed = 0
  for (let index = 0; index < bitCount; index++) {
    reversed = (reversed * 2 + (source & 1)) >>> 0
    source >>>= 1
  }
  return reversed
}

/**
 * Compose stateful stage factories once and return the reusable frame path.
 *
 * @param {*} context Shared stage ownership and persistent state.
 * @param {...function(*): function(*): *} stages Ordered stage factories.
 * @returns {function(*): *} Reusable composed frame operation.
 */
export function pipe(context, ...stages) {
  const operations = stages.map((stage) => stage(context))
  return (input) =>
    operations.reduce((value, operation) => operation(value), input)
}
