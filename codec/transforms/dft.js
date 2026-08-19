/** Exact ATRAC3plus real-DFT primitives. */

import { DFT_16_TWIDDLES, DFT_256_TWIDDLES } from '../core/tables.js'
import { float32Round, reverseLowBits } from '../utils.js'

/**
 * Apply the specialized 16-point bit-reversal permutation to interleaved complex pairs.
 *
 * @param {ArrayLike<number>} spectrum
 */
function bitReverseComplexPairs16(spectrum) {
  for (let sourcePair = 0; sourcePair < 8; sourcePair++) {
    const destinationPair = reverseLowBits(sourcePair, 3)
    if (destinationPair <= sourcePair) continue
    const source = sourcePair * 2
    const destination = destinationPair * 2
    let temporary = spectrum[source]
    spectrum[source] = spectrum[destination]
    spectrum[destination] = temporary
    temporary = spectrum[source + 1]
    spectrum[source + 1] = spectrum[destination + 1]
    spectrum[destination + 1] = temporary
  }
}

/**
 * Permute interleaved complex pairs into radix-two bit-reversed order.
 *
 * @param {ArrayLike<number>} spectrum
 * @param {number} sampleCount
 */
function bitReverseComplexPairs(spectrum, sampleCount) {
  const complexCount = sampleCount >> 1
  let bitCount = 0
  for (let remaining = complexCount; remaining > 1; remaining >>= 1) bitCount++
  for (let sourcePair = 0; sourcePair < complexCount; sourcePair++) {
    const destinationPair = reverseLowBits(sourcePair, bitCount)
    if (destinationPair <= sourcePair) continue
    const source = sourcePair * 2
    const destination = destinationPair * 2
    let temporary = spectrum[source]
    spectrum[source] = spectrum[destination]
    spectrum[destination] = temporary
    temporary = spectrum[source + 1]
    spectrum[source + 1] = spectrum[destination + 1]
    spectrum[destination + 1] = temporary
  }
}

/**
 * In-place 16-point real DFT used by gain flatness analysis.
 *
 * @param {Float32Array} spectrum Mutable 16-float real spectrum.
 * @returns {Float32Array} The transformed spectrum.
 */
