/** Bounded ATRAC3plus frame measurement and immutable final emission. */

import {
  FRAME_PACK_SCRATCH_SLACK_BYTES,
  FRAME_PADDING_BYTE,
  FRAME_TAG,
} from '../../core/constants.js'
import { framePayloadCapacityBits } from '../../core/geometry.js'
import { BitWriter } from '../bitstream.js'
import { packCodingUnit } from '../unit/writer.js'
import {
  FrameHeader,
  frameTagForChannelCount,
  packFrameTag,
} from '../records.js'

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
 * Verify frame geometry, transactions, shared syntax, and spectrum work.
 *
 * @param {CodingUnitAllocationTransaction[]} transactions
 * @param {SharedState[]} sharedCodingUnits
 * @param {number} codingUnitCount
 * @param {number} frameBytes
 * @param {SpectrumSyntaxScratch} spectrumScratch
 */
function validateFrameRequest(
  transactions,
  sharedCodingUnits,
  codingUnitCount,
  frameBytes,
  spectrumScratch
) {
  framePayloadCapacityBits(frameBytes, codingUnitCount)
  if (
    !Array.isArray(transactions) ||
    transactions.length < codingUnitCount ||
    !Array.isArray(sharedCodingUnits) ||
    !spectrumScratch
  ) {
    throw new RangeError('ATRAC3plus frame pack request is invalid')
  }
}

/**
 * Verify bounded caller-owned output storage.
 *
 * @param {number} frameBytes Frame width.
 * @param {Uint8Array} scratch Output scratch.
 */
function validateOutput(frameBytes, scratch) {
  if (
    !(scratch instanceof Uint8Array) ||
    scratch.length < frameBytes + FRAME_PACK_SCRATCH_SLACK_BYTES
  ) {
    throw new RangeError('ATRAC3plus frame pack output is invalid')
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
 * Write one complete frame.
 *
 * @param {CodingUnitAllocationTransaction[]} transactions Selected units.
 * @param {SharedState[]} sharedCodingUnits Detached shared unit states.
 * @param {number} codingUnitCount Active coding-unit count.
 * @param {number} frameBytes Profile frame width.
 * @param {SpectrumSyntaxScratch} spectrumScratch Reusable spectrum work.
 * @param {BitWriter} sink Bit sink.
 * @returns {number} Unpadded payload width in bits.
 */
function traverseFrame(
  transactions,
  sharedCodingUnits,
  codingUnitCount,
  frameBytes,
  spectrumScratch,
  sink
) {
  const frameBits = frameBytes * 8
  FrameHeader.pack(sink)
  for (let unit = 0; unit < codingUnitCount; unit++) {
    const transaction = transactions[unit]
    const tag = frameTagForChannelCount(transaction?.channelCount)
    if (tag === null) {
      throw new RangeError('ATRAC3plus coding-unit frame tag is invalid')
    }
    packFrameTag(tag, sink)
    packCodingUnit(
      transaction,
      sharedForTransaction(transaction, sharedCodingUnits),
      spectrumScratch,
      sink
    )
    if (sink.bitPosition > frameBits) {
      throw new FramePackError('coding-unit overflow', unit)
    }
  }
  packFrameTag(FRAME_TAG.TERMINATOR, sink)
  if (sink.bitPosition > frameBits) {
    throw new FramePackError('terminator overflow')
  }
  return sink.bitPosition
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
  validateFrameRequest(
    transactions,
    sharedCodingUnits,
    codingUnitCount,
    frameBytes,
    spectrumScratch
  )
  validateOutput(frameBytes, scratch)
  scratch.fill(0)
  const writer = new BitWriter(scratch)
  const payloadBits = traverseFrame(
    transactions,
    sharedCodingUnits,
    codingUnitCount,
    frameBytes,
    spectrumScratch,
    writer
  )
  const alignedByte = (payloadBits + 7) >>> 3
  for (let byte = alignedByte; byte < frameBytes; byte++) {
    scratch[byte] |= FRAME_PADDING_BYTE
  }
  return payloadBits
}
