/**
 * Float32 modified discrete cosine transforms.
 *
 * The staged rounding order is part of Carta5's numerical contract. A
 * mathematically equivalent complex-FFT decomposition changes allocation
 * boundaries and is therefore not interchangeable with this kernel.
 */

/**
 * Round multiplication to float32.
 *
 * @param {number} left Left operand.
 * @param {number} right Right operand.
 * @returns {number} Rounded product.
 */
function multiply(left, right) {
  return Math.fround(left * right)
}

/**
 * Round addition to float32.
 *
 * @param {number} left Left operand.
 * @param {number} right Right operand.
 * @returns {number} Rounded sum.
 */
function add(left, right) {
  return Math.fround(left + right)
}

/**
 * Round subtraction to float32.
 *
 * @param {number} left Left operand.
 * @param {number} right Right operand.
 * @returns {number} Rounded difference.
 */
function subtract(left, right) {
  return Math.fround(left - right)
}

/**
 * Round a multiplication and addition to float32 once.
 *
 * @param {number} left Left multiplicand.
 * @param {number} right Right multiplicand.
 * @param {number} addend Value added to the product.
 * @returns {number} Rounded result.
 */
function multiplyAdd(left, right, addend) {
  return Math.fround(left * right + addend)
}

/**
 * Common geometry and rotations for power-of-two MDCT transforms.
 *
 * @property {i32} size Validated time-domain transform size.
 * @property {i32} halfSize Number of transform coefficients.
 * @property {i32} quarterSize Number of complex transform pairs.
 * @property {i32} fftStages Integral base-two transform depth.
 */
class MdctBase {
  /**
   * @param {number} size Time-domain transform size.
   * @param {number} scale Transform normalization.
   */
  constructor(size, scale) {
    if (
      !Number.isInteger(size) ||
      size < 4 ||
      (size & (size - 1)) !== 0 ||
      !Number.isFinite(scale)
    ) {
      throw new RangeError('MDCT geometry is invalid')
    }
    this.size = size
    this.halfSize = size >> 1
    this.quarterSize = size >> 2
    this.fftStages = Math.log2(this.quarterSize)
    this.scale = Math.fround(scale / size)

    this.reorder = new Uint16Array(this.halfSize)
    const reorderBits = Math.log2(this.halfSize)
    for (let index = 0; index < this.halfSize; index++) {
      let source = index ^ (index >> 1)
      let reversed = 0
      for (let bit = 0; bit < reorderBits; bit++) {
        reversed = (reversed << 1) | (source & 1)
        source >>= 1
      }
      this.reorder[index] = reversed
    }

    this.fftCosines = new Float32Array(this.quarterSize - 1)
    this.fftSines = new Float32Array(this.quarterSize - 1)
    let twiddle = 0
    for (let stage = 0; stage < this.fftStages; stage++) {
      const step = 1 << stage
      for (let butterfly = 0; butterfly < step; butterfly++) {
        const angle = ((4 * butterfly + 1) * Math.PI) / (4 * step)
        this.fftCosines[twiddle] = Math.cos(angle)
        this.fftSines[twiddle] = Math.sin(angle)
        twiddle++
      }
    }

    this.rotationCosines = new Float32Array(this.quarterSize)
    this.rotationSines = new Float32Array(this.quarterSize)
    for (let pair = 0; pair < this.quarterSize; pair++) {
      const angle = ((4 * pair + 1) * Math.PI) / (2 * size)
      this.rotationCosines[pair] = Math.cos(angle)
      this.rotationSines[pair] = Math.sin(angle)
    }
  }

  /**
   * Resolve one interleaved complex work array.
   *
   * @param {object} buffers Work buffers indexed by coefficient count.
   * @returns {Float32Array} Interleaved complex work array.
   */
  resolveWork(buffers) {
    const work = buffers?.[this.halfSize]
    if (!(work instanceof Float32Array) || work.length < this.halfSize) {
      throw new RangeError(`MDCT buffer for size ${this.halfSize} is required`)
    }
    return work
  }
}

