/** Module-owned symbol-preparation plans for ATRAC3plus spectrum pricing. */

import { spectrumCostCodeTableIndex, spectrumDescriptor } from './spectrum.js'
import { SPECTRUM_GROUP_VALUE_BITS_BY_MODE } from '../core/tables.js'
import {
  SPECTRUM_PRICING_CANDIDATE_COUNT,
  SPECTRUM_TABLE_INDEX,
} from '../core/constants.js'

/**
 * Resolve all candidate descriptors for one entropy context and quantization mode.
 *
 * Candidate order is part of allocation behavior because equal costs select the
 * lowest slot. The returned array therefore always retains code-table slot order.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {SpectrumDescriptor[]}
 */
function buildCandidateDescriptors(context, mode) {
  return Array.from(
    { length: SPECTRUM_PRICING_CANDIDATE_COUNT },
    (_unused, slot) =>
      spectrumDescriptor(
        context,
        mode,
        spectrumCostCodeTableIndex(context, mode, slot, SPECTRUM_TABLE_INDEX)
      )
  )
}

/**
 * Determine whether every sign-bearing candidate consumes direct magnitudes.
 *
 * A mode can use the direct magnitude row only when group size one is the sole
 * sign-bearing representation. Other modes must retain grouped preparation.
 *
 * @param {SpectrumDescriptor[]} descriptors
 * @returns {boolean}
 */
function usesOnlyDirectMagnitudes(descriptors) {
  let groupMask = 0
  for (const descriptor of descriptors) {
    if (descriptor.hasSignBits) {
      groupMask |= 1 << descriptor.valuesPerCodeword
    }
  }
  return groupMask === 1 << 1
}

/**
 * Describe the symbol row required by one spectrum code-table candidate.
 *
 * @param {SpectrumDescriptor} descriptor
 * @param {number} mode Quantization mode.
 * @param {boolean} directMagnitudes Whether direct magnitude reuse is legal for the mode.
 * @returns {object}
 */
function candidatePreparation(descriptor, mode, directMagnitudes) {
  const group = descriptor.valuesPerCodeword
  const directSigned = !descriptor.hasSignBits && group === 1
  const directMagnitude =
    descriptor.hasSignBits && group === 1 && directMagnitudes
  const masksSymbols = directSigned || directMagnitude
  const valueBits =
    SPECTRUM_GROUP_VALUE_BITS_BY_MODE[mode + Number(descriptor.hasSignBits) * 8]
  return {
    packsGroups: !directSigned && !directMagnitude && group !== 1,
    usesMagnitudes: descriptor.hasSignBits,
    valuesPerSymbol: group,
    valueBits,
    masksSymbols,
    symbolMask: masksSymbols ? 2 ** valueBits - 1 : 0xff,
    candidateSlots: [],
  }
}

/**
 * Test whether two candidates can reuse the same prepared symbol row.
 *
 * Code lengths and zero-run behavior are excluded because they consume the
 * prepared row without changing how it is produced.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function hasSamePreparation(left, right) {
  return (
    left.packsGroups === right.packsGroups &&
    left.usesMagnitudes === right.usesMagnitudes &&
    left.valuesPerSymbol === right.valuesPerSymbol &&
    left.valueBits === right.valueBits &&
    left.masksSymbols === right.masksSymbols &&
    left.symbolMask === right.symbolMask
  )
}

/**
 * Group candidate slots that can price the same prepared symbol row.
 *
 * @param {SpectrumDescriptor[]} descriptors
 * @param {number} mode Quantization mode.
 * @returns {object[]}
 */
function buildSymbolPreparations(descriptors, mode) {
  const preparations = []
  const directMagnitudes = usesOnlyDirectMagnitudes(descriptors)
  for (let slot = 0; slot < descriptors.length; slot++) {
    const candidate = candidatePreparation(
      descriptors[slot],
      mode,
      directMagnitudes
    )
    let shared = preparations.find((entry) =>
      hasSamePreparation(entry, candidate)
    )
    if (!shared) {
      shared = candidate
      preparations.push(shared)
    }
    shared.candidateSlots.push(slot)
  }
  return preparations
}

/**
 * Build one context/mode plan at module initialization.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {object|null}
 */
function buildSpectrumPricingPlan(context, mode) {
  if (mode === 0) return null
  const descriptors = buildCandidateDescriptors(context, mode)
  const preparations = buildSymbolPreparations(descriptors, mode)
  return { descriptors, preparations }
}

const spectrumPricingPlans = Array.from({ length: 2 }, (_unused, context) =>
  Array.from({ length: 8 }, (_empty, mode) =>
    buildSpectrumPricingPlan(context, mode)
  )
)

/**
 * Return the module-owned, read-only candidate and preparation plan for one query.
 *
 * Callers validate context and mode as part of the public pricing boundary.
 *
 * @param {number} context Entropy-table context.
 * @param {number} mode Quantization mode.
 * @returns {object}
 */
export function spectrumPricingPlan(context, mode) {
  return spectrumPricingPlans[context][mode]
}
