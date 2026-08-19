/** Bounded ATRAC3plus frame preflight and coding-unit tag traversal. */

import {
  EXTENSION_HEADER_BITS,
  EXTENSION_LENGTH_BITS,
  EXTENSION_LENGTH_LIMIT,
  EXTENSION_LENGTH_OFFSET_BITS,
  FRAME_HEADER_BITS,
  FRAME_TAG_BITS,
  FRAME_ITEM_KIND,
  FRAME_TAG,
} from '../core/constants.js'
import { peekBits, BitReader } from './bitstream.js'
import {
  FrameHeader,
  channelCountForFrameTag,
  frameTagFromWire,
} from './syntax.js'

import { unpackCodingUnit } from './coding-unit-decoder.js'
import { applyStereoToneFixes } from './tone-decoder.js'
import { FrameDecodeStorage } from '../state/decoder-syntax.js'

/**
 * Error raised when frame traversal input violates the decoder or bitstream contract.
 */
export class FrameTraversalError extends RangeError {
  /**
   * Describe one structural frame traversal failure.
   *
   * @param {string} kind Stable failure category.
   * @param {Record<string, unknown>} fields Additional diagnostic fields.
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus frame traversal failed: ${kind}`)
    this.name = 'FrameTraversalError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Reusable result image returned by one frame traversal.
 */
export class FrameItem {
  /**
   * Allocate one reusable traversal result image.
   */
  constructor() {
    this.kind = FRAME_ITEM_KIND.TERMINATOR
    this.codingUnitIndex = -1
    this.tag = FRAME_TAG.TERMINATOR
  }

  /**
   * Publish a coding-unit traversal result.
   *
   * @param {number} index Configured coding-unit index.
   * @param {number} tag Parsed frame tag.
   * @returns {FrameItem} This reusable result image.
   */
  setCodingUnit(index, tag) {
    this.kind = FRAME_ITEM_KIND.CODING_UNIT
    this.codingUnitIndex = index
    this.tag = tag
    return this
  }

  /**
   * Reset the traversal image to the frame-terminator result.
   *
   * @returns {FrameItem} This image reset to the terminator result.
   */
  setTerminator() {
    this.kind = FRAME_ITEM_KIND.TERMINATOR
    this.codingUnitIndex = -1
    this.tag = FRAME_TAG.TERMINATOR
    return this
  }
}

/**
 * Validate immutable source geometry before decoder transaction capture.
 *
 * @param {Uint8Array} source Complete encoded frame bytes.
 * @param {number} frameBytes Profile frame width in bytes.
 * @returns {Uint8Array} The validated source.
 */
export function validateFrameSource(source, frameBytes) {
  if (
    !(source instanceof Uint8Array) ||
    !Number.isInteger(frameBytes) ||
    frameBytes < 1 ||
    source.length < frameBytes
  ) {
    throw new RangeError('ATRAC3plus frame source is truncated')
  }
  if (!FrameHeader.isValid(source[0])) {
    throw new RangeError('ATRAC3plus frame header is invalid')
  }
  return source
}

/**
 * Own extension skips, configured coding-unit count, and the 16-bit cursor.
 */
export class FrameTraversal {
  /**
   * Allocate one reusable bounded tag traversal.
   *
   * @param {number} frameBytes Encoded frame width in bytes.
   * @param {number} codingUnitCount Expected coding-unit count.
   */
  constructor(frameBytes, codingUnitCount) {
    if (
      !Number.isInteger(frameBytes) ||
      frameBytes < 0 ||
      !Number.isInteger(codingUnitCount) ||
      codingUnitCount < 0
    ) {
      throw new RangeError('ATRAC3plus traversal geometry is invalid')
    }
    this.item = new FrameItem()
    this.reset(frameBytes, codingUnitCount)
  }

