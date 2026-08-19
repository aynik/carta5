/** Detached ATRAC3plus coding-unit wire traversal in reference section order. */

import { DecodeChannelState } from '../state/decoder.js'
import { CodingUnitDecodeScratch } from '../state/decoder-syntax.js'
import { SharedState } from '../state/shared.js'
import { BitReader } from './bitstream.js'
import { unpackCodeTableSection } from './code-table-decoder.js'
import { unpackGainChannel } from './gain-decoder.js'
import { unpackScaleFactorChannel } from './scale-factor-decoder.js'
import { unpackChannelSpectrum } from './spectrum-decoder.js'
import { unpackToneSection } from './tone-decoder.js'
import { unpackWordLengthChannel } from './word-length-decoder.js'

/**
 * Error raised when coding unit decode input violates the decoder or bitstream contract.
 */
export class CodingUnitDecodeError extends RangeError {
  /**
   * Wrap one section failure with coding-unit context.
   *
   * @param {string} section Stable section name.
   * @param {Error} cause Underlying decoder failure.
   */
  constructor(section, cause) {
    super(`ATRAC3plus coding-unit ${section} decode failed`, { cause })
    this.name = 'CodingUnitDecodeError'
    this.section = section
  }
}

/**
 * Verify the mono-or-stereo decoder topology and reusable syntax scratch before reading a coding unit.
 *
 * @param {DecodeChannelState[]} blocks
 * @param {SharedState} shared
 * @param {BitReader} reader
 * @param {CodingUnitDecodeScratch} scratch
 */
function validateRequest(blocks, shared, reader, scratch) {
  if (
    !Array.isArray(blocks) ||
    blocks.length < 1 ||
    blocks.length > 2 ||
    !blocks.every((block) => block instanceof DecodeChannelState) ||
    !(shared instanceof SharedState) ||
    !(reader instanceof BitReader) ||
    !(scratch instanceof CodingUnitDecodeScratch)
  ) {
    throw new RangeError('ATRAC3plus coding-unit decode topology is invalid')
  }
}

/**
 * Ensure a decoded field vector stays within its syntax-defined inclusive range.
 *
 * @param {ArrayLike<number>} values
 * @param {number} maximum
 * @param {number} count
 * @param {string} field
 */
function validateValues(values, maximum, count, field) {
  for (let index = 0; index < count; index++) {
    if (values[index] < 0 || values[index] > maximum) {
      throw new RangeError(
        `ATRAC3plus decoded ${field} ${values[index]} at ${index} is invalid`
      )
    }
  }
}

/**
 * Derive the coded band prefix implied by the decoded word-length and code-table fields.
 *
 * @param {DecodeChannelState[]} blocks
 * @param {number} limit
 * @returns {number}
 */
function activeBandCount(blocks, limit) {
  for (let band = limit - 1; band >= 0; band--) {
    for (let channel = 0; channel < blocks.length; channel++) {
      if (blocks[channel].syntax.wordLengths[band] !== 0) return band + 1
    }
  }
  return 0
}

/**
 * Decode the compact disabled, uniform, or per-band presence header into a caller-owned flag vector.
 *
 * @param {ArrayLike<number>} flags
 * @param {number} count
 * @param {BitReader} reader
 * @returns {number}
 */
function unpackPresence(flags, count, reader) {
  flags.fill(0)
  const enabled = reader.read(1)
  if (enabled === 0) return 0
  const mixed = reader.read(1)
  if (mixed === 0) flags.fill(1, 0, count)
  else {
    for (let index = 0; index < count; index++) flags[index] = reader.read(1)
  }
  return enabled | (mixed << 1)
}

/**
 * Decode both stereo presence planes in their wire order into shared coding-unit state.
 *
 * @param {SharedState} shared
 * @param {BitReader} reader
 */
function unpackStereoPresence(shared, reader) {
  for (const index of [1, 0]) {
    const header = unpackPresence(
      shared.presenceFlags[index],
      shared.mapCount,
      reader
    )
    shared.presenceEnabled[index] = header & 1
    shared.presenceMixed[index] = (header >>> 1) & 1
  }
}

/**
 * Decode each channel's per-subband gain-window flags into temporary storage for delayed publication.
 *
 * @param {DecodeChannelState[]} blocks
 * @param {SharedState} shared
 * @param {BitReader} reader
 * @param {CodingUnitDecodeScratch} scratch
 */
function unpackGainWindowPresence(blocks, shared, reader, scratch) {
  for (let channel = 0; channel < blocks.length; channel++) {
    unpackPresence(
      scratch.gainWindowFlags[channel],
      shared.codedSubbandCount,
      reader
    )
  }
}

/**
 * Reapply decoded gain-window presence flags after coding-unit sidechains are parsed.
 *
 * @param {DecodeChannelState[]} blocks
 * @param {CodingUnitDecodeScratch} scratch
 */
