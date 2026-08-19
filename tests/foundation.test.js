import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as carta5 from '../codec/index.js'
import {
  ANALYSIS_TAIL_SAMPLES,
  DELAY_SAMPLES,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  SUBBAND_BLOCKS,
  SUBBAND_SAMPLES,
} from '../codec/core/constants.js'
import {
  channelMask,
  codecInfoBytes,
  coreModeFromScaled,
  channelsForStreamMode,
  configureCodingUnitProfiles,
  packCodecConfiguration,
  resolveProfile,
  resolveWaveProfile,
} from '../codec/core/profiles.js'
import { CodingUnitProfiles } from '../codec/state/shared.js'
import {
  codedSubbandCount,
  mapCount,
  quantizationUnitCountForCoefficientLimit,
  quantizationUnitPrefixLength,
  quantizationUnitRange,
  shapeCount,
} from '../codec/core/geometry.js'
import {
  BAND_INDEX_BY_QUANTIZATION_UNIT,
  PROFILE_ROWS,
  QUANTIZATION_UNIT_OFFSETS,
  SHAPE_INDEX_BY_QUANTIZATION_UNIT,
} from '../codec/core/tables.js'
import { CORE_MODE_MIN_INCLUSIVE_THRESHOLD } from '../codec/core/constants.js'
import { CORE_MODE_EXCLUSIVE_THRESHOLDS } from '../codec/core/tables.js'

describe('ATRAC3plus foundation geometry', () => {
  it('pins frame, QMF, analysis, and stream geometry', () => {
    expect(FRAME_SAMPLES).toBe(2048)
    expect(SUBBAND_SAMPLES * SUBBAND_BLOCKS).toBe(FRAME_SAMPLES)
    expect(MAX_CHANNELS).toBe(8)
    expect(ANALYSIS_TAIL_SAMPLES).toBe(384)
    expect(DELAY_SAMPLES).toBe(184)
    expect(QUANTIZATION_UNIT_COUNT).toBe(32)
    expect([...QUANTIZATION_UNIT_OFFSETS].at(-1)).toBe(FRAME_SAMPLES)
    expect(BAND_INDEX_BY_QUANTIZATION_UNIT).toHaveLength(33)
    expect(SHAPE_INDEX_BY_QUANTIZATION_UNIT).toHaveLength(32)
  })

  it('pins the complete canonical profile registry and topology counts', () => {
    expect(PROFILE_ROWS).toHaveLength(41)
    expect(PROFILE_ROWS.filter((row) => row.sampleRate === 44100)).toHaveLength(
      22
    )
    expect(PROFILE_ROWS.filter((row) => row.sampleRate === 48000)).toHaveLength(
      19
    )
    expect(new Set(PROFILE_ROWS.map((row) => row.streamChannelMode))).toEqual(
      new Set([1, 2, 5, 7])
    )
  })

  it('shares one end-exclusive quantization geometry contract', () => {
    expect(quantizationUnitRange(0)).toEqual({ start: 0, end: 16 })
    expect(quantizationUnitRange(31)).toEqual({ start: 1920, end: 2048 })
    expect(quantizationUnitRange(32)).toBeNull()
    expect(quantizationUnitPrefixLength(0)).toBe(0)
    expect(quantizationUnitPrefixLength(24)).toBe(1024)
    expect(quantizationUnitPrefixLength(32)).toBe(2048)
    expect(quantizationUnitCountForCoefficientLimit(1)).toBe(1)
    expect(quantizationUnitCountForCoefficientLimit(1024)).toBe(24)
    expect(quantizationUnitCountForCoefficientLimit(2048)).toBe(32)
    expect(mapCount(32)).toBe(16)
    expect(shapeCount(0)).toBe(0)
    expect(shapeCount(32)).toBe(10)
    expect(codedSubbandCount(32)).toBe(16)
  })
})

