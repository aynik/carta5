/** Detached per-coding-unit ATRAC3plus tone analysis and residual planning. */

import { channelCorrelationDb } from './perceptual.js'
import {
  extractToneCandidates,
  applyToneBand0UpperMask,
  orderToneBands,
  planToneExtractionBudget,
  planToneGate,
  planToneWindow,
  selectToneBandCount,
  selectToneMaskedPeakBin,
  writeToneJointRatioMask,
  writeToneWindowedSpectrum,
} from './tone-detection.js'
import { powerSpectrum256 } from '../transforms/dft.js'
import { synthesizeTonePair, writeToneResidual } from '../transforms/tone.js'
import {
  ANALYSIS_TONE_ANALYSIS_BANDS,
  CHANNELS,
  CURRENT_TONE_SLOT,
  ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES,
  HEADER_AMPLITUDE_MODE,
  HEADER_BAND_COUNT,
  HEADER_ENABLE,
  HEADER_FREQUENCY,
  HEADER_JOINT,
  INDEPENDENT_AMPLITUDE_MODE,
  JOINT_MIX_SCALE,
  PREVIOUS_TONE_SLOT,
  TONE_RESIDUAL_SLOT,
  TONE_SOURCE_SAMPLE,
  TONE_ACCUMULATE_FUSED,
  TONE_CROSSFADE_ENCODER_RESIDUAL,
} from '../core/constants.js'

/**
 * Resolve a coding-unit-local channel ordinal to its stream channel index.
 *
 * @param {CodingUnitChannels} channels
 * @param {number} ordinal
 * @returns {number}
 */
function channelIndexAt(channels, ordinal) {
  return typeof channels?.at === 'function'
    ? channels.at(ordinal)
    : channels?.[ordinal]
}

/**
 * Clear all tone entries and flags in a reusable tone record.
 *
 * @param {ToneSynthesisRecord} record
 */
function resetToneRecord(record) {
  record.hasLeftFade = 0
  record.hasRightFade = 0
  record.gateStartValid = 0
  record.gateEndValid = 0
  record.gateStartIndex = 0
  record.gateEndIndex = 0x20
  record.entryCount = 0
  record.scaleFactorIndices.fill(0)
  record.amplitudeIndices.fill(0)
  record.phaseBases.fill(0)
  record.steps.fill(0)
}

/**
 * Snapshot the source samples and tone history needed by a detached tone plan.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {CodingUnitChannels} channels
 * @param {ToneAnalysisScratch} scratch
 */
function captureToneSource(channelBlocks, analysisStates, channels, scratch) {
  scratch.sourcePresent.fill(0)
  scratch.recordPresent.fill(0)
  for (let channel = 0; channel < CHANNELS; channel++) {
    const channelIndex = channelIndexAt(channels, channel)
    const analysis = analysisStates[channelIndex]
    const block = channelBlocks[channelIndex]
    if (!analysis || !block) continue
    scratch.sourcePresent[channel] = 1
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      analysis.copyBandSamples(
        band,
        TONE_SOURCE_SAMPLE,
        scratch.sourceRows[channel][band]
      )
    }
    const slot = block.toneSlots[CURRENT_TONE_SLOT]
    if (!slot?.active) continue
    scratch.recordPresent[channel] = 1
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      slot.records[band].copyTo(scratch.records[channel][band])
      resetToneRecord(scratch.records[channel][band])
    }
  }
}

/**
 * Accumulate channel power together with left-minus-right power in one pass.
 *
 * @param {Float32Array} first
 * @param {Float32Array} second
 * @param {Float64Array} destination
 * @returns {Float64Array}
 */
