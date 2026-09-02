/** Configurable polyphase quadrature-mirror analysis and synthesis. */

import {
  QMF_ANALYSIS_MODULATION_SCALE as analysisModulationScale,
  QMF_ANALYSIS_START_SAMPLE as analysisStartSample,
  QMF_ANALYSIS_STEP_SAMPLES as analysisStepSamples,
  QMF_ANALYSIS_TERMS as analysisTermCount,
  QMF_ANALYSIS_WINDOW_SAMPLES as analysisWindowSamples,
  QMF_BANDS as bandCount,
  QMF_SYNTHESIS_DELAY_ROWS as synthesisDelayRows,
  QMF_SYNTHESIS_TERMS as synthesisTermCount,
} from '../core/constants.js'
import {
  QMF_ANALYSIS_HALF_BUTTERFLY_SCALES as analysisHalfButterflyScales,
  QMF_ANALYSIS_ODD_PI_OVER_16_COSINES as analysisOddPiOver16Cosines,
  QMF_ANALYSIS_ODD_PI_OVER_32_COSINES as analysisOddPiOver32Cosines,
  QMF_ANALYSIS_ODD_PI_OVER_64_COSINES as analysisOddPiOver64Cosines,
  QMF_ANALYSIS_PI_OVER_8_BUTTERFLY_SCALES as analysisPiOver8ButterflyScales,
  QMF_ANALYSIS_FILTER_COEFFICIENTS as analysisFilterCoefficients,
  QMF_ANALYSIS_MODULATION_COEFFICIENTS as analysisModulationCoefficients,
  QMF_ANALYSIS_SAMPLE_OFFSETS as analysisSampleOffsets,
  QMF_SYNTHESIS_DELAY_COMPONENTS as synthesisDelayComponents,
  QMF_SYNTHESIS_DELAY_ROW_OFFSETS as synthesisDelayRowOffsets,
  QMF_SYNTHESIS_FILTER_COEFFICIENTS as synthesisFilterCoefficients,
  QMF_SYNTHESIS_MODULATION_COEFFICIENTS as synthesisModulationCoefficients,
} from '../core/tables.js'

const float32Round = Math.fround

/**
 * Preserve the reference spill order of the native sixteen-band polyphase sum.
 * Other supported widths use the dense configurable path below.
 *
 * @param {Float32Array} input
 * @param {number} inputOffset
 * @param {Float32Array} accumulator
 * @param {Float64Array} extended
 */
