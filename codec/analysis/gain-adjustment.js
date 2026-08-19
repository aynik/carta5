/** ATRAC3plus low-rate gain adjustment, exact lowering, and publication. */

import {
  GainRecordPlan,
  gainRecordIsActive,
  gainRecordPairIsActive,
} from '../coding/gain.js'
import {
  captureGainSyntaxModes,
  measureGainSyntaxBitsWithModes,
  selectGainSyntax,
} from '../io/gain-syntax.js'
import {
  applyForwardGainScale,
  reconstructForwardGainScale,
} from '../transforms/gain-scale.js'
import {
  compareSignalsExact,
  comparePeakEnvelopeCandidate,
  loadPeakEnvelopeReference,
} from './perceptual.js'
import {
  gainPeakOverflows,
  buildGainOverflowStateFrontier,
  collectGainLevelDropEntries,
  loadGainOverflowState,
  normalizeOverflowGainRecord,
  selectOverflowPathCandidate,
} from './gain-overflow.js'
import {
  adjustBand0RecordFromBand1,
  recordMergeHasTemporalSupport,
  planCloseRecordFromPeer,
  planCloseRecordsBetweenChannels,
} from './gain-record-policy.js'
import {
  BAND0_MAX_NO_EDIT_CHANGE_ENERGY_PER_BIT,
  GAIN_BAND_COUNT,
  GAIN_EVENT_SAMPLE_OFFSET,
  GAIN_EVENT_SAMPLES_PER_BLOCK,
  ANALYSIS_GAIN_ADJUSTMENT_GAIN_MAX_CHANNELS,
  ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES,
  RECORD_MERGE_MAX_FINAL_CHANGE_ENERGY_RATIO,
  RECORD_MERGE_STRICT_SHAPE_ERROR,
  STEREO_MERGE_MAX_CHANGE_ENERGY_PER_BIT,
} from '../core/constants.js'

/**
 * Ordered maximum magnitude across the fixed gain window.
 *
 * @param {Float32Array} source Gain-window samples.
 * @returns {number} Maximum finite magnitude.
 */
export function maximumGainWindowMagnitude(source) {
  if (
    !(source instanceof Float32Array) ||
    source.length < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus gain window must contain 256 samples')
  }
  let maximum = 0
  for (
    let sample = 0;
    sample < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES;
    sample++
  ) {
    const magnitude = Math.fround(Math.abs(source[sample]))
    if (!Number.isNaN(magnitude) && magnitude > maximum) maximum = magnitude
  }
  return maximum
}

/**
 * Measure the maximum after applying an adjacent gain-record pair.
 *
 * @param {Float32Array} source Gain-window samples.
 * @param {GainRecord} previousRecord Previous-frame gain record.
 * @param {GainRecord} currentRecord Current-frame gain record.
 * @param {LowRateGainScratch} scratch Reusable scale work.
 * @returns {number|null} Scaled maximum, or `null` for invalid syntax.
 */
export function maximumGainScaledMagnitude(
  source,
  previousRecord,
  currentRecord,
  scratch
) {
  if (
    !(source instanceof Float32Array) ||
    source.length < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus gain window must contain 256 samples')
  }
  const firstChange = reconstructForwardGainScale(
    previousRecord,
    currentRecord,
    scratch.gainScale.scale,
    scratch.gainScale.steps
  )
  if (firstChange === null) return null
  const scaledEnd = Math.min(
    firstChange,
    ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES - 1
  )
  let maximum = 0
  for (
    let sample = 0;
    sample < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES;
    sample++
  ) {
    const value =
      sample <= scaledEnd
        ? Math.fround(source[sample] * scratch.gainScale.scale[sample])
        : source[sample]
    const magnitude = Math.fround(Math.abs(value))
    if (!Number.isNaN(magnitude) && magnitude > maximum) maximum = magnitude
  }
  return maximum
}

/**
 * Apply the planned gain envelope to the source samples used for perceptual candidate comparison.
 *
 * @param {Float32Array} source
 * @param {GainRecord} previousRecord
 * @param {GainRecord} currentRecord
 * @param {Float32Array} destination
 * @param {LowRateGainScratch} scratch
 * @returns {boolean}
 */
function materializeGainScaled(
  source,
  previousRecord,
  currentRecord,
  destination,
  scratch
) {
  for (
    let sample = 0;
    sample < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES;
    sample++
  ) {
    destination[sample] = source[sample]
  }
  if (!gainRecordPairIsActive(previousRecord, currentRecord)) return true
  return (
    applyForwardGainScale(
      previousRecord,
      currentRecord,
      destination,
      scratch.gainScale
    ) !== null
  )
}

/**
 * Compare one current-record alternative in reconstructed sample space.
 *
 * @param {Float32Array} source Gain-window samples.
 * @param {GainRecord} previousRecord Previous-frame record.
 * @param {GainRecord} incumbentRecord Current incumbent record.
 * @param {GainRecord} candidateRecord Candidate replacement record.
 * @param {LowRateGainScratch} scratch Reusable comparison work.
 * @returns {SignalComparison|null} Exact comparison, or `null` if invalid.
 */
export function compareGainRecordAlternative(
  source,
  previousRecord,
  incumbentRecord,
  candidateRecord,
  scratch
) {
  if (
    !materializeGainScaled(
      source,
      previousRecord,
      incumbentRecord,
      scratch.incumbent,
      scratch
    ) ||
    !materializeGainScaled(
      source,
      previousRecord,
      candidateRecord,
      scratch.candidate,
      scratch
    )
  ) {
    return null
  }
  return compareSignalsExact(
    scratch.candidate,
    scratch.incumbent,
    scratch.effect
  )
}

