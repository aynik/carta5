/** ATRAC3plus tone wire decoding into fixed current-slot storage. */

import { readCanonicalSymbol } from '../coding/entropy.js'
import {
  GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
  TONE_AMPLITUDE_CODEBOOK_AA_CODE_LENGTHS,
  TONE_AMPLITUDE_CODEBOOK_AB_CODE_LENGTHS,
  TONE_AMPLITUDE_CODEBOOK_C_CODE_LENGTHS,
  TONE_BAND_COUNT_CODE_LENGTHS,
  TONE_COUNT_CODEBOOK_B_CODE_LENGTHS,
  TONE_FREQUENCY_CODEBOOK_A_CODE_LENGTHS,
  TONE_HEADER_PACK_ORDER,
  TONE_SCALE_FACTOR_CODEBOOK_AA_CODE_LENGTHS,
  TONE_SCALE_FACTOR_CODEBOOK_AB_CODE_LENGTHS,
  TONE_SCALE_FACTOR_CODEBOOK_B_CODE_LENGTHS,
} from '../core/tables.js'
import { ChannelSyntaxState } from '../state/shared.js'
import { ToneDecodeScratch } from '../state/decoder-syntax.js'
import { ToneSlot } from '../state/tone.js'
import { BitReader } from './bitstream.js'
import { buildToneItemMap } from './tone-syntax.js'
import {
  TONE_HEADER_ALLOCATION_POINTER_WORD,
  TONE_HEADER_BAND_COUNT_WORD,
  TONE_HEADER_ENABLE_WORD,
  TONE_HEADER_JOINT_ARRAY_WORD,
  TONE_HEADER_MODE_WORD,
  TONE_HEADER_SWAP_ARRAY_WORD,
} from '../core/constants.js'

/**
 * Error raised when tone decode input violates the decoder or bitstream contract.
 */
export class ToneDecodeError extends RangeError {
  /**
   * Attach codec context to a tone decode error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus tone decode failed: ${kind}`)
    this.name = 'ToneDecodeError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Verify matching tone slots, channel syntax, reader, and scratch for one mono or stereo coding unit.
 *
 * @param {ToneSlot[]} slots
 * @param {ChannelSyntaxState[]} syntaxes
 * @param {BitReader} reader
 * @param {ToneDecodeScratch} scratch
 */
function validateRequest(slots, syntaxes, reader, scratch) {
  if (
    !Array.isArray(slots) ||
    !Array.isArray(syntaxes) ||
    slots.length < 1 ||
    slots.length > 2 ||
    slots.length !== syntaxes.length ||
    !slots.every((slot) => slot instanceof ToneSlot) ||
    !syntaxes.every((syntax) => syntax instanceof ChannelSyntaxState) ||
    !(reader instanceof BitReader) ||
    !(scratch instanceof ToneDecodeScratch)
  ) {
    throw new RangeError('ATRAC3plus tone decode topology is invalid')
  }
}

/**
 * Sign-extend a fixed-width integer into a JavaScript number.
 *
 * @param {number} value
 * @param {number} bits
 * @returns {number}
 */
function signExtend(value, bits) {
  const sign = 2 ** (bits - 1)
  return value >= sign ? value - 2 ** bits : value
}

/**
 * Decode a disabled, uniform, or per-band tone header plane into flat header storage.
 *
 * @param {Int32Array} header
 * @param {{enable: number, mode: number, values: number}} descriptor
 * @param {number} count
 * @param {BitReader} reader
 */
function unpackPresence(header, descriptor, count, reader) {
  header.fill(0, descriptor.values, descriptor.values + 16)
  const enabled = reader.read(1)
  header[descriptor.enable] = enabled
  if (enabled === 0) return
  const mixed = reader.read(1)
  header[descriptor.mode] = mixed
  if (mixed === 0) header.fill(1, descriptor.values, descriptor.values + count)
  else {
    for (let index = 0; index < count; index++) {
      header[descriptor.values + index] = reader.read(1)
    }
  }
}

/**
 * Decode optional start and end gate locations for one tone record.
 *
 * @param {ToneSynthesisRecord} record
 * @param {BitReader} reader
 */
function readLocations(record, reader) {
  record.gateStartValid = reader.read(1)
  record.gateStartIndex = record.gateStartValid === 0 ? 0 : reader.read(5)
  record.gateEndValid = reader.read(1)
  record.gateEndIndex = record.gateEndValid === 0 ? 0 : reader.read(5)
}

/**
 * Decode or copy tone gates for every present band in one channel.
 *
 * @param {ToneSlot[]} slots
 * @param {ArrayLike<number>} present
 * @param {number} ordinal
 * @param {number} count
 * @param {number} mode
 * @param {BitReader} reader
 */
function decodeToneLocations(slots, present, ordinal, count, mode, reader) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slots[ordinal].records[band]
    if (mode === 0) readLocations(record, reader)
    else {
      const base = slots[0].records[band]
      record.gateStartValid = base.gateStartValid
      record.gateStartIndex = base.gateStartIndex
      record.gateEndValid = base.gateEndValid
      record.gateEndIndex = base.gateEndIndex
    }
  }
}

