import { describe, expect, it } from 'vitest'

import { BufferPool } from '../codec/core/buffers.js'
import { selectGainSyntax } from '../codec/io/gain-syntax.js'
import { planScaleFactorSection } from '../codec/io/scale-factor-syntax.js'

import { planRawWordLengthSection } from '../codec/io/word-length-syntax.js'
import { planCodeTableSection } from '../codec/io/code-table-syntax.js'
import { FramePackError, packFrame } from '../codec/io/frame.js'
import {
  FrameDecodeScratch,
  unpackFrameSyntax,
} from '../codec/io/frame-decoder.js'
import { BitWriter } from '../codec/io/bitstream.js'

import {
  bindDecoderChannelStates,
  copyDecoderState,
} from '../codec/state/decoder.js'
import { EncodeChannelState } from '../codec/state/encoder.js'
import {
  SharedState,
  configureCodingUnitChannels,
} from '../codec/state/shared.js'
import { FRAME_PACK_SCRATCH_SLACK_BYTES } from '../codec/core/constants.js'
import { framePayloadCapacityBits } from '../codec/core/geometry.js'
import { CodingUnitAllocationTransaction } from '../codec/state/allocation.js'
import { CodeTableAccountingTransaction } from '../codec/state/code-table.js'
import { GainCodingPlan } from '../codec/state/gain.js'
import { ScaleFactorCodingPlan } from '../codec/state/scale-factor.js'
import { SpectrumSyntaxScratch } from '../codec/state/spectrum.js'
import { ToneCodingPlan } from '../codec/state/tone.js'
import { WordLengthAccountingTransaction } from '../codec/state/word-length.js'

function activeMonoFixture() {
  const shared = new SharedState()
  shared.bandLimit = 1
  shared.scaleFactorCount = 1
  shared.quantizationUnitCount = 1
  const block = new EncodeChannelState(0)
  block.syntax.wordLengths[0] = 1
  block.syntax.scaleFactors[0] = 7
  block.syntax.codeTables[0] = 0
  block.quantizedSpectrum[0] = 1
  block.quantizedSpectrum[1] = -1
  const blocks = [block]
  const wordLength = planRawWordLengthSection(
    blocks,
    1,
    new WordLengthAccountingTransaction()
  )
  const scaleFactor = planScaleFactorSection(
    blocks,
    shared,
    new ScaleFactorCodingPlan()
  )
  const codeTable = planCodeTableSection(
    blocks,
    shared,
    false,
    new CodeTableAccountingTransaction()
  )
  const transaction = new CodingUnitAllocationTransaction().reset(1)
  transaction.channelBlocks[0] = block
  transaction.wordLengthTransaction = wordLength
  transaction.scaleFactorPlan = scaleFactor
  transaction.codeTableTransaction = codeTable
  transaction.gainPlan = selectGainSyntax(blocks, 0, 0, new GainCodingPlan())
  transaction.tonePlan = new ToneCodingPlan().clear(1)
  return { shared, transaction }
}

describe('ATRAC3plus bounded frame emission', () => {
  it('reserves header, coding-unit tags, and the terminator', () => {
    expect(framePayloadCapacityBits(744, 1)).toBe(5947)
    expect(framePayloadCapacityBits(744, 4)).toBe(5941)
  })

  it('wraps the exact coding-unit oracle and pads only whole trailing bytes', () => {
    const { shared, transaction } = activeMonoFixture()
    const frameBytes = 8
    const scratch = new Uint8Array(frameBytes + FRAME_PACK_SCRATCH_SLACK_BYTES)
    expect(
      packFrame(
        [transaction],
        [shared],
        1,
        frameBytes,
        scratch,
        new SpectrumSyntaxScratch()
      )
    ).toBe(45)
    expect(Buffer.from(scratch.subarray(0, frameBytes)).toString('hex')).toBe(
      '00041c0720180101'
    )

    const pool = new BufferPool()
    const frameDecode = new FrameDecodeScratch(pool.decoder.scratch.syntax)
    const topology = configureCodingUnitChannels(
      1,
      pool.decoder.state.topology.codingUnitChannels
    )
    bindDecoderChannelStates(
      pool.decoder.state.topology.codingUnitChannels,
      topology.codingUnitCount,
      pool.decoder.state.channelBlocks
    )
    bindDecoderChannelStates(
      pool.decoder.state.topology.codingUnitChannels,
      topology.codingUnitCount,
      pool.decoder.frame.channelBlocks
    )
    pool.decoder.state.channelBlocks[0].syntax.wordLengths[0] = 6
    copyDecoderState(pool.decoder.state, pool.decoder.frame)
    expect(
      unpackFrameSyntax(
        scratch,
        frameBytes,
        topology.codingUnitCount,
        pool.decoder.state.topology.codingUnitChannels,
        pool.decoder.frame,
        frameDecode
      )
    ).toBe(45)
    expect(pool.decoder.state.channelBlocks[0].syntax.wordLengths[0]).toBe(6)
    expect(pool.decoder.frame.channelBlocks[0].syntax.wordLengths[0]).toBe(1)
    expect([
      ...pool.decoder.frame.channelBlocks[0].quantizedSpectrum.slice(0, 4),
    ]).toEqual([1, -1, 0, 0])

    const malformed = Uint8Array.from(scratch.subarray(0, frameBytes))
    new BitWriter(malformed, 3).write(28, 5)
    expect(() =>
      unpackFrameSyntax(
        malformed,
        frameBytes,
        topology.codingUnitCount,
        pool.decoder.state.topology.codingUnitChannels,
        pool.decoder.frame,
        frameDecode
      )
    ).toThrow('coding-unit header decode failed')
    expect(pool.decoder.state.channelBlocks[0].syntax.wordLengths[0]).toBe(6)
  })

  it('reports the coding unit that crossed bounded frame capacity', () => {
    const { shared, transaction } = activeMonoFixture()
    const frameBytes = 5
    const scratch = new Uint8Array(frameBytes + FRAME_PACK_SCRATCH_SLACK_BYTES)
    let failure = null
    try {
      packFrame(
        [transaction],
        [shared],
        1,
        frameBytes,
        scratch,
        new SpectrumSyntaxScratch()
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(FramePackError)
    expect(failure).toMatchObject({
      kind: 'coding-unit overflow',
      codingUnitIndex: 0,
    })
  })
})
