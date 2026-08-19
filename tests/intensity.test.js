import { describe, expect, it } from 'vitest'

import { applyIntensityStereo } from '../codec/analysis/intensity.js'
import { BufferPool } from '../codec/core/buffers.js'
import { resolveProfile } from '../codec/core/profiles.js'
import {
  analysisGeometryStage,
  historyStage,
  intensityStage,
  qmfStage,
  transactionStage,
  validateFrameStage,
} from '../codec/pipeline/encoder.js'
import {
  EncodeAnalysisState,
  IntensityStereoState,
  initializeEncoderStream,
} from '../codec/state/encoder.js'
import { IntensityScratch } from '../codec/state/analysis.js'

const bits = new DataView(new ArrayBuffer(4))
const MASK = 0xffffffffffffffffn

function mix(hash, value) {
  bits.setFloat32(0, value, true)
  return ((hash ^ BigInt(bits.getUint32(0, true))) * 0x100000001b3n) & MASK
}

function fillFixture(left, right, frame) {
  for (let band = 0; band < 16; band++) {
    for (const slot of [6, 7, 8]) {
      for (let sample = 0; sample < 128; sample++) {
        const leftRaw =
          ((frame * 71 + band * 37 + slot * 19 + sample * 13) % 257) - 128
        const rightRaw =
          ((frame * 53 + band * 29 + slot * 23 + sample * 17 + 7) % 263) - 131
        const leftExponent =
          ((band + slot + Math.trunc(sample / 16) + frame) % 7) - 3
        const rightExponent =
          ((band * 2 + slot + Math.trunc(sample / 8) + frame) % 7) - 3
        left.bandSlots[band][slot][sample] = (leftRaw / 16) * 2 ** leftExponent
        right.bandSlots[band][slot][sample] =
          (rightRaw / 16) * 2 ** rightExponent
      }
    }
  }
}

function hashFixture(state, left, right) {
  let hash = 0xcbf29ce484222325n
  for (const value of state.correlationDecibels) hash = mix(hash, value)
  for (const value of state.mixHistory) hash = mix(hash, value)
  for (const value of state.previousScales) hash = mix(hash, value)
  for (const value of state.currentScales) hash = mix(hash, value)
  for (const analysis of [left, right]) {
    for (let band = 0; band < 16; band++) {
      for (const slot of [6, 7, 8]) {
        for (const value of analysis.bandSlots[band][slot]) {
          hash = mix(hash, value)
        }
      }
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function pcm(channel) {
  return Float32Array.from(
    { length: 2048 },
    (_, sample) =>
      (((sample * (channel ? 29 : 37) + channel * 11) % 257) - 128) / 32
  )
}

describe('ATRAC3plus intensity stereo', () => {
  it('matches the complete two-frame reference state and QMF-row oracle', () => {
    const state = new IntensityStereoState()
    const left = new EncodeAnalysisState()
    const right = new EncodeAnalysisState()
    const scratch = new BufferPool().encoder.scratch.intensity
    const expected = [
      [9, '4f1b15c2363dd478'],
      [6, '07c94b8591edf6ec'],
    ]
    for (let frame = 0; frame < 2; frame++) {
      fillFixture(left, right, frame)
      applyIntensityStereo(
        state,
        frame === 0 ? 0x17 : 0x13,
        frame === 1,
        left,
        right,
        scratch
      )
      expect([
        state.intensityBandLimit,
        hashFixture(state, left, right),
      ]).toEqual(expected[frame])
    }
  })

  it('occupies a detached stereo stage between QMF and gain', () => {
    const bufferPool = new BufferPool()
    expect(bufferPool.encoder.scratch.intensity).toBeInstanceOf(
      IntensityScratch
    )
    const profile = resolveProfile({
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
    })
    initializeEncoderStream(profile, bufferPool.encoder)
    const context = { profile, bufferPool }
    let frame = validateFrameStage(context)([pcm(0), pcm(1)])
    frame = transactionStage(context)(frame)
    frame = analysisGeometryStage(context)(frame)
    frame = historyStage()(frame)
    frame = qmfStage(context)(frame)
    frame = intensityStage(context)(frame)

    const stagedPrimary = frame.channelBlocks[0]
    expect(stagedPrimary.intensityHistory.intensityBandLimit).toBe(
      frame.intensityCodingUnits[0].intensityBandLimit
    )
    expect(
      stagedPrimary.intensityHistory.correlationMetrics.some(
        (value) => value !== 0
      )
    ).toBe(true)
    expect(
      bufferPool.encoder.state.channelBlocks[0].intensityHistory
        .correlationMetrics
    ).toEqual(new Float32Array(80))
    expect(bufferPool.encoder.scratch.intensity.combinedSamples).toHaveLength(
      256
    )
  })
})