function filter16Band(input, inputOffset, accumulator, extended) {
  const c = analysisFilterCoefficients

  for (let component = 0; component < 16; component++) {
    const coefficientOffset = component * analysisTermCount
    const firstSample = component < 8 ? component : component + 8
    const secondSample = component < 8 ? 15 - component : 39 - component
    const firstProduct = input[inputOffset + firstSample] * c[coefficientOffset]
    accumulator[component] = float32Round(
      input[inputOffset + secondSample] * c[coefficientOffset + 1] +
        (component % 4 === 0 ? float32Round(firstProduct) : firstProduct)
    )
  }

  let extended7 = accumulator[7]
  let extended8 = accumulator[8]
  let extended10 = accumulator[10]
  let extended11 = accumulator[11]
  let extended12 = accumulator[12]
  let extended13 = accumulator[13]
  let extended14 = accumulator[14]
  let extended15 = accumulator[15]

  for (let segment = 1; segment < 12; segment++) {
    const inputBase = inputOffset + segment * 32
    const term = segment * 2

    const product0 = float32Round(input[inputBase] * c[term])
    accumulator[0] = float32Round(
      accumulator[0] + product0 + input[inputBase + 15] * c[term + 1]
    )
    accumulator[1] = float32Round(
      input[inputBase + 1] * c[analysisTermCount + term] +
        float32Round(
          input[inputBase + 14] * c[analysisTermCount + term + 1] +
            accumulator[1]
        )
    )
    const product2 = float32Round(
      input[inputBase + 2] * c[analysisTermCount * 2 + term]
    )
    accumulator[2] = float32Round(
      accumulator[2] +
        product2 +
        input[inputBase + 13] * c[analysisTermCount * 2 + term + 1]
    )
    accumulator[3] = float32Round(
      accumulator[3] +
        input[inputBase + 3] * c[analysisTermCount * 3 + term] +
        input[inputBase + 12] * c[analysisTermCount * 3 + term + 1]
    )
    const product4 = float32Round(
      input[inputBase + 4] * c[analysisTermCount * 4 + term]
    )
    const product4Sum =
      product4 + input[inputBase + 11] * c[analysisTermCount * 4 + term + 1]
    accumulator[4] = float32Round(accumulator[4] + product4Sum)
    accumulator[5] = float32Round(
      input[inputBase + 5] * c[analysisTermCount * 5 + term] +
        float32Round(
          input[inputBase + 10] * c[analysisTermCount * 5 + term + 1] +
            accumulator[5]
        )
    )
    const product6 = float32Round(
      input[inputBase + 6] * c[analysisTermCount * 6 + term]
    )
    accumulator[6] = float32Round(
      accumulator[6] +
        product6 +
        input[inputBase + 9] * c[analysisTermCount * 6 + term + 1]
    )
    extended7 =
      accumulator[7] +
      (input[inputBase + 7] * c[analysisTermCount * 7 + term] +
        input[inputBase + 8] * c[analysisTermCount * 7 + term + 1])
    accumulator[7] = float32Round(extended7)

    extended8 =
      input[inputBase + 31] * c[analysisTermCount * 8 + term + 1] +
      input[inputBase + 16] * c[analysisTermCount * 8 + term] +
      accumulator[8]
    accumulator[8] = float32Round(extended8)
    accumulator[9] = float32Round(
      input[inputBase + 17] * c[analysisTermCount * 9 + term] +
        float32Round(
          input[inputBase + 30] * c[analysisTermCount * 9 + term + 1] +
            accumulator[9]
        )
    )
    extended10 =
      accumulator[10] +
      (input[inputBase + 18] * c[analysisTermCount * 10 + term] +
        input[inputBase + 29] * c[analysisTermCount * 10 + term + 1])
    accumulator[10] = float32Round(extended10)
    extended11 =
      accumulator[11] +
      (input[inputBase + 19] * c[analysisTermCount * 11 + term] +
        input[inputBase + 28] * c[analysisTermCount * 11 + term + 1])
    accumulator[11] = float32Round(extended11)
    extended12 =
      accumulator[12] +
      (input[inputBase + 20] * c[analysisTermCount * 12 + term] +
        input[inputBase + 27] * c[analysisTermCount * 12 + term + 1])
    accumulator[12] = float32Round(extended12)
    extended13 =
      accumulator[13] +
      (input[inputBase + 21] * c[analysisTermCount * 13 + term] +
        input[inputBase + 26] * c[analysisTermCount * 13 + term + 1])
    accumulator[13] = float32Round(extended13)
    extended14 =
      accumulator[14] +
      (input[inputBase + 22] * c[analysisTermCount * 14 + term] +
        input[inputBase + 25] * c[analysisTermCount * 14 + term + 1])
    accumulator[14] = float32Round(extended14)
    const product15 =
      input[inputBase + 24] * c[analysisTermCount * 15 + term + 1] +
      input[inputBase + 23] * c[analysisTermCount * 15 + term]
    extended15 = accumulator[15] + product15
    accumulator[15] = float32Round(extended15)
  }

  extended[7] = extended7
  extended[10] = extended10
  extended[11] = extended11
  extended[12] = extended12
  extended[13] = extended13
  extended[14] = extended14
  extended[15] = extended15
}

/**
 * Preserve the reference factorization and spill order of 16-band modulation.
 *
 * @param {Float32Array} polyphase
 * @param {Float64Array} extended
 * @param {Float32Array} output
 */
