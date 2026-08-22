/** ATRAC3plus 16-band quadrature-mirror analysis and synthesis. */

import {
  ANALYSIS_BANDS,
  ANALYSIS_TAIL_SAMPLES,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  SUBBAND_SAMPLES,
  NEWEST_ANALYSIS_SLOT,
  QMF_STARTUP_SKIP_SAMPLES,
  QMF_WINDOW_SAMPLES,
} from '../core/constants.js'
import {
  QMF_ANALYSIS_COEFFICIENTS,
  QMF_ANALYSIS_HALF_BUTTERFLY_SCALES,
  QMF_ANALYSIS_ODD_PI_OVER_16_COSINES,
  QMF_ANALYSIS_ODD_PI_OVER_32_COSINES,
  QMF_ANALYSIS_ODD_PI_OVER_64_COSINES,
  QMF_ANALYSIS_PI_OVER_8_BUTTERFLY_SCALES,
  QMF_SYNTHESIS_COEFFICIENTS,
} from '../core/tables.js'
import { float32MultiplyAdd, float32Round } from '../utils.js'

/**
 * Reference-ordered polyphase accumulation for one 16-sample QMF step.
 *
 * @param {ArrayLike<number>} window
 * @param {number} windowOffset
 * @param {ArrayLike<number>} accumulator
 * @param {ArrayLike<number>} extendedSums
 */
