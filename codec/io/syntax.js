/** Foundational bounded ATRAC3plus frame and coding-unit syntax. */

import {
  FRAME_HEADER_BITS,
  FRAME_TAG,
  FRAME_TAG_BITS,
} from '../core/constants.js'
import { CODING_UNIT_COUNT_BY_MODE } from '../core/tables.js'

/**
 * The ATRAC3plus frame header is one zero bit.
 */
export class FrameHeader {
  /**
   * Report whether the leading frame bit carries the required zero-valued ATRAC3plus header.
   *
   * @param {number} firstByte
   * @returns {boolean}
   */
  static isValid(firstByte) {
    return (firstByte & 0x80) === 0
  }

  /**
   * Emit the required zero-valued leading frame bit.
   *
   * @param {BitWriter|BitCounter} sink
   */
  static pack(sink) {
    sink.write(0, FRAME_HEADER_BITS)
  }
}

/**
 * Normalize a two-bit wire value to a frame tag.
 *
 * @param {number} value Raw wire value.
 * @returns {number} Normalized two-bit tag.
 */
export function frameTagFromWire(value) {
  return value & 3
}

/**
 * Select a coding-unit tag for a mono or stereo channel count.
 *
 * @param {number} channelCount Coding-unit channel count.
 * @returns {number|null} Frame tag, or `null` if unsupported.
 */
export function frameTagForChannelCount(channelCount) {
  if (channelCount === 1) return FRAME_TAG.MONO
  if (channelCount === 2) return FRAME_TAG.STEREO
  return null
}

/**
 * Return a coding-unit channel count, or `null` for non-coding tags.
 *
 * @param {number} tag Frame tag.
 * @returns {number|null} Mono/stereo channel count, or `null`.
 */
export function channelCountForFrameTag(tag) {
  if (tag === FRAME_TAG.MONO) return 1
  if (tag === FRAME_TAG.STEREO) return 2
  return null
}

/**
 * Emit one frame tag through a writer-compatible sink.
 *
 * @param {number} tag Frame tag.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packFrameTag(tag, sink) {
  sink.write(tag & 3, FRAME_TAG_BITS)
}

/**
 * Fixed coding-unit block header.
 */
export class BlockHeaderSyntax {
  /**
   * Initialize the fixed coding-unit header fields shared by encoder and decoder syntax paths.
   *
   * @param {number} bandLimit
   * @param {number} muteFlag
   */
  constructor(bandLimit, muteFlag) {
    this.bandLimit = bandLimit
    this.muteFlag = muteFlag
  }

  /**
   * Decode the five-bit band limit and mute flag into an independent header image.
   *
   * @param {BitReader} reader
   * @returns {BlockHeaderSyntax}
   */
  static unpack(reader) {
    return new BlockHeaderSyntax(reader.read(5) + 1, reader.read(1))
  }

  /**
   * Emit the five-bit coded band limit followed by the mute flag.
   *
   * @param {BitWriter|BitCounter} sink
   */
  pack(sink) {
    sink.write((this.bandLimit - 1) & 0x1f, 5)
    sink.write(this.muteFlag & 1, 1)
  }

  /**
   * Report whether the decoded block band limit falls in the reserved syntax range.
   *
   * @returns {boolean}
   */
  get isReserved() {
    return this.bandLimit >= 29 && this.bandLimit <= 31
  }
}

/**
 * Optional per-subband presence flags shared by a coding unit.
 */
export class PresenceSyntax {
  /**
   * Initialize the three per-channel sidechain-presence flags carried by a coding-unit header.
   *
   * @param {number} [enabled]
   * @param {number} [mixed]
   * @param {ArrayLike<number>[]} [flags]
   */
  constructor(enabled = 0, mixed = 0, flags = []) {
    this.enabled = enabled & 1
    this.mixed = mixed & 1
    this.flags = new Uint8Array(16)
    const count = Math.min(flags.length, this.flags.length)
    for (let index = 0; index < count; index++) {
      this.flags[index] = flags[index] & 1
    }
  }

  /**
   * Decode disabled, uniform, or per-subband presence flags into independent storage.
   *
   * @param {BitReader} reader
   * @param {number} count
   * @returns {PresenceSyntax}
   */
  static unpack(reader, count) {
    const active = Math.min(Math.max(count, 0), 16)
    const enabled = reader.read(1)
    if (enabled === 0) return new PresenceSyntax()
    const mixed = reader.read(1)
    const flags = new Uint8Array(16)
    if (mixed === 0) {
      flags.fill(1, 0, active)
    } else {
      for (let index = 0; index < active; index++) {
        flags[index] = reader.read(1)
      }
    }
    return new PresenceSyntax(enabled, mixed, flags)
  }

  /**
   * Emit the disabled, uniform, or per-subband presence representation selected by this header.
   *
   * @param {number} count
   * @param {BitWriter|BitCounter} sink
   */
  pack(count, sink) {
    sink.write(this.enabled, 1)
    if (this.enabled === 0) return
    sink.write(this.mixed, 1)
    if (this.mixed === 0) return
    const active = Math.min(Math.max(count, 0), 16)
    for (let index = 0; index < active; index++) {
      sink.write(this.flags[index], 1)
    }
  }

  /**
   * Return the fixed number of bits occupied by this header syntax.
   *
   * @param {number} count
   * @returns {number}
   */
  wireBits(count) {
    if (this.enabled === 0) return 1
    if (this.mixed === 0) return 2
    return 2 + Math.min(Math.max(count, 0), 16)
  }
}

/**
 * Optional coding-unit spectral noise parameters.
 */
export class NoiseSyntax {
  /**
   * Initialize optional spectral-noise syntax and its per-channel level fields.
   *
   * @param {number} [present]
   * @param {number} [levelIndex]
   * @param {number} [tableIndex]
   */
  constructor(present = 0, levelIndex = 0, tableIndex = 0) {
    this.present = present
    this.levelIndex = levelIndex
    this.tableIndex = tableIndex
  }

  /**
   * Decode the optional spectral-noise level and table indices into an independent header image.
   *
   * @param {BitReader} reader
   * @returns {NoiseSyntax}
   */
  static unpack(reader) {
    const present = reader.read(1)
    return present === 0
      ? new NoiseSyntax()
      : new NoiseSyntax(present, reader.read(4), reader.read(4))
  }

  /**
   * Emit the presence flag and optional four-bit noise level and table indices.
   *
   * @param {BitWriter|BitCounter} sink
   */
  pack(sink) {
    sink.write(this.present & 1, 1)
    if (this.present !== 0) {
      sink.write(this.levelIndex & 0x0f, 4)
      sink.write(this.tableIndex & 0x0f, 4)
    }
  }
}

/**
 * Number of coding units selected by a packed stream topology mode.
 *
 * @param {number} mode Packed stream topology mode.
 * @returns {number} Coding-unit count.
 */
export function codingUnitCountForStreamMode(mode) {
  return CODING_UNIT_COUNT_BY_MODE[mode & 7]
}

/**
 * Number of channels selected by a coding-unit channel mode.
 *
 * @param {number} mode Coding-unit channel mode.
 * @returns {number} Channel count, or zero for unsupported modes.
 */
export function channelCountForChannelMode(mode) {
  if (mode === 1 || mode === 4) return 1
  if (mode === 2 || mode === 3) return 2
  return 0
}

/**
 * Decoder fallback that treats reserved channel modes as mono.
 *
 * @param {number} mode Coding-unit channel mode.
 * @returns {number} Channel count with a mono fallback.
 */
export function channelCountForChannelModeOrMono(mode) {
  return Math.max(channelCountForChannelMode(mode), 1)
}