function channelAndDifferencePower(first, second, destination) {
  let first0 = 0
  let first1 = 0
  let first2 = 0
  let first3 = 0
  let second0 = 0
  let second1 = 0
  let second2 = 0
  let second3 = 0
  let difference0 = 0
  let difference1 = 0
  let difference2 = 0
  let difference3 = 0
  for (
    let index = 0;
    index < ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES;
    index += 4
  ) {
    const firstValue0 = first[index]
    const secondValue0 = second[index]
    const delta0 = Math.fround(firstValue0 - secondValue0)
    const firstValue2 = first[index + 2]
    const secondValue2 = second[index + 2]
    const delta2 = Math.fround(firstValue2 - secondValue2)
    const firstValue1 = first[index + 1]
    const secondValue1 = second[index + 1]
    const delta1 = Math.fround(firstValue1 - secondValue1)
    const firstValue3 = first[index + 3]
    const secondValue3 = second[index + 3]
    const delta3 = Math.fround(firstValue3 - secondValue3)
    first0 = Math.fround(first0 + Math.fround(firstValue0 * firstValue0))
    first2 = Math.fround(first2 + Math.fround(firstValue2 * firstValue2))
    first1 = Math.fround(first1 + Math.fround(firstValue1 * firstValue1))
    first3 = Math.fround(first3 + Math.fround(firstValue3 * firstValue3))
    second0 = Math.fround(second0 + Math.fround(secondValue0 * secondValue0))
    second2 = Math.fround(second2 + Math.fround(secondValue2 * secondValue2))
    second1 = Math.fround(second1 + Math.fround(secondValue1 * secondValue1))
    second3 = Math.fround(second3 + Math.fround(secondValue3 * secondValue3))
    difference0 = Math.fround(difference0 + Math.fround(delta0 * delta0))
    difference2 = Math.fround(difference2 + Math.fround(delta2 * delta2))
    difference1 = Math.fround(difference1 + Math.fround(delta1 * delta1))
    difference3 = Math.fround(difference3 + Math.fround(delta3 * delta3))
  }
  destination[0] = Math.fround(
    Math.fround(Math.fround(first0 + first1) + first2) + first3
  )
  destination[1] = Math.fround(
    Math.fround(Math.fround(second1 + second0) + second2) + second3
  )
  destination[2] = Math.fround(
    Math.fround(Math.fround(difference0 + difference1) + difference2) +
      difference3
  )
  return destination
}

/**
 * Compute signal power with float32-rounded accumulation for reference parity.
 *
 * @param {ArrayLike<number>} source
 * @returns {number}
 */
function dotPower(source) {
  let lane0 = 0
  let lane1 = 0
  let lane2 = 0
  let lane3 = 0
  for (
    let index = 0;
    index < ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES;
    index += 4
  ) {
    lane0 = Math.fround(lane0 + Math.fround(source[index] * source[index]))
    lane2 = Math.fround(
      lane2 + Math.fround(source[index + 2] * source[index + 2])
    )
    lane1 = Math.fround(
      lane1 + Math.fround(source[index + 1] * source[index + 1])
    )
    lane3 = Math.fround(
      lane3 + Math.fround(source[index + 3] * source[index + 3])
    )
  }
  return Math.fround(Math.fround(Math.fround(lane0 + lane1) + lane2) + lane3)
}

/**
 * Measure original, residual, and channel-difference power for tone gating.
 *
 * @param {number} channelCount
 * @param {ToneAnalysisScratch} scratch
 */
function measureToneFramePower(channelCount, scratch) {
  for (const power of scratch.bandPower) power.fill(0)
  scratch.bandPowerSum.fill(0)
  scratch.jointFlags.fill(0)
  scratch.mixFlags.fill(0)
  if (channelCount === 2) {
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      const powers = channelAndDifferencePower(
        scratch.sourceRows[0][band],
        scratch.sourceRows[1][band],
        scratch.powerTriplet
      )
      const leftWeight = Math.fround(powers[0] * 0.00390625)
      const rightWeight = Math.fround(powers[1] * 0.00390625)
      scratch.bandPower[0][band] = leftWeight
      scratch.bandPower[1][band] = rightWeight
      scratch.bandPowerSum[band] = Math.fround(leftWeight + rightWeight)
      const correlation = channelCorrelationDb(powers[0], powers[1], powers[2])
      if (!Number.isNaN(correlation) && correlation >= 20) {
        scratch.jointFlags[band] = 1
      } else if (!Number.isNaN(correlation) && correlation < -11) {
        scratch.jointFlags[band] = 1
        scratch.mixFlags[band] = 1
      }
    }
    return
  }
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      const weight = Math.fround(
        Number(dotPower(scratch.sourceRows[channel][band])) * 0.00390625
      )
      scratch.bandPower[channel][band] = weight
      scratch.bandPowerSum[band] = Math.fround(
        scratch.bandPowerSum[band] + weight
      )
    }
  }
}