/** Forward modified discrete cosine transform. */
export class MDCT extends MdctBase {
  /**
   * @param {number} size Time-domain transform size.
   * @param {number} [scale=4] Transform normalization.
   */
  constructor(size, scale = 4) {
    super(size, scale)
  }

  /**
   * Transform windowed time-domain samples into MDCT coefficients.
   *
   * @param {Float32Array} input Windowed time-domain samples.
   * @param {object} buffers Reusable work buffers indexed by coefficient count.
   * @param {Float32Array|null} [destination=null] Optional caller-owned output.
   * @param {number} [destinationOffset=0] First output coefficient.
   * @returns {Float32Array} Destination containing the coefficients.
   * @nativeUnchecked Validated geometry bounds the constructor-owned tables and work.
   */
  transform(input, buffers, destination = null, destinationOffset = 0) {
    if (
      !(input instanceof Float32Array) ||
      input.length < this.size ||
      !Number.isInteger(destinationOffset) ||
      destinationOffset < 0
    ) {
      throw new RangeError('MDCT input geometry is invalid')
    }
    const output = destination ?? new Float32Array(this.halfSize)
    if (
      !(output instanceof Float32Array) ||
      destinationOffset + this.halfSize > output.length
    ) {
      throw new RangeError('MDCT output geometry is invalid')
    }
    /** @type {Float32Array} */
    const work = this.resolveWork(buffers)
    const {
      size,
      halfSize,
      quarterSize,
      fftStages,
      scale,
      reorder,
      fftCosines,
      fftSines,
      rotationCosines,
      rotationSines,
    } = this

    for (let sample = 0; sample < quarterSize; sample++) {
      const firstIndex = reorder[quarterSize + sample]
      const secondIndex = reorder[quarterSize - 1 - sample]
      work[firstIndex] = subtract(input[sample], input[halfSize - 1 - sample])
      work[secondIndex] = Math.fround(
        -add(input[halfSize + sample], input[size - 1 - sample])
      )
    }

    let twiddleBase = 0
    for (let stage = 0; stage < fftStages; stage++) {
      const step = 1 << stage
      const butterflySpan = step << 1
      const groups = halfSize / (step * 4)
      let base = 0
      for (let group = 0; group < groups; group++) {
        let twiddle = twiddleBase
        for (let butterfly = 0; butterfly < step; butterfly++) {
          const firstIndex = base + butterfly * 2
          const secondIndex = firstIndex + butterflySpan
          const firstReal = work[firstIndex]
          const firstImaginary = work[firstIndex + 1]
          const secondReal = work[secondIndex]
          const secondImaginary = work[secondIndex + 1]
          const cosine = fftCosines[twiddle]
          const sine = fftSines[twiddle]
          const rotatedReal = add(
            multiply(sine, secondImaginary),
            multiply(cosine, secondReal)
          )
          const rotatedImaginary = subtract(
            multiply(secondReal, sine),
            multiply(secondImaginary, cosine)
          )
          work[firstIndex] = add(firstReal, rotatedReal)
          work[firstIndex + 1] = add(firstImaginary, rotatedImaginary)
          work[secondIndex] = subtract(firstReal, rotatedReal)
          work[secondIndex + 1] = subtract(firstImaginary, rotatedImaginary)
          twiddle++
        }
        base += butterflySpan * 2
      }
      twiddleBase += step
    }

    for (let pair = 0; pair < quarterSize; pair++) {
      const real = work[pair * 2]
      const imaginary = work[pair * 2 + 1]
      const cosine = rotationCosines[pair]
      const sine = rotationSines[pair]
      output[destinationOffset + pair * 2] = multiply(
        multiplyAdd(sine, imaginary, multiply(cosine, real)),
        scale
      )
      output[destinationOffset + halfSize - 1 - pair * 2] = multiply(
        multiplyAdd(real, sine, -multiply(imaginary, cosine)),
        scale
      )
    }
    return output
  }
}