function computePolyphaseSums(window, windowOffset, accumulator, extendedSums) {
  const c = QMF_ANALYSIS_COEFFICIENTS

  accumulator[0] = float32Round(
    window[windowOffset + 15] * c[192] +
      float32Round(window[windowOffset] * c[0])
  )
  accumulator[1] = float32Round(
    window[windowOffset + 14] * c[193] + window[windowOffset + 1] * c[1]
  )
  accumulator[2] = float32Round(
    window[windowOffset + 13] * c[194] + window[windowOffset + 2] * c[2]
  )
  accumulator[3] = float32Round(
    window[windowOffset + 12] * c[195] + window[windowOffset + 3] * c[3]
  )
  accumulator[4] = float32Round(
    window[windowOffset + 11] * c[196] +
      float32Round(window[windowOffset + 4] * c[4])
  )
  accumulator[5] = float32Round(
    window[windowOffset + 10] * c[197] + window[windowOffset + 5] * c[5]
  )
  accumulator[6] = float32Round(
    window[windowOffset + 9] * c[198] + window[windowOffset + 6] * c[6]
  )
  accumulator[7] = float32Round(
    window[windowOffset + 8] * c[199] + window[windowOffset + 7] * c[7]
  )
  accumulator[8] = float32Round(
    window[windowOffset + 31] * c[200] +
      float32Round(window[windowOffset + 16] * c[8])
  )
  accumulator[9] = float32Round(
    window[windowOffset + 30] * c[201] + window[windowOffset + 17] * c[9]
  )
  accumulator[10] = float32Round(
    window[windowOffset + 29] * c[202] + window[windowOffset + 18] * c[10]
  )
  accumulator[11] = float32Round(
    window[windowOffset + 28] * c[203] + window[windowOffset + 19] * c[11]
  )
  accumulator[12] = float32Round(
    window[windowOffset + 27] * c[204] +
      float32Round(window[windowOffset + 20] * c[12])
  )
  accumulator[13] = float32Round(
    window[windowOffset + 26] * c[205] + window[windowOffset + 21] * c[13]
  )
  accumulator[14] = float32Round(
    window[windowOffset + 25] * c[206] + window[windowOffset + 22] * c[14]
  )
  accumulator[15] = float32Round(
    window[windowOffset + 24] * c[207] + window[windowOffset + 23] * c[15]
  )

  let extended7 = accumulator[7]
  let extended8 = accumulator[8]
  let extended10 = accumulator[10]
  let extended11 = accumulator[11]
  let extended12 = accumulator[12]
  let extended13 = accumulator[13]
  let extended14 = accumulator[14]
  let extended15 = accumulator[15]

  for (let segment = 1; segment < 12; segment++) {
    const windowBase = windowOffset + segment * 32
    const first = segment * 16
    const second = 192 + segment * 16

    const product0 = float32Round(window[windowBase] * c[first])
    accumulator[0] = float32Round(
      accumulator[0] + product0 + window[windowBase + 15] * c[second]
    )
    accumulator[1] = float32MultiplyAdd(
      window[windowBase + 1],
      c[first + 1],
      float32MultiplyAdd(window[windowBase + 14], c[second + 1], accumulator[1])
    )
    const product2 = float32Round(window[windowBase + 2] * c[first + 2])
    accumulator[2] = float32Round(
      accumulator[2] + product2 + window[windowBase + 13] * c[second + 2]
    )
    accumulator[3] = float32Round(
      accumulator[3] +
        window[windowBase + 3] * c[first + 3] +
        window[windowBase + 12] * c[second + 3]
    )
    const product4 = float32Round(window[windowBase + 4] * c[first + 4])
    const product4Sum = product4 + window[windowBase + 11] * c[second + 4]
    accumulator[4] = float32Round(accumulator[4] + product4Sum)
    accumulator[5] = float32MultiplyAdd(
      window[windowBase + 5],
      c[first + 5],
      float32MultiplyAdd(window[windowBase + 10], c[second + 5], accumulator[5])
    )
    const product6 = float32Round(window[windowBase + 6] * c[first + 6])
    accumulator[6] = float32Round(
      accumulator[6] + product6 + window[windowBase + 9] * c[second + 6]
    )
    extended7 =
      accumulator[7] +
      (window[windowBase + 7] * c[first + 7] +
        window[windowBase + 8] * c[second + 7])
    accumulator[7] = float32Round(extended7)

    extended8 =
      window[windowBase + 31] * c[second + 8] +
      window[windowBase + 16] * c[first + 8] +
      accumulator[8]
    accumulator[8] = float32Round(extended8)
    accumulator[9] = float32MultiplyAdd(
      window[windowBase + 17],
      c[first + 9],
      float32MultiplyAdd(window[windowBase + 30], c[second + 9], accumulator[9])
    )
    extended10 =
      accumulator[10] +
      (window[windowBase + 18] * c[first + 10] +
        window[windowBase + 29] * c[second + 10])
    accumulator[10] = float32Round(extended10)
    extended11 =
      accumulator[11] +
      (window[windowBase + 19] * c[first + 11] +
        window[windowBase + 28] * c[second + 11])
    accumulator[11] = float32Round(extended11)
    extended12 =
      accumulator[12] +
      (window[windowBase + 20] * c[first + 12] +
        window[windowBase + 27] * c[second + 12])
    accumulator[12] = float32Round(extended12)
    extended13 =
      accumulator[13] +
      (window[windowBase + 21] * c[first + 13] +
        window[windowBase + 26] * c[second + 13])
    accumulator[13] = float32Round(extended13)
    extended14 =
      accumulator[14] +
      (window[windowBase + 22] * c[first + 14] +
        window[windowBase + 25] * c[second + 14])
    accumulator[14] = float32Round(extended14)
    const product15 =
      window[windowBase + 24] * c[second + 15] +
      window[windowBase + 23] * c[first + 15]
    extended15 = accumulator[15] + product15
    accumulator[15] = float32Round(extended15)
  }

  extendedSums.set(accumulator)
  extendedSums[7] = extended7
  extendedSums[8] = extended8
  extendedSums[10] = extended10
  extendedSums[11] = extended11
  extendedSums[12] = extended12
  extendedSums[13] = extended13
  extendedSums[14] = extended14
  extendedSums[15] = extended15
}

/**
 * Reference-unrolled 16-band cosine modulation with explicit float32 spills.
 *
 * @param {ArrayLike<number>} polyphase
 * @param {ArrayLike<number>} extended
 * @param {ArrayLike<number>} output
 */
