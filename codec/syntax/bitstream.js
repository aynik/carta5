/**
 * Carta ATRAC-family Bitstream Operations
 *
 * This module provides low-level bitstream packing and unpacking operations
 * for reading and writing ATRAC bitstreams with bit-level precision.
 */

import { MAX_FRAME_BIT_POSITION } from '../core/constants.js'

/**
 * Reject bit widths that cannot be represented safely by the bitstream primitive.
 *
 * @param {number} bitCount
 * @returns {i32} Validated field width.
 */
function assertBitCount(bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
    throw new RangeError(
      `Bit count must be an integer in 0..32, got ${bitCount}`
    )
  }
  return bitCount
}

/**
 * Reusable MSB-first writer used by ATRAC syntax objects.
 *
 * @property {i32} bitPosition Frame-local bit cursor.
 * @property {DataView} view Reusable big-endian word access to the destination bytes.
 * @nativeStable Own data descriptors and field order stay fixed after construction.
 */
export class BitWriter {
  /**
   * Wrap a destination buffer at an optional initial bit position.
   *
   * @param {Uint8Array} buffer Caller-owned destination bytes.
   * @param {number} [bitPosition] Initial absolute bit position.
   */
  constructor(buffer, bitPosition = 0) {
    this.buffer = buffer
    this.bitPosition = bitPosition
    this.view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    )
  }

  /**
   * Write one unsigned value in MSB-first order.
   *
   * @param {number} value Unsigned low-bit field to write.
   * @param {number} bitCount Field width from zero through 32.
   * @returns {void}
   */
  write(value, bitCount) {
    /** @type {i32} */
    const bitPosition = this.bitPosition
    writeBitsAt(this, this.buffer, bitPosition, value, bitCount)
  }
}

/**
 * Write one field using a caller-cached buffer and cursor, then publish its end.
 * Keeping the cursor current also preserves partial progress when a later field
 * throws. Syntax loops can reuse the returned cursor without rereading state.
 *
 * @param {BitWriter} writer Destination owner.
 * @param {Uint8Array} buffer Destination bytes.
 * @param {i32} bitPosition Initial frame-local cursor.
 * @param {number} value Unsigned low-bit field.
 * @param {number} bitCount Field width from zero through 32, validated before packing.
 * @returns {i32} Cursor following the successfully written field.
 */
export function writeBitsAt(writer, buffer, bitPosition, value, bitCount) {
  if (bitPosition < 0 || bitPosition + bitCount > buffer.length * 8) {
    throw new RangeError('Bit write exceeds destination buffer')
  }
  packField(buffer, bitPosition, value, bitCount, writer.view)
  const next = bitPosition + bitCount
  writer.bitPosition = next
  return next
}

/**
 * Destination-free syntax sink used for exact bit accounting.
 *
 * @property {i32} bitPosition Frame-local bit count.
 * @nativeStable Own data descriptors and field order stay fixed after construction.
 */
export class BitCounter {
  /**
   * Start exact accounting at an optional existing bit position.
   *
   * @param {number} [bitPosition] Initial absolute bit position.
   */
  constructor(bitPosition = 0) {
    this.bitPosition = bitPosition
  }

  /**
   * Account for one write without materializing destination bytes.
   *
   * @param {number} _value Ignored value accepted for writer compatibility.
   * @param {number} bitCount Field width from zero through 32.
   * @returns {void}
   */
  write(_value, bitCount) {
    assertBitCount(bitCount)
    this.bitPosition += bitCount
  }
}

/**
 * ATRAC3plus reader with the reference decoder's 16-bit frame-position limit.
 * ATRAC3plus fields use a zero-padded 24-bit peek window and are at most 17 bits wide.
 *
 * @property {i32} bitPosition Cursor bounded by the format's 16-bit frame limit.
 * @nativeStable Own data descriptors and field order stay fixed after construction.
 */
export class BitReader {
  /**
   * Wrap a zero-padded source at an optional initial bit position.
   *
   * @param {Uint8Array} buffer
   * @param {number} [bitPosition]
   */
  constructor(buffer, bitPosition = 0) {
    this.buffer = buffer
    this.bitPosition = bitPosition
  }

  /**
   * Read low-order bits at the current cursor without advancing the bounded bitstream reader.
   *
   * @param {number} bitCount
   * @returns {i32}
   */
  peek(bitCount) {
    return peekBits(this.buffer, this.bitPosition, bitCount)
  }

  /**
   * Consume an unsigned value of the requested width from the bounded bitstream reader.
   *
   * @param {number} bitCount
   * @returns {i32}
   */
  read(bitCount) {
    /** @type {i32} */
    const bitPosition = this.bitPosition
    const value = peekBits(this.buffer, bitPosition, bitCount)
    this.bitPosition = bitPosition + bitCount
    return value
  }

  /**
   * Consume a fixed-width two's-complement value from the bounded bitstream reader.
   *
   * @param {number} bitCount
   * @returns {i32}
   */
  readSigned(bitCount) {
    const value = this.read(bitCount)
    if (bitCount === 0) return 0
    const signBit = 2 ** (bitCount - 1)
    return value >= signBit ? value - 2 ** bitCount : value
  }
}

