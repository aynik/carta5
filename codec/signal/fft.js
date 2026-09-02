/** Complex radix-2 Fast Fourier Transform. */

export class FFT {
  /**
   * Transform split complex data in place.
   *
   * @param {Float32Array} real Real input and output components.
   * @param {Float32Array} imaginary Imaginary input and output components.
   */
  static transform(real, imaginary) {
    const size = real.length
    if (size === 1) return

    const bits = Math.log2(size)
    for (let index = 0; index < size; index++) {
      let reversed = 0
      let remaining = index
      for (let bit = 0; bit < bits; bit++) {
        reversed = (reversed << 1) | (remaining & 1)
        remaining >>= 1
      }
      if (reversed > index) {
        const realValue = real[index]
        real[index] = real[reversed]
        real[reversed] = realValue
        const imaginaryValue = imaginary[index]
        imaginary[index] = imaginary[reversed]
        imaginary[reversed] = imaginaryValue
      }
    }

    for (let stride = 2; stride <= size; stride <<= 1) {
      const halfStride = stride >> 1
      const angle = (-2 * Math.PI) / stride
      const stepReal = Math.cos(angle)
      const stepImaginary = Math.sin(angle)

      for (let start = 0; start < size; start += stride) {
        let twiddleReal = 1
        let twiddleImaginary = 0

        for (let offset = 0; offset < halfStride; offset++) {
          const evenIndex = start + offset
          const oddIndex = evenIndex + halfStride
          const evenReal = real[evenIndex]
          const evenImaginary = imaginary[evenIndex]
          const oddReal = real[oddIndex]
          const oddImaginary = imaginary[oddIndex]
          const rotatedReal =
            oddReal * twiddleReal - oddImaginary * twiddleImaginary
          const rotatedImaginary =
            oddReal * twiddleImaginary + oddImaginary * twiddleReal

          real[evenIndex] = evenReal + rotatedReal
          imaginary[evenIndex] = evenImaginary + rotatedImaginary
          real[oddIndex] = evenReal - rotatedReal
          imaginary[oddIndex] = evenImaginary - rotatedImaginary

          const nextReal =
            twiddleReal * stepReal - twiddleImaginary * stepImaginary
          twiddleImaginary =
            twiddleReal * stepImaginary + twiddleImaginary * stepReal
          twiddleReal = nextReal
        }
      }
    }
  }
}