export function forwardRealDft16(spectrum) {
  if (!(spectrum instanceof Float32Array) || spectrum.length < 16) {
    throw new RangeError('ATRAC3plus 16-point DFT requires 16 floats')
  }
  bitReverseComplexPairs16(spectrum)

  {
    const lane0 = spectrum[0]
    const lane1 = spectrum[1]
    const lane2 = spectrum[2]
    const lane3 = spectrum[3]
    const lane4 = spectrum[4]
    const lane5 = spectrum[5]
    const lane6 = spectrum[6]
    const lane7 = spectrum[7]
    const butterfly0 = lane0 + lane2
    const butterfly1 = lane1 + lane3
    const butterfly2 = lane1 - lane3
    const butterfly3 = lane4 + lane6
    const butterfly4 = lane5 + lane7
    const butterfly5 = lane5 - lane7
    const butterfly6 = lane0 - lane2
    const butterfly7 = lane4 - lane6
    spectrum[0] = float32Round(butterfly0 + butterfly3)
    spectrum[1] = float32Round(butterfly1 + butterfly4)
    spectrum[4] = float32Round(butterfly0 - butterfly3)
    spectrum[5] = float32Round(butterfly1 - butterfly4)
    spectrum[2] = float32Round(butterfly6 - butterfly5)
    spectrum[3] = float32Round(butterfly2 + butterfly7)
    spectrum[6] = float32Round(butterfly5 + butterfly6)
    spectrum[7] = float32Round(butterfly2 - butterfly7)
  }

  {
    const scale = DFT_16_TWIDDLES[2]
    const lane8 = spectrum[8]
    const lane9 = spectrum[9]
    const lane10 = spectrum[10]
    const lane11 = spectrum[11]
    const lane12 = spectrum[12]
    const lane13 = spectrum[13]
    const lane14 = spectrum[14]
    const lane15 = spectrum[15]
    const butterfly0 = lane8 + lane10
    const butterfly1 = lane9 + lane11
    const butterfly2 = lane9 - lane11
    const butterfly3 = lane8 - lane10
    const butterfly4 = lane14 + lane12
    const butterfly5 = lane13 + lane15
    const butterfly6 = lane13 - lane15
    const butterfly7 = lane12 - lane14
    spectrum[8] = float32Round(butterfly0 + butterfly4)
    spectrum[9] = float32Round(butterfly1 + butterfly5)
    spectrum[12] = float32Round(butterfly5 - butterfly1)
    const quarter0 = butterfly2 + butterfly7
    const quarter1 = butterfly3 - butterfly6
    spectrum[13] = float32Round(butterfly0 - butterfly4)
    const quarter2 = butterfly7 - butterfly2
    const quarter3 = butterfly6 + butterfly3
    spectrum[10] = float32Round((quarter1 - quarter0) * scale)
    spectrum[11] = float32Round((quarter1 + quarter0) * scale)
    spectrum[14] = float32Round((quarter2 - quarter3) * scale)
    spectrum[15] = float32Round((quarter2 + quarter3) * scale)
  }

  for (let lane = 0; lane < 8; lane += 2) {
    const firstEven = spectrum[lane]
    const firstOdd = spectrum[lane + 1]
    const secondEven = spectrum[8 + lane]
    const secondOdd = spectrum[8 + lane + 1]
    spectrum[lane] = float32Round(firstEven + secondEven)
    spectrum[lane + 1] = float32Round(firstOdd + secondOdd)
    spectrum[8 + lane] = float32Round(firstEven - secondEven)
    spectrum[8 + lane + 1] = float32Round(firstOdd - secondOdd)
  }

  let lowTwiddle = 5
  let highTwiddle = 7
  for (let forward = 2; forward < 8; forward += 2) {
    const mirrored = 16 - forward
    const realDifference = spectrum[forward] - spectrum[mirrored]
    const imaginarySum = spectrum[forward + 1] + spectrum[mirrored + 1]
    const rotationReal = 0.5 - DFT_16_TWIDDLES[highTwiddle]
    const rotationImaginary = DFT_16_TWIDDLES[lowTwiddle]
    const rotatedReal =
      rotationReal * realDifference - rotationImaginary * imaginarySum
    const rotatedImaginary =
      rotationReal * imaginarySum + rotationImaginary * realDifference
    spectrum[forward] = float32Round(spectrum[forward] - rotatedReal)
    spectrum[forward + 1] = float32Round(
      spectrum[forward + 1] - rotatedImaginary
    )
    spectrum[mirrored] = float32Round(spectrum[mirrored] + rotatedReal)
    spectrum[mirrored + 1] = float32Round(
      spectrum[mirrored + 1] - rotatedImaginary
    )
    lowTwiddle++
    highTwiddle--
  }

  const originalImaginary = spectrum[1]
  spectrum[1] = float32Round(spectrum[0] - originalImaginary)
  spectrum[0] = float32Round(spectrum[0] + originalImaginary)
  return spectrum
}

/**
 * In-place 256-point real DFT used by tone analysis.
 *
 * @param {Float32Array} spectrum Mutable 256-float real spectrum.
 * @returns {Float32Array} The transformed spectrum.
 */