/**
 * Copy every signal-error metric into detached comparison storage.
 *
 * @param {SignalComparison} source
 * @param {SignalComparison} destination
 * @returns {SignalComparison}
 */
function copySignalComparison(source, destination) {
  destination.referenceEnergy = source.referenceEnergy
  destination.candidateEnergy = source.candidateEnergy
  destination.differenceEnergy = source.differenceEnergy
  destination.relativeDifferenceEnergy = source.relativeDifferenceEnergy
  destination.shapeError = source.shapeError
  return destination
}

/**
 * Resolve the current and predictor gain records used to price one coding candidate.
 *
 * @param {(EncodeChannelState|GainCandidateBlock)[]} blocks
 * @param {number} channelCount
 * @param {LowRateGainScratch} scratch
 * @returns {(EncodeChannelState|GainCandidateBlock)[]}
 */
function gainCodingSources(blocks, channelCount, scratch) {
  const sources =
    channelCount === 1 ? scratch.monoSources : scratch.stereoSources
  for (let channel = 0; channel < channelCount; channel++) {
    sources[channel] = blocks[channel]
  }
  return sources
}

/**
 * Copy candidate block into reusable destination storage without retaining source-owned views.
 *
 * @param {EncodeChannelState|GainCandidateBlock} source
 * @param {GainCandidateBlock} destination
 * @returns {GainCandidateBlock}
 */
function copyCandidateBlock(source, destination) {
  destination.channelOrdinal = source.channelOrdinal
  for (let band = 0; band < GAIN_BAND_COUNT; band++) {
    source.currentGainRecords[band].copyTo(destination.currentGainRecords[band])
    source.previousGainRecords[band].copyTo(
      destination.previousGainRecords[band]
    )
  }
  return destination
}

/**
 * Copy candidate blocks into reusable destination storage without retaining source-owned views.
 *
 * @param {(EncodeChannelState|GainCandidateBlock)[]} source
 * @param {GainCandidateBlock[]} destination
 * @param {number} channelCount
 * @returns {GainCandidateBlock[]}
 */
function copyCandidateBlocks(source, destination, channelCount) {
  for (let channel = 0; channel < channelCount; channel++) {
    copyCandidateBlock(source[channel], destination[channel])
  }
  return destination
}

/**
 * Copy candidate current records into reusable destination storage without retaining source-owned views.
 *
 * @param {GainCandidateBlock[]} source
 * @param {GainCandidateBlock[]} destination
 * @param {number} channelCount
 * @returns {GainCandidateBlock[]}
 */
function copyCandidateCurrentRecords(source, destination, channelCount) {
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < GAIN_BAND_COUNT; band++) {
      source[channel].currentGainRecords[band].copyTo(
        destination[channel].currentGainRecords[band]
      )
    }
  }
  return destination
}

/**
 * Reconstruct one analysis band through its previous and current gain records into reusable comparison samples.
 *
 * @param {EncodeAnalysisState} analysis
 * @param {number} band
 * @param {LowRateGainScratch} scratch
 * @returns {Float32Array}
 */
function loadGainBand(analysis, band, scratch) {
  analysis.copyBandSamples(band, 0, scratch.source)
  return scratch.source
}

/**
 * Compare a candidate with its neighboring band and report the resulting peak-envelope change.
 *
 * @param {EncodeAnalysisState} analysis
 * @param {number} sourceBand
 * @param {LowRateGainScratch} scratch
 * @returns {PeakEnvelopeComparison}
 */
function neighborPeakEffect(analysis, sourceBand, scratch) {
  loadPeakEnvelopeReference(
    scratch.source,
    GAIN_EVENT_SAMPLE_OFFSET,
    GAIN_EVENT_SAMPLES_PER_BLOCK,
    scratch.peakEnvelopes
  )
  loadGainBand(analysis, sourceBand, scratch)
  return comparePeakEnvelopeCandidate(
    scratch.source,
    GAIN_EVENT_SAMPLE_OFFSET,
    GAIN_EVENT_SAMPLES_PER_BLOCK,
    scratch.peakEnvelopes
  )
}

/**
 * Measure how a paired-channel gain edit changes the reconstructed stereo peak envelope.
 *
 * @param {EncodeAnalysisState} left
 * @param {EncodeAnalysisState} right
 * @param {number} band
 * @param {LowRateGainScratch} scratch
 * @returns {PeakEnvelopeComparison}
 */
function stereoPeakEffect(left, right, band, scratch) {
  loadGainBand(left, band, scratch)
  loadPeakEnvelopeReference(
    scratch.source,
    GAIN_EVENT_SAMPLE_OFFSET,
    GAIN_EVENT_SAMPLES_PER_BLOCK,
    scratch.peakEnvelopes
  )
  loadGainBand(right, band, scratch)
  return comparePeakEnvelopeCandidate(
    scratch.source,
    GAIN_EVENT_SAMPLE_OFFSET,
    GAIN_EVENT_SAMPLES_PER_BLOCK,
    scratch.peakEnvelopes
  )
}

/**
 * Combine the local and neighboring measurements into one complete alternative score.
 *
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {GainCandidateBlock[]} incumbentBlocks
 * @param {GainCandidateBlock[]} candidateBlocks
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {LowRateGainScratch} scratch
 * @returns {SignalComparison}
 */
