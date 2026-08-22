/**
 * ATRAC3plus analysis stage.
 *
 * The recipe keeps geometry and chronological preparation separate from
 * bands, signal decisions, and spectrum transformation.
 */

import {
  configureGainDetectionRequest,
  planGainRecords,
} from './gain/detection.js'
import { applyIntensityStereo } from './stereo.js'
import { analyzeTones } from './tones/planning.js'
import { channelCorrelationTwoSegments } from './perceptual.js'
import { rotateEncoderFrameHistories } from '../state/encoder.js'
import { writeMdctOutputs } from '../signal/spectrum.js'
import { analyzeQmfFrame } from '../signal/bands.js'
import { pipe } from '../utils.js'

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
 * Compose ATRAC3plus signal analysis and format decisions.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis stage.
 */
export function analyze(context) {
  return pipe(
    context,
    prepareAnalysis,
    analyzeBands,
    applyIntensity,
    planTones,
    planGain,
    transformSpectrum
  )
}
