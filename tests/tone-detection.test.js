import { describe, expect, it } from 'vitest'

import {
  applyToneBand0UpperMask,
  extractToneCandidates,
  orderToneBands,
  planToneExtractionBudget,
  planToneGate,
  planToneWindow,
  selectToneBandCount,
  selectToneMaskedPeakBin,
  writeToneJointRatioMask,
  writeToneWindowedSpectrum,
} from '../codec/analysis/tone-detection.js'
import { BufferPool } from '../codec/core/buffers.js'

import { TONE_SYNTHESIS_SINE } from '../codec/core/tables.js'
import { ToneSynthesisRecord } from '../codec/state/tone.js'

const bits = new DataView(new ArrayBuffer(4))
const MASK = 0xffffffffffffffffn

function mix(hash, value) {
  return ((hash ^ BigInt(value >>> 0)) * 0x100000001b3n) & MASK
}

function mixFloat(hash, value) {
  bits.setFloat32(0, value, true)
  return mix(hash, bits.getUint32(0, true))
}

describe('ATRAC3plus tone selection and gate policy', () => {
  it('matches complete reference budget, window, mask, and spectrum policy', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.tone.detection
    const bandPower = [new Float32Array(16), new Float32Array(16)]
    const sums = new Float32Array(16)
    for (let band = 0; band < 16; band++) {
      bandPower[0][band] = (band + 1) * (band + 1) * 1.25
      bandPower[1][band] = (16 - band) * 0.75
      sums[band] = bandPower[0][band] + bandPower[1][band]
    }
    sums[0] = 1
    sums[1] = 32
    const count = selectToneBandCount(true, sums, 16)
    const order = orderToneBands(sums, count, scratch.bandOrder)
    const joint = Int32Array.from({ length: 16 }, (_, band) => band % 2)
    const budget = planToneExtractionBudget(
      count,
      joint,
      order,
      bandPower,
      scratch
    )

    const samples = Float32Array.from(
      { length: 320 },
      (_, index) => (((index * 17) % 31) - 15) / 16
    )
    for (let index = 180; index < 196; index++) samples[index] *= 32
    for (let index = 240; index < 256; index++) samples[index] *= 0.125
    const gate = planToneGate(samples, scratch)
    const history = new ToneSynthesisRecord()
    history.gateStartValid = 1
    history.gateStartIndex = 11
    history.gateEndValid = 1
    history.gateEndIndex = 27
    const window = planToneWindow(gate, history, scratch.window)

    const first = new Float32Array(132)
    const second = new Float32Array(132)
    writeToneWindowedSpectrum(samples, 37, 211, first, scratch)
    const reversed = samples.slice().reverse()
    writeToneWindowedSpectrum(reversed, 37, 211, second, scratch)
    const mask = new Float32Array(132)
    writeToneJointRatioMask(first, second, mask)
    applyToneBand0UpperMask(0, first, mask)
    const masked = first.slice()
    const peak = selectToneMaskedPeakBin(masked, mask)

    let hash = 0xcbf29ce484222325n
    hash = mix(hash, count)
    for (const value of order) hash = mix(hash, value)
    for (const row of budget) for (const value of row) hash = mix(hash, value)
    for (const value of [
      gate.startValid,
      gate.endValid,
      gate.startIndex,
      gate.endIndex,
      window.hasLeftFade,
      window.hasRightFade,
      window.leftIndex,
      window.rightIndex,
    ]) {
      hash = mix(hash, value)
    }
    for (const values of [first, second, mask, masked]) {
      for (const value of values) hash = mixFloat(hash, value)
    }
    hash = mix(hash, peak)

    expect({
      count,
      order: [...order.slice(0, 2)],
      budget: budget.map((row) => [...row.slice(0, 2)]),
      gate: [gate.startValid, gate.endValid, gate.startIndex, gate.endIndex],
      window: [
        window.hasLeftFade,
        window.hasRightFade,
        window.leftIndex,
        window.rightIndex,
      ],
      peak,
      hash: hash.toString(16).padStart(16, '0'),
    }).toEqual({
      count: 2,
      order: [1, 0],
      budget: [
        [13, 11],
        [13, 0],
      ],
      gate: [1, 1, 14, 18],
      window: [1, 1, 184, 204],
      peak: 116,
      hash: 'fa49846e86425b06',
    })
  })

  it('owns the detector DFT row inside the composed tone scratch', () => {
    const pool = new BufferPool()
    const dftWork = pool.encoder.scratch.tone.detection.dftWork
    expect(dftWork).toBeInstanceOf(Float32Array)
    expect(dftWork).toHaveLength(256)
  })

  it('matches reference greedy sinusoid fitting in both frequency modes', () => {
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.tone.detection
    const source = new Float32Array(256)
    for (let index = 0; index < source.length; index++) {
      const first = Math.fround(
        8 * TONE_SYNTHESIS_SINE[(index * 137 + 91) & 0x7ff]
      )
      const second = Math.fround(
        3 * TONE_SYNTHESIS_SINE[(index * 311 + 417) & 0x7ff]
      )
      const noise = Math.fround((((index * 37) % 23) - 11) * 0.015625)
      source[index] = Math.fround(Math.fround(first + second) + noise)
    }
    const weights = Float32Array.from(
      { length: 129 },
      (_, index) => 0.75 + (index % 7) * 0.125
    )
    const window = scratch.window.set(1, 1, 36, 228)

    const results = []
    for (const emitted of [false, true]) {
      const plan = extractToneCandidates(
        source,
        window,
        17,
        weights,
        8,
        emitted,
        scratch
      )
      let hash = 0xcbf29ce484222325n
      hash = mix(hash, plan.entryCount)
      for (let index = 0; index < 16; index++) {
        hash = mix(hash, plan.scaleFactorIndices[index])
        hash = mix(hash, plan.amplitudeIndices[index])
        hash = mix(hash, plan.phaseBases[index])
        hash = mix(hash, plan.steps[index])
      }
      const record = new ToneSynthesisRecord()
      plan.commitTo(record)
      results.push({
        emitted,
        count: plan.entryCount,
        hash: hash.toString(16).padStart(16, '0'),
        scaleFactors: [
          ...record.scaleFactorIndices.slice(0, record.entryCount),
        ],
        phases: [...record.phaseBases.slice(0, record.entryCount)],
        steps: [...record.steps.slice(0, record.entryCount)],
      })
    }

    expect(results).toEqual([
      {
        emitted: false,
        count: 3,
        hash: '1e006da6dbbfecf4',
        scaleFactors: [14, 0, 8],
        phases: [19, 30, 20],
        steps: [137, 137, 311],
      },
      {
        emitted: true,
        count: 3,
        hash: '62baff9b197bdb6d',
        scaleFactors: [14, 0, 8],
        phases: [19, 30, 21],
        steps: [137, 137, 311],
      },
    ])
    expect(
      extractToneCandidates(source, window, -1, weights, 8, false, scratch)
        .entryCount
    ).toBe(0)
  })
})
