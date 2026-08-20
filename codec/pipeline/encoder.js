/** Streaming ATRAC3plus encoder composed from explicit transactional stages. */

import {
  configureGainDetectionRequest,
  planGainRecords,
} from '../analysis/gain-detection.js'
import { applyIntensityStereo } from '../analysis/intensity.js'
import { analyzeTones } from '../analysis/tone-analysis.js'
import { prepareAllocationSource } from '../coding/allocation-seed.js'
import { usesSinglePostScaleFactorFill } from '../coding/allocation-policy.js'
import { initializeAllocation } from '../coding/initial-allocation.js'
import { searchAllocation } from '../coding/second-pass-allocation.js'
import { reduceCommittedAllocationToBudget } from '../coding/offset-refinement.js'
import { fillRemainingBitBudget } from '../coding/budget-fill.js'
import { quantizeActiveAllocation } from '../coding/active-quantization.js'
import { refineSpectralNoiseLevels } from '../coding/spectral-noise-refinement.js'
import { refineScaleFactors } from '../coding/scale-factor-refinement.js'
import { channelCorrelationTwoSegments } from '../analysis/perceptual.js'
import { BufferPool } from '../core/buffers.js'
import { framePayloadCapacityBits } from '../core/geometry.js'
import { resolveProfile } from '../core/profiles.js'
import {
  BUDGET_RETRY_LIMIT,
  BUDGET_RETRY_STEP_BITS,
  FRAME_SAMPLES,
} from '../core/constants.js'
import {
  copyEncoderState,
  initializeEncoderStream,
  rotateEncoderFrameHistories,
} from '../state/encoder.js'
import { FramePackError, packFrame } from '../io/frame.js'
import { scalePcmFrame } from '../io/pcm.js'
import { writeMdctOutputs } from '../transforms/mdct.js'
import { analyzeQmfFrame } from '../transforms/qmf.js'
import { pipe } from '../utils.js'

/**
 * Validate and zero-pad one complete ATRAC3plus frame before state capture.
 * This preparatory stage accepts arbitrary valid sample counts while keeping
 * chunk/timeline adaptation outside the transform transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): EncoderFrame} Validation stage.
 */
export function validateFrameStage(context) {
  const { profile } = context
  const pcmChannels = context.bufferPool.encoder.frame.pcmChannels
  return (input) => {
    const channels = Array.isArray(input) ? input : input?.channels
    const sampleCount = Array.isArray(input)
      ? FRAME_SAMPLES
      : (input?.sampleCount ?? FRAME_SAMPLES)
    if (
      !Array.isArray(channels) ||
      channels.length !== profile.channels ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 0 ||
      sampleCount > FRAME_SAMPLES
    ) {
      throw new RangeError('ATRAC3plus PCM frame geometry is invalid')
    }
    for (let channel = 0; channel < channels.length; channel++) {
      const source = channels[channel]
      if (
        !(source instanceof Float32Array) ||
        source.length !== FRAME_SAMPLES
      ) {
        throw new RangeError(
          `Each ATRAC3plus PCM channel must contain ${FRAME_SAMPLES} float samples`
        )
      }
      pcmChannels[channel].set(source)
      pcmChannels[channel].fill(0, sampleCount)
    }
    return {
      channels:
        context.bufferPool.encoder.frame.pcmChannelViews[channels.length],
      channelCount: channels.length,
      sampleCount,
    }
  }
}

/**
 * Capture all ported ATRAC3plus state into detached storage before analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction capture stage.
 */
export function transactionStage(context) {
  return (frame) => {
    copyEncoderState(
      context.bufferPool.encoder.state,
      context.bufferPool.encoder.frame,
      context.bufferPool.encoder.state.topology
    )
    frame.analysisStates = context.bufferPool.encoder.frame.analysisChannels
    frame.channelBlocks = context.bufferPool.encoder.frame.channelBlocks
    frame.sharedCodingUnits = context.bufferPool.encoder.frame.sharedCodingUnits
    frame.intensityCodingUnits =
      context.bufferPool.encoder.frame.intensityCodingUnits
    return frame
  }
}

