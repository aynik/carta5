import { describe, expect, it } from 'vitest'
import {
  BitReader,
  BitCounter,
  BitWriter,
  peekBits,
} from '../codec/io/bitstream.js'
import {
  BlockHeaderSyntax,
  FrameHeader,
  NoiseSyntax,
  PresenceSyntax,
  channelCountForChannelMode,
  channelCountForChannelModeOrMono,
  channelCountForFrameTag,
  codingUnitCountForStreamMode,
  frameTagForChannelCount,
  frameTagFromWire,
  packFrameTag,
} from '../codec/io/syntax.js'
import { FRAME_TAG } from '../codec/core/constants.js'

function roundTrip(
  syntax,
  bitCount,
  unpack,
  pack = (value, sink) => value.pack(sink)
) {
  const bytes = new Uint8Array(Math.ceil(bitCount / 8))
  const writer = new BitWriter(bytes)
  pack(syntax, writer)
  expect(writer.bitPosition).toBe(bitCount)
  const reader = new BitReader(bytes)
  const decoded = unpack(reader)
  expect(reader.bitPosition).toBe(bitCount)
  return decoded
}

describe('ATRAC3plus frame syntax', () => {
  it('uses the bounded zero-padded ATRAC3plus reader contract', () => {
    expect(peekBits(new Uint8Array([0xab]), 4, 8)).toBe(0xb0)
    expect(peekBits(new Uint8Array(8193).fill(0xff), 0x10000, 8)).toBe(0)
    expect(() => peekBits(new Uint8Array(), 0, 25)).toThrow(RangeError)
    const reader = new BitReader(new Uint8Array([0xf0]), 4)
    expect(reader.read(8)).toBe(0)
    expect(reader.bitPosition).toBe(12)
  })

  it('packs the zero frame header and validates the high bit', () => {
    const bytes = new Uint8Array([0xff])
    const writer = new BitWriter(bytes)
    FrameHeader.pack(writer)
    expect(bytes[0]).toBe(0x7f)
    expect(FrameHeader.isValid(bytes[0])).toBe(true)
    expect(FrameHeader.isValid(0x80)).toBe(false)
  })

  it('maps and packs every two-bit frame tag', () => {
    expect([0, 1, 2, 3, 4].map(frameTagFromWire)).toEqual([0, 1, 2, 3, 0])
    expect(frameTagForChannelCount(1)).toBe(FRAME_TAG.MONO)
    expect(frameTagForChannelCount(2)).toBe(FRAME_TAG.STEREO)
    expect(frameTagForChannelCount(3)).toBeNull()
    expect(channelCountForFrameTag(FRAME_TAG.MONO)).toBe(1)
    expect(channelCountForFrameTag(FRAME_TAG.STEREO)).toBe(2)
    expect(channelCountForFrameTag(FRAME_TAG.EXTENSION)).toBeNull()

    const bytes = new Uint8Array(1)
    const writer = new BitWriter(bytes)
    for (const tag of [0, 1, 2, 3]) packFrameTag(tag, writer)
    expect([...bytes]).toEqual([0x1b])
  })

  it('round-trips block headers and identifies reserved band limits', () => {
    const decoded = roundTrip(
      new BlockHeaderSyntax(29, 1),
      6,
      BlockHeaderSyntax.unpack
    )
    expect(decoded).toEqual(new BlockHeaderSyntax(29, 1))
    expect(decoded.isReserved).toBe(true)
    expect(new BlockHeaderSyntax(32, 0).isReserved).toBe(false)
  })

  it('round-trips compact and mixed presence syntax with exact pricing', () => {
    const compact = new PresenceSyntax(1, 0)
    const compactCounter = new BitCounter()
    compact.pack(6, compactCounter)
    expect(compactCounter.bitPosition).toBe(compact.wireBits(6))
    const decodedCompact = roundTrip(
      compact,
      2,
      (reader) => PresenceSyntax.unpack(reader, 6),
      (value, sink) => value.pack(6, sink)
    )
    expect([...decodedCompact.flags.slice(0, 6)]).toEqual([1, 1, 1, 1, 1, 1])

    const mixed = new PresenceSyntax(1, 1, [1, 0, 1, 0])
    const decodedMixed = roundTrip(
      mixed,
      6,
      (reader) => PresenceSyntax.unpack(reader, 4),
      (value, sink) => value.pack(4, sink)
    )
    expect([...decodedMixed.flags.slice(0, 4)]).toEqual([1, 0, 1, 0])
    expect(mixed.wireBits(4)).toBe(6)
  })

  it('round-trips absent and present spectral-noise syntax', () => {
    expect(roundTrip(new NoiseSyntax(), 1, NoiseSyntax.unpack)).toEqual(
      new NoiseSyntax()
    )
    expect(roundTrip(new NoiseSyntax(1, 12, 7), 9, NoiseSyntax.unpack)).toEqual(
      new NoiseSyntax(1, 12, 7)
    )
  })

  it('pins topology helpers', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(codingUnitCountForStreamMode)).toEqual([
      0, 1, 1, 2, 3, 4, 5, 5,
    ])
    expect([0, 1, 2, 3, 4, 5].map(channelCountForChannelMode)).toEqual([
      0, 1, 2, 2, 1, 0,
    ])
    expect(channelCountForChannelModeOrMono(5)).toBe(1)
  })
})