/**
 * Reconstruct per-band sinusoid counts using direct, canonical, or primary-channel prediction.
 *
 * @param {ToneSlot[]} slots
 * @param {ArrayLike<number>} present
 * @param {number} ordinal
 * @param {number} count
 * @param {number} mode
 * @param {BitReader} reader
 */
function decodeToneCounts(slots, present, ordinal, count, mode, reader) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slots[ordinal].records[band]
    if (mode === 0) record.entryCount = reader.read(4)
    else if (mode === 1) {
      record.entryCount = readCanonicalSymbol(
        GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
        reader
      )
    } else if (mode === 2) {
      const delta = signExtend(
        readCanonicalSymbol(TONE_COUNT_CODEBOOK_B_CODE_LENGTHS, reader),
        3
      )
      record.entryCount = (slots[0].records[band].entryCount + delta) & 15
    } else record.entryCount = slots[0].records[band].entryCount
  }
}

/**
 * Return the wrapped upward distance between two coded tone values.
 *
 * @param {number} previous
 * @returns {number}
 */
function upwardBits(previous) {
  if (previous <= 0x1ff) return 10
  if (previous <= 0x2ff) return 9
  if (previous <= 0x37f) return 8
  if (previous <= 0x3bf) return 7
  if (previous <= 0x3df) return 6
  if (previous <= 0x3ef) return 5
  if (previous <= 0x3f7) return 4
  if (previous <= 0x3fb) return 3
  if (previous <= 0x3fd) return 2
  return 1
}

/**
 * Add a wrapped upward delta in the coded tone-value domain.
 *
 * @param {number} previous
 * @returns {number}
 */
function upwardAdd(previous) {
  if (previous <= 0x1ff) return 0
  if (previous <= 0x2ff) return 0x200
  if (previous <= 0x37f) return 0x300
  if (previous <= 0x3bf) return 0x380
  if (previous <= 0x3df) return 0x3c0
  if (previous <= 0x3ef) return 0x3e0
  if (previous <= 0x3f7) return 0x3f0
  if (previous <= 0x3fb) return 0x3f8
  if (previous <= 0x3fd) return 0x3fc
  return 0x3fe
}

/**
 * Reverse the requested low-order bits for the tone frequency code.
 *
 * @param {number} next
 * @returns {number}
 */
function reverseBits(next) {
  if (next <= 1) return 1
  if (next <= 3) return 2
  if (next <= 7) return 3
  if (next <= 0x0f) return 4
  if (next <= 0x1f) return 5
  if (next <= 0x3f) return 6
  if (next <= 0x7f) return 7
  if (next <= 0xff) return 8
  if (next <= 0x1ff) return 9
  return 10
}