function completeAlternativeEffect(
  analysisStates,
  incumbentBlocks,
  candidateBlocks,
  channelCount,
  bandCount,
  scratch
) {
  let offset = 0
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < bandCount; band++) {
      loadGainBand(analysisStates[channel], band, scratch)
      materializeGainScaled(
        scratch.source,
        incumbentBlocks[channel].previousGainRecords[band],
        incumbentBlocks[channel].currentGainRecords[band],
        scratch.incumbent,
        scratch
      )
      materializeGainScaled(
        scratch.source,
        candidateBlocks[channel].previousGainRecords[band],
        candidateBlocks[channel].currentGainRecords[band],
        scratch.candidate,
        scratch
      )
      for (
        let sample = 0;
        sample < ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES;
        sample++
      ) {
        scratch.completeIncumbent[offset] = scratch.incumbent[sample]
        scratch.completeCandidate[offset] = scratch.candidate[sample]
        offset++
      }
    }
  }
  return compareSignalsExact(
    scratch.completeCandidate,
    scratch.completeIncumbent,
    scratch.effect,
    offset
  )
}

/**
 * Select and retain the incumbent gain price without keeping another detached record plan.
 *
 * @param {(EncodeChannelState|GainCandidateBlock)[]} sources Gain-record sources by channel.
 * @param {number} recordCount Active gain-record count.
 * @param {number} coreMode Profile core-mode selector.
 * @param {LowRateGainScratch} scratch Reusable gain adjustment storage.
 * @returns {number} Exact selected gain-section width in bits.
 */
function selectIncumbentGainSyntax(sources, recordCount, coreMode, scratch) {
  const pricing = scratch.syntaxPricing
  selectGainSyntax(sources, recordCount, coreMode, pricing.workspace)
  pricing.incumbentBits = pricing.workspace.bits
  captureGainSyntaxModes(pricing.workspace, pricing.incumbentModes)
  return pricing.incumbentBits
}

/**
 * Promote the optimized syntax currently held in the shared pricing workspace.
 *
 * @param {LowRateGainScratch} scratch Reusable gain adjustment storage.
 */
function commitOptimizedGainSyntax(scratch) {
  const pricing = scratch.syntaxPricing
  pricing.incumbentBits = pricing.workspace.bits
  captureGainSyntaxModes(pricing.workspace, pricing.incumbentModes)
}

/**
 * Price fixed and optimized syntax for a lowered gain candidate and retain the cheaper admissible alternative.
 *
 * @param {GainCandidateBlock[]} candidateBlocks
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {SignalComparison} effect
 * @param {LowRateGainScratch} scratch
 * @returns {GainLoweredAlternative}
 */
function priceLoweredAlternative(
  candidateBlocks,
  channelCount,
  bandCount,
  coreMode,
  effect,
  scratch
) {
  const pricing = scratch.syntaxPricing
  scratch.lowered.incumbentBits = pricing.incumbentBits
  const sources = gainCodingSources(candidateBlocks, channelCount, scratch)
  scratch.lowered.fixedModeBits = measureGainSyntaxBitsWithModes(
    sources,
    bandCount,
    coreMode,
    pricing.incumbentModes,
    pricing.workspace
  )
  selectGainSyntax(sources, bandCount, coreMode, pricing.workspace)
  scratch.lowered.optimizedBits = pricing.workspace.bits
  copySignalComparison(effect, scratch.loweredEffect)
  return scratch.lowered
}

/**
 * Report whether an alternative stays within the permitted bit-rate increase.
 *
 * @param {number} incumbentBits
 * @param {number} candidateBits
 * @param {SignalComparison} effect
 * @param {number} maximumRatio
 * @returns {boolean}
 */
function isRateBounded(incumbentBits, candidateBits, effect, maximumRatio) {
  return (
    candidateBits <= incumbentBits &&
    effect.relativeDifferenceEnergy <= maximumRatio
  )
}

/**
 * Report whether the saved bits justify the alternative's measured signal error.
 *
 * @param {number} incumbentBits
 * @param {number} candidateBits
 * @param {SignalComparison} effect
 * @param {number} maximumPerBit
 * @returns {boolean}
 */
function isRateSavingEfficient(
  incumbentBits,
  candidateBits,
  effect,
  maximumPerBit
) {
  const bitsSaved = incumbentBits - candidateBits
  return (
    bitsSaved > 0 &&
    effect.relativeDifferenceEnergy / bitsSaved <= maximumPerBit
  )
}

/**
 * Combine paired-channel gain records into one detached stereo candidate.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} bandCount
 * @param {LowRateGainScratch} scratch
 * @returns {number}
 */
function mergeStereoBandRecords(
  channelBlocks,
  analysisStates,
  bandCount,
  scratch
) {
  const frontier = scratch.stereoFrontier
  frontier.count = 0
  for (let band = 0; band < bandCount; band++) {
    const primary = channelBlocks[0].currentGainRecords[band]
    const secondary = channelBlocks[1].currentGainRecords[band]
    const planned = planCloseRecordsBetweenChannels(
      primary,
      secondary,
      scratch.recordPolicy
    )
    const candidate =
      !planned[0].codedEquals(primary) || !planned[1].codedEquals(secondary)
    const effect = candidate
      ? stereoPeakEffect(analysisStates[0], analysisStates[1], band, scratch)
      : null
    const selected = effect && recordMergeHasTemporalSupport(effect)
    if (effect && !selected) {
      const index = frontier.count++
      frontier.bands[index] = band
      planned[0].copyTo(frontier.records[index][0])
      planned[1].copyTo(frontier.records[index][1])
    }
    if (selected) {
      planned[0].copyTo(primary)
      planned[1].copyTo(secondary)
    }
  }
  return frontier.count
}

