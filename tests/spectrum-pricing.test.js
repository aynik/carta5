import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { priceSpectrumBand } from '../codec/coding/spectrum-pricing.js'
import { spectrumPricingPlan } from '../codec/coding/spectrum-pricing-plan.js'
import { BufferPool } from '../codec/core/buffers.js'
import { CODING_UNIT_MAX_CHANNELS } from '../codec/core/constants.js'
import {
  PricedSpectrumBand,
  SpectrumPricingState,
} from '../codec/state/spectrum-pricing.js'

function createSource() {
  const spectrum = new Float32Array(2048)
  const step = Math.fround(0.03125)
  for (let index = 0; index < spectrum.length; index++) {
    const wave = ((index * 37 + 11) % 41) - 20
    spectrum[index] = Math.fround(wave * step)
  }
  const thresholdScales = new Float32Array(32)
  const base = Math.fround(0.625)
  const increment = Math.fround(0.09375)
  for (let band = 0; band < thresholdScales.length; band++) {
    thresholdScales[band] = Math.fround(
      base + Math.fround((band % 7) * increment)
    )
  }
  return { spectrum, thresholdScales }
}

function price(state, source, destination, entropyContext, band, mode, offset) {
  return priceSpectrumBand(
    state,
    source.spectrum,
    source.thresholdScales,
    entropyContext,
    band,
    mode,
    offset,
    destination
  )
}

describe('ATRAC3plus spectrum pricing', () => {
  it('assigns every candidate slot to exactly one symbol preparation', () => {
    for (let context = 0; context < 2; context++) {
      for (let mode = 1; mode <= 7; mode++) {
        const plan = spectrumPricingPlan(context, mode)
        expect(plan.descriptors).toHaveLength(8)
        expect(
          plan.preparations
            .flatMap((preparation) => preparation.candidateSlots)
            .sort((left, right) => left - right)
        ).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      }
    }
  })

  it('pins every context, mode, band, and offset cost row', () => {
    const source = createSource()
    const state = new SpectrumPricingState()
    const priced = new PricedSpectrumBand()
    const hash = createHash('sha256')
    const bytes = new Uint8Array(20)
    for (let context = 0; context < 2; context++) {
      for (let mode = 1; mode <= 7; mode++) {
        for (let band = 0; band < 32; band++) {
          for (let offset = 0; offset < 16; offset++) {
            price(state, source, priced, context, band, mode, offset)
            for (let slot = 0; slot < 8; slot++) {
              const cost = priced.costs[slot]
              bytes[slot * 2] = cost & 0xff
              bytes[slot * 2 + 1] = cost >>> 8
            }
            bytes[16] = priced.selectedIndex
            bytes[17] = 0
            const selectedCost = priced.costs[priced.selectedIndex]
            bytes[18] = selectedCost & 0xff
            bytes[19] = selectedCost >>> 8
            hash.update(bytes)
          }
        }
      }
    }
    expect(hash.digest('hex')).toBe(
      '1630079686a6f6f5919076a7cddced694a9063bbf462b71e9bf4622c529d77c1'
    )
  })

  it('matches the fixed codec table family across band widths and contexts', () => {
    const source = createSource()
    const state = new SpectrumPricingState()
    const priced = new PricedSpectrumBand()
    const fixtures = [
      [0, 1, 3, 0, [33, 33, 33, 32, 36, 31, 33, 30], 7, 30],
      [8, 5, 9, 0, [114, 114, 117, 121, 116, 141, 130, 115], 0, 114],
      [17, 3, 5, 1, [172, 162, 147, 153, 154, 183, 167, 165], 2, 147],
      [24, 7, 15, 1, [814, 863, 895, 988, 815, 878, 824, 765], 7, 765],
    ]
    for (const [
      band,
      mode,
      offset,
      context,
      costs,
      selected,
      cost,
    ] of fixtures) {
      price(state, source, priced, context, band, mode, offset)
      expect(Array.from(priced.costs)).toEqual(costs)
      expect([
        priced.selectedIndex,
        priced.costs[priced.selectedIndex],
      ]).toEqual([selected, cost])
    }
  })

  it('prices both entropy contexts independently', () => {
    const source = createSource()
    const state = new SpectrumPricingState()
    const priced = new PricedSpectrumBand()
    price(state, source, priced, 0, 8, 5, 9)
    expect(state.commit(priced, 0)).toBe(114)
    price(state, source, priced, 1, 8, 5, 9)
    expect(Array.from(priced.costs)).toEqual([
      116, 114, 124, 136, 116, 141, 136, 130,
    ])
    expect([priced.selectedIndex, priced.costs[priced.selectedIndex]]).toEqual([
      1, 114,
    ])
    expect(state.commit(priced, 1)).toBe(114)
    expect(state.selectedIndex(0, 8)).toBe(0)
    expect(state.selectedIndex(1, 8)).toBe(1)
  })

  it('uses two stable cache slots and preserves the cached winner', () => {
    const source = createSource()
    const state = new SpectrumPricingState()
    const priced = new PricedSpectrumBand()
    for (const offset of [1, 2, 3, 1]) {
      price(state, source, priced, 0, 9, 4, offset)
      expect(Array.from(priced.costs)).toEqual([
        102, 108, 97, 102, 97, 106, 96, 116,
      ])
      expect([
        priced.selectedIndex,
        priced.costs[priced.selectedIndex],
      ]).toEqual([6, 96])
    }
    const entry = (9 * 7 + 4 - 1) * 2
    expect(Array.from(state.cacheKeys.slice(entry, entry + 2))).toEqual([
      0x01, 0x03,
    ])
    // The final offset-one request hits its entropy row, so the lazy
    // quantization cache correctly retains the most recently materialized row.
    expect(state.quantizedKeys[9]).toBe(0x43)
  })

  it('captures and restores compact selected-value rows', () => {
    const source = createSource()
    const state = new SpectrumPricingState()
    const priced = new PricedSpectrumBand()
    price(state, source, priced, 0, 8, 5, 9)
    state.commit(priced, 0)
    state.captureWorkContext(0)
    price(state, source, priced, 0, 8, 5, 10)
    state.commit(priced, 0, 3)
    expect(state.selectedIndex(0, 8)).toBe(3)
    state.restoreWorkContext(0)
    expect(state.selectedIndex(0, 8)).toBe(0)
    expect(state.selectedCosts[8]).toBe(114)
  })

  it('preallocates every pricing and result identity in the pool', () => {
    const pool = new BufferPool()
    const workspace = pool.encoder.frame.allocationWorkspace
    expect(workspace.spectrumPricingStates).toHaveLength(
      CODING_UNIT_MAX_CHANNELS
    )
    expect(workspace.spectrumPricedBands).toHaveLength(CODING_UNIT_MAX_CHANNELS)
    expect(workspace.normalizedSpectra).toHaveLength(CODING_UNIT_MAX_CHANNELS)
    expect(
      workspace.spectrumPricingStates.every(
        (state) => state instanceof SpectrumPricingState
      )
    ).toBe(true)
    expect(
      workspace.spectrumPricedBands.every(
        (record) => record instanceof PricedSpectrumBand
      )
    ).toBe(true)
  })
})