/**
 * Pack bits into a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Destination buffer
 * @param {number} bitPosition - Bit position to start writing at
 * @param {number} value - Value to pack
 * @param {number} bitCount - Number of bits to pack
 * @returns {void}
 */
export function packBits(buffer, bitPosition, value, bitCount) {
  packField(buffer, bitPosition, value, bitCount)
}

/**
 * Pack a field and report its written width to the cursor-owning writer.
 *
 * @param {Uint8Array} buffer Destination bytes.
 * @param {i32} bitPosition Initial frame-local bit position.
 * @param {number} value Unsigned low-bit field.
 * @param {number} bitCount Requested width.
 * @param {DataView|null} [wordView=null] Reusable word view for the standard writer.
 * @returns {i32} Number of bits written.
 * @nativeUnchecked Native callers use writer-owned bytes and a validated nonnegative frame cursor.
 */
function packField(buffer, bitPosition, value, bitCount, wordView = null) {
  const width = assertBitCount(bitCount)
  if (width === 0) return 0

  /** @type {i32} Byte index within the validated frame buffer. */
  let byteIndex = Math.floor(bitPosition / 8)
  /** @type {i32} Bit offset within the current byte. */
  let bitOffset =
    bitPosition >= 0 ? bitPosition - byteIndex * 8 : bitPosition % 8

  const fieldValue = Number(value) | 0

  if (
    wordView !== null &&
    Number.isInteger(bitPosition) &&
    bitOffset + width <= 32 &&
    byteIndex + 4 <= buffer.length
  ) {
    /** @type {DataView} The standard writer owns this view. */
    const view = wordView
    const shift = 32 - width - bitOffset
    /** @type {i32} */
    const fieldMask = width === 32 ? -1 : (1 << width) - 1
    const mask = fieldMask << shift
    /** @type {i32} Signed word preserves the same 32-bit field pattern. */
    const word = view.getInt32(byteIndex)
    view.setInt32(byteIndex, (word & ~mask) | ((fieldValue << shift) & mask))
    return width
  }

  /** @type {i32} */
  let bitsWritten = 0
  while (bitsWritten < width && byteIndex < buffer.length) {
    const bitsAvailable = 8 - bitOffset
    /** @type {i32} The remaining field and byte both have integral widths. */
    const bitsToWrite = Math.min(width - bitsWritten, bitsAvailable)

    const shift = width - bitsWritten - bitsToWrite
    const fieldMask = (1 << bitsToWrite) - 1
    const valueBits = (fieldValue >>> shift) & fieldMask

    const mask = fieldMask << (bitsAvailable - bitsToWrite)
    buffer[byteIndex] =
      (buffer[byteIndex] & ~mask) | (valueBits << (bitsAvailable - bitsToWrite))

    bitsWritten += bitsToWrite
    byteIndex++
    bitOffset = 0
  }
  return bitsWritten
}

/**
 * Unpack bits from a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Source buffer
 * @param {number} bitPosition - Bit position to start reading from
 * @param {number} bitCount - Number of bits to unpack
 * @returns {number} Unpacked unsigned value
 */
export function unpackBits(buffer, bitPosition, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return 0

  let byteIndex = Math.floor(bitPosition / 8)
  let bitOffset = bitPosition % 8
  let value = 0

  for (let bitsRead = 0; bitsRead < bitCount && byteIndex < buffer.length; ) {
    const bitsAvailable = 8 - bitOffset
    const bitsToRead = Math.min(bitCount - bitsRead, bitsAvailable)

    const mask = 2 ** bitsToRead - 1
    const bits = (buffer[byteIndex] >> (bitsAvailable - bitsToRead)) & mask

    value = (value * 2 ** bitsToRead + bits) >>> 0
    bitsRead += bitsToRead
    byteIndex++
    bitOffset = 0
  }

  return value
}

/**
 * Peek an ATRAC3plus field with zero padding and the format cursor limit.
 *
 * @param {Uint8Array} buffer Source frame bytes.
 * @param {number} bitPosition Absolute source bit position.
 * @param {number} bitCount Field width from zero through 24.
 * @returns {i32} Unsigned decoded field, or zero beyond the ATRAC3plus limit.
 */
export function peekBits(buffer, bitPosition, bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 24) {
    throw new RangeError(
      `ATRAC3plus bit count must be an integer in 0..24, got ${bitCount}`
    )
  }
  if (bitPosition > MAX_FRAME_BIT_POSITION) return 0
  if (bitCount === 0) return 0
  const byteIndex = bitPosition >>> 3
  const window =
    ((buffer[byteIndex] ?? 0) << 16) |
    ((buffer[byteIndex + 1] ?? 0) << 8) |
    (buffer[byteIndex + 2] ?? 0)
  const aligned = (window << (bitPosition & 7)) & 0x00ffffff
  return aligned >>> (24 - bitCount)
}

/**
 * Unpack signed bits from a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Source buffer
 * @param {number} bitPosition - Bit position to start reading from
 * @param {number} bitCount - Number of bits to unpack
 * @returns {number} Unpacked signed value (two's complement)
 */
export function unpackSignedBits(buffer, bitPosition, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return 0
  const value = unpackBits(buffer, bitPosition, bitCount)
  const signBit = 2 ** (bitCount - 1)
  return value >= signBit ? value - 2 ** bitCount : value
}
