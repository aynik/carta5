import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { resolveProfile } from '../codec/core/profiles.js'
import {
  analysisToStreamDelayStage,
  allocationPreflightStage,
  allocationStage,
  commitStage,
  analysisGeometryStage,
  gainStage,
  historyStage,
  intensityStage,
  mdctStage,
  packingStage,
  qmfStage,
  toneStage,
  transactionStage,
  validateFrameStage,
} from '../codec/pipeline/encoder.js'
import { initializeEncoderStream } from '../codec/state/encoder.js'
import { packCodingUnit } from '../codec/io/coding-unit.js'
import { BitCounter } from '../codec/io/bitstream.js'

function referencePcm() {
  return Float32Array.from(
    { length: 2048 },
    (_, sample) => (((sample * 37 + 11) % 257) - 128) / 32
  )
}

function seedDelayedAnalysis(state) {
  for (let band = 0; band < 16; band++) {
    for (let slot = 1; slot < 8; slot++) {
      const samples = state.bandSlots[band][slot]
      for (let sample = 0; sample < samples.length; sample++) {
        samples[sample] = ((((band + 3) * sample + slot * 19) % 193) - 96) / 16
      }
    }
  }
}

describe('ATRAC3plus detached analysis stage chain', () => {
  it('places intensity and tone before gain and dual-spectrum MDCT', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    initializeEncoderStream(profile, bufferPool.encoder)
    bufferPool.encoder.state.analysisToStreamDelay.reset(0)
    const context = { profile, bufferPool }
    const committed = bufferPool.encoder.state.channelBlocks[0]
    seedDelayedAnalysis(committed.analysis)
    committed.currentGainRecords[0].entries = 1
    committed.currentGainRecords[0].locations[0] = 20
    committed.currentGainRecords[0].levels[0] = 8

    const pcmView = bufferPool.encoder.frame.pcmChannelViews[1]
    const qmfView = bufferPool.encoder.frame.qmfBandViews[1]
    const scaledView = bufferPool.encoder.frame.gainScaledSpectrumViews[1]
    const unscaledView = bufferPool.encoder.frame.gainUnscaledSpectrumViews[1]
    const request = bufferPool.encoder.scratch.gain.detection.request

    let frame = validateFrameStage(context)([referencePcm()])
    frame = transactionStage(context)(frame)
    frame = analysisGeometryStage(context)(frame)
    frame = historyStage()(frame)
    frame = qmfStage(context)(frame)
    frame = intensityStage(context)(frame)
    frame = toneStage(context)(frame)
    frame = gainStage(context)(frame)
    frame = mdctStage(context)(frame)
    frame = allocationStage(context)(frame)
    frame = analysisToStreamDelayStage(context)(frame)
    frame = allocationPreflightStage(context)(frame)
    frame = packingStage(context)(frame)

    expect(frame.channels).toBe(pcmView)
    expect(frame.qmfBands).toBe(qmfView)
    expect(frame.gainScaledSpectra).toBe(scaledView)
    expect(frame.gainUnscaledSpectra).toBe(unscaledView)
    expect(bufferPool.encoder.scratch.gain.detection.request).toBe(request)
    expect(frame.sharedCodingUnits[0].scaleFactorCount).toBe(32)
    expect(frame.sharedCodingUnits[0].quantizationUnitCount).toBe(32)
    expect([...frame.channelBlocks[0].toneSlots[4].shared.slice(0, 3)]).toEqual(
      [0, 1, 1]
    )
    expect(frame.channelBlocks[0].previousGainRecords[0].locations[0]).toBe(20)
    expect(frame.gainScaledSpectra[0].some((value) => value !== 0)).toBe(true)
    expect(frame.gainScaledSpectra[0]).not.toEqual(frame.gainUnscaledSpectra[0])
    expect(frame.allocationTransactions).toBe(
      bufferPool.encoder.frame.allocationTransactionViews[1]
    )
    const allocation = frame.allocationTransactions[0]
    const shared = frame.sharedCodingUnits[0]
    const counter = new BitCounter()
    expect(
      packCodingUnit(
        allocation,
        shared,
        bufferPool.encoder.scratch.spectrumSyntax,
        counter
      )
    ).toBe(allocation.bitsTotal)
    expect(counter.bitPosition).toBe(allocation.bitsTotal)
    expect(frame.output.buffer).toBe(
      bufferPool.encoder.scratch.packedFrame.buffer
    )
    expect(frame.output.byteOffset).toBe(
      bufferPool.encoder.scratch.packedFrame.byteOffset
    )
    expect(frame.output).toHaveLength(profile.bytesPerFrame)
    expect(frame.packedPayloadBits).toBe(allocation.bitsTotal + 5)
    expect(allocation.channelCount).toBe(1)
    expect(allocation.bandCount).toBe(32)
    expect(allocation.allocationBandOrder.count).toBe(32)
    expect(allocation.gainScaledSpectra[0]).toBe(frame.gainScaledSpectra[0])
    expect(allocation.initialWordLengths.some(Boolean)).toBe(true)
    expect(frame.channelBlocks[0].syntax.scaleFactors.some(Boolean)).toBe(true)
    expect(frame.channelBlocks[0].syntax.wordLengths.some(Boolean)).toBe(true)
    expect(allocation.spectrumBits[0][0]).toBeGreaterThan(0)
    expect(allocation.allocationBudgetBits).toBe(5947)
    expect(allocation.bitsTotal).toBe(5946)
    expect(frame.packedPayloadBits).toBe(5951)
    expect(allocation.quantizationDirty).toBe(false)
    expect(
      frame.channelBlocks[0].quantizedSpectrum.some((value) => value !== 0)
    ).toBe(true)
    expect(allocation).toMatchObject({
      fixedBits: 30,
      wordLengthBits: 91,
      scaleFactorBits: 148,
      codeTableBits: 93,
    })
    expect(allocation.wordLengthTransaction).toBe(
      bufferPool.encoder.frame.wordLengthTransactions[0]
    )
    expect(allocation.scaleFactorPlan).toBe(
      bufferPool.encoder.frame.scaleFactorPlan
    )
    expect(allocation.toneSwapGate).toBe(
      bufferPool.encoder.scratch.toneSwapGates[0]
    )
    expect(allocation.spectrumBits[0][0]).toBe(5323)
    expect(allocation.spectrumBits[0][1]).toBe(5584)
    expect(allocation.channelBlocks[0].syntax.codeTableContext).toBe(1)
    expect(allocation.wordLengthTransaction.rawOnly).toBe(false)
    expect(frame.sharedCodingUnits[0].gainModeFlag).toBe(1)

    // No analysis stage has authority to publish persistent state.
    expect(committed.currentGainRecords[0].locations[0]).toBe(20)
    expect(committed.analysis.bandSlots[0][0][0]).not.toBe(
      frame.analysisStates[0].bandSlots[0][0][0]
    )
    expect(bufferPool.encoder.state.sharedCodingUnits[0].scaleFactorCount).toBe(
      0
    )
    expect(
      bufferPool.encoder.state.channelBlocks[0].syntax.scaleFactors.every(
        (value) => value === 0
      )
    ).toBe(true)
    expect([
      ...bufferPool.encoder.state.channelBlocks[0].toneSlots[4].shared.slice(
        0,
        3
      ),
    ]).toEqual([0, 0, 0])
  })

  it('rejects an uninitialized topology before rotating or analyzing state', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    const context = { profile, bufferPool }
    const frame = transactionStage(context)(
      validateFrameStage(context)([referencePcm()])
    )
    expect(() => analysisGeometryStage(context)(frame)).toThrow(RangeError)
    expect(
      bufferPool.encoder.frame.analysisChannels[0].samples.every(Boolean)
    ).toBe(false)
  })

  it('consumes analysis delay and publishes staged history without output', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 128,
      channels: 1,
      sampleRate: 44100,
    })
    initializeEncoderStream(profile, bufferPool.encoder)
    const context = { profile, bufferPool }
    let frame = transactionStage(context)(
      validateFrameStage(context)([referencePcm()])
    )
    frame.sharedCodingUnits[0].scaleFactorCount = 9

    frame = analysisToStreamDelayStage(context)(frame)
    expect(frame.analysisDelayed).toBe(true)
    expect(bufferPool.encoder.state.analysisToStreamDelay.remainingFrames).toBe(
      6
    )
    frame = packingStage(context)(frame)
    expect(frame.output).toBeNull()
    expect(frame.packedPayloadBits).toBe(0)
    frame = commitStage(context)(frame)
    expect(frame.committed).toBe(true)
    expect(bufferPool.encoder.state.sharedCodingUnits[0].scaleFactorCount).toBe(
      9
    )

    expect(() =>
      commitStage(context)({ analysisDelayed: false, output: null })
    ).toThrow('cannot commit before successful packing')
  })

  it('preflights the finalized aggregate budget before serialization', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 320,
      channels: 6,
      sampleRate: 48000,
    })
    initializeEncoderStream(profile, bufferPool.encoder)
    const context = { profile, bufferPool }
    const topology = bufferPool.encoder.state.topology
    const transactions = bufferPool.encoder.frame.allocationTransactions
    const frame = {
      analysisDelayed: false,
      allocationTransactions: transactions,
    }

    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const transaction = transactions[unit]
      transaction.allocationBudgetBits =
        topology.codingUnitProfiles.budgetBits[unit]
      transaction.bitsTotal = transaction.allocationBudgetBits
    }

    transactions[0].bitsTotal += 64
    transactions[1].bitsTotal -= 64
    expect(allocationPreflightStage(context)(frame)).toBe(frame)

    transactions[0].bitsTotal = profile.bytesPerFrame * 8
    expect(() => allocationPreflightStage(context)(frame)).toThrow(
      'allocation total overflow'
    )

    frame.analysisDelayed = true
    expect(allocationPreflightStage(context)(frame)).toBe(frame)
  })

  it('rebinds pooled gain views across every multi-channel coding unit', () => {
    const bufferPool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 256,
      channels: 6,
      sampleRate: 44100,
    })
    initializeEncoderStream(profile, bufferPool.encoder)
    for (let channel = 0; channel < profile.channels; channel++) {
      seedDelayedAnalysis(bufferPool.encoder.state.analysisChannels[channel])
    }
    const context = { profile, bufferPool }
    const channels = Array.from({ length: profile.channels }, (_, channel) =>
      Float32Array.from(referencePcm(), (value) => value + channel / 16)
    )
    let frame = validateFrameStage(context)(channels)
    frame = transactionStage(context)(frame)
    frame = analysisGeometryStage(context)(frame)
    frame = historyStage()(frame)
    frame = qmfStage(context)(frame)
    frame = intensityStage(context)(frame)
    frame = toneStage(context)(frame)
    frame = gainStage(context)(frame)

    expect(
      frame.channelBlocks
        .slice(0, profile.channels)
        .map((block) => [block.sharedIndex, block.channelOrdinal])
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [2, 0],
      [2, 1],
      [3, 0],
    ])
    for (let channel = 0; channel < profile.channels; channel++) {
      expect(
        frame.channelBlocks[
          channel
        ].detection.bands[0].absoluteLevelHistory.some((value) => value !== 0)
      ).toBe(true)
      expect(
        bufferPool.encoder.state.channelBlocks[
          channel
        ].detection.bands[0].absoluteLevelHistory.every((value) => value === 0)
      ).toBe(true)
    }
  })
})
