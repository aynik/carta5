/** Exact invariant sidechain accounting for ATRAC3plus allocation. */

import { spectralNoiseLevelFieldCount } from './spectrum-syntax.js'

/**
 * Measure every syntax cost that remains unchanged during allocation refinement.
 *
 * @param {SharedState} shared Shared coding-unit syntax.
 * @param {number} channelCount Active coding-unit channels.
 * @param {number} gainBits Selected gain sidechain width.
 * @param {number} toneBits Selected tone sidechain width.
 * @returns {number} Exact invariant allocation width.
 */
export function measureInvariantAllocationBits(
  shared,
  channelCount,
  gainBits,
  toneBits
) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 2 ||
    !Number.isInteger(shared?.bandLimit) ||
    !Number.isInteger(shared?.muteFlag) ||
    !Number.isInteger(shared?.noisePresent) ||
    !Number.isInteger(shared?.noiseLevelIndex) ||
    !Number.isInteger(shared?.noiseTableIndex) ||
    !Number.isInteger(gainBits) ||
    gainBits < 0 ||
    !Number.isInteger(toneBits) ||
    toneBits < 0
  ) {
    throw new RangeError('ATRAC3plus invariant allocation syntax is invalid')
  }
  let bits =
    6 +
    channelCount +
    (shared.noisePresent === 0 ? 1 : 9) +
    gainBits +
    toneBits +
    channelCount *
      spectralNoiseLevelFieldCount(shared.scaleFactorCount, shared.mapCount) *
      4
  if (channelCount === 2) {
    for (let index = 1; index >= 0; index--) {
      bits +=
        shared.presenceEnabled[index] === 0
          ? 1
          : shared.presenceMixed[index] === 0
            ? 2
            : 2 + shared.mapCount
    }
  }
  return bits
}