function modulate16Band(polyphase, extended, output) {
  const half = QMF_ANALYSIS_HALF_BUTTERFLY_SCALES
  const cos32 = QMF_ANALYSIS_ODD_PI_OVER_32_COSINES
  const cos16 = QMF_ANALYSIS_ODD_PI_OVER_16_COSINES
  const cos64 = QMF_ANALYSIS_ODD_PI_OVER_64_COSINES
  const pi8 = QMF_ANALYSIS_PI_OVER_8_BUTTERFLY_SCALES

  const twoCosPi8 = pi8[0]
  const cosPi4 = half[0]
  const twoCosPi32 = cos32[0]
  const twoCosPi16 = cos16[0]

  const rotated7Extended = extended[7] * cos64[0]
  const rotated0Extended = polyphase[0] * cos64[7]
  const rotated13Extended = extended[13] * cos64[13]
  const rotated7 = float32Round(rotated7Extended)
  const rotated5 = float32Round(polyphase[5] * cos64[2])
  const rotated6Extended = polyphase[6] * cos64[1]
  const rotated6 = float32Round(rotated6Extended)
  const rotated4Extended = polyphase[4] * cos64[3]
  const rotated4 = float32Round(rotated4Extended)
  const rotated3 = float32Round(polyphase[3] * cos64[4])
  const rotated3Extended = rotated3
  const rotated2 = float32Round(polyphase[2] * cos64[5])
  const rotated0 = float32Round(rotated0Extended)
  const rotated1Extended = polyphase[1] * cos64[6]
  const rotated8Extended = polyphase[8] * cos64[8]
  const rotated8 = float32Round(rotated8Extended)
  const rotated14Extended = extended[14] * cos64[14]
  const rotated14 = float32Round(rotated14Extended)
  const rotated15Extended = extended[15] * cos64[15]
  const rotated9Extended = polyphase[9] * cos64[9]
  const rotated9 = float32Round(rotated9Extended)
  const rotated13 = float32Round(rotated13Extended)
  const rotated10Extended = extended[10] * cos64[10]
  const rotated10 = float32Round(rotated10Extended)
  const rotated11Extended = extended[11] * cos64[11]
  const rotated11 = float32Round(rotated11Extended)
  const rotated12Extended = extended[12] * cos64[12]

  const sum0Extended = rotated0 + rotated8 + (rotated7 + rotated15Extended)
  const mix0Term0Extended = (rotated7 - rotated15Extended) * twoCosPi32
  const mix0Term1Extended = (rotated0 - rotated8) * cos32[7]
  const mix0Extended = mix0Term0Extended + mix0Term1Extended
  const mix0 = float32Round(mix0Extended)
  const mixASum0Extended = rotated7 + rotated15Extended
  const mixASum1Extended = rotated0 + rotated8
  const mixAExtended = twoCosPi16 * (mixASum0Extended - mixASum1Extended)
  const mix1 = float32Round(
    twoCosPi16 * (mix0Term0Extended - mix0Term1Extended)
  )

  const sum1Extended = rotated14 + rotated1Extended + (rotated6 + rotated9)
  const sum1Float32 = float32Round(sum1Extended)
  const mix2Term0Extended = (rotated1Extended - rotated9) * cos32[6]
  const mixBInnerExtended = rotated6 + rotated14 - rotated1Extended - rotated9
  const mixBInnerFloat32 = float32Round(mixBInnerExtended)
  const mixBExtended = cos16[1] * mixBInnerFloat32
  const mixB = float32Round(mixBExtended)
  const mix2Term1Extended = float32Round(rotated6 - rotated14) * cos32[1]
  const mix2 = float32Round(mix2Term1Extended + mix2Term0Extended)
  const mix3 = float32Round(cos16[1] * (mix2Term1Extended - mix2Term0Extended))

  const sum2Pair0Extended = rotated5 + rotated13
  const sum2Pair1Extended = rotated2 + rotated10
  const sum2Extended = sum2Pair0Extended + sum2Pair1Extended
  const sum2Float32 = float32Round(sum2Extended)
  const mixCInnerExtended = sum2Pair0Extended - rotated2 - rotated10
  const mixCInnerFloat32 = float32Round(mixCInnerExtended)
  const mixCExtended = cos16[2] * mixCInnerFloat32
  const mixC = float32Round(mixCExtended)
  const mix4Term0Extended = (rotated5 - rotated13) * cos32[2]
  const mix4Term1Extended = (rotated2 - rotated10) * cos32[5]
  const mix4 = float32Round(mix4Term0Extended + mix4Term1Extended)
  const mix5 = float32Round(cos16[2] * (mix4Term0Extended - mix4Term1Extended))

  const sum3Extended =
    rotated3 + rotated4 + rotated11Extended + rotated12Extended
  const mix6Term0Extended = (rotated4 - rotated12Extended) * cos32[3]
  const mixDInnerExtended =
    rotated4 + rotated12Extended - rotated3Extended - rotated11Extended
  const mixDExtended = cos16[3] * mixDInnerExtended
  const mix6Term1Extended = (rotated3Extended - rotated11) * cos32[4]
  const mix6 = float32Round(mix6Term0Extended + mix6Term1Extended)
  const mix6Term0SpilledExtended = float32Round(mix6Term0Extended)
  const mix7 = float32Round(
    cos16[3] * (mix6Term0SpilledExtended - mix6Term1Extended)
  )

  const sumAllExtended = sum0Extended + sum1Float32 + sum2Float32 + sum3Extended
  const out0Extended = sumAllExtended * 0.5
  output[0] = float32Round(out0Extended)
  const mid0Extended =
    cosPi4 * (sum0Extended - sum1Float32 - sum2Float32 + sum3Extended)
  const mid0 = float32Round(mid0Extended)
  const diff03Extended = (sum0Extended - sum3Extended) * twoCosPi8
  const diff12Extended = float32Round(sum1Float32 - sum2Float32) * pi8[1]
  const diff12 = float32Round(diff12Extended)
  const mid1Extended = half[1] * diff03Extended - half[2] * diff12
  const mid1 = float32Round(mid1Extended)
  const mid2Extended = (mixAExtended - mixDExtended) * pi8[2]
  const mid2 = float32Round(mid2Extended)
  const mid3Extended = (mixB - mixC) * pi8[3]
  const avg2Pair0Extended = mixB + mixC
  const avg2Pair1Extended = mixAExtended + mixDExtended
  const avg2Extended = (avg2Pair0Extended + avg2Pair1Extended) * 0.5
  const mid4Extended = (mid2 + mid3Extended) * 0.5 - avg2Extended
  const mid4 = float32Round(mid4Extended)
  const mid5Extended =
    cosPi4 * (mixAExtended - mixB - mixC + mixDExtended) - mid4Extended
  const mid6Extended = half[1] * mid2 - half[2] * mid3Extended - mid5Extended
  const mid6 = float32Round(mid6Extended)

  const avg1Extended = (mix0 + mix2 + mix4 + mix6) * 0.5
  const out1Extended = avg1Extended - output[0]
  output[1] = float32Round(out1Extended)
  const out2Extended = avg2Extended - out1Extended
  output[2] = float32Round(out2Extended)
  const mid7Extended = cosPi4 * (mix0 - mix2 - mix4 + mix6)
  const mid7 = float32Round(mid7Extended)
  const mid8Extended = twoCosPi8 * (mix0 - mix6)
  const mid8 = float32Round(mid8Extended)
  const mid9 = float32Round(pi8[1] * float32Round(mix2 - mix4))
  const mid10Extended = half[1] * mid8 - half[2] * mid9
  const mid10 = float32Round(mid10Extended)
  const avg3Extended = (mix1 + mix3 + mix5 + mix7) * 0.5 - avg1Extended
  const out3Extended = avg3Extended - out2Extended
  output[3] = float32Round(out3Extended)
  const mid11Extended = (mid8 + mid9) * 0.5 - avg3Extended
  const mid11 = float32Round(mid11Extended)
  const out4Extended = (diff03Extended + diff12) * 0.5 - out3Extended
  output[4] = float32Round(out4Extended)
  const mid12Extended = (mix1 - mix7) * pi8[2]
  const mid13Extended = (mix3 - mix5) * pi8[3]
  const out5Extended = mid11Extended - out4Extended
  output[5] = float32Round(out5Extended)
  const out6Extended = mid4 - out5Extended
  output[6] = float32Round(out6Extended)
  const mid14Extended =
    mid12Extended + mid13Extended - mix1 - mix3 - mix5 - mix7
  const mid14HalfExtended = mid14Extended * 0.5
  const mid15Extended = cosPi4 * (mix1 - mix3 - mix5 + mix7) - mid14HalfExtended
  const mid16Extended =
    half[1] * mid12Extended - half[2] * mid13Extended - mid15Extended
  const mid17Extended = mid14HalfExtended - mid11
  const out7Extended = mid17Extended - output[6]
  output[7] = float32Round(out7Extended)
  const mid18Extended = mid7 - mid17Extended
  const out8Extended = mid0 - out7Extended
  output[8] = float32Round(out8Extended)
  const out9Extended = mid18Extended - out8Extended
  output[9] = float32Round(out9Extended)
  const mid19Extended = mid15Extended - mid18Extended
  const out10Extended = mid5Extended - out9Extended
  output[10] = float32Round(out10Extended)
  const out11Extended = mid19Extended - out10Extended
  output[11] = float32Round(out11Extended)
  const mid20Extended = mid10 - mid19Extended
  const out12Extended = mid1 - out11Extended
  output[12] = float32Round(out12Extended)
  const out13Extended = mid20Extended - out12Extended
  output[13] = float32Round(out13Extended)
  const mid21Extended = mid16Extended - mid20Extended
  const out14Extended = mid6 - out13Extended
  output[14] = float32Round(out14Extended)
  const out15Extended = mid21Extended - out14Extended
  output[15] = float32Round(out15Extended)
}