describe('ATRAC3plus profile resolution', () => {
  it('publishes only the Carta5 ATRAC3plus package boundary', () => {
    expect(Object.keys(carta5).sort()).toEqual([
      'AudioProcessor',
      'BufferPool',
      'WaveStreamingDecoder',
      'WaveStreamingEncoder',
      'createWave',
      'createWaveStreamingDecoder',
      'createWaveStreamingEncoder',
      'decode',
      'decodeWavePcm',
      'encode',
      'encodeWavePcm',
      'parseWave',
      'resolveProfile',
      'resolveWaveProfile',
    ])
    expect(
      carta5.resolveProfile({
        bitrateKbps: 128,
        channels: 2,
        sampleRate: 44100,
      })
    ).toMatchObject({ frameSamples: 2048, bytesPerFrame: 744 })
    const pool = new carta5.BufferPool()
    expect(Object.keys(pool.encoder)).toEqual(['state', 'frame', 'scratch'])
    expect(Object.keys(pool.decoder)).toEqual(['state', 'frame', 'scratch'])
  })

  it('materializes canonical stereo profile and packed codec metadata', () => {
    const profile = resolveProfile()
    expect(profile).toMatchObject({
      bitrateKbps: 128,
      bytesPerFrame: 744,
      sampleRate: 44100,
      channels: 2,
      frameSamples: 2048,
      streamChannelMode: 2,
      bandwidthHz: 15159,
      primaryCodingUnitChannelMode: 3,
      channelMask: 0x3,
      codecConfiguration: 0x0100285c,
    })
    expect([...profile.codecInfoBytes]).toEqual([0x28, 0x5c])
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it('round-trips every registry row through encode and WAVE selectors', () => {
    for (const row of PROFILE_ROWS) {
      const channels = channelsForStreamMode(row.streamChannelMode)
      const encode = resolveProfile({
        bitrateKbps: row.bitrateKbps,
        channels,
        sampleRate: row.sampleRate,
      })
      const wave = resolveWaveProfile({
        channels,
        sampleRate: row.sampleRate,
        blockAlign: row.bytesPerFrame,
        samplesPerBlock: FRAME_SAMPLES,
      })
      expect(encode).not.toBeNull()
      expect(wave).toEqual(encode)
    }
  })

  it('executes every canonical profile through the encoder', () => {
    for (const row of PROFILE_ROWS) {
      const channels = channelsForStreamMode(row.streamChannelMode)
      const options = {
        bitrateKbps: row.bitrateKbps,
        channels,
        sampleRate: row.sampleRate,
      }
      const encode = carta5.encode(options, new carta5.BufferPool())
      const pcm = Array.from(
        { length: channels },
        () => new Float32Array(FRAME_SAMPLES)
      )
      let frame = null
      for (let delayed = 0; delayed < 8; delayed++) frame = encode(pcm)
      expect(frame).toBeInstanceOf(Uint8Array)
      expect(frame).toHaveLength(row.bytesPerFrame)

      const decoded = carta5.decode(options, new carta5.BufferPool())(frame)
      expect(decoded).toHaveLength(channels)
      for (const channel of decoded) {
        expect(channel).toHaveLength(FRAME_SAMPLES)
        expect(channel.every(Number.isFinite)).toBe(true)
      }
    }
  }, 15000)

  it('pins non-silent encoded bytes for every canonical profile', () => {
    const hash = createHash('sha256')
    for (
      let profileIndex = 0;
      profileIndex < PROFILE_ROWS.length;
      profileIndex++
    ) {
      const row = PROFILE_ROWS[profileIndex]
      const channels = channelsForStreamMode(row.streamChannelMode)
      const options = {
        bitrateKbps: row.bitrateKbps,
        channels,
        sampleRate: row.sampleRate,
      }
      const encode = carta5.encode(options, new carta5.BufferPool())
      const pcm = Array.from({ length: channels }, (_, channel) =>
        Float32Array.from({ length: FRAME_SAMPLES }, (_, sample) =>
          Math.fround(
            (((sample * 37 + channel * 101 + profileIndex * 53) % 2048) -
              1024) *
              24
          )
        )
      )
      let frame = null
      for (let delayed = 0; delayed < 8; delayed++) frame = encode(pcm)
      hash.update(frame)
    }
    expect(hash.digest('hex')).toBe(
      '2ac5ef4f71636c32b8d3b69c9417e52e134870b890c66b47a8100cd5a0b8c084'
    )
  }, 15000)

  it('rejects unsupported or misaligned geometry', () => {
    expect(
      resolveProfile({
        bitrateKbps: 132,
        channels: 2,
        sampleRate: 44100,
      })
    ).toBeNull()
    expect(
      resolveWaveProfile({
        channels: 2,
        sampleRate: 44100,
        blockAlign: 744,
        samplesPerBlock: 1024,
      })
    ).toBeNull()
    expect(
      packCodecConfiguration({
        streamChannelMode: 2,
        sampleRate: 44100,
        bytesPerFrame: 745,
      })
    ).toBeNull()
  })

  it('pins topology selectors, masks, and codec-info byte order', () => {
    expect([1, 2, 5, 7].map(channelsForStreamMode)).toEqual([1, 2, 6, 8])
    expect([1, 2, 6, 8].map(channelMask)).toEqual([4, 3, 0x3f, 0x63f])
    expect(channelMask(4)).toBe(0)
    expect([...codecInfoBytes(0x0100285c)]).toEqual([0x28, 0x5c])
  })

  it('matches reference coding-unit policy for representative profiles', () => {
    const expected = new Map([
      [9, [[3, 27, 23, 1, 5947]]],
      [
        16,
        [
          [3, 27, 19, 0, 4702],
          [1, 27, 15, 0, 2351],
          [3, 27, 19, 0, 4702],
          [4, 1, 0, 0, 136],
        ],
      ],
      [
        20,
        [
          [3, 27, 20, 0, 5058],
          [1, 27, 15, 0, 2529],
          [3, 27, 20, 0, 5058],
          [3, 27, 20, 0, 5058],
          [4, 1, 0, 0, 136],
        ],
      ],
      [
        35,
        [
          [3, 26, 19, 0, 4318],
          [1, 26, 15, 0, 2159],
          [3, 26, 19, 0, 4318],
          [4, 1, 0, 0, 136],
        ],
      ],
      [
        39,
        [
          [3, 26, 20, 0, 4638],
          [1, 26, 15, 0, 2319],
          [3, 26, 20, 0, 4638],
          [3, 26, 20, 0, 4638],
          [4, 1, 0, 0, 136],
        ],
      ],
    ])
    for (const [index, rows] of expected) {
      const row = PROFILE_ROWS[index]
      const profile = resolveProfile({
        bitrateKbps: row.bitrateKbps,
        channels: channelsForStreamMode(row.streamChannelMode),
        sampleRate: row.sampleRate,
      })
      const profiles = new CodingUnitProfiles()
      configureCodingUnitProfiles(profile, profiles)
      expect(
        Array.from({ length: profiles.length }, (_, unit) => [
          profiles.channelModes[unit],
          profiles.quantizationUnitCounts[unit],
          profiles.coreModes[unit],
          profiles.toneAnalysisEnabled[unit],
          profiles.budgetBits[unit],
        ])
      ).toEqual(rows)
    }
  })

  it('pins weighted budget formulas and every core-mode threshold boundary', () => {
    const profiles = new CodingUnitProfiles()
    const base = {
      streamChannelMode: 1,
      sampleRate: 44100,
      bytesPerFrame: 100,
      bandwidthHz: 0,
      primaryCodingUnitChannelMode: 2,
    }
    const budgets = (streamChannelMode) => {
      configureCodingUnitProfiles({ ...base, streamChannelMode }, profiles)
      return Array.from({ length: profiles.length }, (_, unit) => [
        profiles.channelModes[unit],
        profiles.budgetBits[unit],
      ])
    }
    expect(budgets(1)).toEqual([[2, 795]])
    expect(budgets(2)).toEqual([[2, 795]])
    expect(budgets(3)).toEqual([
      [2, 528],
      [1, 264],
    ])
    expect(budgets(4)).toEqual([
      [2, 394],
      [1, 197],
      [1, 197],
    ])
    expect(budgets(5)).toEqual([
      [2, 260],
      [1, 130],
      [2, 260],
      [4, 136],
    ])
    expect(budgets(7)).toEqual([
      [2, 186],
      [1, 93],
      [2, 186],
      [2, 186],
      [4, 136],
    ])

    for (
      let index = 0;
      index < CORE_MODE_EXCLUSIVE_THRESHOLDS.length;
      index++
    ) {
      const [threshold, mode] = CORE_MODE_EXCLUSIVE_THRESHOLDS[index]
      expect(coreModeFromScaled(threshold + 1)).toBe(mode)
      expect(coreModeFromScaled(threshold)).toBe(
        CORE_MODE_EXCLUSIVE_THRESHOLDS[index + 1]?.[1] ?? 1
      )
    }
    expect(coreModeFromScaled(CORE_MODE_MIN_INCLUSIVE_THRESHOLD - 1)).toBe(0)
    expect(coreModeFromScaled(CORE_MODE_MIN_INCLUSIVE_THRESHOLD)).toBe(1)
  })
})
