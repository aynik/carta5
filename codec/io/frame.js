/** Bounded ATRAC3plus frame measurement and immutable final emission. */

import {
  FRAME_PACK_SCRATCH_SLACK_BYTES,
  FRAME_PADDING_BYTE,
  FRAME_TAG,
} from '../core/constants.js'
import { framePayloadCapacityBits } from '../core/geometry.js'
import { BitWriter } from './bitstream.js'
import { packCodingUnit } from './coding-unit.js'
import { FrameHeader, frameTagForChannelCount, packFrameTag } from './syntax.js'

/**
 * Error raised when frame pack input violates the decoder or bitstream contract.
 */
export class FramePackError extends RangeError {
  /**
   * Attach codec context to a frame pack error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {number} [codingUnitIndex]
   */
  constructor(kind, codingUnitIndex = -1) {
    const suffix =
      codingUnitIndex < 0 ? '' : ` at coding unit ${codingUnitIndex}`
    super(`ATRAC3plus frame ${kind}${suffix}`)
    this.name = 'FramePackError'
    this.kind = kind
    this.codingUnitIndex = codingUnitIndex
  }
}

/**
 * Verify frame capacity, coding-unit transactions, shared syntax, and output scratch before exact preflight and packing.
 *
 * @param {CodingUnitAllocationTransaction[]} transactions
 * @param {SharedState[]} sharedCodingUnits
 * @param {number} codingUnitCount
 * @param {number} frameBytes
 * @param {Uint8Array} scratch
 * @param {SpectrumSyntaxScratch} spectrumScratch
 */
function validatePackRequest(
  transactions,
  sharedCodingUnits,
  codingUnitCount,
  frameBytes,
  scratch,
  spectrumScratch
) {
  framePayloadCapacityBits(frameBytes, codingUnitCount)
  if (
    !Array.isArray(transactions) ||
    transactions.length < codingUnitCount ||
    !Array.isArray(sharedCodingUnits) ||
    !(scratch instanceof Uint8Array) ||
    scratch.length < frameBytes + FRAME_PACK_SCRATCH_SLACK_BYTES ||
    !spectrumScratch
  ) {
    throw new RangeError('ATRAC3plus frame pack request is invalid')
  }
}

/**
 * Resolve the coding-unit shared state associated with a frame transaction.
 *
 * @param {CodingUnitAllocationTransaction} transaction
 * @param {SharedState[]} sharedCodingUnits
 * @returns {SharedState}
 */
function sharedForTransaction(transaction, sharedCodingUnits) {
  const index = transaction?.channelBlocks?.[0]?.sharedIndex
  const shared = sharedCodingUnits[index]
  if (!Number.isInteger(index) || index < 0 || !shared) {
    throw new RangeError('ATRAC3plus coding-unit shared state is missing')
  }
  return shared
}

/**
 * Pack a complete selected frame into caller-owned scratch.
 * Returns the unpadded payload cursor and publishes no state or output view.
 *
 * @param {CodingUnitAllocationTransaction[]} transactions Selected units.
 * @param {SharedState[]} sharedCodingUnits Detached shared unit states.
 * @param {number} codingUnitCount Active coding-unit count.
 * @param {number} frameBytes Profile frame width.
 * @param {Uint8Array} scratch Caller-owned frame storage.
 * @param {SpectrumSyntaxScratch} spectrumScratch Reusable spectrum work.
 * @returns {number} Unpadded payload width in bits.
 */
export function packFrame(
  transactions,
  sharedCodingUnits,
  codingUnitCount,
  frameBytes,
  scratch,
  spectrumScratch
) {
  validatePackRequest(
    transactions,
    sharedCodingUnits,
    codingUnitCount,
    frameBytes,
    scratch,
    spectrumScratch
  )
  scratch.fill(0)
  const writer = new BitWriter(scratch)
  const frameBits = frameBytes * 8
  FrameHeader.pack(writer)
  for (let unit = 0; unit < codingUnitCount; unit++) {
    const transaction = transactions[unit]
    const tag = frameTagForChannelCount(transaction?.channelCount)
    if (tag === null) {
      throw new RangeError('ATRAC3plus coding-unit frame tag is invalid')
    }
    packFrameTag(tag, writer)
    packCodingUnit(
      transaction,
      sharedForTransaction(transaction, sharedCodingUnits),
      spectrumScratch,
      writer
    )
    if (writer.bitPosition > frameBits) {
      throw new FramePackError('coding-unit overflow', unit)
    }
  }
  packFrameTag(FRAME_TAG.TERMINATOR, writer)
  if (writer.bitPosition > frameBits) {
    throw new FramePackError('terminator overflow')
  }
  const payloadBits = writer.bitPosition
  const alignedByte = (payloadBits + 7) >>> 3
  for (let byte = alignedByte; byte < frameBytes; byte++) {
    scratch[byte] |= FRAME_PADDING_BYTE
  }
  return payloadBits
}
