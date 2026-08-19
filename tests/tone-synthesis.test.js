import { describe, expect, it } from 'vitest'

import { DecodeChannelState } from '../codec/state/decoder.js'

import { SharedState } from '../codec/state/shared.js'
import { BufferPool } from '../codec/core/buffers.js'
import {
  addDecodedTones,
  synthesizeTonePair,
  writeToneResidual,
} from '../codec/transforms/tone.js'
import { addSubbandNoise } from '../codec/transforms/subband-noise.js'
import {
  TONE_ACCUMULATE_FUSED,
  TONE_ACCUMULATE_SEPARATE,
  TONE_CROSSFADE_DECODER_RECONSTRUCTION,
  TONE_CROSSFADE_ENCODER_RESIDUAL,
  TONE_HEADER_ENABLE_WORD,
  TONE_HEADER_FREQUENCY_ARRAY_WORD,
  TONE_HEADER_MODE_WORD,
} from '../codec/core/constants.js'
import {
  TONE_SYNTHESIS_CROSSFADE,
  TONE_SYNTHESIS_SINE,
} from '../codec/core/tables.js'
import { ToneSynthesisRecord } from '../codec/state/tone.js'

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

function setEntries(record, entries) {
  record.entryCount = entries.length
  for (let index = 0; index < entries.length; index++) {
    const [scale, amplitude, phase, step] = entries[index]
    record.scaleFactorIndices[index] = scale
    record.amplitudeIndices[index] = amplitude
    record.phaseBases[index] = phase
    record.steps[index] = step
  }
}

function records() {
  const previous = new ToneSynthesisRecord()
  previous.hasLeftFade = 1
  previous.leftIndex = 20
  previous.rightIndex = 220
  setEntries(previous, [
    [9, 3, 5, 31],
    [22, 12, 17, 513],
    [41, 7, 29, 1023],
  ])
  const current = new ToneSynthesisRecord()
  current.hasRightFade = 1
  current.leftIndex = 40
  current.rightIndex = 180
  setEntries(current, [
    [4, 15, 1, 77],
    [35, 0, 31, 777],
  ])
  return { previous, current }
}

describe('ATRAC3plus shared tone synthesis', () => {
  it('matches reference tables, encoder residual, and decoder traversal', () => {
    const { previous, current } = records()
    const pool = new BufferPool()
    const scratch = pool.encoder.scratch.tone.synthesis
    const fused = synthesizeTonePair(
      previous,
      current,
      0,
      0,
      1,
      1,
      1,
      TONE_CROSSFADE_ENCODER_RESIDUAL,
      TONE_ACCUMULATE_FUSED,
      scratch
    ).slice()
    const separate = synthesizeTonePair(
      previous,
      current,
      0,
      0,
      1,
      1,
      1,
      TONE_CROSSFADE_DECODER_RECONSTRUCTION,
      TONE_ACCUMULATE_SEPARATE,
      scratch
    ).slice()
    const source = Float32Array.from(
      { length: 128 },
      (_, index) => (((index * 19 + 3) % 127) - 63) / 8
    )
    const residual = new Float32Array(128)
    writeToneResidual(source, fused, residual)

    expect([
      hash(TONE_SYNTHESIS_SINE),
      hash(TONE_SYNTHESIS_CROSSFADE),
      hash(fused),
      hash(separate),
      hash(scratch.previous),
      hash(scratch.current),
      hash(residual),
    ]).toEqual([
      '210a00f30460ffb7',
      'ceea09a9166288d5',
      '3a55e70b4c91e332',
      '64c9d29d49e4c392',
      'fd569f894457ef1d',
      '1af5194c9babfce1',
      'bf378a17b3433bad',
    ])
  })

  it('rejects invalid packed entries before overwriting output', () => {
    const record = new ToneSynthesisRecord()
    setEntries(record, [[64, 0, 0, 0]])
    const pool = new BufferPool()
    const output = new Float32Array(128).fill(7)
    expect(() =>
      synthesizeTonePair(
        record,
        null,
        0,
        0,
        0,
        0,
        0,
        TONE_CROSSFADE_ENCODER_RESIDUAL,
        TONE_ACCUMULATE_FUSED,
        pool.encoder.scratch.tone.synthesis,
        output
      )
    ).toThrow(RangeError)
    expect(output.every((value) => value === 7)).toBe(true)
  })

  it('derives decoder fade bounds and adds tones in the subband domain', () => {
    const pool = new BufferPool()
    const channel = new DecodeChannelState()
    const previousSlot = channel.toneSlots[0]
    const currentSlot = channel.toneSlots[1]
    previousSlot.shared[TONE_HEADER_ENABLE_WORD] = 1
    previousSlot.shared[TONE_HEADER_MODE_WORD] = 0
    currentSlot.shared[TONE_HEADER_ENABLE_WORD] = 1
    currentSlot.shared[TONE_HEADER_MODE_WORD] = 1
    currentSlot.shared[TONE_HEADER_FREQUENCY_ARRAY_WORD] = 1
    const previous = previousSlot.records[0]
    previous.gateStartValid = 1
    previous.gateStartIndex = 3
    previous.gateEndValid = 1
    previous.gateEndIndex = 20
    setEntries(previous, [[9, 3, 5, 31]])
    const current = currentSlot.records[0]
    setEntries(current, [[4, 15, 1, 77]])
    const subbands = new Float32Array(2048).fill(1)

    expect(
      addDecodedTones(
        channel,
        channel,
        subbands,
        1,
        pool.decoder.scratch.toneSynthesis
      )
    ).toBe(subbands)
    expect(current).toMatchObject({
      hasLeftFade: 1,
      leftIndex: 12,
      hasRightFade: 1,
      rightIndex: 84,
    })
    expect(hash(subbands.slice(0, 128))).toBe('0a82d3f7fadb2d5c')
    expect(subbands.slice(128).every((value) => value === 1)).toBe(true)
  })

  it('adds decoded broadband noise and advances only staged syntax', () => {
    const shared = new SharedState()
    shared.noisePresent = 1
    shared.noiseLevelIndex = 3
    shared.noiseTableIndex = 4
    const subbands = new Float32Array(2048)
    expect(addSubbandNoise(shared, subbands)).toBe(subbands)
    expect(shared.noiseTableIndex).toBe(20)
    expect(hash(subbands)).toBe('5bb2bf2c54e34f25')
  })
})
