import { describe, expect, it } from 'vitest'

import { analyzeTones } from '../codec/analysis/tone-analysis.js'
import { BufferPool } from '../codec/core/buffers.js'

import { TONE_SYNTHESIS_SINE } from '../codec/core/tables.js'

const bits = new DataView(new ArrayBuffer(4))
const MASK = 0xffffffffffffffffn

function mix(hash, value) {
  return ((hash ^ BigInt(value >>> 0)) * 0x100000001b3n) & MASK
}

function mixFloat(hash, value) {
  bits.setFloat32(0, value, true)
  return mix(hash, bits.getUint32(0, true))
}

describe('ATRAC3plus detached tone analysis composition', () => {
  it('matches reference joint extraction, history windows, and residuals', () => {
    const pool = new BufferPool()
    const blocks = pool.encoder.frame.channelBlocks
    const analysis = pool.encoder.frame.analysisChannels
    for (let channel = 0; channel < 2; channel++) {
      for (const slot of blocks[channel].toneSlots) slot.active = true
    }

    for (let band = 0; band < 16; band++) {
      for (let position = 0; position < 320; position++) {
        const slot = 4 + Math.trunc(position / 128)
        const sample = position % 128
        let base
        if (band === 0) {
          base = Math.fround(
            2 * TONE_SYNTHESIS_SINE[(position * 137 + 91) & 0x7ff]
          )
        } else if (band === 1) {
          base = Math.fround(
            10 * TONE_SYNTHESIS_SINE[(position * 311 + 417) & 0x7ff]
          )
        } else {
          base = Math.fround(
            0.25 *
              TONE_SYNTHESIS_SINE[(position * (17 + band) + band * 29) & 0x7ff]
          )
        }
        const noise = Math.fround(
          (((position * 37 + band * 11) % 23) - 11) * 0.00390625
        )
        const value = Math.fround(base + noise)
        analysis[0].bandSlots[band][slot][sample] = value
        analysis[1].bandSlots[band][slot][sample] =
          band === 1 ? Math.fround(-value) : value
      }
    }
    for (let channel = 0; channel < 2; channel++) {
      const previous = blocks[channel].toneSlots[3]
      previous.shared[1] = 1
      previous.shared[0xd8] = channel
      const record = previous.records[0]
      record.hasLeftFade = 1
      record.hasRightFade = 1
      record.leftIndex = 24
      record.rightIndex = 220
      record.gateStartValid = 1
      record.gateStartIndex = 9
      record.gateEndValid = 1
      record.gateEndIndex = 27
      record.entryCount = 1
      record.scaleFactorIndices[0] = 12
      record.phaseBases[0] = 7
      record.steps[0] = 137
      blocks[channel].toneSlots[4].records[2].leftIndex = 77
      blocks[channel].toneSlots[4].records[2].rightIndex = 199
    }

    analyzeTones(blocks, analysis, [0, 1], 3, 1, 256, pool.encoder.scratch.tone)

    let hash = 0xcbf29ce484222325n
    for (let channel = 0; channel < 2; channel++) {
      const slot = blocks[channel].toneSlots[4]
      for (const word of slot.shared) hash = mix(hash, word)
      for (const record of slot.records) {
        for (const value of [
          record.hasLeftFade,
          record.hasRightFade,
          record.leftIndex,
          record.rightIndex,
          record.gateStartValid,
          record.gateEndValid,
          record.gateStartIndex,
          record.gateEndIndex,
          record.entryCount,
        ]) {
          hash = mix(hash, value)
        }
        for (let entry = 0; entry < record.entryCount; entry++) {
          hash = mix(hash, record.scaleFactorIndices[entry])
          hash = mix(hash, record.amplitudeIndices[entry])
          hash = mix(hash, record.phaseBases[entry])
          hash = mix(hash, record.steps[entry])
        }
      }
      for (let band = 0; band < 16; band++) {
        for (const sample of analysis[channel].bandSlots[band][4]) {
          hash = mixFloat(hash, sample)
        }
      }
    }

    const left = blocks[0].toneSlots[4]
    expect({
      hash: hash.toString(16).padStart(16, '0'),
      header: [...left.shared.slice(0, 3)],
      band0: {
        fades: [
          left.records[0].hasLeftFade,
          left.records[0].hasRightFade,
          left.records[0].leftIndex,
          left.records[0].rightIndex,
        ],
        gate: [
          left.records[0].gateStartValid,
          left.records[0].gateEndValid,
          left.records[0].gateStartIndex,
          left.records[0].gateEndIndex,
        ],
        entries: [
          left.records[0].entryCount,
          left.records[0].scaleFactorIndices[0],
          left.records[0].phaseBases[0],
          left.records[0].steps[0],
        ],
      },
      band1: {
        fades: [
          left.records[1].hasLeftFade,
          left.records[1].hasRightFade,
          left.records[1].leftIndex,
          left.records[1].rightIndex,
        ],
        entries: [
          left.records[1].entryCount,
          ...left.records[1].scaleFactorIndices.slice(0, 2),
          ...left.records[1].phaseBases.slice(0, 2),
          ...left.records[1].steps.slice(0, 2),
        ],
      },
    }).toEqual({
      hash: '06df4a0df041470f',
      header: [1, 1, 2],
      band0: {
        fades: [1, 1, 36, 112],
        gate: [0, 0, -1, 32],
        entries: [1, 3, 19, 136],
      },
      band1: {
        fades: [0, 0, 0, 256],
        entries: [2, 16, 3, 21, 15, 311, 311],
      },
    })
    expect(blocks[1].toneSlots[4].records[0]).not.toBe(
      blocks[0].toneSlots[4].records[0]
    )
  })

  it('shares detector and synthesis owners with the composed scratch', () => {
    const tone = new BufferPool().encoder.scratch.tone
    expect(tone.detection.dftWork).toBeInstanceOf(Float32Array)
    expect(tone.synthesis.output).toBeInstanceOf(Float32Array)
  })
})