/**
 * Decode one band's ordered frequency steps in forward or reversed delta order.
 *
 * @param {ToneSynthesisRecord} record
 * @param {ChannelSyntaxState} syntax
 * @param {number} band
 * @param {BitReader} reader
 */
function decodeCodedFrequencies(record, syntax, band, reader) {
  const count = record.entryCount
  const reverse = count > 1 && reader.read(1) !== 0
  syntax.toneFrequencyFlags[band] = reverse ? 1 : 0
  if (count === 0) return
  if (!reverse) {
    record.steps[0] = reader.read(10)
    for (let item = 1; item < count; item++) {
      const previous = record.steps[item - 1]
      record.steps[item] =
        reader.read(upwardBits(previous)) + upwardAdd(previous)
    }
  } else {
    record.steps[count - 1] = reader.read(10)
    for (let item = count - 2; item >= 0; item--) {
      record.steps[item] = reader.read(reverseBits(record.steps[item + 1]))
    }
  }
}

/**
 * Reconstruct frequency steps for every present band using independent or paired-channel coding.
 *
 * @param {ToneSlot[]} slots
 * @param {ChannelSyntaxState} syntax
 * @param {ArrayLike<number>} present
 * @param {number} ordinal
 * @param {number} count
 * @param {number} mode
 * @param {BitReader} reader
 */
function decodeFrequencies(
  slots,
  syntax,
  present,
  ordinal,
  count,
  mode,
  reader
) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slots[ordinal].records[band]
    if (mode === 0) decodeCodedFrequencies(record, syntax, band, reader)
    else {
      const base = slots[0].records[band]
      for (let item = 0; item < record.entryCount; item++) {
        const delta = signExtend(
          readCanonicalSymbol(TONE_FREQUENCY_CODEBOOK_A_CODE_LENGTHS, reader),
          8
        )
        const reference =
          item < base.entryCount
            ? base.steps[item]
            : base.entryCount === 0
              ? 0
              : base.steps[base.entryCount - 1]
        record.steps[item] = (reference + delta) & 0x3ff
      }
    }
  }
}

/**
 * Resolve a coded tone ordinal through the channel's item map.
 *
 * @param {ToneDecodeScratch} scratch
 * @param {number} mapIndex
 * @param {number} item
 * @returns {number}
 */
function mappedItem(scratch, mapIndex, item) {
  return scratch.itemMap[mapIndex + item] ?? -1
}

/**
 * Reconstruct tone scale factors in frequency order from direct or paired-channel predictors.
 *
 * @param {ToneSlot[]} slots
 * @param {ArrayLike<number>} present
 * @param {number} ordinal
 * @param {number} count
 * @param {number} codingMode
 * @param {number} mode
 * @param {BitReader} reader
 * @param {ToneDecodeScratch} scratch
 */
function decodeScaleFactors(
  slots,
  present,
  ordinal,
  count,
  codingMode,
  mode,
  reader,
  scratch
) {
  const direct = mode === 0 || mode === 1
  const shared = codingMode === 0
  let mapIndex = 0
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slots[ordinal].records[band]
    const base = slots[0].records[band]
    const iterations = shared && record.entryCount > 0 ? 1 : record.entryCount
    for (let item = 0; item < iterations; item++) {
      let value
      if (direct) {
        if (mode === 0) value = reader.read(6)
        else {
          const table = shared
            ? TONE_SCALE_FACTOR_CODEBOOK_AA_CODE_LENGTHS
            : TONE_SCALE_FACTOR_CODEBOOK_AB_CODE_LENGTHS
          value = readCanonicalSymbol(table, reader) + (shared ? 0x18 : 0x14)
        }
      } else {
        const mapped = shared ? 0 : mappedItem(scratch, mapIndex, item)
        let reference
        if (shared) {
          reference = base.entryCount > 0 ? base.scaleFactorIndices[0] : 0x2c
        } else if (mapped < 0) reference = mode === 2 ? 0x22 : 0x20
        else if (mapped < base.entryCount)
          reference = base.scaleFactorIndices[mapped]
        else reference = 0
        value =
          mode === 2
            ? (reference +
                signExtend(
                  readCanonicalSymbol(
                    TONE_SCALE_FACTOR_CODEBOOK_B_CODE_LENGTHS,
                    reader
                  ),
                  5
                )) &
              0x3f
            : reference
      }
      if (shared) record.scaleFactorIndices.fill(value, 0, record.entryCount)
      else record.scaleFactorIndices[item] = value
    }
    mapIndex += record.entryCount
  }
}