/**
 * Combine neighboring-band gain records into a detached candidate and normalize its ordering.
 *
 * @param {GainRecord[]} currentRecords
 * @param {EncodeAnalysisState} analysis
 * @param {number} channel
 * @param {number} bandLimit
 * @param {LowRateGainScratch} scratch
 * @returns {number}
 */
function mergeAdjacentBandRecords(
  currentRecords,
  analysis,
  channel,
  bandLimit,
  scratch
) {
  const frontier = scratch.adjacentFrontier
  frontier.counts[channel] = 0
  if (bandLimit <= 3) return 0
  for (let band = 2; band < bandLimit - 1; band++) {
    const current = currentRecords[band]
    current.copyTo(scratch.temporaryRecord)
    if (
      !planCloseRecordFromPeer(
        current,
        currentRecords[band + 1],
        scratch.recordPolicy.mergedRecord
      )
    ) {
      continue
    }
    loadGainBand(analysis, band, scratch)
    const effect = neighborPeakEffect(analysis, band + 1, scratch)
    const selected = recordMergeHasTemporalSupport(effect)
    if (selected) scratch.recordPolicy.mergedRecord.copyTo(current)
    if (selected && effect.shapeError > RECORD_MERGE_STRICT_SHAPE_ERROR) {
      const index = frontier.counts[channel]++
      frontier.bands[channel][index] = band
      scratch.temporaryRecord.copyTo(frontier.records[channel][index])
    }
  }
  return frontier.counts[channel]
}

/**
 * Return the nested gain workspace required for recursive candidate measurement, rejecting aliasing.
 *
 * @param {LowRateGainScratch} scratch
 * @returns {LowRateGainScratch}
 */
function requireNestedGainScratch(scratch) {
  if (!scratch.nested) {
    throw new Error('ATRAC3plus gain adjustment exceeded nested scratch depth')
  }
  return scratch.nested
}

/**
 * Construct and price the next lower-cost paired-channel gain merge.
 *
 * @param {GainCandidateBlock[]} postStereoBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {number} frontierIndex
 * @param {LowRateGainScratch} scratch
 * @returns {GainLoweredAlternative}
 */
function lowerStereoMergeAlternative(
  postStereoBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  frontierIndex,
  scratch
) {
  const candidateBlocks = copyCandidateBlocks(
    postStereoBlocks,
    scratch.candidateBlocks,
    channelCount
  )
  const band = scratch.stereoFrontier.bands[frontierIndex]
  for (let channel = 0; channel < channelCount; channel++) {
    scratch.stereoFrontier.records[frontierIndex][channel].copyTo(
      candidateBlocks[channel].currentGainRecords[band]
    )
  }
  applyPostStereoGainAdjust(
    candidateBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    requireNestedGainScratch(scratch)
  )
  const effect = completeAlternativeEffect(
    analysisStates,
    finalBlocks,
    candidateBlocks,
    channelCount,
    bandCount,
    scratch
  )
  return priceLoweredAlternative(
    candidateBlocks,
    channelCount,
    bandCount,
    coreMode,
    effect,
    scratch
  )
}

/**
 * Commit stereo gain merges whose reconstructed error remains within the rate bound.
 *
 * @param {GainCandidateBlock[]} postStereoBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function applyRateBoundedStereoMergeAlternatives(
  postStereoBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  selectIncumbentGainSyntax(
    gainCodingSources(finalBlocks, channelCount, scratch),
    bandCount,
    coreMode,
    scratch
  )
  for (
    let frontierIndex = 0;
    frontierIndex < scratch.stereoFrontier.count;
    frontierIndex++
  ) {
    const lowered = lowerStereoMergeAlternative(
      postStereoBlocks,
      finalBlocks,
      analysisStates,
      channelCount,
      bandCount,
      coreMode,
      frontierIndex,
      scratch
    )
    const selected = isRateSavingEfficient(
      lowered.incumbentBits,
      lowered.optimizedBits,
      scratch.loweredEffect,
      STEREO_MERGE_MAX_CHANGE_ENERGY_PER_BIT
    )
    if (!selected) continue
    const band = scratch.stereoFrontier.bands[frontierIndex]
    for (let channel = 0; channel < channelCount; channel++) {
      scratch.stereoFrontier.records[frontierIndex][channel].copyTo(
        postStereoBlocks[channel].currentGainRecords[band]
      )
    }
    copyCandidateCurrentRecords(
      scratch.candidateBlocks,
      finalBlocks,
      channelCount
    )
    commitOptimizedGainSyntax(scratch)
  }
}

/**
 * Construct and price a reduced gain record for one channel and band.
 *
 * @param {GainCandidateBlock[]} preOverflowBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {number} channel
 * @param {number} band
 * @param {GainRecord} record
 * @param {LowRateGainScratch} scratch
 * @returns {GainLoweredAlternative}
 */