/** Inverse modified discrete cosine transform. */
export class IMDCT extends MdctBase {
  /**
   * @param {number} size Time-domain transform size.
   * @param {number} [scale=size] Transform normalization.
   */
  constructor(size, scale = size) {
    super(size, scale)
  }

  /**
   * Transform MDCT coefficients into time-domain samples.
   *
   * @param {Float32Array} input MDCT coefficients.
   * @param {object} buffers Reusable work buffers indexed by coefficient count.
   * @param {Float32Array|null} [destination=null] Optional caller-owned output.
   * @param {number} [destinationOffset=0] First output sample.
   * @returns {Float32Array} Destination containing the time-domain samples.
   * @nativeUnchecked Validated geometry bounds the constructor-owned tables and work.
   */
  transform(input, buffers, destination = null, destinationOffset = 0) {
    if (
      !(input instanceof Float32Array) ||
      input.length < this.halfSize ||
      !Number.isInteger(destinationOffset) ||
      destinationOffset < 0
    ) {
      throw new RangeError('IMDCT input geometry is invalid')
    }
    const output = destination ?? new Float32Array(this.size)
    if (
      !(output instanceof Float32Array) ||
      destinationOffset + this.size > output.length
    ) {
      throw new RangeError('IMDCT output geometry is invalid')
    }
    /** @type {Float32Array} */
    const work = this.resolveWork(buffers)
    const {
      halfSize,
      quarterSize,
      fftStages,
      scale,
      reorder,
      fftCosines,
      fftSines,
      rotationCosines,
      rotationSines,
    } = this

    for (let pair = 0; pair < quarterSize; pair++) {
      const index = pair * 2
      const head = input[index]
      const tail = input[halfSize - 1 - index]
      const cosine = rotationCosines[pair]
      const sine = rotationSines[pair]
      work[index] = cosine * head + sine * tail
      work[index + 1] = head * sine - tail * cosine
    }

    let twiddleBase = quarterSize - 1
    for (let stage = fftStages - 1; stage >= 0; stage--) {
      const step = 1 << stage
      const half = step * 2
      const groupStride = step * 4
      const groups = halfSize / groupStride
      for (let group = 0; group < groups; group++) {
        let twiddle = twiddleBase - step
        const base = group * groupStride
        for (let butterfly = 0; butterfly < step; butterfly++) {
          const firstIndex = base + butterfly * 2
          const secondIndex = base + half + butterfly * 2
          const firstReal = work[firstIndex]
          const firstImaginary = work[firstIndex + 1]
          const secondReal = work[secondIndex]
          const secondImaginary = work[secondIndex + 1]
          const differenceReal = firstReal - secondReal
          const differenceImaginary = firstImaginary - secondImaginary
          const cosine = fftCosines[twiddle]
          const sine = fftSines[twiddle]
          work[firstIndex] = firstReal + secondReal
          work[firstIndex + 1] = firstImaginary + secondImaginary
          work[secondIndex] =
            differenceReal * cosine + differenceImaginary * sine
          work[secondIndex + 1] =
            differenceReal * sine - differenceImaginary * cosine
          twiddle++
        }
      }
      twiddleBase -= step
    }

    for (let sample = 0; sample < quarterSize; sample++) {
      const firstIndex = reorder[quarterSize + sample]
      output[destinationOffset + sample] = multiply(work[firstIndex], scale)
      const lastIndex = reorder[sample]
      output[destinationOffset + 3 * quarterSize + sample] = multiply(
        -work[lastIndex],
        scale
      )
    }
    for (let sample = 0; sample < halfSize; sample++) {
      const workIndex = reorder[halfSize - 1 - sample]
      output[destinationOffset + quarterSize + sample] = multiply(
        -work[workIndex],
        scale
      )
    }
    return output
  }
}
