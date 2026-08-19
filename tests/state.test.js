import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { FrameDecodeScratch } from '../codec/io/frame-decoder.js'
import {
  ANALYSIS_BANDS,
  ANALYSIS_SLOTS,
  ANALYSIS_TAIL_SAMPLES,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  MAX_CODING_UNITS,
  SUBBAND_SAMPLES,
} from '../codec/core/constants.js'
import {
  EncoderAllocationCheckpoint,
  EncodeChannelState,
  EncodeAnalysisState,
  EncoderFrameState,
  EncoderState,
  EncoderStateImage,
  bindEncoderChannelStates,
  copyEncoderState,
  initializeEncoderStream,
  rotateEncoderFrameHistories,
} from '../codec/state/encoder.js'
import {
  DecoderFrameState,
  DecoderState,
  DecoderStateImage,
  copyDecoderState,
} from '../codec/state/decoder.js'
import { FrameDecodeStorage } from '../codec/state/decoder-syntax.js'
import { CodeTableAccountingTransaction } from '../codec/state/code-table.js'
import {
  GainEnvelopeScratch,
  GainMeasurementScratch,
  IntensityScratch,
} from '../codec/state/analysis.js'
import { GainCodingPlan, GainSyntaxModeProfile } from '../codec/state/gain.js'
import {
  GainAnalysisScratch,
  GainDetectionScratch,
  LowRateGainScratch,
} from '../codec/state/gain-analysis.js'
import { ScaleFactorCodingPlan } from '../codec/state/scale-factor.js'
import { configureCodingUnitChannels } from '../codec/state/shared.js'
import { SpectrumSyntaxScratch } from '../codec/state/spectrum.js'
import {
  ToneAnalysisScratch,
  ToneCodingPlan,
  ToneDetectionScratch,
  ToneSwapGate,
} from '../codec/state/tone.js'
import {
  MdctScratch,
  QmfAnalysisScratch,
  SpectralReconstructionScratch,
  ToneSynthesisScratch,
} from '../codec/state/transform.js'
import { WordLengthAccountingTransaction } from '../codec/state/word-length.js'
import { resolveProfile } from '../codec/core/profiles.js'
import { ReconstructionRefinementScratch } from '../codec/coding/reconstruction-noise.js'

