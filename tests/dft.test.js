import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { powerSpectrum256, forwardRealDft256 } from '../codec/transforms/dft.js'

const bits = new DataView(new ArrayBuffer(4))
const MASK = 0xffffffffffffffffn

function hash(values) {
  let result = 0xcbf29ce484222325n
  for (const value of values) {
    bits.setFloat32(0, value, true)
    result =
      ((result ^ BigInt(bits.getUint32(0, true))) * 0x100000001b3n) & MASK
  }
  return result.toString(16).padStart(16, '0')
}

function sourceFixture() {
  return Float32Array.from({ length: 256 }, (_, index) => {
    const raw = ((index * 37 + 11) % 257) - 128
    const exponent = (Math.trunc(index / 13) % 9) - 4
    return (raw / 16) * 2 ** exponent
  })
}

describe('ATRAC3plus 256-point tone DFT', () => {
  it('matches the complete reference transform and power-spectrum oracles', () => {
    const source = sourceFixture()
    const transformed = source.slice()
    forwardRealDft256(transformed)
    expect(hash(transformed)).toBe('7c4c31550301c523')
    expect([0, 1, 2, 127, 255].map((index) => transformed[index])).toEqual([
      -393.74609375, 25.44921875, 82.45024108886719, 228.43833923339844,
      -54.797119140625,
    ])

    const scratch = new BufferPool().encoder.scratch.tone.detection.dftWork
    const full = new Float32Array(129)
    const partial = new Float32Array(129)
    powerSpectrum256(source, 256, full, scratch)
    powerSpectrum256(source, 173, partial, scratch)
    expect(hash(full)).toBe('7c1b06aff9f5a23f')
    expect(hash(partial)).toBe('e6de47415e480d68')
  })

  it('uses fixed pool work and validates before mutation', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.tone.detection.dftWork
    expect(scratch).toHaveLength(256)
    const destination = new Float32Array(129).fill(7)
    expect(() =>
      powerSpectrum256(new Float32Array(128), 129, destination, scratch)
    ).toThrow(RangeError)
    expect(destination.every((value) => value === 7)).toBe(true)
  })
})