function lowerGainRecordAlternative(
  preOverflowBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  channel,
  band,
  record,
  scratch
) {
  const candidateBlocks = copyCandidateBlocks(
    preOverflowBlocks,
    scratch.candidateBlocks,
    channelCount
  )
  record.copyTo(candidateBlocks[channel].currentGainRecords[band])
  reduceGainOverflow(
    candidateBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    requireNestedGainScratch(scratch)
  )
  const candidateRecord = candidateBlocks[channel].currentGainRecords[band]
  loadGainBand(analysisStates[channel], band, scratch)
  const effect = compareGainRecordAlternative(
    scratch.source,
    finalBlocks[channel].previousGainRecords[band],
    finalBlocks[channel].currentGainRecords[band],
    candidateRecord,
    scratch
  )
  if (!effect) {
    throw new Error('ATRAC3plus gain alternative could not be reconstructed')
  }
  return priceLoweredAlternative(
    candidateBlocks,
    channelCount,
    bandCount,
    coreMode,
    effect,
    scratch
  )
}

/**
 * Publish a previously measured lower-cost gain candidate into the incumbent blocks.
 *
 * @param {GainCandidateBlock[]} preOverflowBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {number} channelCount
 * @param {number} channel
 * @param {number} band
 * @param {GainRecord} record
 * @param {LowRateGainScratch} scratch
 */
function commitLoweredGainAlternative(
  preOverflowBlocks,
  finalBlocks,
  channelCount,
  channel,
  band,
  record,
  scratch
) {
  record.copyTo(preOverflowBlocks[channel].currentGainRecords[band])
  copyCandidateCurrentRecords(
    scratch.candidateBlocks,
    finalBlocks,
    channelCount
  )
  commitOptimizedGainSyntax(scratch)
}

/**
 * Accept a gain-record edit only when its bit saving and signal error pass policy.
 *
 * @param {GainCandidateBlock[]} preOverflowBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {number} channel
 * @param {number} band
 * @param {GainRecord} record
 * @param {LowRateGainScratch} scratch
 * @param {number} acceptance
 * @param {number} threshold
 * @returns {boolean}
 */
function applyGainRecordAlternative(
  preOverflowBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  channel,
  band,
  record,
  scratch,
  acceptance,
  threshold
) {
  const lowered = lowerGainRecordAlternative(
    preOverflowBlocks,
    finalBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    channel,
    band,
    record,
    scratch
  )
  const accepted =
    acceptance === 0
      ? isRateSavingEfficient(
          lowered.incumbentBits,
          lowered.fixedModeBits,
          scratch.loweredEffect,
          threshold
        )
      : isRateBounded(
          lowered.incumbentBits,
          lowered.fixedModeBits,
          scratch.loweredEffect,
          threshold
        )
  if (accepted) {
    commitLoweredGainAlternative(
      preOverflowBlocks,
      finalBlocks,
      channelCount,
      channel,
      band,
      record,
      scratch
    )
  }
  return accepted
}

/**
 * Retain unchanged band-zero records when they are more efficient than proposed edits.
 *
 * @param {GainCandidateBlock[]} preOverflowBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function applyEfficientBand0NoEdits(
  preOverflowBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  let any = false
  for (let channel = 0; channel < channelCount; channel++) {
    any ||= scratch.band0FrontierActive[channel] !== 0
  }
  if (!any) return
  selectIncumbentGainSyntax(
    gainCodingSources(finalBlocks, channelCount, scratch),
    bandCount,
    coreMode,
    scratch
  )
  for (let channel = 0; channel < channelCount; channel++) {
    if (scratch.band0FrontierActive[channel] === 0) continue
    applyGainRecordAlternative(
      preOverflowBlocks,
      finalBlocks,
      analysisStates,
      channelCount,
      bandCount,
      coreMode,
      channel,
      0,
      scratch.band0FrontierRecords[channel],
      scratch,
      0,
      BAND0_MAX_NO_EDIT_CHANGE_ENERGY_PER_BIT
    )
  }
}

/**
 * Commit neighboring-band gain merges that stay within the configured error bound.
 *
 * @param {GainCandidateBlock[]} preOverflowBlocks
 * @param {GainCandidateBlock[]} finalBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function applyRateBoundedAdjacentMergeKeeps(
  preOverflowBlocks,
  finalBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  let any = false
  for (let channel = 0; channel < channelCount; channel++) {
    any ||= scratch.adjacentFrontier.counts[channel] !== 0
  }
  if (!any) return
  selectIncumbentGainSyntax(
    gainCodingSources(finalBlocks, channelCount, scratch),
    bandCount,
    coreMode,
    scratch
  )
  for (let channel = 0; channel < channelCount; channel++) {
    const count = scratch.adjacentFrontier.counts[channel]
    for (let index = 0; index < count; index++) {
      applyGainRecordAlternative(
        preOverflowBlocks,
        finalBlocks,
        analysisStates,
        channelCount,
        bandCount,
        coreMode,
        channel,
        scratch.adjacentFrontier.bands[channel][index],
        scratch.adjacentFrontier.records[channel][index],
        scratch,
        1,
        RECORD_MERGE_MAX_FINAL_CHANGE_ENERGY_RATIO
      )
    }
  }
}

/**
 * Follow the bounded reduction frontier until the incumbent gain syntax fits its budget.
 *
 * @param {GainRecord} record
 * @param {GainRecord} previousRecord
 * @param {number} sourcePeak
 * @param {number} currentPeak
 * @param {number} initialEntry
 * @param {GainRecord} destination
 * @param {LowRateGainScratch} scratch
 * @returns {number}
 */