describe('ATRAC3plus shared topology', () => {
  it('folds maintained stream modes into contiguous mono/stereo coding units', () => {
    const pool = new BufferPool()
    const expected = new Map([
      [1, [1]],
      [2, [2]],
      [5, [2, 1, 2, 1]],
      [7, [2, 1, 2, 2, 1]],
    ])
    for (const [mode, channelCounts] of expected) {
      const storage = pool.encoder.state.topology.codingUnitChannels
      const topology = configureCodingUnitChannels(mode, storage)
      expect(topology).toEqual({
        codingUnitCount: channelCounts.length,
        channelCount: channelCounts.reduce((sum, count) => sum + count, 0),
      })
      expect(
        storage.slice(0, topology.codingUnitCount).map((unit) => unit.length)
      ).toEqual(channelCounts)
      expect(
        storage
          .slice(0, topology.codingUnitCount)
          .flatMap((unit) => [...unit.indices.slice(0, unit.length)])
      ).toEqual(
        Array.from({ length: topology.channelCount }, (_, index) => index)
      )
    }
    expect(
      configureCodingUnitChannels(
        0,
        pool.encoder.state.topology.codingUnitChannels
      )
    ).toBeNull()
  })

  it('binds fixed channel blocks to coding-unit-local ownership once', () => {
    const pool = new BufferPool()
    const units = pool.encoder.state.topology.codingUnitChannels
    const topology = configureCodingUnitChannels(5, units)
    const count = bindEncoderChannelStates(
      units,
      topology.codingUnitCount,
      pool.encoder.state.channelBlocks
    )

    expect(count).toBe(6)
    expect(
      pool.encoder.state.channelBlocks
        .slice(0, 6)
        .map((channel) => [
          channel.sharedIndex,
          channel.channelOrdinal,
          channel.primaryChannelOrdinal,
        ])
    ).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [3, 0, 0],
    ])
    expect(pool.encoder.state.channelBlocks[4].detection.energyRatio[7]).toBe(1)
    expect(
      pool.encoder.state.channelBlocks[4].toneSlots.every((slot) => slot.active)
    ).toBe(true)
  })

  it('initializes complete stream topology and immutable coding-unit policy', () => {
    const pool = new BufferPool()
    const profile = resolveProfile({
      bitrateKbps: 256,
      channels: 6,
      sampleRate: 44100,
    })
    const topology = initializeEncoderStream(profile, pool.encoder)
    expect(topology.codingUnitCount).toBe(4)
    expect(topology.channelCount).toBe(6)
    expect(topology.codingUnitProfiles.length).toBe(4)
    expect([...topology.codingUnitProfiles.channelModes.slice(0, 4)]).toEqual([
      3, 1, 3, 4,
    ])
    expect(pool.encoder.state.channelBlocks[4].sharedIndex).toBe(2)
    expect(pool.encoder.state.channelBlocks[4].channelOrdinal).toBe(1)
  })

  it('sizes gain adjustment scratch once from active coding-unit policy', () => {
    const pool = new BufferPool()
    initializeEncoderStream(resolveProfile(), pool.encoder)
    expect(pool.encoder.scratch.gain.adjustment).toBeNull()

    initializeEncoderStream(
      resolveProfile({ bitrateKbps: 32, channels: 1, sampleRate: 44100 }),
      pool.encoder
    )
    const mono = pool.encoder.scratch.gain.adjustment
    expect(pool.encoder.scratch.gain.adjustmentDepth).toBe(1)
    expect(mono.nested).toBeInstanceOf(LowRateGainScratch)
    expect(mono.nested.nested).toBeNull()
    initializeEncoderStream(
      resolveProfile({ bitrateKbps: 32, channels: 1, sampleRate: 44100 }),
      pool.encoder
    )
    expect(pool.encoder.scratch.gain.adjustment).toBe(mono)

    initializeEncoderStream(
      resolveProfile({ bitrateKbps: 24, channels: 2, sampleRate: 44100 }),
      pool.encoder
    )
    const stereo = pool.encoder.scratch.gain.adjustment
    expect(pool.encoder.scratch.gain.adjustmentDepth).toBe(2)
    expect(stereo).not.toBe(mono)
    expect(stereo.nested.nested).toBeInstanceOf(LowRateGainScratch)
    expect(stereo.nested.nested.nested).toBeNull()
  })
})