  /**
   * Reset the cursor for another frame without replacing its result image.
   *
   * @param {number} frameBytes Encoded frame width in bytes.
   * @param {number} codingUnitCount Expected coding-unit count.
   * @returns {FrameTraversal} This traversal.
   */
  reset(frameBytes, codingUnitCount) {
    if (
      !Number.isInteger(frameBytes) ||
      frameBytes < 0 ||
      !Number.isInteger(codingUnitCount) ||
      codingUnitCount < 0
    ) {
      throw new RangeError('ATRAC3plus traversal geometry is invalid')
    }
    this.bitPosition = FRAME_HEADER_BITS
    this.frameBits = frameBytes * 8
    this.codingUnitCount = codingUnitCount
    this.nextCodingUnit = 0
    return this
  }

  /**
   * Return the next coding-unit or terminator item, skipping extensions.
   *
   * @param {Uint8Array} source Padded frame source.
   * @returns {FrameItem} Reused current traversal item.
   */
  next(source) {
    if (!(source instanceof Uint8Array)) {
      throw new TypeError('ATRAC3plus traversal source is invalid')
    }
    for (;;) {
      const lastTagPosition = this.frameBits - FRAME_TAG_BITS
      if (lastTagPosition < 0 || this.bitPosition > lastTagPosition) {
        throw new FrameTraversalError('unterminated frame', {
          bitPosition: this.bitPosition,
          frameBits: this.frameBits,
        })
      }
      const tag = frameTagFromWire(
        peekBits(source, this.bitPosition, FRAME_TAG_BITS)
      )
      const payloadPosition = this.bitPosition + FRAME_TAG_BITS
      if (tag === FRAME_TAG.TERMINATOR) {
        if (this.nextCodingUnit !== this.codingUnitCount) {
          throw new FrameTraversalError('missing coding units', {
            parsedCodingUnits: this.nextCodingUnit,
            configuredCodingUnits: this.codingUnitCount,
          })
        }
        return this.item.setTerminator()
      }
      if (payloadPosition > 0x10000) {
        throw new FrameTraversalError('bit position overflow', {
          bitPosition: payloadPosition,
        })
      }
      if (tag === FRAME_TAG.EXTENSION) {
        const lengthBytes = peekBits(
          source,
          this.bitPosition + EXTENSION_LENGTH_OFFSET_BITS,
          EXTENSION_LENGTH_BITS
        )
        this.bitPosition += EXTENSION_HEADER_BITS
        if (lengthBytes >= EXTENSION_LENGTH_LIMIT) {
          throw new FrameTraversalError('extension length', {
            bitPosition: this.bitPosition,
            lengthBytes,
          })
        }
        this.bitPosition += lengthBytes * 8
        continue
      }
      if (this.nextCodingUnit >= this.codingUnitCount) {
        throw new FrameTraversalError('too many coding units', {
          parsedCodingUnits: this.nextCodingUnit,
          configuredCodingUnits: this.codingUnitCount,
        })
      }
      this.bitPosition = payloadPosition
      return this.item.setCodingUnit(this.nextCodingUnit, tag)
    }
  }