/**
 * Reconstruct tone amplitude indices in frequency order using the selected joint-amplitude mode.
 *
 * @param {ToneSlot[]} slots
 * @param {ArrayLike<number>} present
 * @param {number} ordinal
 * @param {number} count
 * @param {number} mode
 * @param {BitReader} reader
 * @param {ToneDecodeScratch} scratch
 */
function decodeAmplitudes(
  slots,
  present,
  ordinal,
  count,
  mode,
  reader,
  scratch
) {
  let mapIndex = 0
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slots[ordinal].records[band]
    const base = slots[0].records[band]
    for (let item = 0; item < record.entryCount; item++) {
      let value
      if (mode === 0) value = reader.read(4)
      else if (mode === 1) {
        value = readCanonicalSymbol(
          record.entryCount === 1
            ? TONE_AMPLITUDE_CODEBOOK_AA_CODE_LENGTHS
            : TONE_AMPLITUDE_CODEBOOK_AB_CODE_LENGTHS,
          reader
        )
      } else {
        const mapped = mappedItem(scratch, mapIndex, item)
        const reference =
          mapped >= 0 && mapped < base.entryCount
            ? base.amplitudeIndices[mapped]
            : mode === 2
              ? 0x0c
              : 0x0e
        value =
          mode === 2
            ? (reference +
                signExtend(
                  readCanonicalSymbol(
                    TONE_AMPLITUDE_CODEBOOK_C_CODE_LENGTHS,
                    reader
                  ),
                  3
                )) &
              0x0f
            : reference
      }
      record.amplitudeIndices[item] = value
    }
    mapIndex += record.entryCount
  }
}

/**
 * Read the five-bit initial phase of every transmitted sinusoid.
 *
 * @param {ToneSlot} slot
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @param {BitReader} reader
 */
function decodePhases(slot, present, count, reader) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = slot.records[band]
    for (let item = 0; item < record.entryCount; item++) {
      record.phaseBases[item] = reader.read(5)
    }
  }
}

/**
 * Decode one mono or stereo coding-unit tone section.
 *
 * @param {ToneSlot[]} slots Destination tone slots.
 * @param {ChannelSyntaxState[]} syntaxes Destination channel syntax rows.
 * @param {BitReader} reader Source bit reader.
 * @param {ToneDecodeScratch} scratch Reusable decoder work.
 * @returns {number} Active tone-record count.
 */
