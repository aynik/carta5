import { describe, expect, it } from 'vitest'

import {
  EXTENSION_HEADER_BITS,
  EXTENSION_LENGTH_BITS,
  EXTENSION_LENGTH_LIMIT,
  EXTENSION_LENGTH_OFFSET_BITS,
  FRAME_HEADER_BITS,
  FRAME_TAG_BITS,
} from '../codec/core/constants.js'
import {
  FrameTraversal,
  FrameTraversalError,
  validateFrameSource,
} from '../codec/io/frame-decoder.js'

import { BitWriter } from '../codec/io/bitstream.js'
import { FRAME_ITEM_KIND, FRAME_TAG } from '../codec/core/constants.js'

function frameSyntax(fields, bytes = 16) {
  const output = new Uint8Array(bytes)
  for (const [position, value, bits] of fields) {
    new BitWriter(output, position).write(value, bits)
  }
  return output
}

describe('ATRAC3plus bounded frame traversal', () => {
  it('emits one coding unit then the configured terminator', () => {
    const frame = frameSyntax([
      [FRAME_HEADER_BITS, FRAME_TAG.MONO, FRAME_TAG_BITS],
      [
        FRAME_HEADER_BITS + FRAME_TAG_BITS,
        FRAME_TAG.TERMINATOR,
        FRAME_TAG_BITS,
      ],
    ])
    const traversal = new FrameTraversal(frame.length, 1)
    const itemIdentity = traversal.item
    expect(traversal.next(frame)).toMatchObject({
      kind: FRAME_ITEM_KIND.CODING_UNIT,
      codingUnitIndex: 0,
      tag: FRAME_TAG.MONO,
    })
    expect(traversal.item).toBe(itemIdentity)
    expect(traversal.bitPosition).toBe(FRAME_HEADER_BITS + FRAME_TAG_BITS)
    traversal.advanceAfterCodingUnit()
    traversal.bitPosition += 0
    expect(traversal.next(frame)).toMatchObject({
      kind: FRAME_ITEM_KIND.TERMINATOR,
    })
  })

  it('skips an extension payload before reading the next tag', () => {
    const frame = frameSyntax([
      [FRAME_HEADER_BITS, FRAME_TAG.EXTENSION, FRAME_TAG_BITS],
      [
        FRAME_HEADER_BITS + EXTENSION_LENGTH_OFFSET_BITS,
        1,
        EXTENSION_LENGTH_BITS,
      ],
      [
        FRAME_HEADER_BITS + EXTENSION_HEADER_BITS + 8,
        FRAME_TAG.TERMINATOR,
        FRAME_TAG_BITS,
      ],
    ])
    const traversal = new FrameTraversal(frame.length, 0)
    expect(traversal.next(frame).kind).toBe(FRAME_ITEM_KIND.TERMINATOR)
  })

  it('reports every structural boundary without mutating decoder state', () => {
    const terminator = frameSyntax([
      [FRAME_HEADER_BITS, FRAME_TAG.TERMINATOR, FRAME_TAG_BITS],
    ])
    const codingUnit = frameSyntax([
      [FRAME_HEADER_BITS, FRAME_TAG.STEREO, FRAME_TAG_BITS],
    ])
    const extension = frameSyntax([
      [FRAME_HEADER_BITS, FRAME_TAG.EXTENSION, FRAME_TAG_BITS],
      [
        FRAME_HEADER_BITS + EXTENSION_LENGTH_OFFSET_BITS,
        EXTENSION_LENGTH_LIMIT,
        EXTENSION_LENGTH_BITS,
      ],
    ])
    const failures = [
      () => new FrameTraversal(terminator.length, 1).next(terminator),
      () => new FrameTraversal(codingUnit.length, 0).next(codingUnit),
      () => new FrameTraversal(extension.length, 0).next(extension),
      () => new FrameTraversal(0, 0).next(new Uint8Array(0)),
    ]
    const kinds = [
      'missing coding units',
      'too many coding units',
      'extension length',
      'unterminated frame',
    ]
    for (let index = 0; index < failures.length; index++) {
      expect(failures[index]).toThrow(FrameTraversalError)
      try {
        failures[index]()
      } catch (error) {
        expect(error.kind).toBe(kinds[index])
      }
    }
  })

  it('preflights truncation and header validity before transaction capture', () => {
    expect(() => validateFrameSource(new Uint8Array(0), 1)).toThrow(
      'source is truncated'
    )
    expect(() => validateFrameSource(Uint8Array.of(0), 2)).toThrow(
      'source is truncated'
    )
    expect(() => validateFrameSource(Uint8Array.of(0x80), 1)).toThrow(
      'header is invalid'
    )
    const source = Uint8Array.of(0, 1)
    expect(validateFrameSource(source, 1)).toBe(source)
  })
})
