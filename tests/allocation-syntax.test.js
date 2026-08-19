import { describe, expect, it } from 'vitest'

import { measureInvariantAllocationBits } from '../codec/io/allocation-syntax.js'

import { SharedState } from '../codec/state/shared.js'

describe('ATRAC3plus fixed allocation syntax accounting', () => {
  it('matches fixed, presence, noise, stereo-map, and trailer sections', () => {
    const shared = new SharedState()
    shared.bandLimit = 24
    shared.scaleFactorCount = 16
    shared.quantizationUnitCount = 24
    shared.noisePresent = 1
    shared.noiseLevelIndex = 3
    shared.noiseTableIndex = 7
    shared.presenceEnabled[1] = 1
    shared.presenceMixed[1] = 1
    expect(measureInvariantAllocationBits(shared, 2, 3, 5)).toBe(47)
  })
})