function reattachGainWindowFlags(blocks, scratch) {
  for (let channel = 0; channel < blocks.length; channel++) {
    blocks[channel].gain.windowFlags.set(scratch.gainWindowFlags[channel])
  }
}

/**
 * Decode one complete coding unit without publishing persistent state.
 *
 * @param {DecodeChannelState[]} blocks Detached mono/stereo channel blocks.
 * @param {SharedState} shared Detached shared coding-unit state.
 * @param {BitReader} reader Frame reader positioned after the coding-unit tag.
 * @param {CodingUnitDecodeScratch} scratch Reusable leaf decode storage.
 * @returns {number} Number of consumed coding-unit bits.
 */
export function unpackCodingUnit(blocks, shared, reader, scratch) {
  validateRequest(blocks, shared, reader, scratch)
  const start = reader.bitPosition
  shared.clear()
  const bandLimit = reader.read(5) + 1
  const muteFlag = reader.read(1)
  if (bandLimit >= 29 && bandLimit <= 31) {
    throw new CodingUnitDecodeError(
      'header',
      new RangeError(`reserved word-length limit ${bandLimit}`)
    )
  }
  shared.bandLimit = bandLimit
  shared.quantizationUnitCount = bandLimit
  shared.muteFlag = muteFlag

  try {
    for (let channel = 0; channel < blocks.length; channel++) {
      const syntax = blocks[channel].syntax
      unpackWordLengthChannel(
        syntax,
        channel === 0 ? null : blocks[0].syntax,
        channel,
        bandLimit,
        reader,
        scratch.wordLength
      )
      validateValues(syntax.wordLengths, 7, bandLimit, 'word length')
    }
  } catch (cause) {
    throw new CodingUnitDecodeError('word length', cause)
  }

  const scaleFactorCount = activeBandCount(blocks, bandLimit)
  shared.scaleFactorCount = scaleFactorCount
  if (scaleFactorCount === 0) {
    shared.gainModeFlag = 0
    for (const block of blocks) {
      block.syntax.scaleFactors.fill(0)
      block.syntax.codeTables.fill(0)
      block.syntax.codeTableContext = 0
    }
  } else {
    try {
      for (let channel = 0; channel < blocks.length; channel++) {
        const syntax = blocks[channel].syntax
        unpackScaleFactorChannel(
          syntax,
          channel === 0 ? null : blocks[0].syntax,
          channel,
          scaleFactorCount,
          reader,
          scratch.scaleFactor
        )
        validateValues(
          syntax.scaleFactors,
          0x3f,
          scaleFactorCount,
          'scale factor'
        )
      }
    } catch (cause) {
      throw new CodingUnitDecodeError('scale factor', cause)
    }
    try {
      for (let channel = 0; channel < blocks.length; channel++) {
        scratch.syntaxes[channel] = blocks[channel].syntax
      }
      scratch.syntaxes.length = blocks.length
      unpackCodeTableSection(scratch.syntaxes, shared, reader)
      scratch.syntaxes.length = 2
    } catch (cause) {
      scratch.syntaxes.length = 2
      throw new CodingUnitDecodeError('code table', cause)
    }
  }

  try {
    for (const block of blocks) {
      unpackChannelSpectrum(
        block.syntax,
        block.quantizedSpectrum,
        shared,
        reader
      )
    }
  } catch (cause) {
    throw new CodingUnitDecodeError('spectrum', cause)
  }

  if (blocks.length === 2) unpackStereoPresence(shared, reader)
  unpackGainWindowPresence(blocks, shared, reader, scratch)
  try {
    for (let channel = 0; channel < blocks.length; channel++) {
      unpackGainChannel(
        blocks[channel].gain,
        channel === 0 ? null : blocks[0].gain,
        channel,
        reader
      )
    }
    reattachGainWindowFlags(blocks, scratch)
  } catch (cause) {
    throw new CodingUnitDecodeError('gain', cause)
  }

  try {
    for (let channel = 0; channel < blocks.length; channel++) {
      scratch.syntaxes[channel] = blocks[channel].syntax
      scratch.toneSlots[channel] = blocks[channel].toneSlots[1]
    }
    scratch.syntaxes.length = blocks.length
    scratch.toneSlots.length = blocks.length
    unpackToneSection(scratch.toneSlots, scratch.syntaxes, reader, scratch.tone)
    scratch.syntaxes.length = 2
    scratch.toneSlots.length = 2
  } catch (cause) {
    scratch.syntaxes.length = 2
    scratch.toneSlots.length = 2
    throw new CodingUnitDecodeError('tones', cause)
  }

  shared.noisePresent = reader.read(1)
  if (shared.noisePresent !== 0) {
    shared.noiseLevelIndex = reader.read(4)
    shared.noiseTableIndex = reader.read(4)
  }
  return reader.bitPosition - start
}