export function forwardRealDft256(spectrum) {
  if (!(spectrum instanceof Float32Array) || spectrum.length < 256) {
    throw new RangeError('ATRAC3plus 256-point DFT requires 256 floats')
  }
  const twiddles = DFT_256_TWIDDLES
  bitReverseComplexPairs(spectrum, 256)

  {
    const a0 = spectrum[0]
    const a1 = spectrum[1]
    const a2 = spectrum[2]
    const a3 = spectrum[3]
    const a4 = spectrum[4]
    const a5 = spectrum[5]
    const a6 = spectrum[6]
    const a7 = spectrum[7]
    const b0 = a0 + a2
    const b1 = a1 + a3
    const b2 = a1 - a3
    const b3 = a4 + a6
    const b4 = a5 + a7
    const b5 = a5 - a7
    const b6 = a0 - a2
    const b7 = a4 - a6
    spectrum[0] = float32Round(b0 + b3)
    spectrum[1] = float32Round(b1 + b4)
    spectrum[4] = float32Round(b0 - b3)
    spectrum[5] = float32Round(b1 - b4)
    spectrum[2] = float32Round(b6 - b5)
    spectrum[3] = float32Round(b2 + b7)
    spectrum[6] = float32Round(b5 + b6)
    spectrum[7] = float32Round(b2 - b7)
  }
  {
    const scale = twiddles[2]
    const a8 = spectrum[8]
    const a9 = spectrum[9]
    const a10 = spectrum[10]
    const a11 = spectrum[11]
    const a12 = spectrum[12]
    const a13 = spectrum[13]
    const a14 = spectrum[14]
    const a15 = spectrum[15]
    const b0 = a8 + a10
    const b1 = a9 + a11
    const b2 = a9 - a11
    const b3 = a8 - a10
    const b4 = a14 + a12
    const b5 = a13 + a15
    const b6 = a13 - a15
    const b7 = a12 - a14
    spectrum[8] = float32Round(b0 + b4)
    spectrum[9] = float32Round(b1 + b5)
    spectrum[12] = float32Round(b5 - b1)
    const q0 = b2 + b7
    const q1 = b3 - b6
    spectrum[13] = float32Round(b0 - b4)
    const q2 = b7 - b2
    const q3 = b6 + b3
    spectrum[10] = float32Round((q1 - q0) * scale)
    spectrum[11] = float32Round((q1 + q0) * scale)
    spectrum[14] = float32Round((q2 - q3) * scale)
    spectrum[15] = float32Round((q2 + q3) * scale)
  }

  let twiddleBlockOffset = 0
  for (let base = 16; base < 256; base += 16, twiddleBlockOffset += 2) {
    const twiddleIndex = twiddleBlockOffset + 2
    const firstImaginary = twiddles[twiddleBlockOffset + 3]
    const firstReal = twiddles[twiddleIndex]
    const secondImaginary = twiddles[twiddleIndex * 2 + 1]
    const secondReal = twiddles[twiddleIndex * 2]
    const thirdReal =
      secondReal - secondImaginary * (firstImaginary + firstImaginary)
    const thirdImaginary =
      (firstImaginary + firstImaginary) * secondReal - secondImaginary
    {
      const a0 = spectrum[base]
      const a1 = spectrum[base + 1]
      const a2 = spectrum[base + 2]
      const a3 = spectrum[base + 3]
      const a4 = spectrum[base + 4]
      const a5 = spectrum[base + 5]
      const a6 = spectrum[base + 6]
      const a7 = spectrum[base + 7]
      const odd0 = a1 + a3
      const odd1 = a1 - a3
      const odd2 = a5 + a7
      const odd3 = a5 - a7
      const even = a0 + a2 + a4 + a6
      const b14 = odd0 - odd2
      spectrum[base] = float32Round(even)
      spectrum[base + 1] = float32Round(odd0 + odd2)
      const b06 = a0 + a2 - (a4 + a6)
      const b11 = a0 - a2 + odd3
      const b13 = odd1 - (a4 - a6)
      const b15 = a0 - a2 - odd3
      const b12 = odd1 + (a4 - a6)
      spectrum[base + 4] = float32Round(firstReal * b06 - firstImaginary * b14)
      spectrum[base + 5] = float32Round(firstReal * b14 + firstImaginary * b06)
      spectrum[base + 2] = float32Round(
        secondReal * b15 - secondImaginary * b12
      )
      spectrum[base + 3] = float32Round(
        secondImaginary * b15 + secondReal * b12
      )
      spectrum[base + 6] = float32Round(thirdReal * b11 - thirdImaginary * b13)
      spectrum[base + 7] = float32Round(thirdReal * b13 + thirdImaginary * b11)
    }
    const mirroredSecondImaginary = twiddles[twiddleIndex * 2 + 3]
    const mirroredSecondReal = twiddles[twiddleIndex * 2 + 2]
    const mirroredThirdReal =
      mirroredSecondReal - mirroredSecondImaginary * (firstReal + firstReal)
    const mirroredThirdImaginary =
      (firstReal + firstReal) * mirroredSecondReal - mirroredSecondImaginary
    {
      const a8 = spectrum[base + 8]
      const a9 = spectrum[base + 9]
      const a10 = spectrum[base + 10]
      const a11 = spectrum[base + 11]
      const a12 = spectrum[base + 12]
      const a13 = spectrum[base + 13]
      const a14 = spectrum[base + 14]
      const a15 = spectrum[base + 15]
      const odd0 = a9 + a11
      const odd1 = a9 - a11
      const odd2 = a13 + a15
      const odd3 = a13 - a15
      const b15 = odd0 - odd2
      const even = a8 + a10 + a12 + a14
      const b16 = odd1 - (a12 - a14)
      spectrum[base + 8] = float32Round(even)
      spectrum[base + 9] = float32Round(odd0 + odd2)
      const b06 = a8 + a10 - (a12 + a14)
      const b11 = a8 - a10 - odd3
      const b12 = odd1 + (a12 - a14)
      const b14 = a8 - a10 + odd3
      spectrum[base + 12] = float32Round(
        -firstImaginary * b06 - firstReal * b15
      )
      spectrum[base + 13] = float32Round(
        -firstImaginary * b15 + firstReal * b06
      )
      spectrum[base + 10] = float32Round(
        mirroredSecondReal * b11 - mirroredSecondImaginary * b12
      )
      spectrum[base + 11] = float32Round(
        mirroredSecondImaginary * b11 + mirroredSecondReal * b12
      )
      spectrum[base + 14] = float32Round(
        mirroredThirdReal * b14 - mirroredThirdImaginary * b16
      )
      spectrum[base + 15] = float32Round(
        mirroredThirdReal * b16 + mirroredThirdImaginary * b14
      )
    }
  }

  let butterflySpan = 8
  for (;;) {
    const groupStride = butterflySpan
    const quarterSpan = groupStride * 4
    for (let lane = 0; lane < groupStride; lane += 2) {
      const g0r = spectrum[lane]
      const g0i = spectrum[lane + 1]
      const g1r = spectrum[groupStride + lane]
      const g1i = spectrum[groupStride + lane + 1]
      const g2r = spectrum[groupStride * 2 + lane]
      const g2i = spectrum[groupStride * 2 + lane + 1]
      const g3r = spectrum[groupStride * 3 + lane]
      const g3i = spectrum[groupStride * 3 + lane + 1]
      const p0r = g0r + g1r
      const p0i = g0i + g1i
      const p1r = g0r - g1r
      const p1i = g0i - g1i
      const p2r = g2r + g3r
      const p2i = g2i + g3i
      const p3i = g2i - g3i
      const p3r = g2r - g3r
      spectrum[lane] = float32Round(p0r + p2r)
      spectrum[lane + 1] = float32Round(p0i + p2i)
      spectrum[groupStride * 2 + lane] = float32Round(p0r - p2r)
      spectrum[groupStride * 2 + lane + 1] = float32Round(p0i - p2i)
      spectrum[groupStride + lane] = float32Round(p1r - p3i)
      spectrum[groupStride + lane + 1] = float32Round(p1i + p3r)
      spectrum[groupStride * 3 + lane] = float32Round(p3i + p1r)
      spectrum[groupStride * 3 + lane + 1] = float32Round(p1i - p3r)
    }
    {
      const scale = twiddles[2]
      const q0 = quarterSpan
      const q1 = q0 + groupStride
      const q2 = q1 + groupStride
      const q3 = q2 + groupStride
      for (let lane = 0; lane < groupStride; lane += 2) {
        const r0s = spectrum[q0 + lane] + spectrum[q1 + lane]
        const r0d = spectrum[q0 + lane] - spectrum[q1 + lane]
        const i0s = spectrum[q0 + lane + 1] + spectrum[q1 + lane + 1]
        const i0d = spectrum[q0 + lane + 1] - spectrum[q1 + lane + 1]
        const r1s = spectrum[q2 + lane] + spectrum[q3 + lane]
        const i1s = spectrum[q2 + lane + 1] + spectrum[q3 + lane + 1]
        const i1d = spectrum[q2 + lane + 1] - spectrum[q3 + lane + 1]
        const r1d = spectrum[q2 + lane] - spectrum[q3 + lane]
        spectrum[q0 + lane] = float32Round(r0s + r1s)
        spectrum[q0 + lane + 1] = float32Round(i0s + i1s)
        spectrum[q2 + lane] = float32Round(i1s - i0s)
        spectrum[q2 + lane + 1] = float32Round(r0s - r1s)
        const b0 = r0d - i1d
        const b1 = i0d + r1d
        const b2 = i1d + r0d
        const b3 = r1d - i0d
        spectrum[q1 + lane] = float32Round((b0 - b1) * scale)
        spectrum[q1 + lane + 1] = float32Round((b1 + b0) * scale)
        spectrum[q3 + lane] = float32Round((b3 - b2) * scale)
        spectrum[q3 + lane + 1] = float32Round((b2 + b3) * scale)
      }
    }

    const step = groupStride * 8
    let index = 2
    for (let base = step; base < 256; base += step, index += 2) {
      const firstReal = twiddles[index]
      const firstImaginary = twiddles[index + 1]
      const secondImaginary = twiddles[index * 2 + 1]
      const secondReal = twiddles[index * 2]
      const thirdReal =
        secondReal - (firstImaginary + firstImaginary) * secondImaginary
      const thirdImaginary =
        (firstImaginary + firstImaginary) * secondReal - secondImaginary
      const p0 = base
      const p1 = p0 + groupStride
      const p2 = p1 + groupStride
      const p3 = p2 + groupStride
      for (let lane = 0; lane < groupStride; lane += 2) {
        const r0s = spectrum[p0 + lane] + spectrum[p1 + lane]
        const r2 = spectrum[p2 + lane]
        const i0s = spectrum[p0 + lane + 1] + spectrum[p1 + lane + 1]
        const i0d = spectrum[p0 + lane + 1] - spectrum[p1 + lane + 1]
        const r1s = spectrum[p3 + lane] + r2
        const r0d = spectrum[p0 + lane] - spectrum[p1 + lane]
        const i1s = spectrum[p2 + lane + 1] + spectrum[p3 + lane + 1]
        const i1d = spectrum[p2 + lane + 1] - spectrum[p3 + lane + 1]
        const r3 = spectrum[p3 + lane]
        spectrum[p0 + lane] = float32Round(r0s + r1s)
        spectrum[p0 + lane + 1] = float32Round(i0s + i1s)
        const crossR = r0s - r1s
        const crossI = i0s - i1s
        const r1d = r2 - r3
        spectrum[p2 + lane] = float32Round(
          firstReal * crossR - firstImaginary * crossI
        )
        spectrum[p2 + lane + 1] = float32Round(
          firstReal * crossI + firstImaginary * crossR
        )
        const b9 = i0d + r1d
        const b12 = i0d - r1d
        const b8 = r0d - i1d
        const b13 = i1d + r0d
        spectrum[p1 + lane] = float32Round(
          secondReal * b8 - secondImaginary * b9
        )
        spectrum[p1 + lane + 1] = float32Round(
          secondReal * b9 + secondImaginary * b8
        )
        spectrum[p3 + lane] = float32Round(
          thirdReal * b13 - thirdImaginary * b12
        )
        spectrum[p3 + lane + 1] = float32Round(
          thirdImaginary * b13 + thirdReal * b12
        )
      }

      const mirroredSecondReal = twiddles[index * 2 + 2]
      const mirroredSecondImaginary = twiddles[index * 2 + 3]
      const mirroredThirdReal =
        mirroredSecondReal - (firstReal + firstReal) * mirroredSecondImaginary
      const mirroredThirdImaginary =
        (firstReal + firstReal) * mirroredSecondReal - mirroredSecondImaginary
      const m0 = p0 + quarterSpan
      const m1 = m0 + groupStride
      const m2 = m1 + groupStride
      const m3 = m2 + groupStride
      for (let lane = 0; lane < groupStride; lane += 2) {
        const r0s = spectrum[m0 + lane] + spectrum[m1 + lane]
        const r0d = spectrum[m0 + lane] - spectrum[m1 + lane]
        const i0s = spectrum[m0 + lane + 1] + spectrum[m1 + lane + 1]
        const i0d = spectrum[m0 + lane + 1] - spectrum[m1 + lane + 1]
        const r1s = spectrum[m3 + lane] + spectrum[m2 + lane]
        const i1s = spectrum[m2 + lane + 1] + spectrum[m3 + lane + 1]
        const i1d = spectrum[m2 + lane + 1] - spectrum[m3 + lane + 1]
        const r1d = spectrum[m2 + lane] - spectrum[m3 + lane]
        const crossR = r0s - r1s
        spectrum[m0 + lane] = float32Round(r0s + r1s)
        spectrum[m0 + lane + 1] = float32Round(i0s + i1s)
        const crossI = i0s - i1s
        spectrum[m2 + lane] = float32Round(
          -firstImaginary * crossR - firstReal * crossI
        )
        spectrum[m2 + lane + 1] = float32Round(
          -firstImaginary * crossI + firstReal * crossR
        )
        const b8 = i0d + r1d
        const b10 = r0d - i1d
        const b16 = i1d + r0d
        const b11 = i0d - r1d
        spectrum[m1 + lane] = float32Round(
          mirroredSecondReal * b10 - mirroredSecondImaginary * b8
        )
        spectrum[m1 + lane + 1] = float32Round(
          mirroredSecondReal * b8 + mirroredSecondImaginary * b10
        )
        spectrum[m3 + lane] = float32Round(
          mirroredThirdReal * b16 - mirroredThirdImaginary * b11
        )
        spectrum[m3 + lane + 1] = float32Round(
          mirroredThirdReal * b11 + mirroredThirdImaginary * b16
        )
      }
    }
    butterflySpan = quarterSpan
    if (groupStride << 4 >= 256) break
  }

  if (butterflySpan * 4 === 256) {
    const i1 = butterflySpan
    const i2 = butterflySpan * 2
    const i3 = butterflySpan * 3
    for (let lane = 0; lane < butterflySpan; lane += 2) {
      const q0e = spectrum[lane]
      const q0o = spectrum[lane + 1]
      const q1e = spectrum[i1 + lane]
      const q1o = spectrum[i1 + lane + 1]
      const q2e = spectrum[i2 + lane]
      const q2o = spectrum[i2 + lane + 1]
      const q3e = spectrum[i3 + lane]
      const q3o = spectrum[i3 + lane + 1]
      spectrum[lane] = float32Round(
        float32Round(float32Round(q0e + q1e) + q2e) + q3e
      )
      spectrum[lane + 1] = float32Round(
        float32Round(float32Round(q0o + q1o) + q2o) + q3o
      )
      spectrum[i1 + lane] = float32Round(
        float32Round(float32Round(q0e - q1e) - q2o) + q3o
      )
      spectrum[i1 + lane + 1] = float32Round(
        float32Round(float32Round(q0o - q1o) + q2e) - q3e
      )
      spectrum[i2 + lane] = float32Round(
        float32Round(float32Round(q0e + q1e) - q2e) - q3e
      )
      spectrum[i2 + lane + 1] = float32Round(
        float32Round(float32Round(q0o + q1o) - q2o) - q3o
      )
      spectrum[i3 + lane] = float32Round(
        float32Round(float32Round(q0e - q1e) + q2o) - q3o
      )
      spectrum[i3 + lane + 1] = float32Round(
        float32Round(float32Round(q0o - q1o) - q2e) + q3e
      )
    }
  } else {
    const i1 = butterflySpan
    for (let lane = 0; lane < butterflySpan; lane += 2) {
      const q0e = spectrum[lane]
      const q0o = spectrum[lane + 1]
      const q1e = spectrum[i1 + lane]
      const q1o = spectrum[i1 + lane + 1]
      spectrum[lane] = float32Round(q0e + q1e)
      spectrum[lane + 1] = float32Round(q0o + q1o)
      spectrum[i1 + lane] = float32Round(q0e - q1e)
      spectrum[i1 + lane + 1] = float32Round(q0o - q1o)
    }
  }

  let low = 65
  let high = 127
  for (let forward = 2; forward < 128; forward += 2, low++, high--) {
    const mirrored = 256 - forward
    const realDifference = spectrum[forward] - spectrum[mirrored]
    const imaginarySum = spectrum[forward + 1] + spectrum[mirrored + 1]
    const rotationReal = 0.5 - twiddles[high]
    const rotationImaginary = twiddles[low]
    const rotatedReal =
      rotationReal * realDifference - rotationImaginary * imaginarySum
    const rotatedImaginary =
      rotationReal * imaginarySum + rotationImaginary * realDifference
    spectrum[forward] = float32Round(spectrum[forward] - rotatedReal)
    spectrum[forward + 1] = float32Round(
      spectrum[forward + 1] - rotatedImaginary
    )
    spectrum[mirrored] = float32Round(spectrum[mirrored] + rotatedReal)
    spectrum[mirrored + 1] = float32Round(
      spectrum[mirrored + 1] - rotatedImaginary
    )
  }
  const originalImaginary = spectrum[1]
  spectrum[1] = float32Round(spectrum[0] - originalImaginary)
  spectrum[0] = float32Round(spectrum[0] + originalImaginary)
  return spectrum
}

