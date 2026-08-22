/** Stable fixed-storage allocation-band ordering for ATRAC3plus coding units. */

import {
  CODING_UNIT_MAX_CHANNELS,
  QUANTIZATION_UNIT_COUNT,
  ALLOCATION_BAND_ORDER_CAPACITY,
} from '../core/constants.js'

/**
 * Sort flat band ordinals by descending score without allocating temporary arrays.
 *
 * @param {ArrayLike<number>} order
 * @param {number} count
 * @param {function(number, number): boolean} greater
 */
function shellSortDescending(order, count, greater) {
  let gap = 1
  while (gap <= count) gap = gap * 3 + 1
  for (;;) {
    gap = Math.trunc(gap / 3)
    if (gap === 0) break
    for (let index = gap; index < count; index++) {
      const item = order[index]
      let slot = index
      while (slot >= gap && greater(item, order[slot - gap])) {
        order[slot] = order[slot - gap]
        slot -= gap
      }
      order[slot] = item
    }
  }
}

/**
 * Channel-major ordinal order plus all fixed ranking scratch.
 */
export class AllocationBandOrder {
  /**
   * Allocate band indices and scores used to prioritize allocation improvements without sorting objects.
   */
  constructor() {
    this.ordinals = new Uint8Array(ALLOCATION_BAND_ORDER_CAPACITY)
    this.integerScores = new Int32Array(ALLOCATION_BAND_ORDER_CAPACITY)
    this.count = 0
    this.bandCount = 0
  }

  /**
   * Resolve the stream channel ordinal stored at one position in the ranked allocation order.
   *
   * @param {number} index
   * @returns {number}
   */
  channel(index) {
    return Math.trunc(this.ordinals[index] / this.bandCount)
  }

  /**
   * Resolve the quantization band stored at one position in the ranked allocation order.
   *
   * @param {number} index
   * @returns {number}
   */
  band(index) {
    return this.ordinals[index] % this.bandCount
  }
}

/**
 * Score and order every active band by scale-factor and band-level priority.
 *
 * @param {EncodeChannelState[]} channelBlocks Coding-unit channels in ordinal order.
 * @param {import('../state/allocation.js').AllocationSourceChannel[]} sourceChannels
 * @param {number} bandCount
 * @param {AllocationBandOrder} destination
 */
function fillPriorityOrder(
  channelBlocks,
  sourceChannels,
  bandCount,
  destination
) {
  const channelCount = channelBlocks.length
  const count = channelCount * bandCount
  for (let ordinal = 0; ordinal < count; ordinal++) {
    destination.ordinals[ordinal] = ordinal
  }
  for (let channel = 0; channel < channelCount; channel++) {
    const input = sourceChannels[channel]
    const row = channel * bandCount
    for (let band = 0; band < bandCount; band++) {
      const bias = Math.trunc(
        Math.fround(Math.fround(band * Math.fround(0.125)) + Math.fround(0.5))
      )
      const groupBias = band >> 4
      const levelBias = Math.trunc(
        Math.fround(input.bandLevels[band] - Math.fround(groupBias))
      )
      destination.integerScores[row + band] =
        channelBlocks[channel].syntax.scaleFactors[band] - bias + levelBias
    }
  }
  shellSortDescending(
    destination.ordinals,
    count,
    (left, right) =>
      destination.integerScores[left] > destination.integerScores[right]
  )
}

/**
 * Rank one measured coding unit using the qualified allocation priority.
 *
 * @param {EncodeChannelState[]} channelBlocks Coding-unit channels in ordinal order.
 * @param {import('../state/allocation.js').AllocationSourceChannel[]} sourceChannels Measured allocation source rows.
 * @param {number} bandCount Active quantization bands.
 * @param {AllocationBandOrder} destination Ordering to overwrite.
 * @returns {AllocationBandOrder} The destination ordering.
 */
export function planAllocationBandOrder(
  channelBlocks,
  sourceChannels,
  bandCount,
  destination
) {
  const channelCount = channelBlocks?.length ?? 0
  if (
    !(destination instanceof AllocationBandOrder) ||
    !Array.isArray(channelBlocks) ||
    !Array.isArray(sourceChannels) ||
    sourceChannels.length < channelCount ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    !Number.isInteger(bandCount) ||
    bandCount < 1 ||
    bandCount > QUANTIZATION_UNIT_COUNT
  ) {
    throw new RangeError('ATRAC3plus allocation order request is invalid')
  }
  destination.count = channelCount * bandCount
  destination.bandCount = bandCount
  fillPriorityOrder(channelBlocks, sourceChannels, bandCount, destination)
  return destination
}