/**
 * Refresh detached syntax geometry before current-frame signal analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Geometry stage.
 */
export function analysisGeometryStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    const { topology } = encoder.state
    if (
      topology.channelCount !== frame.channelCount ||
      topology.codingUnitCount !== topology.codingUnitProfiles.length
    ) {
      throw new RangeError('ATRAC3plus analysis topology is not initialized')
    }
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const primary = frame.channelBlocks[channels.at(0)]
      const shared = frame.sharedCodingUnits[primary.sharedIndex]
      const quantizationUnitCount = Math.max(
        topology.codingUnitProfiles.quantizationUnitCounts[unit],
        1
      )
      shared.scaleFactorCount = quantizationUnitCount
      shared.quantizationUnitCount = quantizationUnitCount
    }
    return frame
  }
}

/**
 * Rotate only detached frame histories before current-frame analysis.
 *
 * @returns {function(EncoderFrame): EncoderFrame} History rotation stage.
 */
export function historyStage() {
  return (frame) => {
    rotateEncoderFrameHistories(frame.channelBlocks, frame.channelCount)
    return frame
  }
}

/**
 * Advance the detached 16-band QMF histories for every stream channel.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} QMF analysis stage.
 */
export function qmfStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    analyzeQmfFrame(
      frame.channels,
      frame.analysisStates,
      frame.channelCount,
      encoder.scratch.qmf
    )
    frame.qmfBands = encoder.frame.qmfBandViews[frame.channelCount]
    return frame
  }
}

/**
 * Apply stereo-only intensity processing and publish delayed correlation.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Intensity analysis stage.
 */
export function intensityStage(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  return (frame) => {
    if (frame.channelCount !== 2) return frame
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      if (
        channels.length !== 2 ||
        topology.codingUnitProfiles.channelModes[unit] !== 3
      ) {
        continue
      }
      const leftIndex = channels.at(0)
      const rightIndex = channels.at(1)
      const left = frame.analysisStates[leftIndex]
      const right = frame.analysisStates[rightIndex]
      const intensity = frame.intensityCodingUnits[unit]
      applyIntensityStereo(
        intensity,
        topology.codingUnitProfiles.coreModes[unit],
        context.profile.sampleRate === 48000,
        left,
        right,
        encoder.scratch.intensity
      )

      const primary = frame.channelBlocks[leftIndex]
      const shared = frame.sharedCodingUnits[primary.sharedIndex]
      primary.intensityHistory.shift()
      primary.intensityHistory.intensityBandLimit = intensity.intensityBandLimit
      for (
        let band = 0;
        band < Math.min(shared.codedSubbandCount, 16);
        band++
      ) {
        primary.intensityHistory.setCorrelation(
          2,
          band,
          channelCorrelationTwoSegments(
            left.bandSlots[band][1],
            right.bandSlots[band][1],
            left.bandSlots[band][2],
            right.bandSlots[band][2]
          )
        )
      }
    }
    return frame
  }
}

/**
 * Plan complete per-unit tone syntax and residuals in detached state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Tone analysis stage.
 */
export function toneStage(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      analyzeTones(
        frame.channelBlocks,
        frame.analysisStates,
        topology.codingUnitChannels[unit],
        topology.codingUnitProfiles.channelModes[unit],
        topology.codingUnitProfiles.toneAnalysisEnabled[unit],
        context.profile.bitrateKbps,
        encoder.scratch.tone
      )
    }
    return frame
  }
}

/**
 * Plan gain records per coding unit and publish them only into detached state.
 * Intensity-stereo and tone stages belong immediately before this stage; this
 * stage deliberately owns neither policy.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Gain analysis stage.
 */