describe('ATRAC3plus persistent state', () => {
  it('constructs complete state, frame, and scratch owners directly', () => {
    const encoderFrame = new EncoderFrameState()
    const decoderFrame = new DecoderFrameState()
    expect(new EncoderState().topology).toBeDefined()
    expect(encoderFrame.allocationCheckpoint).toBeDefined()
    expect(encoderFrame.pcmChannels).toHaveLength(MAX_CHANNELS)
    expect(encoderFrame.allocationTransactions).toHaveLength(MAX_CODING_UNITS)
    const allocation = encoderFrame.allocationTransactions[0]
    expect(allocation.reconstructionRefinement).toBeInstanceOf(
      ReconstructionRefinementScratch
    )
    expect(new DecoderState().topology).toBeDefined()
    expect(decoderFrame.spectra).toHaveLength(MAX_CHANNELS)
    expect(decoderFrame.outputChannels).toHaveLength(MAX_CHANNELS)
    expect(new GainDetectionScratch().measurement).toBeDefined()
    const gain = new GainAnalysisScratch()
    expect(gain.adjustment).toBeNull()
    expect(gain.configureAdjustment(1)).toBeInstanceOf(LowRateGainScratch)
    expect(new FrameDecodeStorage().codingUnit).toBeDefined()
    expect(() => new FrameDecodeScratch()).toThrow('storage is invalid')
  })

  it('owns the complete fixed analysis ring and zero-padded band traversal', () => {
    const state = new EncodeAnalysisState()
    expect(state.samples).toHaveLength(
      ANALYSIS_BANDS * ANALYSIS_SLOTS * SUBBAND_SAMPLES
    )
    expect(state.tail).toHaveLength(ANALYSIS_TAIL_SAMPLES)
    for (let slot = 0; slot < ANALYSIS_SLOTS; slot++) {
      state.bandSlots[3][slot].fill(slot + 1)
    }
    state.shiftBandSlots()
    expect(state.bandSlots[3][0][0]).toBe(2)
    expect(state.bandSlots[3][7][0]).toBe(9)
    expect(state.bandSlots[3][8][0]).toBe(9)

    const copied = new Float32Array(16)
    state.copyBandSamples(3, ANALYSIS_SLOTS * SUBBAND_SAMPLES - 8, copied)
    expect([...copied.slice(0, 8)]).toEqual(new Array(8).fill(9))
    expect([...copied.slice(8)]).toEqual(new Array(8).fill(0))
  })

  it('captures encoder transactions without replacing destination identities', () => {
    const pool = new BufferPool()
    const source = pool.encoder.state
    const staged = pool.encoder.frame
    const stagedSamples = staged.analysisChannels[0].samples
    const stagedPresence = staged.sharedCodingUnits[0].presenceFlags[1]
    const stagedWordLengths = staged.channelBlocks[0].syntax.wordLengths
    const stagedPoints = staged.channelBlocks[0].detection.bands[3].points.index
    const stagedToneEntries =
      staged.channelBlocks[0].toneSlots[2].records[5].phaseBases
    const stagedGainLocations =
      staged.channelBlocks[0].currentGainRecords[4].locations

    source.sharedCodingUnits[0].scaleFactorCount = 32
    source.sharedCodingUnits[0].quantizationUnitCount = 32
    source.sharedCodingUnits[0].presenceFlags[1][4] = 1
    source.channelBlocks[0].syntax.wordLengths[7] = 6
    source.analysisChannels[0].bandSlots[2][8][11] = 3.5
    source.analysisChannels[0].tail[17] = -2.25
    source.intensityCodingUnits[0].mixHistory[9] = 0.75
    const channel = source.channelBlocks[0]
    channel.currentScaleHistory.scales[4] = 1.25
    channel.intensityHistory.setCorrelation(2, 9, -0.5)
    channel.detection.bands[3].points.index[65] = 27
    channel.detection.bands[3].scaleHistory[17] = 2.5
    channel.toneSlots[2].active = true
    channel.toneSlots[2].records[5].phaseBases[3] = 19
    channel.scaleFactorEncode.mode2Values[100] = 41
    channel.currentGainRecords[4].entries = 1
    channel.currentGainRecords[4].locations[0] = 12
    channel.currentGainRecords[4].levels[0] = 9
    copyEncoderState(source, staged)

    expect(staged.analysisChannels[0].samples).toBe(stagedSamples)
    expect(staged.sharedCodingUnits[0].presenceFlags[1]).toBe(stagedPresence)
    expect(staged.channelBlocks[0].syntax.wordLengths).toBe(stagedWordLengths)
    expect(staged.sharedCodingUnits[0].mapCount).toBe(16)
    expect(staged.sharedCodingUnits[0].shapeCount).toBe(10)
    expect(staged.sharedCodingUnits[0].codedSubbandCount).toBe(16)
    expect(staged.sharedCodingUnits[0].presenceFlags[1][4]).toBe(1)
    expect(staged.channelBlocks[0].syntax.wordLengths[7]).toBe(6)
    expect(staged.analysisChannels[0].bandSlots[2][8][11]).toBe(3.5)
    expect(staged.analysisChannels[0].tail[17]).toBe(-2.25)
    expect(staged.intensityCodingUnits[0].mixHistory[9]).toBe(0.75)
    expect(staged.channelBlocks[0].detection.bands[3].points.index).toBe(
      stagedPoints
    )
    expect(staged.channelBlocks[0].toneSlots[2].records[5].phaseBases).toBe(
      stagedToneEntries
    )
    expect(staged.channelBlocks[0].currentGainRecords[4].locations).toBe(
      stagedGainLocations
    )
    expect(staged.channelBlocks[0].currentScaleHistory.scales[4]).toBe(1.25)
    expect(staged.channelBlocks[0].intensityHistory.correlation(2, 9)).toBe(
      -0.5
    )
    expect(stagedPoints[65]).toBe(27)
    expect(stagedToneEntries[3]).toBe(19)
    expect(staged.channelBlocks[0].scaleFactorEncode.mode2Values[100]).toBe(41)
    expect(stagedGainLocations[0]).toBe(12)

    staged.channelBlocks[0].syntax.wordLengths[7] = 1
    expect(source.channelBlocks[0].syntax.wordLengths[7]).toBe(6)
    stagedPoints[65] = 1
    expect(channel.detection.bands[3].points.index[65]).toBe(27)
  })

  it('copies only the active encoder topology when geometry is supplied', () => {
    const pool = new BufferPool()
    const source = pool.encoder.state
    const staged = pool.encoder.frame
    source.channelBlocks[0].syntax.wordLengths[0] = 3
    source.channelBlocks[1].syntax.wordLengths[0] = 4
    source.channelBlocks[2].syntax.wordLengths[0] = 5
    source.sharedCodingUnits[0].scaleFactorCount = 17
    source.sharedCodingUnits[1].scaleFactorCount = 23
    source.intensityCodingUnits[0].mixHistory[0] = 1.25
    source.intensityCodingUnits[1].mixHistory[0] = 2.5
    staged.channelBlocks[2].syntax.wordLengths[0] = 29
    staged.sharedCodingUnits[1].scaleFactorCount = 30
    staged.intensityCodingUnits[1].mixHistory[0] = 3.75

    copyEncoderState(source, staged, {
      channelCount: 2,
      codingUnitCount: 1,
    })

    expect(staged.channelBlocks[0].syntax.wordLengths[0]).toBe(3)
    expect(staged.channelBlocks[1].syntax.wordLengths[0]).toBe(4)
    expect(staged.sharedCodingUnits[0].scaleFactorCount).toBe(17)
    expect(staged.intensityCodingUnits[0].mixHistory[0]).toBe(1.25)
    expect(staged.channelBlocks[2].syntax.wordLengths[0]).toBe(29)
    expect(staged.sharedCodingUnits[1].scaleFactorCount).toBe(30)
    expect(staged.intensityCodingUnits[1].mixHistory[0]).toBe(3.75)
    expect(() =>
      copyEncoderState(source, staged, {
        channelCount: MAX_CHANNELS + 1,
        codingUnitCount: 1,
      })
    ).toThrow('copy topology')
  })

  it('captures only allocation-mutated state in the pool retry checkpoint', () => {
    const pool = new BufferPool()
    const checkpoint = pool.encoder.frame.allocationCheckpoint
    const staged = pool.encoder.frame
    const topology = { channelCount: 2, codingUnitCount: 1 }
    const channel = staged.channelBlocks[0]
    staged.sharedCodingUnits[0].scaleFactorCount = 21
    channel.currentScaleHistory.scaleFactors[3] = 11
    channel.syntax.wordLengths[4] = 5
    channel.scaleFactorEncode.mode2Values[7] = 19
    channel.quantizedSpectrum[8] = -27
    channel.toneSlots[0].active = true
    channel.toneSlots[0].records[2].phaseBases[1] = 13
    channel.analysis.tail[0] = 1.5
    channel.previousScaleHistory.scaleFactors[3] = 17
    channel.intensityHistory.intensityBandLimit = 9
    channel.detection.energySum[0] = 2.5
    channel.currentGainRecords[0].entries = 1
    channel.toneSlots[1].active = true

    checkpoint.capture(staged, topology)
    staged.sharedCodingUnits[0].scaleFactorCount = 0
    channel.currentScaleHistory.scaleFactors[3] = 0
    channel.syntax.wordLengths[4] = 0
    channel.scaleFactorEncode.mode2Values[7] = 0
    channel.quantizedSpectrum[8] = 0
    channel.toneSlots[0].active = false
    channel.toneSlots[0].records[2].phaseBases[1] = 0
    channel.analysis.tail[0] = 4.5
    channel.previousScaleHistory.scaleFactors[3] = 22
    channel.intensityHistory.intensityBandLimit = 12
    channel.detection.energySum[0] = 6.5
    channel.currentGainRecords[0].entries = 2
    channel.toneSlots[1].active = false

    checkpoint.restore(staged, topology)

    expect(checkpoint).toBeInstanceOf(EncoderAllocationCheckpoint)
    expect(checkpoint.channels[0]).not.toHaveProperty('analysis')
    expect(checkpoint.channels[0]).not.toHaveProperty('detection')
    expect(staged.sharedCodingUnits[0].scaleFactorCount).toBe(21)
    expect(channel.currentScaleHistory.scaleFactors[3]).toBe(11)
    expect(channel.syntax.wordLengths[4]).toBe(5)
    expect(channel.scaleFactorEncode.mode2Values[7]).toBe(19)
    expect(channel.quantizedSpectrum[8]).toBe(-27)
    expect(channel.toneSlots[0].active).toBe(true)
    expect(channel.toneSlots[0].records[2].phaseBases[1]).toBe(13)
    expect(channel.analysis.tail[0]).toBe(4.5)
    expect(channel.previousScaleHistory.scaleFactors[3]).toBe(22)
    expect(channel.intensityHistory.intensityBandLimit).toBe(12)
    expect(channel.detection.energySum[0]).toBe(6.5)
    expect(channel.currentGainRecords[0].entries).toBe(2)
    expect(channel.toneSlots[1].active).toBe(false)
    expect(() =>
      checkpoint.restore(staged, { channelCount: 1, codingUnitCount: 1 })
    ).toThrow('geometry changed')
  })

  it('rotates delayed histories by fixed storage identity', () => {
    const channel = new EncodeChannelState()
    const currentScale = channel.currentScaleHistory
    const previousScale = channel.previousScaleHistory
    const currentGain = channel.currentGainRecords
    const previousGain = channel.previousGainRecords
    const toneSlots = [...channel.toneSlots]
    currentScale.scales[0] = 2
    currentGain[0].entries = 1
    channel.intensityHistory.setCorrelation(4, 3, 8)

    channel.rotateFrameHistory()
    channel.intensityHistory.shift()

    expect(channel.currentScaleHistory).toBe(previousScale)
    expect(channel.previousScaleHistory).toBe(currentScale)
    expect(channel.currentGainRecords).toBe(previousGain)
    expect(channel.previousGainRecords).toBe(currentGain)
    expect(channel.previousGainRecords[0].entries).toBe(1)
    expect(channel.toneSlots).toEqual([
      toneSlots[1],
      toneSlots[2],
      toneSlots[3],
      toneSlots[4],
      toneSlots[0],
    ])
    expect(channel.intensityHistory.correlation(3, 3)).toBe(8)
    expect(channel.intensityHistory.correlation(4, 3)).toBe(0)
  })

  it('clears only new staged gain records during frame-history rotation', () => {
    const channels = [new EncodeChannelState(), new EncodeChannelState()]
    channels[0].currentGainRecords[2].entries = 1
    channels[0].currentGainRecords[2].locations[0] = 9
    const previousBank = channels[0].previousGainRecords
    rotateEncoderFrameHistories(channels, 2)
    expect(channels[0].previousGainRecords[2].entries).toBe(1)
    expect(channels[0].currentGainRecords).toBe(previousBank)
    expect(
      channels[0].currentGainRecords.every((record) => record.entries === 0)
    ).toBe(true)
  })

  it('captures decoder synthesis state independently and identity-preservingly', () => {
    const pool = new BufferPool()
    const source = pool.decoder.state
    const staged = pool.decoder.frame
    const overlap = staged.synthesisCodingUnits[3][1].inverseTransformOverlap
    source.sharedCodingUnits[3].bandLimit = 27
    source.channelBlocks[6].syntax.scaleFactors[4] = 38
    source.synthesisCodingUnits[3][1].inverseTransformOverlap[1024] = -8.5
    source.synthesisCodingUnits[3][1].firstPhaseDelay[17] = 1.25
    source.synthesisCodingUnits[3][1].delayRingIndex = 19
    copyDecoderState(source, staged)

    expect(staged.synthesisCodingUnits[3][1].inverseTransformOverlap).toBe(
      overlap
    )
    expect(staged.sharedCodingUnits[3].bandLimit).toBe(27)
    expect(staged.channelBlocks[6].syntax.scaleFactors[4]).toBe(38)
    expect(overlap[1024]).toBe(-8.5)
    expect(staged.synthesisCodingUnits[3][1].firstPhaseDelay[17]).toBe(1.25)
    expect(staged.synthesisCodingUnits[3][1].delayRingIndex).toBe(19)
    staged.synthesisCodingUnits[3][1].firstPhaseDelay[17] = 0
    expect(source.synthesisCodingUnits[3][1].firstPhaseDelay[17]).toBe(1.25)
  })

  it('allocates explicit maximum state, frame, and scratch lifetimes', () => {
    const pool = new BufferPool()
    initializeEncoderStream(
      resolveProfile({ bitrateKbps: 24, channels: 2, sampleRate: 44100 }),
      pool.encoder
    )
    expect(Object.keys(pool.encoder)).toEqual(['state', 'frame', 'scratch'])
    expect(Object.keys(pool.decoder)).toEqual(['state', 'frame', 'scratch'])
    expect(pool.encoder.state).toBeInstanceOf(EncoderStateImage)
    expect(pool.encoder.frame).toBeInstanceOf(EncoderStateImage)
    expect(pool.encoder.frame).not.toBeInstanceOf(EncoderState)
    expect(pool.encoder.state).not.toBeInstanceOf(EncoderFrameState)
    expect(pool.encoder.frame).not.toHaveProperty('topology')
    expect(pool.encoder.frame).not.toHaveProperty('analysisToStreamDelay')
    expect(pool.decoder.state).toBeInstanceOf(DecoderStateImage)
    expect(pool.decoder.frame).toBeInstanceOf(DecoderStateImage)
    expect(pool.decoder.frame).not.toBeInstanceOf(DecoderState)
    expect(pool.decoder.state).not.toBeInstanceOf(DecoderFrameState)
    expect(pool.decoder.frame).not.toHaveProperty('topology')
    expect(pool.encoder.state.analysisChannels).toHaveLength(MAX_CHANNELS)
    expect(pool.encoder.state.channelBlocks).toHaveLength(MAX_CHANNELS)
    expect(pool.encoder.state.channelBlocks[0].analysis).toBe(
      pool.encoder.state.analysisChannels[0]
    )
    expect(pool.encoder.state).not.toHaveProperty('channelSyntax')
    expect(pool.decoder.state).not.toHaveProperty('channelSyntax')
    expect(pool.encoder.frame.gainPlans).toHaveLength(MAX_CODING_UNITS)
    expect(
      pool.encoder.frame.gainPlans.every(
        (plan) => plan instanceof GainCodingPlan
      )
    ).toBe(true)
    expect(pool.encoder.frame.gainPlans[0].channels[0].records).toBeNull()
    expect(pool.encoder.frame.scaleFactorPlan).toBeInstanceOf(
      ScaleFactorCodingPlan
    )
    expect(pool.encoder.frame.tonePlans).toHaveLength(MAX_CODING_UNITS)
    expect(
      pool.encoder.frame.tonePlans.every(
        (plan) => plan instanceof ToneCodingPlan
      )
    ).toBe(true)
    expect(pool.encoder.scratch.toneSwapGates).toHaveLength(MAX_CODING_UNITS)
    expect(
      pool.encoder.scratch.toneSwapGates.every(
        (gate) => gate instanceof ToneSwapGate
      )
    ).toBe(true)
    expect(pool.encoder.scratch.toneSwapGates[0].temporary).not.toBe(
      pool.encoder.scratch.toneSwapGates[1].temporary
    )
    expect(pool.encoder.scratch.spectrumSyntax).toBeInstanceOf(
      SpectrumSyntaxScratch
    )
    expect(pool.encoder.scratch.spectrumSyntax.symbol.fields).toHaveLength(3)
    expect(pool.encoder.scratch.gain).toBeInstanceOf(GainAnalysisScratch)
    expect(pool.encoder.scratch.gain.detection.measurement).toBeInstanceOf(
      GainMeasurementScratch
    )
    expect(pool.encoder.scratch.gain.detection.envelope).toBeInstanceOf(
      GainEnvelopeScratch
    )
    expect(pool.encoder.scratch.gain.detection).toBeInstanceOf(
      GainDetectionScratch
    )
    expect(pool.encoder.scratch.gain.adjustment).toBeInstanceOf(
      LowRateGainScratch
    )
    expect(pool.encoder.scratch.intensity).toBeInstanceOf(IntensityScratch)
    expect(pool.encoder.scratch.tone.detection).toBeInstanceOf(
      ToneDetectionScratch
    )
    expect(pool.encoder.scratch.tone).toBeInstanceOf(ToneAnalysisScratch)
    expect(pool.encoder.frame.wordLengthTransactions).toHaveLength(
      MAX_CODING_UNITS
    )
    expect(
      pool.encoder.frame.wordLengthTransactions.every(
        (transaction) => transaction instanceof WordLengthAccountingTransaction
      )
    ).toBe(true)
    expect(
      pool.encoder.frame.wordLengthTransactions[0].candidateScratch[0]
        .candidateRows
    ).not.toBe(
      pool.encoder.frame.wordLengthTransactions[0].scratch[0].candidateRows
    )
    expect(pool.encoder.frame.codeTableTransactions).toHaveLength(
      MAX_CODING_UNITS
    )
    expect(
      pool.encoder.frame.codeTableTransactions.every(
        (transaction) => transaction instanceof CodeTableAccountingTransaction
      )
    ).toBe(true)
    expect(
      pool.encoder.frame.codeTableTransactions[0].candidateStates[0]
    ).not.toBe(pool.encoder.frame.codeTableTransactions[0].states[0])
    expect(pool.encoder.frame.gainPlans[0]).not.toBe(
      pool.encoder.scratch.gain.adjustment.syntaxPricing.workspace
    )
    expect(
      pool.encoder.scratch.gain.adjustment.syntaxPricing.incumbentModes
    ).toBeInstanceOf(GainSyntaxModeProfile)
    expect(pool.encoder.state.sharedCodingUnits).toHaveLength(MAX_CODING_UNITS)
    expect(pool.encoder.frame.pcmChannels[0]).toHaveLength(FRAME_SAMPLES)
    expect(pool.encoder.frame.pcmChannels[0]).not.toBe(
      pool.encoder.frame.gainScaledSpectra[0]
    )
    expect(pool.encoder.frame.gainScaledSpectra[0]).not.toBe(
      pool.encoder.frame.gainUnscaledSpectra[0]
    )
    expect(pool.encoder.state.analysisChannels[0].samples).not.toBe(
      pool.encoder.frame.analysisChannels[0].samples
    )
    expect(pool.decoder.state.synthesisCodingUnits[0][0]).not.toBe(
      pool.decoder.frame.synthesisCodingUnits[0][0]
    )
    expect(pool.decoder.scratch.syntax).toBeInstanceOf(FrameDecodeStorage)
    expect(pool.decoder.scratch).not.toHaveProperty('paddedFrame')
    expect(pool.decoder.scratch).not.toHaveProperty('codingUnit')
    expect(pool.decoder.scratch).not.toHaveProperty('frameDecode')
    expect(pool.encoder.scratch.packedFrame.length).toBeGreaterThan(4464)
    expect(pool.encoder.scratch.qmf).toBeInstanceOf(QmfAnalysisScratch)
    expect(pool.encoder.scratch.mdct).toBeInstanceOf(MdctScratch)
    expect(pool.encoder.scratch.tone.synthesis).toBeInstanceOf(
      ToneSynthesisScratch
    )
    expect(pool.encoder.scratch.tone.detection.dftWork).toBeInstanceOf(
      Float32Array
    )
    expect(pool.encoder.scratch.mdct.fftWork).toHaveLength(128)
    expect(pool.encoder.scratch.mdct.timeSamples).toHaveLength(256)
    expect(pool.decoder.scratch.inverseMdct).toBeInstanceOf(MdctScratch)
    expect(pool.decoder.scratch.spectralReconstruction).toBeInstanceOf(
      SpectralReconstructionScratch
    )
  })
})