/**
 * Derive per-channel tone fitting windows and disable joint coding when their gates disagree.
 *
 * @param {number} selectedBandCount
 * @param {ToneAnalysisScratch} scratch
 */
function planToneGates(selectedBandCount, scratch) {
  scratch.gatePresent.fill(0)
  scratch.clearJointMix.fill(0)
  scratch.resolvedJointFlags.set(scratch.jointFlags)
  scratch.resolvedMixFlags.set(scratch.mixFlags)
  for (let band = 0; band < selectedBandCount; band++) {
    for (let channel = 0; channel < CHANNELS; channel++) {
      if (!scratch.recordPresent[channel]) continue
      planToneGate(
        scratch.sourceRows[channel][band],
        scratch.detection,
        scratch.gates[channel][band]
      )
      scratch.gatePresent[channel * ANALYSIS_TONE_ANALYSIS_BANDS + band] = 1
    }
    const first = scratch.gates[0][band]
    const second = scratch.gates[1][band]
    const differs =
      first.startValid !== second.startValid ||
      first.endValid !== second.endValid ||
      first.startIndex !== second.startIndex ||
      first.endIndex !== second.endIndex
    if (scratch.jointFlags[band] !== 0 && differs) {
      scratch.clearJointMix[band] = 1
      scratch.resolvedJointFlags[band] = 0
      scratch.resolvedMixFlags[band] = 0
    }
  }
}

/**
 * Resolve the predictor tone record associated with one current channel and band.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} channel
 * @param {number} band
 * @returns {ToneSynthesisRecord|null} Active predictor record, or `null` when no history is available.
 */
function previousToneRecord(channelBlocks, channels, channel, band) {
  const block = channelBlocks[channelIndexAt(channels, channel)]
  const slot = block?.toneSlots[PREVIOUS_TONE_SLOT]
  return slot?.active ? slot.records[band] : null
}

/**
 * Combine the current tone gate with predictor history to obtain a phase-continuous analysis window.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} channel
 * @param {number} band
 * @param {ToneGate} gate
 * @param {ToneAnalysisScratch} scratch
 * @returns {ToneWindow}
 */
function planWindow(channelBlocks, channels, channel, band, gate, scratch) {
  const history = previousToneRecord(
    channelBlocks,
    channels,
    channel,
    band
  ) ?? {
    gateStartValid: 0,
    gateEndValid: 0,
    gateStartIndex: 0,
    gateEndIndex: 0,
  }
  return planToneWindow(gate, history, scratch.detection.window)
}

/**
 * Publish one accepted tone-band plan and its residual samples to the detached analysis transaction.
 *
 * @param {ToneSynthesisRecord} record
 * @param {ToneGate} gate
 * @param {ToneWindow} window
 * @param {ToneEntryPlan} entryPlan
 */
function commitBandPlan(record, gate, window, entryPlan) {
  gate.commitTo(record)
  window.commitTo(record)
  entryPlan.commitTo(record)
}

/**
 * Detect tones for one independent channel and subtract accepted sinusoids from its residual.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} band
 * @param {ArrayLike<number>} allocations
 * @param {boolean} fitEmittedFrequency
 * @param {ToneAnalysisScratch} scratch
 */