  /**
   * Advance the traversal cursor after the current coding unit has been decoded successfully.
   *
   * @returns {void}
   */
  advanceAfterCodingUnit() {
    this.nextCodingUnit++
  }
}

/**
 * Fixed reader, traversal, and rebound views for complete frame parsing.
 */
export class FrameDecodeScratch {
  /**
   * Wrap pool-owned storage with one reader and traversal context.
   *
   * @param {FrameDecodeStorage} storage Fixed decoder storage.
   */
  constructor(storage) {
    if (!(storage instanceof FrameDecodeStorage)) {
      throw new TypeError('ATRAC3plus frame decoder storage is invalid')
    }
    this.storage = storage
    this.paddedFrame = storage.paddedFrame
    this.reader = new BitReader(storage.paddedFrame)
    this.traversal = new FrameTraversal(1, 0)
    this.codingUnit = storage.codingUnit
    this.blockViews = storage.blockViews
    this.primaryToneSlots = storage.primaryToneSlots
    this.secondaryToneSlots = storage.secondaryToneSlots
  }
}

/**
 * Attach decoded channel blocks to coding-unit descriptors in frame traversal order.
 *
 * @param {DecodeChannelState[]} destination
 * @param {DecoderFrameState} state
 * @param {CodingUnitChannels} channels
 * @returns {DecodeChannelState[]}
 */
function bindCodingUnitBlocks(destination, state, channels) {
  destination.length = channels.length
  for (let ordinal = 0; ordinal < channels.length; ordinal++) {
    destination[ordinal] = state.channelBlocks[channels.at(ordinal)]
  }
  return destination
}

/**
 * Parse a complete frame into detached state, stopping before reconstruction.
 *
 * @param {Uint8Array} source Complete encoded frame bytes.
 * @param {number} frameBytes Profile frame width in bytes.
 * @param {number} codingUnitCount Expected coding-unit count.
 * @param {CodingUnitChannels[]} codingUnitChannels Configured channel topology.
 * @param {DecoderFrameState} stagedState Detached decoder frame state.
 * @param {FrameDecodeScratch} scratch I/O wrapper over pool-owned storage.
 * @returns {number} Parsed terminal bit position.
 */
export function unpackFrameSyntax(
  source,
  frameBytes,
  codingUnitCount,
  codingUnitChannels,
  stagedState,
  scratch
) {
  validateFrameSource(source, frameBytes)
  if (
    !(scratch instanceof FrameDecodeScratch) ||
    !Array.isArray(codingUnitChannels) ||
    codingUnitChannels.length < codingUnitCount ||
    !Array.isArray(stagedState?.channelBlocks) ||
    !Array.isArray(stagedState?.sharedCodingUnits)
  ) {
    throw new RangeError('ATRAC3plus frame decode state is invalid')
  }
  const padded = scratch.paddedFrame
  padded.fill(0)
  for (let index = 0; index < frameBytes; index++) padded[index] = source[index]
  const reader = scratch.reader
  reader.bitPosition = FRAME_HEADER_BITS
  const traversal = scratch.traversal.reset(frameBytes, codingUnitCount)

  for (;;) {
    const item = traversal.next(padded)
    if (item.kind === FRAME_ITEM_KIND.TERMINATOR) {
      traversal.bitPosition += FRAME_TAG_BITS
      break
    }
    const unit = item.codingUnitIndex
    const channels = codingUnitChannels[unit]
    const channelCount = channelCountForFrameTag(item.tag)
    if (channelCount !== channels.length) {
      throw new FrameTraversalError('coding-unit tag mismatch', {
        codingUnitIndex: unit,
        taggedChannels: channelCount,
        configuredChannels: channels.length,
      })
    }
    const blocks = bindCodingUnitBlocks(
      scratch.blockViews[unit],
      stagedState,
      channels
    )
    reader.bitPosition = traversal.bitPosition
    unpackCodingUnit(
      blocks,
      stagedState.sharedCodingUnits[unit],
      reader,
      scratch.codingUnit
    )
    traversal.bitPosition = reader.bitPosition
    traversal.advanceAfterCodingUnit()
  }

  for (let unit = 0; unit < codingUnitCount; unit++) {
    const channels = codingUnitChannels[unit]
    if (channels.length !== 2) continue
    const primary = stagedState.channelBlocks[channels.at(0)]
    const secondary = stagedState.channelBlocks[channels.at(1)]
    scratch.primaryToneSlots[0] = primary.toneSlots[0]
    scratch.primaryToneSlots[1] = primary.toneSlots[1]
    scratch.secondaryToneSlots[0] = secondary.toneSlots[0]
    scratch.secondaryToneSlots[1] = secondary.toneSlots[1]
    applyStereoToneFixes(
      scratch.primaryToneSlots,
      scratch.secondaryToneSlots,
      scratch.codingUnit.tone
    )
  }
  return traversal.bitPosition
}
