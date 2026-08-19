import { describe, expect, it } from 'vitest'

import {
  configureGainDetectionRequest,
  detectGainRecordsRaw,
  planGainRecords,
} from '../codec/analysis/gain-detection.js'
import { BufferPool } from '../codec/core/buffers.js'
import { EncodeChannelState } from '../codec/state/encoder.js'

const HASH_OFFSET = 1469598103934665603n
const HASH_PRIME = 1099511628211n
const HASH_MASK = 0xffffffffffffffffn
const POINT_FIELDS = [
  'index',
  'delta',
  'nextActiveOffset',
  'nextByIndexOffset',
  'previousByIndexOffset',
  'disabled',
  'step',
  'hasLink',
  'linkGroupDelta',
  'linkIndex',
  'spanCost',
  'pointCount',
]

const bitsView = new DataView(new ArrayBuffer(4))
function floatBits(value) {
  bitsView.setFloat32(0, value, true)
  return bitsView.getUint32(0, true)
}

function mix(hash, value) {
  return ((hash ^ BigInt(value >>> 0)) * HASH_PRIME) & HASH_MASK
}

function fillAnalysis(states, frame) {
  for (let channel = 0; channel < states.length; channel++) {
    const state = states[channel]
    for (let band = 0; band < 16; band++) {
      for (let slot = 0; slot < 9; slot++) {
        for (let sample = 0; sample < 128; sample++) {
          const raw =
            ((frame * 211 +
              channel * 79 +
              band * 43 +
              slot * 17 +
              sample * 29) %
              257) -
            128
          const exponent =
            ((Math.trunc(sample / 16) + slot * 2 + band + frame * 3 + channel) %
              9) -
            4
          let value = Math.fround((raw / 16) * 2 ** exponent)
          if ((sample + slot + frame + band + channel) % 17 === 0) {
            value = 0
          }
          state.bandSlots[band][slot][sample] = value
        }
      }
    }
  }
}

function hashPlan(plan) {
  let hash = HASH_OFFSET
  for (let channel = 0; channel < plan.channelCount; channel++) {
    for (const record of plan.records[channel]) {
      hash = mix(hash, record.entries)
      for (const location of record.locations) hash = mix(hash, location)
      for (const level of record.levels) hash = mix(hash, level)
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function hashState(channels, bandCount) {
  let hash = HASH_OFFSET
  for (const channel of channels) {
    for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
      const band = channel.detection.bands[bandIndex]
      for (const value of band.absoluteLevelHistory) {
        hash = mix(hash, floatBits(value))
      }
      for (const value of band.scaleHistory) {
        hash = mix(hash, floatBits(value))
      }
      for (const value of [
        band.previousAbsoluteLevel,
        band.previousPeak,
        band.currentPeak,
      ]) {
        hash = mix(hash, floatBits(value))
      }
      hash = mix(hash, band.previousPeakIndex)
      hash = mix(hash, band.currentPeakIndex)
      for (const value of band.pointCounts) hash = mix(hash, value)
      for (const value of band.disabledCounts) hash = mix(hash, value)
      hash = mix(hash, band.duplicateCount)
      for (let entry = 0; entry < 128; entry++) {
        for (const field of POINT_FIELDS) {
          hash = mix(hash, band.points[field][entry])
        }
      }
    }
    for (const value of channel.detection.energySum) {
      hash = mix(hash, floatBits(value))
    }
    for (const value of channel.detection.energyRatio) {
      hash = mix(hash, floatBits(value))
    }
  }
  return hash.toString(16).padStart(16, '0')
}

describe('ATRAC3plus full-rate raw gain detector', () => {
  it('matches reference across four persisted stereo frames', () => {
    const channels = [new EncodeChannelState(0), new EncodeChannelState(1)]
    const analysis = channels.map((channel) => channel.analysis)
    const scratch = new BufferPool().encoder.scratch.gain.detection
    const request = configureGainDetectionRequest({}, 6, 10, 0x17, 3, 2)
    const expected = [
      ['4ecd8062ba2f5a03', 'c50e00ab8fb4ba6d'],
      ['4ecd8062ba2f5a03', '72fd0bcbddacf91e'],
      ['4ecd8062ba2f5a03', '265d93927096a95b'],
      ['9b54b532a259ceae', 'e5b34e894387f41c'],
    ]

    for (let frame = 0; frame < expected.length; frame++) {
      fillAnalysis(analysis, frame)
      const plan = detectGainRecordsRaw(channels, analysis, request, scratch)
      expect([hashPlan(plan), hashState(channels, request.bandCount)]).toEqual(
        expected[frame]
      )
    }
  })

  it('shares measurement and envelope storage with the ATRAC3plus pool owner', () => {
    const pool = new BufferPool()
    const detection = pool.encoder.scratch.gain.detection
    expect(detection.measurement).toBeInstanceOf(Object)
    expect(detection.envelope).toBeInstanceOf(Object)
  })

  it('composes full- and low-rate publication without implicit commit', () => {
    const channel = new EncodeChannelState(0)
    const channels = [channel]
    const analysis = [channel.analysis]
    const gainScratch = new BufferPool().encoder.scratch.gain
    const detectionScratch = gainScratch.detection
    const adjustmentScratch = gainScratch.configureAdjustment(1)
    channel.currentGainRecords[0].entries = 1
    channel.currentGainRecords[0].locations[0] = 31
    channel.currentGainRecords[0].levels[0] = 8

    fillAnalysis(analysis, 0)
    const fullRateRequest = configureGainDetectionRequest({}, 6, 4, 0x17, 1, 1)
    const fullRate = planGainRecords(
      channels,
      analysis,
      fullRateRequest,
      detectionScratch,
      adjustmentScratch
    )
    expect(fullRate).toBe(detectionScratch.plan)
    expect(channel.currentGainRecords[0].locations[0]).toBe(31)

    fillAnalysis(analysis, 1)
    const lowRateRequest = configureGainDetectionRequest({}, 6, 4, 0x0f, 1, 1)
    const lowRate = planGainRecords(
      channels,
      analysis,
      lowRateRequest,
      detectionScratch,
      adjustmentScratch
    )
    expect(lowRate).toBe(adjustmentScratch.publication)
    expect(lowRate).not.toBe(detectionScratch.plan)
    expect(channel.currentGainRecords[0].locations[0]).toBe(31)

    lowRate.commitTo(channels)
    expect(channel.currentGainRecords[0].locations[0]).not.toBe(31)
  })
})