function convergeGainOverflowPath(
  record,
  previousRecord,
  sourcePeak,
  currentPeak,
  initialEntry,
  destination,
  scratch
) {
  record.copyTo(destination)
  let firstEntry = initialEntry
  while (
    gainRecordIsActive(destination) &&
    gainPeakOverflows(sourcePeak, currentPeak)
  ) {
    let entry = firstEntry
    firstEntry = -1
    if (entry < 0) {
      const count = collectGainLevelDropEntries(
        destination,
        scratch.overflow.dropEntries
      )
      if (count === 0) break
      entry = scratch.overflow.dropEntries[0]
    }
    destination.levels[entry]--
    normalizeOverflowGainRecord(destination)
    currentPeak = maximumGainScaledMagnitude(
      scratch.source,
      previousRecord,
      destination,
      scratch
    )
    if (currentPeak === null) {
      throw new Error('ATRAC3plus gain overflow path is unrepresentable')
    }
  }
  return currentPeak
}

/**
 * Seed the overflow frontier from the incumbent gain record and retain the best path that reaches budget.
 *
 * @param {GainRecord} record
 * @param {GainRecord} previousRecord
 * @param {number} sourcePeak
 * @param {number} currentPeak
 * @param {ArrayLike<number>} initialEntries
 * @param {number} initialCount
 * @param {LowRateGainScratch} scratch
 * @returns {number}
 */
function planIncumbentGainOverflowPath(
  record,
  previousRecord,
  sourcePeak,
  currentPeak,
  initialEntries,
  initialCount,
  scratch
) {
  const candidates = scratch.overflowIncumbentCandidates
  let candidateCount = 0
  for (let index = 0; index < initialCount; index++) {
    const candidate = candidates[candidateCount]
    candidate.peak = convergeGainOverflowPath(
      record,
      previousRecord,
      sourcePeak,
      currentPeak,
      initialEntries[index],
      candidate.record,
      scratch
    )
    let duplicate = false
    for (let prior = 0; prior < candidateCount; prior++) {
      if (candidates[prior].record.codedEquals(candidate.record)) {
        duplicate = true
        break
      }
    }
    if (duplicate) continue
    const effect = compareGainRecordAlternative(
      scratch.source,
      previousRecord,
      record,
      candidate.record,
      scratch
    )
    if (!effect) {
      throw new Error('ATRAC3plus gain overflow incumbent is unrepresentable')
    }
    copySignalComparison(effect, candidate.effect)
    candidate.syntaxBits = null
    candidateCount++
  }
  scratch.overflowIncumbentCount = candidateCount
  const selected = selectOverflowPathCandidate(
    candidates,
    candidateCount,
    sourcePeak,
    null
  )
  if (selected < 0) {
    throw new Error('ATRAC3plus gain overflow lacks an incumbent path')
  }
  return selected
}

/**
 * Reconstruct one overflow candidate and measure its maximum gain-scaled magnitude.
 *
 * @param {GainRecord} record
 * @param {LowRateGainScratch} scratch
 * @returns {number}
 */
function measureOverflowCandidatePeak(record, scratch) {
  const peak = maximumGainScaledMagnitude(
    scratch.source,
    scratch.overflowPreviousRecord,
    record,
    scratch
  )
  if (peak === null) {
    throw new Error('ATRAC3plus gain overflow candidate is unrepresentable')
  }
  return peak
}

/**
 * Choose the in-budget terminal gain state with the lowest measured signal error.
 *
 * @param {GainOverflowScratch} overflow
 * @param {number} sourcePeak
 * @returns {number}
 */
function selectOverflowTerminalCandidate(overflow, sourcePeak) {
  let safeCount = 0
  let soleSafe = -1
  for (let index = 0; index < overflow.candidateCount; index++) {
    const state = overflow.candidateStateIndices[index]
    if (!gainPeakOverflows(sourcePeak, overflow.peaks[state])) {
      safeCount++
      soleSafe = index
    }
  }
  if (safeCount === 1) return soleSafe
  let selected = -1
  let lowest = Number.POSITIVE_INFINITY
  for (let index = 0; index < overflow.candidateCount; index++) {
    const state = overflow.candidateStateIndices[index]
    const safe = !gainPeakOverflows(sourcePeak, overflow.peaks[state])
    if (safeCount > 1 && !safe) continue
    let cost =
      safeCount > 1
        ? overflow.candidateDifferenceEnergies[index]
        : overflow.peaks[state]
    if (!Number.isFinite(cost)) cost = Number.POSITIVE_INFINITY
    if (selected < 0 || cost < lowest) {
      selected = index
      lowest = cost
    }
  }
  return selected
}

/**
 * Find the measured overflow candidate whose gain record exactly matches the requested state.
 *
 * @param {GainOverflowScratch} overflow
 * @param {GainRecord} record
 * @returns {number}
 */
function findOverflowCandidateByRecord(overflow, record) {
  for (let index = 0; index < overflow.candidateCount; index++) {
    loadGainOverflowState(
      overflow,
      overflow.candidateStateIndices[index],
      overflow.candidateRecord
    )
    if (overflow.candidateRecord.codedEquals(record)) return index
  }
  return -1
}

/**
 * Search the bounded gain frontier and materialize the selected sequence of record reductions.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {number} channel
 * @param {number} band
 * @param {GainRecord} record
 * @param {GainRecord} previousRecord
 * @param {number} sourcePeak
 * @param {number} currentPeak
 * @param {LowRateGainScratch} scratch
 * @returns {GainRecord}
 */