/**
 * Write bins 0..128 of one zero-padded real power spectrum.
 *
 * @param {Float32Array} source Real source samples.
 * @param {number} sampleCount Valid source prefix length.
 * @param {Float32Array} destination Caller-owned power spectrum.
 * @param {Float32Array} scratch Reusable DFT work.
 * @returns {Float32Array} The destination spectrum.
 */
export function powerSpectrum256(source, sampleCount, destination, scratch) {
  if (
    !(source instanceof Float32Array) ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > 256 ||
    source.length < sampleCount ||
    !(destination instanceof Float32Array) ||
    destination.length < 129 ||
    !(scratch instanceof Float32Array) ||
    scratch.length < 256
  ) {
    throw new RangeError('ATRAC3plus tone power-spectrum geometry is invalid')
  }
  scratch.fill(0)
  scratch.set(source.subarray(0, sampleCount), 0)
  forwardRealDft256(scratch)
  const nyquist = scratch[1]
  scratch[1] = 0
  for (let bin = 0; bin < 128; bin++) {
    const real = scratch[bin * 2]
    const imaginary = scratch[bin * 2 + 1]
    destination[bin] = float32Round(
      float32Round(real * real) + float32Round(imaginary * imaginary)
    )
  }
  destination[128] = float32Round(nyquist * nyquist)
  return destination
}