/**
 * Analyze one complete ATRAC3plus PCM channel into the newest history slot.
 * The caller owns the preceding ring shift and supplies reusable scratch.
 *
 * @param {EncodeAnalysisState} analysisState Detached channel analysis state.
 * @param {Float32Array} pcm One frame of PCM samples.
 * @param {QmfAnalysisScratch} scratch Reusable QMF work.
 * @returns {EncodeAnalysisState} The updated analysis state.
 */
export function analyzeQmfChannel(analysisState, pcm, scratch) {
  if (!(pcm instanceof Float32Array) || pcm.length < FRAME_SAMPLES) {
    throw new RangeError(`ATRAC3plus QMF requires ${FRAME_SAMPLES} PCM samples`)
  }
  if (
    !analysisState ||
    analysisState.bandSlots?.length !== ANALYSIS_BANDS ||
    analysisState.tail?.length !== ANALYSIS_TAIL_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus QMF analysis state geometry is invalid')
  }
  if (
    !scratch ||
    scratch.window?.length !== QMF_WINDOW_SAMPLES ||
    scratch.polyphaseSums?.length !== ANALYSIS_BANDS ||
    scratch.extendedPolyphaseSums?.length !== ANALYSIS_BANDS ||
    scratch.bands?.length !== ANALYSIS_BANDS
  ) {
    throw new RangeError('ATRAC3plus QMF scratch geometry is invalid')
  }

  const { window, polyphaseSums, extendedPolyphaseSums, bands } = scratch
  window.set(analysisState.tail, 0)
  window.set(pcm.subarray(0, FRAME_SAMPLES), ANALYSIS_TAIL_SAMPLES)

  for (let sample = 0; sample < SUBBAND_SAMPLES; sample++) {
    const windowOffset = QMF_STARTUP_SKIP_SAMPLES + sample * 16
    computePolyphaseSums(
      window,
      windowOffset,
      polyphaseSums,
      extendedPolyphaseSums
    )
    modulate16Band(polyphaseSums, extendedPolyphaseSums, bands)
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      analysisState.bandSlots[band][NEWEST_ANALYSIS_SLOT][sample] = bands[band]
    }
  }

  analysisState.tail.set(
    pcm.subarray(FRAME_SAMPLES - ANALYSIS_TAIL_SAMPLES, FRAME_SAMPLES)
  )
  return analysisState
}