function planGainOverflowReduction(
  channelBlocks,
  channelCount,
  bandCount,
  coreMode,
  channel,
  band,
  record,
  previousRecord,
  sourcePeak,
  currentPeak,
  scratch
) {
  const overflow = scratch.overflow
  const initialCount = collectGainLevelDropEntries(record, overflow.dropEntries)
  if (initialCount === 0) {
    record.copyTo(scratch.selectedRecord)
    return scratch.selectedRecord
  }
  if (initialCount === 1) {
    convergeGainOverflowPath(
      record,
      previousRecord,
      sourcePeak,
      currentPeak,
      overflow.dropEntries[0],
      scratch.selectedRecord,
      scratch
    )
    return scratch.selectedRecord
  }

  const incumbentIndex = planIncumbentGainOverflowPath(
    record,
    previousRecord,
    sourcePeak,
    currentPeak,
    overflow.dropEntries,
    initialCount,
    scratch
  )
  const incumbentRecord =
    scratch.overflowIncumbentCandidates[incumbentIndex].record
  previousRecord.copyTo(scratch.overflowPreviousRecord)
  buildGainOverflowStateFrontier(
    record,
    sourcePeak,
    currentPeak,
    overflow,
    measureOverflowCandidatePeak,
    scratch
  )
  overflow.candidateCount = overflow.terminalCount
  overflow.candidateSyntaxBits.fill(-1, 0, overflow.candidateCount)
  for (let index = 0; index < overflow.candidateCount; index++) {
    const state = overflow.terminalIndices[index]
    overflow.candidateStateIndices[index] = state
    loadGainOverflowState(overflow, state, overflow.candidateRecord)
    const effect = compareGainRecordAlternative(
      scratch.source,
      previousRecord,
      record,
      overflow.candidateRecord,
      scratch
    )
    if (!effect) {
      throw new Error('ATRAC3plus gain overflow terminal is unrepresentable')
    }
    overflow.candidateDifferenceEnergies[index] = effect.differenceEnergy
  }

  const incumbentCandidate = findOverflowCandidateByRecord(
    overflow,
    incumbentRecord
  )
  if (incumbentCandidate < 0) {
    throw new Error('ATRAC3plus gain overflow lost its incumbent terminal')
  }
  const unrestrictedCandidate = selectOverflowTerminalCandidate(
    overflow,
    sourcePeak
  )
  if (unrestrictedCandidate < 0) {
    throw new Error('ATRAC3plus gain overflow lacks a terminal candidate')
  }
  let selectedCandidate = incumbentCandidate
  if (unrestrictedCandidate !== incumbentCandidate) {
    loadGainOverflowState(
      overflow,
      overflow.candidateStateIndices[incumbentCandidate],
      channelBlocks[channel].currentGainRecords[band]
    )
    const incumbentBits = selectIncumbentGainSyntax(
      gainCodingSources(channelBlocks, channelCount, scratch),
      bandCount,
      coreMode,
      scratch
    )
    overflow.candidateSyntaxBits[incumbentCandidate] = incumbentBits

    loadGainOverflowState(
      overflow,
      overflow.candidateStateIndices[unrestrictedCandidate],
      channelBlocks[channel].currentGainRecords[band]
    )
    const candidateBits = measureGainSyntaxBitsWithModes(
      gainCodingSources(channelBlocks, channelCount, scratch),
      bandCount,
      coreMode,
      scratch.syntaxPricing.incumbentModes,
      scratch.syntaxPricing.workspace
    )
    overflow.candidateSyntaxBits[unrestrictedCandidate] = candidateBits
    if (
      candidateBits <= incumbentBits &&
      overflow.candidateDifferenceEnergies[unrestrictedCandidate] <
        overflow.candidateDifferenceEnergies[incumbentCandidate]
    ) {
      selectedCandidate = unrestrictedCandidate
    }
  }
  loadGainOverflowState(
    overflow,
    overflow.candidateStateIndices[selectedCandidate],
    scratch.selectedRecord
  )
  scratch.selectedRecord.copyTo(channelBlocks[channel].currentGainRecords[band])
  return scratch.selectedRecord
}

/**
 * Reduce gain points for one band while preserving the best measured envelope candidate.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState} analysis
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {number} channel
 * @param {number} band
 * @param {LowRateGainScratch} scratch
 */
function reduceBandGainOverflow(
  channelBlocks,
  analysis,
  channelCount,
  bandCount,
  coreMode,
  channel,
  band,
  scratch
) {
  const block = channelBlocks[channel]
  const previous = block.previousGainRecords[band]
  const current = block.currentGainRecords[band]
  if (!gainRecordPairIsActive(previous, current)) return

  loadGainBand(analysis, band, scratch)
  const sourcePeak = maximumGainWindowMagnitude(scratch.source)
  const currentPeak = maximumGainScaledMagnitude(
    scratch.source,
    previous,
    current,
    scratch
  )
  if (currentPeak === null) {
    throw new Error('ATRAC3plus gain overflow source is unrepresentable')
  }
  if (!gainPeakOverflows(sourcePeak, currentPeak)) return

  current.copyTo(scratch.overflowSourceRecord)
  previous.copyTo(scratch.overflowPreviousRecord)
  const selected = planGainOverflowReduction(
    channelBlocks,
    channelCount,
    bandCount,
    coreMode,
    channel,
    band,
    scratch.overflowSourceRecord,
    scratch.overflowPreviousRecord,
    sourcePeak,
    currentPeak,
    scratch
  )
  selected.copyTo(current)
}

