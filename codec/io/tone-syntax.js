/** ATRAC3plus tone planning, exact pricing, and canonical emission. */

import { packableSymbolBits, writeCanonicalSymbol } from '../coding/entropy.js'
import {
  TONE_BAND_COUNT_CODE_LENGTHS,
  TONE_SCALE_FACTOR_CODEBOOK_B_CODE_LENGTHS,
  TONE_HEADER_ARRAYS,
  TONE_HEADER_PACK_ORDER,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  FREQUENCY_BASE_BITS,
  SCALE_FACTOR_DELTA_BASE,
  IO_TONE_SYNTAX_SCALE_FACTOR_RAW_BITS,
  TONE_COUNT_BITS,
  TONE_INVALID_BITS,
  TONE_PHASE_BITS,
  TONE_HEADER_BAND_COUNT_WORD,
  TONE_HEADER_ENABLE_WORD,
  TONE_HEADER_JOINT_ARRAY_WORD,
  TONE_HEADER_SWAP_ARRAY_WORD,
  TONE_RECORD_COUNT,
} from '../core/constants.js'
import { ToneCodingPlan, ToneSwapGate, activeToneSlot } from '../state/tone.js'

/**
 * Return the active tone-entry count for a nullable tone record.
 *
 * @param {ToneSynthesisRecord} record
 * @returns {number}
 */
function recordCount(record) {
  return record?.entryCount ?? 0
}

/**
 * Return a tone frequency or the predictor value used when the entry is absent.
 *
 * @param {ToneSynthesisRecord} record
 * @param {number} item
 * @returns {number}
 */
function frequency(record, item) {
  return record?.steps?.[item] ?? 0
}

/**
 * Compute the header width required to signal tone presence for both channels.
 *
 * @param {boolean} enabled
 * @param {boolean} mixed
 * @param {number} count
 * @returns {number}
 */
function presenceBits(enabled, mixed, count) {
  return 1 + (enabled === 0 ? 0 : 1 + (mixed === 0 ? 0 : count))
}

/**
 * Choose joint, differential, and orientation flags for the shared tone header array.
 *
 * @param {SharedState} header
 * @param {{enable: number, mode: number, values: number}} descriptor
 * @param {number} count
 * @param {ToneCodingPlan} plan
 * @param {number} arrayIndex
 * @returns {number}
 */
function planHeaderArray(header, descriptor, count, plan, arrayIndex) {
  let sum = 0
  for (let index = 0; index < count; index++) {
    sum += header[descriptor.values + index] ?? 0
  }
  let enabled = 0
  let mode = 0
  if (count !== 0 && sum !== 0) {
    enabled = 1
    mode = sum === count ? 0 : 1
  }
  plan.headerEnables[arrayIndex] = enabled
  plan.headerModes[arrayIndex] = mode
  return presenceBits(enabled, mode, count)
}

/**
 * Exchange two tone records in place without changing their owning objects.
 *
 * @param {ToneSynthesisRecord} first
 * @param {ToneSynthesisRecord} second
 * @param {ToneSynthesisRecord} temporary
 */
function swapRecordContents(first, second, temporary) {
  first.copyTo(temporary)
  second.copyTo(first)
  temporary.copyTo(second)
}

/**
 * Orient paired tone records so primary/secondary prediction matches the selected header.
 *
 * @param {EncodeChannelState[]} channelBlocks
 * @param {number} count
 * @param {ToneSwapGate} gate
 */