/**
 * Advance and analyze every active stream channel with one shared scratch.
 *
 * @param {Float32Array[]} pcmChannels Active planar PCM frame.
 * @param {EncodeAnalysisState[]} analysisStates Detached channel analysis states.
 * @param {number} channelCount Active stream channel count.
 * @param {QmfAnalysisScratch} scratch Reusable QMF work.
 * @returns {EncodeAnalysisState[]} The updated analysis states.
 */
export function analyzeQmfFrame(
  pcmChannels,
  analysisStates,
  channelCount,
  scratch
) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > MAX_CHANNELS ||
    pcmChannels.length < channelCount ||
    analysisStates.length < channelCount
  ) {
    throw new RangeError('ATRAC3plus QMF frame channel geometry is invalid')
  }
  for (let channel = 0; channel < channelCount; channel++) {
    analysisStates[channel].shiftBandSlots()
    analyzeQmfChannel(analysisStates[channel], pcmChannels[channel], scratch)
  }
  return analysisStates
}

/**
 * Fold detached subbands through the staged synthesis rings.
 *
 * @param {Float32Array} subbands Contiguous subband samples.
 * @param {QmfAnalysisScratch} state Staged QMF synthesis state.
 * @param {Float32Array} output Caller-owned PCM output.
 * @returns {Float32Array} The output PCM.
 */
