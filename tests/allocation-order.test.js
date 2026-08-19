import { describe, expect, it } from 'vitest'

import {
  AllocationBandOrder,
  planAllocationBandOrder,
} from '../codec/coding/allocation-order.js'

import { AllocationSourceChannel } from '../codec/state/allocation.js'
import { EncodeChannelState } from '../codec/state/encoder.js'

function fnv32Words(words) {
  let hash = 0xcbf29ce484222325n
  for (const value of words) {
    let word = BigInt(value >>> 0)
    for (let byte = 0; byte < 4; byte++) {
      hash ^= word & 0xffn
      hash = BigInt.asUintN(64, hash * 0x100000001b3n)
      word >>= 8n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function createOrderFixture() {
  const sourceChannels = [
    new AllocationSourceChannel(),
    new AllocationSourceChannel(),
  ]
  const channelBlocks = [new EncodeChannelState(0), new EncodeChannelState(1)]
  for (let channel = 0; channel < 2; channel++) {
    for (let band = 0; band < 27; band++) {
      channelBlocks[channel].syntax.scaleFactors[band] =
        (band * 11 + channel * 7) % 64
      sourceChannels[channel].bandLevels[band] = Math.fround(
        (((band * 13 + channel * 17) % 41) - 9) * 0.375
      )
    }
  }
  return { channelBlocks, sourceChannels }
}

describe('ATRAC3plus allocation band order', () => {
  it('matches the stable qualified priority order', () => {
    const { channelBlocks, sourceChannels } = createOrderFixture()
    const destination = new AllocationBandOrder()
    const ordinalIdentity = destination.ordinals
    planAllocationBandOrder(channelBlocks, sourceChannels, 27, destination)
    expect(destination.ordinals).toBe(ordinalIdentity)
    expect(destination.count).toBe(54)
    expect(fnv32Words(destination.ordinals.slice(0, destination.count))).toBe(
      '975811752e4450d4'
    )
    expect(Array.from(destination.ordinals.slice(0, 12))).toEqual([
      11, 5, 17, 32, 23, 37, 22, 31, 43, 49, 10, 3,
    ])
  })

  it('preserves channel-major order on strict score ties', () => {
    const sourceChannels = [
      new AllocationSourceChannel(),
      new AllocationSourceChannel(),
    ]
    const channelBlocks = [new EncodeChannelState(0), new EncodeChannelState(1)]
    const destination = planAllocationBandOrder(
      channelBlocks,
      sourceChannels,
      4,
      new AllocationBandOrder()
    )
    expect(
      Array.from(destination.ordinals.slice(0, destination.count))
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