function extractIndependentBand(
  channelBlocks,
  channels,
  band,
  allocations,
  fitEmittedFrequency,
  scratch
) {
  for (let channel = 0; channel < CHANNELS; channel++) {
    if (allocations[channel] <= 0 || !scratch.recordPresent[channel]) continue
    const gate = scratch.gates[channel][band]
    const window = planWindow(
      channelBlocks,
      channels,
      channel,
      band,
      gate,
      scratch
    )
    const spectrum = scratch.detection.spectrum
    writeToneWindowedSpectrum(
      scratch.sourceRows[channel][band],
      window.leftIndex,
      window.rightIndex,
      spectrum,
      scratch.detection
    )
    scratch.detection.frequencyMask.fill(1)
    applyToneBand0UpperMask(band, spectrum, scratch.detection.frequencyMask)
    const peak = selectToneMaskedPeakBin(
      spectrum,
      scratch.detection.frequencyMask
    )
    const entries = extractToneCandidates(
      scratch.sourceRows[channel][band],
      window,
      peak,
      scratch.detection.frequencyMask,
      allocations[channel],
      fitEmittedFrequency,
      scratch.detection
    )
    commitBandPlan(scratch.records[channel][band], gate, window, entries)
  }
}

/**
 * Form the normalized sum or difference signal used to fit a joint-stereo tone candidate.
 *
 * @param {number} band
 * @param {boolean} subtract
 * @param {ToneAnalysisScratch} scratch
 */
function writeJointMix(band, subtract, scratch) {
  const first = scratch.sourceRows[0][band]
  const second = scratch.sourceRows[1][band]
  for (
    let sample = 0;
    sample < ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES;
    sample++
  ) {
    const combined = subtract
      ? Math.fround(first[sample] - second[sample])
      : Math.fround(first[sample] + second[sample])
    scratch.mixed[sample] = Math.fround(combined * JOINT_MIX_SCALE)
  }
}

/**
 * Evaluate shared and independent tone fits for a stereo band before choosing its representation.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} band
 * @param {number} allocation
 * @param {boolean} fitEmittedFrequency
 * @param {ToneAnalysisScratch} scratch
 */
function extractJointBand(
  channelBlocks,
  channels,
  band,
  allocation,
  fitEmittedFrequency,
  scratch
) {
  if (allocation <= 0 || !scratch.recordPresent[0]) return
  writeJointMix(band, scratch.resolvedMixFlags[band] !== 0, scratch)
  const gate = scratch.gates[0][band]
  const window = planWindow(channelBlocks, channels, 0, band, gate, scratch)
  const spectrum = scratch.detection.spectrum
  writeToneWindowedSpectrum(
    scratch.mixed,
    window.leftIndex,
    window.rightIndex,
    spectrum,
    scratch.detection
  )
  scratch.primarySpectrum.fill(0)
  scratch.secondarySpectrum.fill(0)
  powerSpectrum256(
    scratch.sourceRows[0][band],
    ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES,
    scratch.primarySpectrum,
    scratch.detection.dftWork
  )
  powerSpectrum256(
    scratch.sourceRows[1][band],
    ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES,
    scratch.secondarySpectrum,
    scratch.detection.dftWork
  )
  writeToneJointRatioMask(
    scratch.primarySpectrum,
    scratch.secondarySpectrum,
    scratch.detection.frequencyMask
  )
  applyToneBand0UpperMask(band, spectrum, scratch.detection.frequencyMask)
  const peak = selectToneMaskedPeakBin(
    spectrum,
    scratch.detection.frequencyMask
  )
  const entries = extractToneCandidates(
    scratch.mixed,
    window,
    peak,
    scratch.detection.frequencyMask,
    allocation,
    fitEmittedFrequency,
    scratch.detection
  )
  commitBandPlan(scratch.records[0][band], gate, window, entries)
  if (scratch.recordPresent[1]) {
    scratch.records[0][band].copyTo(scratch.records[1][band])
  }
}

/**
 * Run tone extraction only over the subbands enabled by the current tone gates.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} selectedBandCount
 * @param {number} bitrateKbps
 * @param {ToneAnalysisScratch} scratch
 */