function applyToneRecordOrientation(channelBlocks, count, gate) {
  if (!gate.takeFirstApplication()) return
  const primary = channelBlocks[0]
  const primarySlot = activeToneSlot(primary)
  if (!primarySlot) return
  if (channelBlocks.length !== 2) {
    primarySlot.shared.fill(
      0,
      TONE_HEADER_SWAP_ARRAY_WORD,
      TONE_HEADER_SWAP_ARRAY_WORD + count
    )
    return
  }
  const secondary = channelBlocks[1]
  const secondarySlot = activeToneSlot(secondary)
  for (let band = 0; band < count; band++) {
    const shouldSwap =
      recordCount(primarySlot.records[band]) === 0 &&
      recordCount(secondarySlot?.records[band]) > 0
    primarySlot.shared[TONE_HEADER_SWAP_ARRAY_WORD + band] = shouldSwap ? 1 : 0
    if (shouldSwap && secondarySlot) {
      swapRecordContents(
        primarySlot.records[band],
        secondarySlot.records[band],
        gate.temporary
      )
    }
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
 * Return exact payload bits for one frequency direction.
 *
 * @param {ToneSynthesisRecord} record Tone synthesis record.
 * @param {boolean} reverse Whether to traverse frequencies in reverse.
 * @returns {number} Exact frequency payload width in bits.
 */
function measureToneFrequencyPayload(record, reverse = false) {
  const count = Math.max(recordCount(record), 0)
  if (count <= 0) return 0
  let bits = FREQUENCY_BASE_BITS
  if (!reverse) {
    for (let item = 1; item < count; item++) {
      bits += upwardBits(frequency(record, item - 1) >>> 0)
    }
  } else {
    for (let item = count - 2; item >= 0; item--) {
      bits += reverseBits(frequency(record, item + 1) >>> 0)
    }
  }
  return bits
}

/**
 * Choose direct or differential tone-frequency coding from their exact bit costs.
 *
 * @param {ToneSynthesisRecord} record
 * @param {ToneChannelPlan} side
 * @param {number} band
 * @returns {number}
 */
function selectFrequencyBits(record, side, band) {
  const count = recordCount(record)
  if (count <= 0) return 0
  const upward = measureToneFrequencyPayload(record, false)
  const reverse = measureToneFrequencyPayload(record, true)
  const useReverse = count > 1 && reverse < upward
  side.frequencyDirectionFlags[band] = useReverse ? 1 : 0
  return (count > 1 ? 1 : 0) + (useReverse ? reverse : upward)
}

/**
 * Map one tone item to the reference's nearest/same-position base item.
 *
 * @param {number} item Current item index.
 * @param {number} baseCount Reference item count.
 * @param {number} currentFrequency Current frequency step.
 * @param {Int32Array} baseSteps Reference frequency steps.
 * @returns {number} Reference item index, or `-1`.
 */
function mappedToneItemIndex(item, baseCount, currentFrequency, baseSteps) {
  let nearest = -1
  let difference = Number.POSITIVE_INFINITY
  for (let baseItem = 0; baseItem < baseCount; baseItem++) {
    const candidate = Math.abs(currentFrequency - baseSteps[baseItem])
    if (candidate < difference) {
      difference = candidate
      nearest = baseItem
    }
  }
  if (nearest >= 0 && difference <= 7) return nearest
  if (nearest >= 0 && item < baseCount) return item
  return -1
}

/**
 * Build the concatenated secondary-to-primary tone item map used by decoding.
 *
 * @param {Int32Array} destination Caller-owned item map.
 * @param {ToneSynthesisRecord[]} records Secondary-channel records.
 * @param {ToneSynthesisRecord[]} baseRecords Primary-channel records.
 * @param {Uint8Array} present Per-band presence flags.
 * @param {number} count Active tone-record count.
 * @returns {number} Required concatenated map length.
 */
export function buildToneItemMap(
  destination,
  records,
  baseRecords,
  present,
  count
) {
  destination.fill(-1)
  let mapIndex = 0
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = records[band]
    const itemCount = Math.max(recordCount(record), 0)
    if (itemCount <= 0) continue
    const base = baseRecords[band]
    const baseCount = Math.max(recordCount(base), 0)
    for (let item = 0; item < itemCount; item++) {
      const target = mapIndex + item
      if (target < destination.length) {
        destination[target] = mappedToneItemIndex(
          item,
          baseCount,
          frequency(record, item),
          base.steps
        )
      }
    }
    mapIndex += itemCount
  }
  return mapIndex
}

/**
 * Compute the exact width of the tone location/count payload.
 *
 * @param {ToneSynthesisRecord} record
 * @returns {number}
 */
function locationBits(record) {
  return (
    2 +
    (record.gateStartValid !== 0 ? 5 : 0) +
    (record.gateEndValid !== 0 ? 5 : 0)
  )
}

/**
 * Compute the width of tone fields emitted only when a record flag is set.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @param {function(ToneSynthesisRecord): number} measure Record field-width function.
 * @returns {number}
 */
function flaggedRecordBits(records, present, count, measure) {
  let bits = 0
  for (let band = 0; band < count; band++) {
    if (present[band] !== 0) bits += measure(records[band])
  }
  return bits
}

/**
 * Compute the width of directly coded tone scale factors.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @returns {number}
 */
function rawScaleFactorBits(records, present, count) {
  return flaggedRecordBits(
    records,
    present,
    count,
    (record) =>
      Math.max(recordCount(record), 0) * IO_TONE_SYNTAX_SCALE_FACTOR_RAW_BITS
  )
}

/**
 * Compute the width of predictor-relative tone scale factors.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ToneSynthesisRecord[]} baseRecords
 * @param {ToneChannelPlan} side
 * @param {number} count
 * @returns {number}
 */
function deltaScaleFactorBits(records, baseRecords, side, count) {
  let bits = 0
  for (let band = 0; band < count; band++) {
    if (side.presenceFlags[band] === 0) continue
    const record = records[band]
    const base = baseRecords[band]
    const itemCount = Math.max(recordCount(record), 0)
    const baseCount = Math.max(recordCount(base), 0)
    for (let item = 0; item < itemCount; item++) {
      const mapped = mappedToneItemIndex(
        item,
        baseCount,
        frequency(record, item),
        base.steps
      )
      const current = record.scaleFactorIndices[item]
      const baseValue =
        mapped < 0 ? SCALE_FACTOR_DELTA_BASE : base.scaleFactorIndices[mapped]
      const delta = current - baseValue
      const code = delta & 0x1f
      const symbolBits = packableSymbolBits(
        TONE_SCALE_FACTOR_CODEBOOK_B_CODE_LENGTHS,
        code
      )
      if (delta < -16 || delta > 15 || symbolBits === null) {
        return TONE_INVALID_BITS
      }
      bits += symbolBits
    }
  }
  return bits
}

/**
 * Price tone frequency, scale-factor, amplitude, and phase fields for one channel.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ToneSynthesisRecord[]} baseRecords
 * @param {number} parity
 * @param {ArrayLike<number>} jointFlags
 * @param {number} count
 * @param {ToneChannelPlan} side
 * @returns {number}
 */
function planChannel(records, baseRecords, parity, jointFlags, count, side) {
  side.clear()
  for (let band = 0; band < count; band++) {
    side.presenceFlags[band] = parity === 0 || jointFlags[band] === 0 ? 1 : 0
  }
  const location = flaggedRecordBits(
    records,
    side.presenceFlags,
    count,
    locationBits
  )
  const waveCount = flaggedRecordBits(
    records,
    side.presenceFlags,
    count,
    () => TONE_COUNT_BITS
  )
  let frequencyBits = 0
  for (let band = 0; band < count; band++) {
    if (side.presenceFlags[band] !== 0) {
      frequencyBits += selectFrequencyBits(records[band], side, band)
    }
  }
  const rawScale = rawScaleFactorBits(records, side.presenceFlags, count)
  let scaleBits = rawScale
  if (baseRecords) {
    const deltaScale = deltaScaleFactorBits(records, baseRecords, side, count)
    if (deltaScale < rawScale) {
      side.scaleFactorMode = 2
      scaleBits = deltaScale
    }
  }
  const phase = flaggedRecordBits(
    records,
    side.presenceFlags,
    count,
    (record) => Math.max(recordCount(record), 0) * TONE_PHASE_BITS
  )
  return (
    2 * parity +
    2 * (1 + parity) +
    location +
    waveCount +
    frequencyBits +
    scaleBits +
    phase
  )
}

/**
 * Select exact tone syntax costs over the delayed slot-0 payload.
 *
 * @param {EncodeChannelState[]} channelBlocks All frame channel blocks.
 * @param {ToneSwapGate} swapGate Once-per-frame orientation gate.
 * @param {ToneCodingPlan} destination Reusable detached plan.
 * @returns {ToneCodingPlan} Selected plan without published syntax fields.
 */
export function planToneSection(channelBlocks, swapGate, destination) {
  const channelCount = channelBlocks?.length ?? 0
  if (
    !Array.isArray(channelBlocks) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    !(swapGate instanceof ToneSwapGate) ||
    !(destination instanceof ToneCodingPlan)
  ) {
    throw new RangeError('ATRAC3plus tone coding-unit geometry is invalid')
  }
  destination.clear()
  const primary = channelBlocks[0]
  const primarySlot = activeToneSlot(primary)
  if (!primarySlot || primarySlot.shared[TONE_HEADER_ENABLE_WORD] === 0) {
    destination.totalBits = 1
    return destination
  }
  const count = primarySlot.shared[TONE_HEADER_BAND_COUNT_WORD]
  if (!Number.isInteger(count) || count <= 0) {
    destination.totalBits = 1
    return destination
  }
  if (count > TONE_RECORD_COUNT) {
    throw new RangeError('ATRAC3plus tone band count exceeds 16')
  }
  for (let channel = 0; channel < channelCount; channel++) {
    if (!activeToneSlot(channelBlocks[channel])) {
      throw new RangeError('ATRAC3plus tone-enabled channel has no slot')
    }
  }
  applyToneRecordOrientation(channelBlocks, count, swapGate)

  const bandBits = packableSymbolBits(TONE_BAND_COUNT_CODE_LENGTHS, count - 1)
  if (bandBits === null) {
    throw new RangeError('ATRAC3plus tone band count is not packable')
  }
  let stereoHeader = 0
  if (channelCount === 2) {
    for (let array = 0; array < TONE_HEADER_ARRAYS.length; array++) {
      stereoHeader += planHeaderArray(
        primarySlot.shared,
        TONE_HEADER_ARRAYS[array],
        count,
        destination,
        array
      )
    }
  }
  destination.totalBits = 2 + bandBits + stereoHeader
  const jointFlags = primarySlot.shared.subarray(
    TONE_HEADER_JOINT_ARRAY_WORD,
    TONE_HEADER_JOINT_ARRAY_WORD + TONE_RECORD_COUNT
  )
  for (let channel = 0; channel < channelCount; channel++) {
    const block = channelBlocks[channel]
    const slot = activeToneSlot(block)
    const parity = block.channelOrdinal & 1
    const base = parity !== 0 ? primarySlot.records : null
    destination.totalBits += planChannel(
      slot.records,
      base,
      parity,
      jointFlags,
      count,
      destination.sides[channel]
    )
  }
  return destination
}

/**
 * Emit one disabled, uniform, or per-band tone header plane.
 *
 * @param {Int32Array} header
 * @param {{enable: number, mode: number, values: number}} descriptor
 * @param {number} enabled
 * @param {number} mixed
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packPresence(header, descriptor, enabled, mixed, count, sink) {
  sink.write(enabled, 1)
  if (enabled === 0) return
  sink.write(mixed, 1)
  if (mixed === 0) return
  for (let index = 0; index < count; index++) {
    sink.write(header[descriptor.values + index] & 1, 1)
  }
}

/**
 * Emit optional start and end gate locations for every present tone band.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packLocations(records, present, count, sink) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = records[band]
    sink.write(record.gateStartValid & 1, 1)
    if (record.gateStartValid !== 0) sink.write(record.gateStartIndex, 5)
    sink.write(record.gateEndValid & 1, 1)
    if (record.gateEndValid !== 0) sink.write(record.gateEndIndex, 5)
  }
}

/**
 * Emit the fixed-width sinusoid count for every present tone band.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packCounts(records, present, count, sink) {
  for (let band = 0; band < count; band++) {
    if (present[band] !== 0)
      sink.write(recordCount(records[band]), TONE_COUNT_BITS)
  }
}

/**
 * Emit ordered frequency steps in each band's selected forward or reverse delta direction.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ToneChannelPlan} side
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packFrequencies(records, side, count, sink) {
  for (let band = 0; band < count; band++) {
    if (side.presenceFlags[band] === 0) continue
    const record = records[band]
    const itemCount = Math.max(recordCount(record), 0)
    const reverse = side.frequencyDirectionFlags[band] !== 0
    if (itemCount > 1) sink.write(reverse ? 1 : 0, 1)
    if (itemCount <= 0) continue
    if (!reverse) {
      sink.write(frequency(record, 0), FREQUENCY_BASE_BITS)
      for (let item = 1; item < itemCount; item++) {
        const previous = frequency(record, item - 1) >>> 0
        sink.write(
          (frequency(record, item) - upwardAdd(previous)) >>> 0,
          upwardBits(previous)
        )
      }
    } else {
      sink.write(frequency(record, itemCount - 1), FREQUENCY_BASE_BITS)
      for (let item = itemCount - 2; item >= 0; item--) {
        sink.write(
          frequency(record, item),
          reverseBits(frequency(record, item + 1) >>> 0)
        )
      }
    }
  }
}

/**
 * Emit raw tone scale factors or canonical deltas from their frequency-matched primary items.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ToneSynthesisRecord[]} baseRecords
 * @param {ToneChannelPlan} side
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packScaleFactors(records, baseRecords, side, count, sink) {
  if (side.scaleFactorMode === 0) {
    for (let band = 0; band < count; band++) {
      if (side.presenceFlags[band] === 0) continue
      const record = records[band]
      for (let item = 0; item < Math.max(recordCount(record), 0); item++) {
        sink.write(
          record.scaleFactorIndices[item],
          IO_TONE_SYNTAX_SCALE_FACTOR_RAW_BITS
        )
      }
    }
    return
  }
  if (side.scaleFactorMode !== 2 || !baseRecords) return
  for (let band = 0; band < count; band++) {
    if (side.presenceFlags[band] === 0) continue
    const record = records[band]
    const base = baseRecords[band]
    const itemCount = Math.max(recordCount(record), 0)
    const baseCount = Math.max(recordCount(base), 0)
    for (let item = 0; item < itemCount; item++) {
      const mapped = mappedToneItemIndex(
        item,
        baseCount,
        frequency(record, item),
        base.steps
      )
      const baseValue =
        mapped < 0 ? SCALE_FACTOR_DELTA_BASE : base.scaleFactorIndices[mapped]
      const delta = record.scaleFactorIndices[item] - baseValue
      if (
        delta < -16 ||
        delta > 15 ||
        !writeCanonicalSymbol(
          TONE_SCALE_FACTOR_CODEBOOK_B_CODE_LENGTHS,
          delta & 0x1f,
          sink
        )
      ) {
        throw new RangeError('ATRAC3plus tone scale-factor delta is invalid')
      }
    }
  }
}

/**
 * Emit the five-bit initial phase of every transmitted sinusoid.
 *
 * @param {ToneSynthesisRecord[]} records
 * @param {ArrayLike<number>} present
 * @param {number} count
 * @param {BitWriter|BitCounter} sink
 */
function packPhases(records, present, count, sink) {
  for (let band = 0; band < count; band++) {
    if (present[band] === 0) continue
    const record = records[band]
    for (let item = 0; item < Math.max(recordCount(record), 0); item++) {
      sink.write(record.phaseBases[item], TONE_PHASE_BITS)
    }
  }
}

/**
 * Emit one already-planned delayed tone section.
 *
 * @param {EncodeChannelState[]} channelBlocks All frame channel blocks.
 * @param {ToneCodingPlan} plan Committed tone plan.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packToneSection(channelBlocks, plan, sink) {
  const channelCount = channelBlocks?.length ?? 0
  if (
    !Array.isArray(channelBlocks) ||
    channelCount < 1 ||
    channelCount > CODING_UNIT_MAX_CHANNELS ||
    !(plan instanceof ToneCodingPlan) ||
    typeof sink?.write !== 'function'
  ) {
    throw new RangeError('ATRAC3plus tone pack request is invalid')
  }
  const primary = channelBlocks[0]
  const primarySlot = activeToneSlot(primary)
  if (!primarySlot) {
    sink.write(0, 1)
    return
  }
  const enabled = primarySlot.shared[TONE_HEADER_ENABLE_WORD] & 1
  sink.write(enabled, 1)
  if (enabled === 0) return
  sink.write(1, 1)
  const count = primarySlot.shared[TONE_HEADER_BAND_COUNT_WORD] >>> 0
  if (
    !writeCanonicalSymbol(
      TONE_BAND_COUNT_CODE_LENGTHS,
      (count - 1) & 0x1f,
      sink
    )
  ) {
    throw new RangeError('ATRAC3plus tone band count is invalid')
  }
  if (channelCount === 2) {
    for (const descriptor of TONE_HEADER_PACK_ORDER) {
      const array = TONE_HEADER_ARRAYS.indexOf(descriptor)
      packPresence(
        primarySlot.shared,
        descriptor,
        plan.headerEnables[array],
        plan.headerModes[array],
        count,
        sink
      )
    }
  }
  for (let channel = 0; channel < channelCount; channel++) {
    const block = channelBlocks[channel]
    const slot = activeToneSlot(block)
    if (!slot) throw new RangeError('ATRAC3plus tone channel slot is absent')
    const parity = block.channelOrdinal & 1
    const side = plan.sides[channel]
    sink.write(0, parity)
    packLocations(slot.records, side.presenceFlags, count, sink)
    sink.write(0, 1 + parity)
    packCounts(slot.records, side.presenceFlags, count, sink)
    sink.write(0, parity)
    packFrequencies(slot.records, side, count, sink)
    sink.write(side.scaleFactorMode & 3, 1 + parity)
    packScaleFactors(
      slot.records,
      parity !== 0 ? primarySlot.records : null,
      side,
      count,
      sink
    )
    packPhases(slot.records, side.presenceFlags, count, sink)
  }
}