/**
 * Write magnitudes for bins 0..7 of the fixed gain-analysis DFT.
 *
 * @param {Float32Array} source Sixteen real samples.
 * @param {Float32Array} destination Caller-owned magnitude output.
 * @param {Float32Array} scratch Reusable DFT work; may alias source.
 * @returns {Float32Array} The destination magnitudes.
 */
export function magnitudeSpectrum16LowBins(source, destination, scratch) {
  if (
    !(source instanceof Float32Array) ||
    source.length < 16 ||
    !(destination instanceof Float32Array) ||
    destination.length < 8 ||
    !(scratch instanceof Float32Array) ||
    scratch.length < 16
  ) {
    throw new RangeError(
      'ATRAC3plus magnitude DFT buffers have invalid geometry'
    )
  }
  if (source !== scratch) {
    for (let index = 0; index < 16; index++) scratch[index] = source[index]
  }
  forwardRealDft16(scratch)
  scratch[1] = 0
  for (let bin = 0; bin < 8; bin++) {
    const real = scratch[bin * 2]
    const imaginary = scratch[bin * 2 + 1]
    const sum = real * real + imaginary * imaginary
    const root = Math.sqrt(sum)
    destination[bin] = Number.isNaN(root) ? Math.sqrt(Math.fround(sum)) : root
  }
  return destination
}
