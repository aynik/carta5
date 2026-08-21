/**
 * Streaming ATRAC3plus encoder pipeline.
 *
 * PCM passes through analysis, allocation, quantization, and packing.
 * Validation, detached state, retry, delay, commit, and output detachment
 * surround that semantic recipe.
 */

import {
  configureGainDetectionRequest,
  planGainRecords,
} from '../analysis/gain-detection.js'
import { applyIntensityStereo } from '../analysis/intensity.js'
import { analyzeTones } from '../analysis/tone-analysis.js'
import { createAllocation } from '../coding/allocation.js'
import { quantizeSymbols } from '../coding/active-quantization.js'
import { channelCorrelationTwoSegments } from '../analysis/perceptual.js'
import { BufferPool } from '../core/buffers.js'
import { resolveProfile } from '../core/profiles.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import {
  copyEncoderState,
  initializeEncoderStream,
  rotateEncoderFrameHistories,
} from '../state/encoder.js'
import { packFrame } from '../io/frame.js'
import { createPcmScaler } from '../io/pcm.js'
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
export function validateFrame(context) {
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
export function beginTransaction(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} Geometry setup operation.
 */
export function prepareGeometry(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} History setup operation.
 */
export function rotateHistory() {
  return (frame) => {
    rotateEncoderFrameHistories(frame.channelBlocks, frame.channelCount)
    return frame
  }
}

/**
 * Advance the detached 16-band QMF histories for every stream channel.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Band analysis application.
 */
export function analyzeBands(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} Intensity application.
 */
export function applyIntensity(context) {
  const encoder = context.bufferPool.encoder
  const { topology } = encoder.state
  const units = []
  if (topology.channelCount === 2) {
    for (let unit = 0; unit < topology.codingUnitCount; unit++) {
      const channels = topology.codingUnitChannels[unit]
      if (
        channels.length === 2 &&
        topology.codingUnitProfiles.channelModes[unit] === 3
      ) {
        units.push(unit)
      }
    }
  }
  const highRate = context.profile.sampleRate === 48000
  return (frame) => {
    for (const unit of units) {
      const channels = topology.codingUnitChannels[unit]
      const leftIndex = channels.at(0)
      const rightIndex = channels.at(1)
      const left = frame.analysisStates[leftIndex]
      const right = frame.analysisStates[rightIndex]
      const state = frame.intensityCodingUnits[unit]
      applyIntensityStereo(
        state,
        topology.codingUnitProfiles.coreModes[unit],
        highRate,
        left,
        right,
        encoder.scratch.intensity
      )

      const primary = frame.channelBlocks[leftIndex]
      const shared = frame.sharedCodingUnits[primary.sharedIndex]
      primary.intensityHistory.shift()
      primary.intensityHistory.intensityBandLimit = state.intensityBandLimit
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
 * @returns {function(EncoderFrame): EncoderFrame} Tone application.
 */
export function planTones(context) {
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
 * Intensity-stereo and tone applications run immediately before this one; gain
 * deliberately owns neither policy.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Gain application.
 */
export function planGain(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} Spectrum application.
 */
export function transformSpectrum(context) {
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
 * Consume one successful analyzed frame before stream output becomes visible.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis delay stage.
 */
export function applyDelay(context) {
  const delay = context.bufferPool.encoder.state.analysisToStreamDelay
  return (frame) => {
    frame.analysisDelayed = delay.consumeAfterAllocation()
    return frame
  }
}

/**
 * Serialize the detached frame into bounded scratch without publishing state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function pack(context) {
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
export function commitFrame(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (!frame.analysisDelayed && !(frame.output instanceof Uint8Array)) {
      throw new Error(
        'ATRAC3plus frame cannot commit before successful packing'
      )
    }
    copyEncoderState(encoder.frame, encoder.state, encoder.state.topology)
    encoder.state.lastAllocationAttempts = frame.allocationAttempts
    frame.committed = true
    return frame
  }
}

/**
 * Detach a packed frame; analysis-delay frames intentionally emit none.
 *
 * @returns {function(EncoderFrame): (Uint8Array|null)} Output stage.
 */
export function detachOutput() {
  return (frame) => (frame.output === null ? null : frame.output.slice())
}

/**
 * Allocate stream state and stable construction context.
 *
 * @param {CodecProfileOptions} options Maintained profile options.
 * @param {BufferPool} bufferPool Reusable codec storage.
 * @returns {EncoderContext} Pipeline ownership context.
 */
function createEncoderContext(options, bufferPool) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3plus encoder profile')
  initializeEncoderStream(profile, bufferPool.encoder)
  return { profile, bufferPool }
}

/**
 * Prepare detached format geometry and chronological histories for analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis setup protocol.
 */
function prepareAnalysis(context) {
  return pipe(context, prepareGeometry, rotateHistory)
}

/**
 * Compose ATRAC3plus signal analysis and format decisions.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis stage.
 */
export function analyze(context) {
  return pipe(
    context,
    analyzeBands,
    applyIntensity,
    planTones,
    planGain,
    transformSpectrum
  )
}

/**
 * Compose retained allocation and exact frame fitting.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocate(context) {
  return createAllocation(context)
}

/**
 * Materialize final symbols for every retained coding unit.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization stage.
 */
export function quantize(context) {
  const { codingUnitCount } = context.bufferPool.encoder.state.topology
  return (frame) => {
    for (let unit = 0; unit < codingUnitCount; unit++) {
      quantizeSymbols(frame.allocationTransactions[unit])
    }
    return frame
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
  const context = createEncoderContext(options, bufferPool)
  const encodeFrame = pipe(
    context,
    validateFrame,
    beginTransaction,
    prepareAnalysis,
    analyze,
    allocate,
    quantize,
    applyDelay,
    pack,
    commitFrame,
    detachOutput
  )
  const scale = createPcmScaler(context.profile.channels)
  return (input) => encodeFrame(scale(input))
}