function modulate16Band(polyphase, extended, output) {
  const half = analysisHalfButterflyScales
  const cos32 = analysisOddPiOver32Cosines
  const cos16 = analysisOddPiOver16Cosines
  const cos64 = analysisOddPiOver64Cosines
  const pi8 = analysisPiOver8ButterflyScales

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
 * Transform one complete time window into caller-owned QMF subband rows.
 *
 * @param {Float32Array} input Current samples preceded by the required history.
 * @param {Float32Array[]} outputBands Caller-owned chronological subband rows.
 * @param {QmfScratch} scratch Reusable component and modulation storage.
 * @returns {Float32Array[]} The completed subband rows.
 */
export function analyzeQmf(input, outputBands, scratch) {
  if (
    !(input instanceof Float32Array) ||
    outputBands?.length !== bandCount ||
    outputBands.some(
      (band) =>
        !(band instanceof Float32Array) || band.length !== outputBands[0].length
    ) ||
    !scratch ||
    scratch.polyphase?.length !== bandCount ||
    scratch.extended?.length !== bandCount ||
    scratch.bands?.length !== bandCount
  ) {
    throw new RangeError('QMF analysis geometry is invalid')
  }

  const sampleCount = outputBands[0].length
  const requiredSamples =
    analysisStartSample +
    Math.max(0, sampleCount - 1) * analysisStepSamples +
    analysisWindowSamples
  if (input.length < requiredSamples) {
    throw new RangeError('QMF analysis window is incomplete')
  }

  const { polyphase, extended, bands } = scratch

  for (let sample = 0; sample < sampleCount; sample++) {
    const inputOffset = analysisStartSample + sample * analysisStepSamples
    if (bandCount === 2) {
      for (let component = 0; component < bandCount; component++) {
        const termOffset = component * analysisTermCount
        let sum = 0
        for (let term = 0; term < analysisTermCount; term++) {
          const index = termOffset + term
          sum +=
            input[inputOffset + analysisSampleOffsets[index]] *
            analysisFilterCoefficients[index]
        }
        extended[component] = sum
      }
      for (let band = 0; band < bandCount; band++) {
        const coefficientOffset = band * bandCount
        let sum = 0
        for (let component = 0; component < bandCount; component++) {
          sum +=
            extended[component] *
            analysisModulationCoefficients[coefficientOffset + component]
        }
        outputBands[band][sample] = sum * analysisModulationScale
      }
      continue
    }
    if (bandCount === 16) {
      filter16Band(input, inputOffset, polyphase, extended)
      modulate16Band(polyphase, extended, bands)
      for (let band = 0; band < bandCount; band++) {
        outputBands[band][sample] = bands[band]
      }
      continue
    }

    for (let component = 0; component < bandCount; component++) {
      const termOffset = component * analysisTermCount
      let sum = 0
      for (let term = 0; term < analysisTermCount; term++) {
        const index = termOffset + term
        sum +=
          input[inputOffset + analysisSampleOffsets[index]] *
          analysisFilterCoefficients[index]
      }
      polyphase[component] = sum
    }

    for (let band = 0; band < bandCount; band++) {
      const coefficientOffset = band * bandCount
      let sum = 0
      for (let component = 0; component < bandCount; component++) {
        sum +=
          polyphase[component] *
          analysisModulationCoefficients[coefficientOffset + component]
      }
      bands[band] = sum * analysisModulationScale
      outputBands[band][sample] = bands[band]
    }
  }
  return outputBands
}

/**
 * Fold caller-owned QMF subband rows through one circular synthesis delay.
 *
 * @param {Float32Array[]} inputBands Chronological subband rows.
 * @param {Float32Array} delay Caller-owned component delay ring.
 * @param {number} delayRow Current delay-ring row.
 * @param {Float32Array} output Caller-owned interleaved PCM output.
 * @param {QmfScratch} scratch Reusable component and modulation storage.
 * @returns {number} Next delay-ring row.
 */
export function synthesizeQmf(inputBands, delay, delayRow, output, scratch) {
  if (
    inputBands?.length !== bandCount ||
    inputBands.some(
      (band) =>
        !(band instanceof Float32Array) || band.length !== inputBands[0].length
    ) ||
    !(delay instanceof Float32Array) ||
    delay.length !== synthesisDelayRows * bandCount ||
    !Number.isInteger(delayRow) ||
    delayRow < 0 ||
    delayRow >= synthesisDelayRows ||
    !(output instanceof Float32Array) ||
    output.length < inputBands[0].length * bandCount ||
    !scratch ||
    scratch.polyphase?.length !== bandCount ||
    scratch.bands?.length !== bandCount
  ) {
    throw new RangeError('QMF synthesis geometry is invalid')
  }

  const { polyphase, bands } = scratch
  const sampleCount = inputBands[0].length

  for (let sample = 0; sample < sampleCount; sample++) {
    for (let band = 0; band < bandCount; band++) {
      bands[band] = inputBands[band][sample]
    }

    const delayOffset = delayRow * bandCount
    for (let component = 0; component < bandCount; component++) {
      const coefficientOffset = component * bandCount
      let sum = 0
      for (let band = 0; band < bandCount; band++) {
        sum +=
          synthesisModulationCoefficients[coefficientOffset + band] *
          bands[band]
      }
      polyphase[component] = sum
      delay[delayOffset + component] = polyphase[component]
    }

    const outputOffset = sample * bandCount
    for (let outputSample = 0; outputSample < bandCount; outputSample++) {
      const termOffset = outputSample * synthesisTermCount
      let sum = 0
      if (bandCount === 16) {
        for (let term = 0; term < synthesisTermCount; term += 2) {
          const first = termOffset + term
          const second = first + 1
          const firstRow =
            (delayRow + synthesisDelayRowOffsets[first]) % synthesisDelayRows
          const secondRow =
            (delayRow + synthesisDelayRowOffsets[second]) % synthesisDelayRows
          sum = float32Round(
            delay[firstRow * bandCount + synthesisDelayComponents[first]] *
              synthesisFilterCoefficients[first] +
              delay[secondRow * bandCount + synthesisDelayComponents[second]] *
                synthesisFilterCoefficients[second] +
              sum
          )
        }
        output[outputOffset + outputSample] = sum
        continue
      }
      for (let term = 0; term < synthesisTermCount; term++) {
        const index = termOffset + term
        const row =
          (delayRow + synthesisDelayRowOffsets[index]) % synthesisDelayRows
        sum +=
          delay[row * bandCount + synthesisDelayComponents[index]] *
          synthesisFilterCoefficients[index]
      }
      output[outputOffset + outputSample] = sum
    }
    delayRow = delayRow === 0 ? synthesisDelayRows - 1 : delayRow - 1
  }
  return delayRow
}