export function gainStage(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const detectionScratch = encoder.scratch.gain.detection
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      const channelCount = channels.length
      for (let ordinal = 0; ordinal < channelCount; ordinal++) {
        const channelIndex = channels.at(ordinal)
        detectionScratch.unitChannelBlocks[ordinal] =
          frame.channelBlocks[channelIndex]
        detectionScratch.unitAnalysisStates[ordinal] =
          frame.analysisStates[channelIndex]
      }
      const primary = detectionScratch.unitChannelBlocks[0]
      const shared = frame.sharedCodingUnits[primary.sharedIndex]
      const request = configureGainDetectionRequest(
        detectionScratch.request,
        primary.intensityHistory.intensityBandLimit,
        shared.codedSubbandCount,
        topology.codingUnitProfiles.coreModes[unit],
        topology.codingUnitProfiles.channelModes[unit],
        channelCount
      )
      const plan = planGainRecords(
        detectionScratch.unitChannelBlocks,
        detectionScratch.unitAnalysisStates,
        request,
        detectionScratch,
        encoder.scratch.gain.adjustment
      )
      plan.commitTo(detectionScratch.unitChannelBlocks)
    }
    return frame
  }
}

/**
 * Publish gain-scaled and gain-unscaled spectra from detached channel state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} MDCT stage.
 */
export function mdctStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channelCount; channel++) {
      const block = frame.channelBlocks[channel]
      if (
        writeMdctOutputs(
          frame.analysisStates[channel],
          16,
          block.previousGainRecords,
          block.currentGainRecords,
          encoder.frame.gainScaledSpectra[channel],
          encoder.frame.gainUnscaledSpectra[channel],
          encoder.scratch.mdct
        ) === null
      ) {
        throw new Error(
          `ATRAC3plus gain application failed for channel ${channel}`
        )
      }
    }
    frame.gainScaledSpectra =
      encoder.frame.gainScaledSpectrumViews[frame.channelCount]
    frame.gainUnscaledSpectra =
      encoder.frame.gainUnscaledSpectrumViews[frame.channelCount]
    return frame
  }
}

/**
 * Complete one independent coding-unit allocation from measured spectra through final quantization.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @param {EncoderFrame} frame Detached frame transaction.
 * @param {number} unit Coding-unit index.
 * @returns {CodingUnitAllocationTransaction} Finalized coding-unit transaction.
 */
function allocateCodingUnit(context, frame, unit) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const topologyChannels = topology.codingUnitChannels[unit]
  const channelCount = topologyChannels.length
  const coreMode = topology.codingUnitProfiles.coreModes[unit]
  const allocationBudgetBits =
    topology.codingUnitProfiles.budgetBits[unit] -
    (context.allocationBudgetReductionBits ?? 0)
  if (allocationBudgetBits < 1) {
    throw new RangeError('ATRAC3plus retry budget is exhausted')
  }
  const transaction = encoder.frame.allocationTransactions[unit].beginAttempt(
    channelCount,
    coreMode,
    allocationBudgetBits,
    encoder.scratch.toneSwapGates[unit].beginFrame()
  )
  for (let ordinal = 0; ordinal < channelCount; ordinal++) {
    const channel = topologyChannels.at(ordinal)
    transaction.bindChannel(
      ordinal,
      frame.channelBlocks[channel],
      frame.gainScaledSpectra[channel],
      frame.gainUnscaledSpectra[channel]
    )
  }
  transaction.completeBinding()

  const shared =
    frame.sharedCodingUnits[transaction.channelBlocks[0].sharedIndex]
  const channelMode = topology.codingUnitProfiles.channelModes[unit]
  const bitrateKbps = context.profile.bitrateKbps
  prepareAllocationSource(
    transaction,
    shared.quantizationUnitCount,
    channelMode,
    context.profile.sampleRate
  )
  initializeAllocation(transaction, shared)
  searchAllocation(transaction, shared)
  if (!usesSinglePostScaleFactorFill(channelMode, bitrateKbps)) {
    fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  }
  quantizeActiveAllocation(transaction)
  refineSpectralNoiseLevels(
    transaction,
    shared,
    transaction.reconstructionRefinement
  )
  if (channelMode !== 4) {
    refineScaleFactors(
      transaction,
      shared,
      transaction.reconstructionRefinement
    )
  }
  if (transaction.bitsTotal > transaction.allocationBudgetBits) {
    reduceCommittedAllocationToBudget(transaction, shared)
  }
  if (channelMode !== 4) {
    fillRemainingBitBudget(transaction, shared, bitrateKbps >= 256)
  }
  if (transaction.bitsTotal > transaction.allocationBudgetBits) {
    reduceCommittedAllocationToBudget(transaction, shared)
  }
  if (transaction.quantizationDirty) quantizeActiveAllocation(transaction)
  return transaction
}