export function unpackToneSection(slots, syntaxes, reader, scratch) {
  validateRequest(slots, syntaxes, reader, scratch)
  for (const slot of slots) slot.clear()
  for (const syntax of syntaxes) {
    syntax.toneScaleFactorMode = 0
    syntax.toneFrequencyFlags.fill(0)
    syntax.tonePresenceFlags.fill(0)
  }
  const header = slots[0].shared
  header[TONE_HEADER_ALLOCATION_POINTER_WORD] = 0
  const enabled = reader.read(1)
  header[TONE_HEADER_ENABLE_WORD] = enabled
  if (enabled === 0) return 0
  for (const slot of slots) slot.active = true
  const codingMode = reader.read(1)
  header[TONE_HEADER_MODE_WORD] = codingMode
  const count = readCanonicalSymbol(TONE_BAND_COUNT_CODE_LENGTHS, reader) + 1
  if (count > 16) {
    throw new ToneDecodeError('band count exceeds sixteen', { count })
  }
  header[TONE_HEADER_BAND_COUNT_WORD] = count
  if (slots.length === 2) {
    for (const descriptor of TONE_HEADER_PACK_ORDER) {
      unpackPresence(header, descriptor, count, reader)
    }
  }

  let combinedEntries = 0
  for (let ordinal = 0; ordinal < slots.length; ordinal++) {
    const syntax = syntaxes[ordinal]
    const present = syntax.tonePresenceFlags
    for (let band = 0; band < count; band++) {
      present[band] =
        ordinal === 0 || header[TONE_HEADER_JOINT_ARRAY_WORD + band] === 0
          ? 1
          : 0
    }
    const locationMode = reader.read(ordinal)
    decodeToneLocations(slots, present, ordinal, count, locationMode, reader)
    const countMode = reader.read(1 + ordinal)
    decodeToneCounts(slots, present, ordinal, count, countMode, reader)
    for (let band = 0; band < count; band++) {
      if (present[band] !== 0)
        combinedEntries += slots[ordinal].records[band].entryCount
    }
    if (combinedEntries > 0x30) {
      throw new ToneDecodeError('item map exceeds forty-eight entries', {
        entries: combinedEntries,
      })
    }
    const frequencyMode = reader.read(ordinal)
    decodeFrequencies(
      slots,
      syntax,
      present,
      ordinal,
      count,
      frequencyMode,
      reader
    )
    scratch.itemMap.fill(-1)
    if (ordinal === 1) {
      buildToneItemMap(
        scratch.itemMap,
        slots[1].records,
        slots[0].records,
        present,
        count
      )
    }
    const scaleMode = reader.read(1 + ordinal)
    syntax.toneScaleFactorMode = scaleMode
    decodeScaleFactors(
      slots,
      present,
      ordinal,
      count,
      codingMode,
      scaleMode,
      reader,
      scratch
    )
    if (codingMode === 0) {
      const amplitudeMode = reader.read(1 + ordinal)
      decodeAmplitudes(
        slots,
        present,
        ordinal,
        count,
        amplitudeMode,
        reader,
        scratch
      )
    }
    decodePhases(slots[ordinal], present, count, reader)
  }
  return count
}

/**
 * Apply accepted-frame stereo copy/swap syntax without replacing records.
 *
 * @param {ToneSlot[]} primarySlots Primary-channel tone slots.
 * @param {ToneSlot[]} secondarySlots Secondary-channel tone slots.
 * @param {ToneDecodeScratch} scratch Reusable decoder work.
 * @returns {void}
 */
export function applyStereoToneFixes(primarySlots, secondarySlots, scratch) {
  if (
    !Array.isArray(primarySlots) ||
    !Array.isArray(secondarySlots) ||
    primarySlots.length < 2 ||
    secondarySlots.length < 2 ||
    !primarySlots.every((slot) => slot instanceof ToneSlot) ||
    !secondarySlots.every((slot) => slot instanceof ToneSlot) ||
    !(scratch instanceof ToneDecodeScratch)
  ) {
    throw new RangeError('ATRAC3plus stereo tone fix state is invalid')
  }
  const header = primarySlots[1].shared
  const count = header[TONE_HEADER_BAND_COUNT_WORD]
  for (let band = 0; band < count; band++) {
    if (header[TONE_HEADER_JOINT_ARRAY_WORD + band] !== 0) {
      primarySlots[1].records[band].copyTo(secondarySlots[1].records[band])
      const source = primarySlots[0].records[band]
      const target = secondarySlots[0].records[band]
      target.gateStartValid = source.gateStartValid
      target.gateStartIndex = source.gateStartIndex
      target.gateEndValid = source.gateEndValid
      target.gateEndIndex = source.gateEndIndex
    }
    if (header[TONE_HEADER_SWAP_ARRAY_WORD + band] !== 0) {
      const left = primarySlots[1].records[band]
      const right = secondarySlots[1].records[band]
      left.copyTo(scratch.temporary)
      right.copyTo(left)
      scratch.temporary.copyTo(right)
    }
  }
}
