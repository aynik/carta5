import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const packFrameControl = vi.hoisted(() => ({ intercept: null }))

vi.mock('../codec/io/frame.js', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    packFrame(...args) {
      return packFrameControl.intercept
        ? packFrameControl.intercept(original.packFrame, args)
        : original.packFrame(...args)
    },
  }
})

import { BufferPool } from '../codec/core/buffers.js'
import { flushTailFramesForSampleCount } from '../codec/core/timing.js'
import { BitCounter } from '../codec/io/bitstream.js'
import { packCodingUnit } from '../codec/io/coding-unit.js'
import { FramePackError } from '../codec/io/frame.js'
import { createFrameEncoder } from '../codec/pipeline/encoder.js'
import { createPcmFrameDecoder, decode } from '../codec/pipeline/decoder.js'
import { createStreamingEncoder } from '../codec/io/stream-encoder.js'
import { SpectrumSyntaxScratch } from '../codec/state/spectrum.js'

function referencePcm(frameIndex = 0) {
  return Float32Array.from(
    { length: 2048 },
    (_, sample) => (((sample * 37 + frameIndex * 19 + 11) % 257) - 128) / 32
  )
}

function frameHash(frames) {
  const hash = createHash('sha256')
  for (const frame of frames) hash.update(frame)
  return hash.digest('hex')
}

afterEach(() => {
  packFrameControl.intercept = null
})