/**
 * Allocate each independent coding unit completely before advancing to the next unit.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Unit-local allocation stage.
 */
export function allocationStage(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  return (frame) => {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      allocateCodingUnit(context, frame, unit)
    }
    frame.allocationTransactions =
      encoder.frame.allocationTransactionViews[topology.codingUnitCount]
    return frame
  }
}

/**
 * Consume one successful analyzed frame before stream output becomes visible.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis delay stage.
 */
export function analysisToStreamDelayStage(context) {
  const delay = context.bufferPool.encoder.state.analysisToStreamDelay
  return (frame) => {
    frame.analysisDelayed = delay.consumeAfterAllocation()
    return frame
  }
}

/**
 * Prove that finalized coding-unit allocations fit the complete frame payload
 * before serialization begins. Unit budgets are allocation targets rather
 * than serialized boundaries, so unused bits may move between units.
 *
 * Suppressed analysis-delay frames have no serialized representation and do
 * not require this check.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation preflight stage.
 */
export function allocationPreflightStage(context) {
  const { topology } = context.bufferPool.encoder.state
  const framePayloadBits = framePayloadCapacityBits(
    context.profile.bytesPerFrame,
    topology.codingUnitCount
  )
  return (frame) => {
    if (frame.analysisDelayed) return frame
    let allocationBits = 0
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const transaction = frame.allocationTransactions[unit]
      allocationBits += transaction.bitsTotal
    }
    if (allocationBits > framePayloadBits) {
      throw new FramePackError('allocation total overflow')
    }
    return frame
  }
}

/**
 * Serialize the detached frame into bounded scratch without publishing state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function packingStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (frame.analysisDelayed) {
      frame.packedPayloadBits = 0
      frame.output = null
      return frame
    }
    const payloadBits = packFrame(
      frame.allocationTransactions,
      frame.sharedCodingUnits,
      encoder.state.topology.codingUnitCount,
      context.profile.bytesPerFrame,
      encoder.scratch.packedFrame,
      encoder.scratch.spectrumSyntax
    )
    frame.packedPayloadBits = payloadBits
    frame.output = encoder.scratch.packedFrame.subarray(
      0,
      context.profile.bytesPerFrame
    )
    return frame
  }
}

/**
 * Publish frame histories only after delay acceptance or successful packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Atomic commit stage.
 */
export function commitStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (!frame.analysisDelayed && !(frame.output instanceof Uint8Array)) {
      throw new Error(
        'ATRAC3plus frame cannot commit before successful packing'
      )
    }
    copyEncoderState(encoder.frame, encoder.state, encoder.state.topology)
    frame.committed = true
    return frame
  }
}

/**
 * Detach a packed frame; analysis-delay frames intentionally emit none.
 *
 * @returns {function(EncoderFrame): (Uint8Array|null)} Output stage.
 */
export function outputStage() {
  return (frame) => (frame.output === null ? null : frame.output.slice())
}