function extractSelectedBands(
  channelBlocks,
  channels,
  selectedBandCount,
  bitrateKbps,
  scratch
) {
  planToneGates(selectedBandCount, scratch)
  const budgets = planToneExtractionBudget(
    selectedBandCount,
    scratch.resolvedJointFlags,
    scratch.detection.bandOrder,
    scratch.bandPower,
    scratch.detection
  )
  const fitEmittedFrequency = bitrateKbps >= 192
  for (let order = 0; order < selectedBandCount; order++) {
    const band = scratch.detection.bandOrder[order]
    if (band < 0 || band >= selectedBandCount) continue
    if (scratch.resolvedJointFlags[band] === 0) {
      extractIndependentBand(
        channelBlocks,
        channels,
        band,
        [budgets[0][band], budgets[1][band]],
        fitEmittedFrequency,
        scratch
      )
    } else {
      extractJointBand(
        channelBlocks,
        channels,
        band,
        budgets[0][band],
        fitEmittedFrequency,
        scratch
      )
    }
  }
  for (let band = 0; band < selectedBandCount; band++) {
    for (let channel = 0; channel < CHANNELS; channel++) {
      if (scratch.gatePresent[channel * ANALYSIS_TONE_ANALYSIS_BANDS + band]) {
        scratch.gates[channel][band].commitTo(scratch.records[channel][band])
      }
    }
  }
}

/**
 * Clear every reusable tone record before starting a new detached analysis plan.
 *
 * @param {ToneAnalysisScratch} scratch
 */
function resetAllPlanRecords(scratch) {
  for (let channel = 0; channel < CHANNELS; channel++) {
    if (!scratch.recordPresent[channel]) continue
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      resetToneRecord(scratch.records[channel][band])
    }
  }
}

/**
 * Discard the weakest accepted tones until the coding unit fits the syntax-wide entry limit.
 *
 * @param {number} channelCount
 * @param {ToneAnalysisScratch} scratch
 */
function enforceTotalEntryLimit(channelCount, scratch) {
  let totalEntries = 0
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      if (channel > 0 && scratch.jointFlags[band] !== 0) continue
      if (scratch.recordPresent[channel]) {
        totalEntries += scratch.records[channel][band].entryCount
      }
    }
  }
  if (totalEntries > 48) {
    scratch.headerBandCount = 1
    resetAllPlanRecords(scratch)
  }
}

/**
 * Synthesize previous/current tone pairs and subtract their contribution from each transform residual.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {CodingUnitChannels} channels
 * @param {number} channelCount
 * @param {ToneAnalysisScratch} scratch
 */
function planToneResiduals(channelBlocks, channels, channelCount, scratch) {
  scratch.residualPresent.fill(0)
  for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const previous = previousToneRecord(
        channelBlocks,
        channels,
        channel,
        band
      )
      const current = scratch.recordPresent[channel]
        ? scratch.records[channel][band]
        : null
      if ((previous?.entryCount ?? 0) <= 0 && (current?.entryCount ?? 0) <= 0) {
        continue
      }
      const previousSlot =
        channelBlocks[channelIndexAt(channels, channel)].toneSlots[
          PREVIOUS_TONE_SLOT
        ]
      const contribution = synthesizeTonePair(
        previous,
        current,
        previousSlot?.active ? previousSlot.shared[HEADER_AMPLITUDE_MODE] : 0,
        previousSlot?.active ? previousSlot.shared[HEADER_FREQUENCY + band] : 0,
        scratch.headerAmplitudeMode,
        scratch.resolvedMixFlags[band],
        channel,
        TONE_CROSSFADE_ENCODER_RESIDUAL,
        TONE_ACCUMULATE_FUSED,
        scratch.synthesis
      )
      writeToneResidual(
        scratch.sourceRows[channel][band],
        contribution,
        scratch.residualRows[channel][band]
      )
      scratch.residualPresent[channel * ANALYSIS_TONE_ANALYSIS_BANDS + band] = 1
    }
  }
}

/**
 * Publish accepted tone headers, records, and residual samples after every band decision is final.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {CodingUnitChannels} channels
 * @param {number} channelCount
 * @param {ToneAnalysisScratch} scratch
 */