describe('ATRAC3plus detached streaming frame encoder', () => {
  it('matches the reference flush-tail timing boundaries', () => {
    expect(flushTailFramesForSampleCount(-1)).toBeNull()
    expect(flushTailFramesForSampleCount(0)).toBeNull()
    expect(flushTailFramesForSampleCount(1)).toBe(8)
    expect(flushTailFramesForSampleCount(1680)).toBe(8)
    expect(flushTailFramesForSampleCount(1681)).toBe(9)
    expect(flushTailFramesForSampleCount(2048)).toBe(9)
    expect(() => flushTailFramesForSampleCount(2049)).toThrow(RangeError)
    expect(() => flushTailFramesForSampleCount(1.5)).toThrow(RangeError)
  })

  it('commits seven delayed frames before publishing a bounded frame', () => {
    const pool = new BufferPool()
    const encodeFrame = createFrameEncoder(
      { bitrateKbps: 128, channels: 1, sampleRate: 44100 },
      pool
    )
    const committedSamples = pool.encoder.state.analysisChannels[0].samples
    const stagedSamples = pool.encoder.frame.analysisChannels[0].samples

    expect(() => encodeFrame([referencePcm(), referencePcm()])).toThrow(
      'PCM frame geometry is invalid'
    )
    expect(pool.encoder.state.analysisToStreamDelay.remainingFrames).toBe(7)
    expect(committedSamples.every((value) => value === 0)).toBe(true)

    for (let frame = 0; frame < 7; frame++) {
      expect(encodeFrame([referencePcm(frame)])).toBeNull()
      expect(pool.encoder.state.analysisToStreamDelay.remainingFrames).toBe(
        6 - frame
      )
    }
    expect(committedSamples.some((value) => value !== 0)).toBe(true)
    expect(committedSamples).not.toBe(stagedSamples)

    const output = encodeFrame([referencePcm(7)])
    expect(output).toBeInstanceOf(Uint8Array)
    expect(output).toHaveLength(744)
    expect(output.buffer).not.toBe(pool.encoder.scratch.packedFrame.buffer)
    expect(output[0] & 0x80).toBe(0)
    expect(pool.encoder.state.analysisToStreamDelay.remainingFrames).toBe(0)

    pool.decoder.state.channelBlocks[0].syntax.wordLengths[0] = 7
    pool.decoder.state.synthesisCodingUnits[0][0].inverseTransformOverlap[0] = 19
    pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex = 7
    const decodePcm = createPcmFrameDecoder(
      { bitrateKbps: 128, channels: 1, sampleRate: 44100 },
      pool
    )
    const parsed = decodePcm(output)
    expect(parsed.parsedBits).toBeGreaterThan(3)
    expect(parsed.parsedBits).toBeLessThanOrEqual(output.length * 8)
    expect(pool.decoder.state.channelBlocks[0].syntax.wordLengths[0]).toBe(7)
    expect(parsed.channelBlocks[0]).toBe(pool.decoder.frame.channelBlocks[0])
    expect(parsed.spectra).toBe(pool.decoder.frame.spectra)
    expect(parsed.spectra[0].some((value) => value !== 0)).toBe(true)
    expect(parsed.spectra[0].every(Number.isFinite)).toBe(true)
    expect(parsed.subbandSamples).toBe(pool.decoder.frame.subbandSamples)
    expect(parsed.subbandSamples[0].some((value) => value !== 0)).toBe(true)
    expect(parsed.subbandSamples[0].every(Number.isFinite)).toBe(true)
    expect(
      pool.decoder.state.synthesisCodingUnits[0][0].inverseTransformOverlap[0]
    ).toBe(19)
    expect(
      pool.decoder.frame.synthesisCodingUnits[0][0].inverseTransformOverlap
    ).not.toBe(
      pool.decoder.state.synthesisCodingUnits[0][0].inverseTransformOverlap
    )
    expect(parsed.outputChannels).toBe(pool.decoder.frame.outputChannels)
    expect(parsed.outputChannels[0].some((value) => value !== 0)).toBe(true)
    expect(parsed.outputChannels[0].every(Number.isFinite)).toBe(true)
    expect(pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex).toBe(7)
    expect(pool.decoder.frame.synthesisCodingUnits[0][0].delayRingIndex).toBe(
      23
    )

    const decodeCommitted = decode(
      { bitrateKbps: 128, channels: 1, sampleRate: 44100 },
      pool
    )
    const pcm = decodeCommitted(output)
    expect(pcm).toHaveLength(1)
    expect(pcm[0]).toBeInstanceOf(Float32Array)
    expect(pcm[0]).toHaveLength(2048)
    expect(pcm[0].buffer).not.toBe(pool.decoder.frame.outputChannels[0].buffer)
    expect(pcm[0].every(Number.isFinite)).toBe(true)
    expect(pool.decoder.state.channelBlocks[0].syntax.wordLengths[0]).not.toBe(
      7
    )
    expect(pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex).toBe(
      23
    )
    const secondPcm = decodeCommitted(output)
    expect(secondPcm[0].buffer).not.toBe(pcm[0].buffer)
    expect(pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex).toBe(
      15
    )
    const malformed = output.slice()
    malformed[0] |= 0x80
    expect(() => decodeCommitted(malformed)).toThrow('frame header is invalid')
    expect(pool.decoder.state.synthesisCodingUnits[0][0].delayRingIndex).toBe(
      15
    )
  })

  it('is invariant to arbitrary chunk boundaries and drains exactly once', () => {
    const source = Float32Array.from(
      { length: 3000 },
      (_, sample) => (((sample * 31 + 17) % 251) - 125) / 16
    )
    const options = { bitrateKbps: 128, channels: 1, sampleRate: 44100 }
    const contiguous = createStreamingEncoder(options)
    const contiguousFrames = contiguous.write([source])
    contiguousFrames.push(...contiguous.finish())

    const partitioned = createStreamingEncoder(options)
    const partitionedFrames = []
    for (const [start, end] of [
      [0, 13],
      [13, 1011],
      [1011, 2049],
      [2049, 2999],
      [2999, 3000],
    ]) {
      partitionedFrames.push(...partitioned.write([source.slice(start, end)]))
    }
    partitionedFrames.push(...partitioned.finish())

    expect(contiguous.sampleCount).toBe(3000)
    expect(partitioned.sampleCount).toBe(3000)
    expect(contiguousFrames).toHaveLength(3)
    expect(partitionedFrames).toHaveLength(3)
    expect(frameHash(partitionedFrames)).toBe(frameHash(contiguousFrames))
    expect(partitioned.finish()).toEqual([])
    expect(() => partitioned.write([new Float32Array(0)])).toThrow(
      'no longer accepting input'
    )
  })

  it('lazily emits frames without collecting a complete input chunk', () => {
    const encoder = createStreamingEncoder({
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    let encodeCalls = 0
    encoder.encodeFrame = () => {
      encodeCalls++
      return new Uint8Array(744)
    }
    const frames = encoder.frames([new Float32Array(2048 * 3)])

    expect(encodeCalls).toBe(0)
    expect(encoder.sampleCount).toBe(0)
    expect(frames.next().done).toBe(false)
    expect(encodeCalls).toBe(1)
    expect(encoder.sampleCount).toBe(2048)
    expect([...frames]).toHaveLength(2)
    expect(encodeCalls).toBe(3)
    expect(encoder.sampleCount).toBe(2048 * 3)
  })

  it('retries packing on the 32-bit grid without repeating analysis', () => {
    const options = { bitrateKbps: 128, channels: 1, sampleRate: 44100 }
    const retryPool = new BufferPool()
    let packCalls = 0
    packFrameControl.intercept = (packFrame, args) => {
      packCalls++
      if (packCalls === 1) {
        throw new FramePackError('coding-unit overflow', 0)
      }
      packFrameControl.intercept = null
      return packFrame(...args)
    }
    const retryEncoder = createFrameEncoder(options, retryPool)
    const controlPool = new BufferPool()
    const controlEncoder = createFrameEncoder(options, controlPool)
    let retriedOutput = null
    let controlOutput = null
    for (let frame = 0; frame < 8; frame++) {
      const input = [referencePcm(frame)]
      retriedOutput = retryEncoder(input)
      controlOutput = controlEncoder(input)
    }

    expect(retriedOutput).toHaveLength(744)
    expect(controlOutput).toHaveLength(744)
    expect(packCalls).toBe(2)
    expect(retryPool.encoder.state.lastAllocationAttempts).toBe(2)
    expect(retryPool.encoder.frame.allocationCheckpoint.channelCount).toBe(1)
    expect(retryPool.encoder.frame.allocationCheckpoint.codingUnitCount).toBe(1)
    expect(retryPool.encoder.state.analysisChannels[0].samples).toStrictEqual(
      controlPool.encoder.state.analysisChannels[0].samples
    )
    expect(
      retryPool.encoder.state.channelBlocks[0].detection.energySum
    ).toStrictEqual(
      controlPool.encoder.state.channelBlocks[0].detection.energySum
    )
  })

  it('keeps finalized silent-unit accounting equal to serialized size', () => {
    const options = { bitrateKbps: 320, channels: 6, sampleRate: 48000 }
    const pool = new BufferPool()
    const syntaxScratch = new SpectrumSyntaxScratch()
    let checkedUnits = 0
    const encode = createFrameEncoder(options, pool)
    const silence = Array.from({ length: 6 }, () => new Float32Array(2048))
    let output = null
    for (let frame = 0; frame < 8; frame++) output = encode(silence)

    const { topology } = pool.encoder.state
    const transactions = pool.encoder.frame.allocationTransactions
    const sharedCodingUnits = pool.encoder.frame.sharedCodingUnits
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const transaction = transactions[unit]
      const shared = sharedCodingUnits[transaction.channelBlocks[0].sharedIndex]
      const counter = new BitCounter()
      expect(packCodingUnit(transaction, shared, syntaxScratch, counter)).toBe(
        transaction.bitsTotal
      )
      checkedUnits++
    }

    expect(output).toHaveLength(1712)
    expect(checkedUnits).toBe(4)
  })
})