/**
 * Apply bounded gain-point reduction across every channel and active gain band.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function reduceGainOverflow(
  channelBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  for (let band = 0; band < bandCount; band++) {
    for (let channel = 0; channel < channelCount; channel++) {
      reduceBandGainOverflow(
        channelBlocks,
        analysisStates[channel],
        channelCount,
        bandCount,
        coreMode,
        channel,
        band,
        scratch
      )
    }
  }
}

/**
 * Run the post-stereo gain simplifications against the already selected channel pairing.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function applyPostStereoGainAdjust(
  channelBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  scratch.band0FrontierActive.fill(0)
  for (let channel = 0; channel < channelCount; channel++) {
    const peerBand1 =
      channelCount === 2
        ? channelBlocks[1 - channel].currentGainRecords[1]
        : null
    const hasIncumbent = adjustBand0RecordFromBand1(
      channelBlocks[channel].currentGainRecords,
      peerBand1,
      channelCount,
      bandCount,
      scratch.recordPolicy
    )
    if (hasIncumbent) {
      scratch.band0FrontierActive[channel] = 1
      scratch.recordPolicy.band0Incumbent.copyTo(
        scratch.band0FrontierRecords[channel]
      )
    }
  }

  scratch.adjacentFrontier.counts.fill(0)
  for (let channel = 0; channel < channelCount; channel++) {
    mergeAdjacentBandRecords(
      channelBlocks[channel].currentGainRecords,
      analysisStates[channel],
      channel,
      bandCount,
      scratch
    )
  }
  let hasLoweredAlternatives = false
  for (let channel = 0; channel < channelCount; channel++) {
    hasLoweredAlternatives ||=
      scratch.band0FrontierActive[channel] !== 0 ||
      scratch.adjacentFrontier.counts[channel] !== 0
  }
  if (hasLoweredAlternatives) {
    copyCandidateBlocks(channelBlocks, scratch.preOverflowBlocks, channelCount)
  }

  reduceGainOverflow(
    channelBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    scratch
  )
  if (!hasLoweredAlternatives) return
  applyEfficientBand0NoEdits(
    scratch.preOverflowBlocks,
    channelBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    scratch
  )
  applyRateBoundedAdjacentMergeKeeps(
    scratch.preOverflowBlocks,
    channelBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    scratch
  )
}

/**
 * Apply low-rate gain edits only after their exact sidechain price and envelope error are known.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {EncodeAnalysisState[]} analysisStates
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} coreMode
 * @param {LowRateGainScratch} scratch
 */
function applyLowModeGainAdjustPlan(
  channelBlocks,
  analysisStates,
  channelCount,
  bandCount,
  coreMode,
  scratch
) {
  scratch.stereoFrontier.count = 0
  if (channelCount === 2) {
    mergeStereoBandRecords(channelBlocks, analysisStates, bandCount, scratch)
  }
  const hasStereoAlternatives = scratch.stereoFrontier.count !== 0
  if (hasStereoAlternatives) {
    copyCandidateBlocks(channelBlocks, scratch.postStereoBlocks, channelCount)
  }

  applyPostStereoGainAdjust(
    channelBlocks,
    analysisStates,
    channelCount,
    bandCount,
    coreMode,
    scratch
  )
  if (hasStereoAlternatives) {
    applyRateBoundedStereoMergeAlternatives(
      scratch.postStereoBlocks,
      channelBlocks,
      analysisStates,
      channelCount,
      bandCount,
      coreMode,
      scratch
    )
  }
}

/**
 * Lower detected records through every low-rate policy into a detached plan.
 * Persistent channel state remains untouched until the returned plan commits.
 *
 * @param {EncodeChannelState[]} channelBlocks Detached coding-unit channel blocks.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {number} bandCount Active gain-band count.
 * @param {number} coreMode Profile core-mode selector.
 * @param {GainRecordPlan} detectedPlan Raw detector publication plan.
 * @param {LowRateGainScratch} scratch Reusable adjustment work.
 * @returns {GainRecordPlan} Detached adjusted publication plan.
 */
export function planLowModeGainAdjustment(
  channelBlocks,
  analysisStates,
  bandCount,
  coreMode,
  detectedPlan,
  scratch
) {
  if (
    !Array.isArray(channelBlocks) ||
    !Array.isArray(analysisStates) ||
    !scratch ||
    !(detectedPlan instanceof GainRecordPlan)
  ) {
    throw new TypeError('ATRAC3plus low-rate gain adjustment input is invalid')
  }
  const channelCount = Math.min(
    channelBlocks.length,
    analysisStates.length,
    detectedPlan.channelCount,
    ANALYSIS_GAIN_ADJUSTMENT_GAIN_MAX_CHANNELS
  )
  if (channelCount < 1) {
    throw new RangeError('ATRAC3plus low-rate gain adjustment has no channels')
  }
  const activeBands = Math.min(Math.max(bandCount, 0), GAIN_BAND_COUNT)
  copyCandidateBlocks(channelBlocks, scratch.selectedBlocks, channelCount)
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < GAIN_BAND_COUNT; band++) {
      detectedPlan.records[channel][band].copyTo(
        scratch.selectedBlocks[channel].currentGainRecords[band]
      )
    }
  }
  applyLowModeGainAdjustPlan(
    scratch.selectedBlocks,
    analysisStates,
    channelCount,
    activeBands,
    coreMode,
    scratch
  )
  scratch.publication.clear(channelCount)
  for (let channel = 0; channel < channelCount; channel++) {
    for (let band = 0; band < GAIN_BAND_COUNT; band++) {
      scratch.selectedBlocks[channel].currentGainRecords[band].copyTo(
        scratch.publication.records[channel][band]
      )
    }
  }
  return scratch.publication
}