function commitTonePlan(
  channelBlocks,
  analysisStates,
  channels,
  channelCount,
  scratch
) {
  for (let channel = 0; channel < channelCount; channel++) {
    const channelIndex = channelIndexAt(channels, channel)
    const analysis = analysisStates[channelIndex]
    const block = channelBlocks[channelIndex]
    if (!analysis || !block) continue
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      if (
        scratch.residualPresent[channel * ANALYSIS_TONE_ANALYSIS_BANDS + band]
      ) {
        analysis.bandSlots[band][TONE_RESIDUAL_SLOT].set(
          scratch.residualRows[channel][band]
        )
      }
    }
    const slot = block.toneSlots[CURRENT_TONE_SLOT]
    if (!slot?.active || !scratch.recordPresent[channel]) continue
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      scratch.records[channel][band].copyTo(slot.records[band])
    }
    slot.shared[HEADER_ENABLE] = scratch.headerEnabled
    slot.shared[HEADER_AMPLITUDE_MODE] = scratch.headerAmplitudeMode
    slot.shared[HEADER_BAND_COUNT] = scratch.headerBandCount
    for (let band = 0; band < ANALYSIS_TONE_ANALYSIS_BANDS; band++) {
      slot.shared[HEADER_JOINT + band] = scratch.resolvedJointFlags[band]
      slot.shared[HEADER_FREQUENCY + band] = scratch.resolvedMixFlags[band]
    }
  }
}

/**
 * Plan and atomically commit one detached coding unit's tone transaction.
 *
 * @param {EncodeChannelState[]} channelBlocks Detached encoder channel blocks.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {CodingUnitChannels|ArrayLike<number>} channels Coding-unit channel indices.
 * @param {number} channelMode Coding-unit channel mode.
 * @param {number} toneAnalysisEnabled Tone extraction enable flag.
 * @param {number} bitrateKbps Stream bitrate in kilobits per second.
 * @param {ToneAnalysisScratch} scratch Reusable tone transaction.
 * @returns {ToneAnalysisScratch} The committed transaction storage.
 */
export function analyzeTones(
  channelBlocks,
  analysisStates,
  channels,
  channelMode,
  toneAnalysisEnabled,
  bitrateKbps,
  scratch
) {
  const channelCount = channels?.length ?? 0
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > CHANNELS ||
    !Number.isInteger(channelMode) ||
    !Number.isInteger(toneAnalysisEnabled) ||
    !Number.isInteger(bitrateKbps) ||
    !scratch?.detection ||
    !scratch?.synthesis
  ) {
    throw new RangeError('ATRAC3plus tone analysis request is invalid')
  }
  if (channelMode === 4) return scratch
  if (toneAnalysisEnabled !== 0 && channelCount < 2) {
    throw new RangeError('ATRAC3plus tone extraction requires stereo')
  }

  captureToneSource(channelBlocks, analysisStates, channels, scratch)
  measureToneFramePower(channelCount, scratch)
  const selectedBandCount = selectToneBandCount(
    toneAnalysisEnabled !== 0,
    scratch.bandPowerSum,
    ANALYSIS_TONE_ANALYSIS_BANDS
  )
  orderToneBands(
    scratch.bandPowerSum,
    selectedBandCount,
    scratch.detection.bandOrder
  )
  scratch.headerEnabled = toneAnalysisEnabled !== 0 ? 1 : 0
  scratch.headerAmplitudeMode = INDEPENDENT_AMPLITUDE_MODE
  scratch.headerBandCount = selectedBandCount
  scratch.resolvedJointFlags.set(scratch.jointFlags)
  scratch.resolvedMixFlags.set(scratch.mixFlags)

  if (toneAnalysisEnabled !== 0) {
    extractSelectedBands(
      channelBlocks,
      channels,
      selectedBandCount,
      bitrateKbps,
      scratch
    )
    enforceTotalEntryLimit(channelCount, scratch)
  }
  planToneResiduals(channelBlocks, channels, channelCount, scratch)
  commitTonePlan(channelBlocks, analysisStates, channels, channelCount, scratch)
  return scratch
}