export function synthesizeQmfChannel(subbands, state, output) {
  if (
    !(subbands instanceof Float32Array) ||
    subbands.length < FRAME_SAMPLES ||
    !(state?.firstPhaseDelay instanceof Float32Array) ||
    state.firstPhaseDelay.length < 24 * 8 ||
    !(state?.secondPhaseDelay instanceof Float32Array) ||
    state.secondPhaseDelay.length < 24 * 8 ||
    !Number.isInteger(state.delayRingIndex) ||
    state.delayRingIndex < 0 ||
    state.delayRingIndex >= 24 ||
    !(output instanceof Float32Array) ||
    output.length < FRAME_SAMPLES
  ) {
    throw new RangeError('ATRAC3plus QMF synthesis geometry is invalid')
  }
  output.fill(0)
  let delayRow = state.delayRingIndex
  for (let sampleIndex = 0; sampleIndex < SUBBAND_SAMPLES; sampleIndex++) {
    const delayOffset = delayRow * 8
    for (let phaseSample = 0; phaseSample < 8; phaseSample++) {
      let firstSum = 0
      let secondSum = 0
      const coefficientOffset = phaseSample * 16
      for (let subband = 0; subband < 16; subband++) {
        const sample = subbands[subband * 128 + sampleIndex]
        const coefficientIndex = coefficientOffset + subband
        firstSum += QMF_SYNTHESIS_COEFFICIENTS[coefficientIndex] * sample
        secondSum += sample * QMF_SYNTHESIS_COEFFICIENTS[128 + coefficientIndex]
      }
      state.firstPhaseDelay[delayOffset + phaseSample] = firstSum
      state.secondPhaseDelay[delayOffset + phaseSample] = secondSum
    }

    const outputOffset = sampleIndex * 16
    for (let tap = 0; tap < 12; tap++) {
      const firstDelayOffset = ((delayRow + tap * 2) % 24) * 8
      const secondDelayOffset = ((delayRow + tap * 2 + 1) % 24) * 8
      const coefficientOffset = tap * 16
      for (let sample = 0; sample < 8; sample++) {
        output[outputOffset + sample] =
          state.firstPhaseDelay[firstDelayOffset + sample] *
            QMF_SYNTHESIS_COEFFICIENTS[256 + coefficientOffset + sample] +
          state.secondPhaseDelay[secondDelayOffset + sample] *
            QMF_SYNTHESIS_COEFFICIENTS[448 + coefficientOffset + sample] +
          output[outputOffset + sample]
      }
      for (let sample = 8; sample < 16; sample++) {
        const mirrored = 15 - sample
        output[outputOffset + sample] =
          state.firstPhaseDelay[firstDelayOffset + mirrored] *
            QMF_SYNTHESIS_COEFFICIENTS[256 + coefficientOffset + sample] +
          state.secondPhaseDelay[secondDelayOffset + mirrored] *
            QMF_SYNTHESIS_COEFFICIENTS[448 + coefficientOffset + sample] +
          output[outputOffset + sample]
      }
    }
    delayRow = delayRow === 0 ? 23 : delayRow - 1
  }
  state.delayRingIndex = delayRow
  return output
}