/**
 * Compose the complete detached ATRAC3plus frame transaction.
 * Chunk adaptation and the ATRACX timeline remain outside this transaction.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): (Uint8Array|null)} Persistent
 * one-frame encoder; initial analysis-delay frames return `null`.
 */
export function createFrameEncoder(
  options = {},
  bufferPool = new BufferPool()
) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3plus encoder profile')
  initializeEncoderStream(profile, bufferPool.encoder)
  const context = {
    profile,
    bufferPool,
    allocationBudgetReductionBits: 0,
  }
  const analyze = pipe(
    context,
    validateFrameStage,
    transactionStage,
    analysisGeometryStage,
    historyStage,
    qmfStage,
    intensityStage,
    toneStage,
    gainStage,
    mdctStage
  )
  const allocate = allocationStage(context)
  const publish = pipe(
    context,
    analysisToStreamDelayStage,
    allocationPreflightStage,
    packingStage,
    commitStage,
    outputStage
  )
  return (input) => {
    let frame = analyze(input)
    bufferPool.encoder.frame.allocationCheckpoint.capture(
      bufferPool.encoder.frame,
      bufferPool.encoder.state.topology
    )
    for (let attempt = 0; attempt < BUDGET_RETRY_LIMIT; attempt++) {
      if (attempt > 0) {
        bufferPool.encoder.frame.allocationCheckpoint.restore(
          bufferPool.encoder.frame,
          bufferPool.encoder.state.topology
        )
      }
      context.allocationBudgetReductionBits = attempt * BUDGET_RETRY_STEP_BITS
      try {
        frame = allocate(frame)
        const output = publish(frame)
        bufferPool.encoder.state.lastAllocationAttempts = attempt + 1
        context.allocationBudgetReductionBits = 0
        return output
      } catch (error) {
        if (!(error instanceof FramePackError)) {
          bufferPool.encoder.frame.allocationCheckpoint.restore(
            bufferPool.encoder.frame,
            bufferPool.encoder.state.topology
          )
          context.allocationBudgetReductionBits = 0
          throw error
        }
      }
    }
    bufferPool.encoder.frame.allocationCheckpoint.restore(
      bufferPool.encoder.frame,
      bufferPool.encoder.state.topology
    )
    context.allocationBudgetReductionBits = 0
    throw new RangeError('ATRAC3plus frame packing retry limit was exhausted')
  }
}

/**
 * Compose one persistent encoder accepting normalized Web Audio PCM.
 *
 * The adapter reuses one codec-domain frame for the lifetime of the closure.
 * Initial analysis-delay frames return `null`.
 *
 * @param {CodecProfileOptions} [options] Maintained profile options.
 * @param {BufferPool} [bufferPool] Reusable state, frame, and scratch storage.
 * @returns {function(Float32Array[]|{channels: Float32Array[], sampleCount?: number}): (Uint8Array|null)} One-frame encoder.
 */
export function encode(options = {}, bufferPool = new BufferPool()) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3plus encoder profile')
  const encodeFrame = createFrameEncoder(profile, bufferPool)
  const codecFrame = Array.from(
    { length: profile.channels },
    () => new Float32Array(FRAME_SAMPLES)
  )
  return (input) => {
    const channels = Array.isArray(input) ? input : input?.channels
    const sampleCount = Array.isArray(input)
      ? FRAME_SAMPLES
      : (input?.sampleCount ?? FRAME_SAMPLES)
    if (
      !Array.isArray(channels) ||
      channels.length !== profile.channels ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 0 ||
      sampleCount > FRAME_SAMPLES ||
      !channels.every(
        (channel) =>
          channel instanceof Float32Array && channel.length === FRAME_SAMPLES
      )
    ) {
      throw new RangeError('ATRAC3plus PCM frame geometry is invalid')
    }
    scalePcmFrame(channels, codecFrame)
    return encodeFrame({ channels: codecFrame, sampleCount })
  }
}
