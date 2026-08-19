/** ATRAC3plus gain-record bitstream decoding into fixed frame storage. */

import { readCanonicalSymbol } from '../coding/entropy.js'
import {
  GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
  GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS,
  LEVEL_CODE_LENGTHS,
  LOCATION_CODE_LENGTHS,
} from '../core/tables.js'
import {
  GAIN_LEVEL_DEFAULT,
  COUNT_MASK,
  LEVEL_MASK,
  LOCATION_MASK,
} from '../core/constants.js'
import { DecodeGainFrame } from '../state/decoder.js'
import { BitReader } from './bitstream.js'

/**
 * Error raised when gain decode input violates the decoder or bitstream contract.
 */
export class GainDecodeError extends RangeError {
  /**
   * Attach codec context to a gain decode error before it crosses the public boundary.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  constructor(kind, fields = {}) {
    super(`ATRAC3plus gain decode failed: ${kind}`)
    this.name = 'GainDecodeError'
    this.kind = kind
    Object.assign(this, fields)
  }
}

/**
 * Verify primary/secondary gain-frame relationships and reader state before decoding one channel.
 *
 * @param {DecodeGainFrame} destination
 * @param {DecodeGainFrame|null} base
 * @param {number} channelOrdinal
 * @param {BitReader} reader
 */
function validateRequest(destination, base, channelOrdinal, reader) {
  if (
    !(destination instanceof DecodeGainFrame) ||
    (base !== null && !(base instanceof DecodeGainFrame)) ||
    !Number.isInteger(channelOrdinal) ||
    channelOrdinal < 0 ||
    channelOrdinal > 1 ||
    (channelOrdinal === 1 && base === null) ||
    !(reader instanceof BitReader)
  ) {
    throw new RangeError('ATRAC3plus gain decode topology is invalid')
  }
}

/**
 * Add a decoded gain delta to its predictor and wrap it in the target syntax domain.
 *
 * @param {number} symbol
 * @param {number} reference
 * @param {number} mask
 * @returns {number}
 */
function applyDelta(symbol, reference, mask) {
  return (symbol + reference) & mask
}

/**
 * Return a decoded gain level or the neutral predictor when the entry is absent.
 *
 * @param {GainRecord} record
 * @param {number} entry
 * @returns {number}
 */
function levelOrDefault(record, entry) {
  return entry < record.entries ? record.levels[entry] : GAIN_LEVEL_DEFAULT
}

/**
 * Report whether a gain transition moves toward release rather than attack.
 *
 * @param {GainRecord} record
 * @param {number} entry
 * @returns {boolean}
 */
function isRelease(record, entry) {
  return entry > 0 && record.levels[entry] > record.levels[entry - 1]
}

/**
 * Choose the gain-location codebook that matches attack or release direction.
 *
 * @param {number} aFamily
 * @param {number} release
 * @returns {number}
 */
function releaseCodebook(aFamily, release) {
  if (aFamily) return release ? 1 : 0
  return release ? 3 : 2
}

/**
 * Compute the wrapped bit cost of coding gain locations in ascending order.
 *
 * @param {number} previous
 * @returns {number}
 */
function ascendingBits(previous) {
  if (previous <= 0x0e) return 5
  if (previous <= 0x16) return 4
  if (previous <= 0x1a) return 3
  if (previous <= 0x1c) return 2
  if (previous === 0x1d) return 1
  return 0
}

/**
 * Advance a gain location by its wrapped ascending symbol.
 *
 * @param {number} previous
 * @param {number} symbol
 * @returns {number}
 */
function applyAscendingSymbol(previous, symbol) {
  return previous <= 0x0e ? symbol : previous + 1 + symbol
}

/**
 * Reconstruct every transmitted record's point count using direct, intra-frame, fixed-width, or stereo prediction.
 *
 * @param {DecodeGainFrame} frame
 * @param {DecodeGainFrame|null} base
 * @param {boolean} secondary
 * @param {BitReader} reader
 */
function readPointCounts(frame, base, secondary, reader) {
  const count = frame.transmittedCount
  const mode = frame.pointCountMode
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      frame.records[record].entries = reader.read(3)
    }
  } else if (mode === 1) {
    for (let record = 0; record < count; record++) {
      frame.records[record].entries = readCanonicalSymbol(
        GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
        reader
      )
    }
  } else if (!secondary && mode === 2) {
    for (let record = 0; record < count; record++) {
      const table =
        record === 0
          ? GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS
          : GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS
      const symbol = readCanonicalSymbol(table, reader)
      frame.records[record].entries =
        record === 0
          ? symbol
          : applyDelta(symbol, frame.records[record - 1].entries, COUNT_MASK)
    }
  } else if (!secondary && mode === 3) {
    frame.countWidth = reader.read(2)
    frame.countBase = reader.read(3)
    for (let record = 0; record < count; record++) {
      frame.records[record].entries =
        reader.read(frame.countWidth) + frame.countBase
    }
  } else if (mode === 2) {
    for (let record = 0; record < count; record++) {
      const symbol = readCanonicalSymbol(
        GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS,
        reader
      )
      frame.records[record].entries = applyDelta(
        symbol,
        base.records[record].entries,
        COUNT_MASK
      )
    }
  } else {
    for (let record = 0; record < count; record++) {
      frame.records[record].entries = base.records[record].entries
    }
  }
}

/**
 * Decode the first absolute level followed by wrapped deltas within one gain record.
 *
 * @param {GainRecord} record
 * @param {BitReader} reader
 */
function readIntraLevels(record, reader) {
  for (let entry = 0; entry < record.entries; entry++) {
    const symbol = readCanonicalSymbol(
      LEVEL_CODE_LENGTHS[entry === 0 ? 0 : 1],
      reader
    )
    record.levels[entry] =
      entry === 0
        ? symbol
        : applyDelta(symbol, record.levels[entry - 1], LEVEL_MASK)
  }
}

/**
 * Copy base levels into reusable destination storage without retaining source-owned views.
 *
 * @param {GainRecord} record
 * @param {GainRecord} base
 */
function copyBaseLevels(record, base) {
  for (let entry = 0; entry < record.entries; entry++) {
    record.levels[entry] = levelOrDefault(base, entry)
  }
}

/**
 * Reconstruct gain levels using the selected direct, intra-record, inter-record, fixed-width, or stereo mode.
 *
 * @param {DecodeGainFrame} frame
 * @param {DecodeGainFrame|null} base
 * @param {boolean} secondary
 * @param {BitReader} reader
 */
function readLevels(frame, base, secondary, reader) {
  const count = frame.transmittedCount
  const mode = frame.levelMode
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        current.levels[entry] = reader.read(4)
      }
    }
  } else if (!secondary && mode === 1) {
    for (let record = 0; record < count; record++) {
      readIntraLevels(frame.records[record], reader)
    }
  } else if (!secondary && mode === 2) {
    if (count > 0) readIntraLevels(frame.records[0], reader)
    for (let record = 1; record < count; record++) {
      const current = frame.records[record]
      const previous = frame.records[record - 1]
      for (let entry = 0; entry < current.entries; entry++) {
        const symbol = readCanonicalSymbol(LEVEL_CODE_LENGTHS[2], reader)
        current.levels[entry] = applyDelta(
          symbol,
          levelOrDefault(previous, entry),
          LEVEL_MASK
        )
      }
    }
  } else if (!secondary && mode === 3) {
    frame.levelWidth = reader.read(2)
    frame.levelBase = reader.read(4)
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        current.levels[entry] = reader.read(frame.levelWidth) + frame.levelBase
      }
    }
  } else if (mode === 1) {
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        const symbol = readCanonicalSymbol(LEVEL_CODE_LENGTHS[3], reader)
        current.levels[entry] = applyDelta(
          symbol,
          levelOrDefault(base.records[record], entry),
          LEVEL_MASK
        )
      }
    }
  } else if (mode === 2) {
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      if (current.entries === 0) continue
      if (reader.read(1) !== 0) readIntraLevels(current, reader)
      else copyBaseLevels(current, base.records[record])
    }
  } else {
    for (let record = 0; record < count; record++) {
      copyBaseLevels(frame.records[record], base.records[record])
    }
  }
}

/**
 * Decode strictly ascending gain locations with the width implied by each preceding location.
 *
 * @param {GainRecord} record
 * @param {number} startEntry
 * @param {BitReader} reader
 */
function readAscending(record, startEntry, reader) {
  for (let entry = startEntry; entry < record.entries; entry++) {
    record.locations[entry] =
      entry === 0
        ? reader.read(5)
        : applyAscendingSymbol(
            record.locations[entry - 1],
            reader.read(ascendingBits(record.locations[entry - 1]))
          )
  }
}

/**
 * Decode A-family gain locations using attack/release-dependent increment codebooks.
 *
 * @param {GainRecord} record
 * @param {BitReader} reader
 */
function readAIncrement(record, reader) {
  if (record.entries === 0) return
  record.locations[0] = reader.read(5)
  for (let entry = 1; entry < record.entries; entry++) {
    const codebook = releaseCodebook(true, isRelease(record, entry))
    record.locations[entry] =
      record.locations[entry - 1] +
      readCanonicalSymbol(LOCATION_CODE_LENGTHS[codebook], reader)
  }
}

/**
 * Decode primary-channel locations predicted from the preceding gain record.
 *
 * @param {DecodeGainFrame} frame
 * @param {BitReader} reader
 */
function readPrimaryPrevious(frame, reader) {
  const count = frame.transmittedCount
  if (count > 0) readAscending(frame.records[0], 0, reader)
  for (let record = 1; record < count; record++) {
    const current = frame.records[record]
    const previous = frame.records[record - 1]
    for (let entry = 0; entry < current.entries; entry++) {
      let codebook
      let reference
      let delta = true
      if (entry === 0) {
        codebook = 2
        reference = previous.entries > 0 ? previous.locations[entry] : 0
        delta = previous.entries > 0
      } else if (entry >= previous.entries) {
        codebook = releaseCodebook(true, isRelease(current, entry))
        reference = current.locations[entry - 1]
        delta = false
      } else {
        codebook = releaseCodebook(false, isRelease(current, entry))
        reference = previous.locations[entry]
      }
      const symbol = readCanonicalSymbol(
        LOCATION_CODE_LENGTHS[codebook],
        reader
      )
      current.locations[entry] = delta
        ? applyDelta(symbol, reference, LOCATION_MASK)
        : reference + symbol
    }
  }
}

/**
 * Decode secondary-channel locations as deltas from matching primary-channel points where available.
 *
 * @param {DecodeGainFrame} frame
 * @param {DecodeGainFrame} base
 * @param {BitReader} reader
 */
function readSecondaryBaseDelta(frame, base, reader) {
  for (let record = 0; record < frame.transmittedCount; record++) {
    const current = frame.records[record]
    const primary = base.records[record]
    for (let entry = 0; entry < current.entries; entry++) {
      if (entry === 0) {
        const symbol = readCanonicalSymbol(LOCATION_CODE_LENGTHS[4], reader)
        current.locations[entry] =
          primary.entries > 0
            ? applyDelta(symbol, primary.locations[entry], LOCATION_MASK)
            : symbol
      } else if (isRelease(current, entry) && entry < primary.entries) {
        if (reader.read(1) === 0) {
          current.locations[entry] = primary.locations[entry]
        } else {
          current.locations[entry] = applyAscendingSymbol(
            current.locations[entry - 1],
            reader.read(ascendingBits(current.locations[entry - 1]))
          )
        }
      } else if (entry < primary.entries) {
        const symbol = readCanonicalSymbol(LOCATION_CODE_LENGTHS[4], reader)
        current.locations[entry] = applyDelta(
          symbol,
          primary.locations[entry],
          LOCATION_MASK
        )
      } else {
        const codebook = releaseCodebook(true, isRelease(current, entry))
        current.locations[entry] =
          current.locations[entry - 1] +
          readCanonicalSymbol(LOCATION_CODE_LENGTHS[codebook], reader)
      }
    }
  }
}

/**
 * Either copy primary locations or recode a complete A-family location sequence for each secondary record.
 *
 * @param {DecodeGainFrame} frame
 * @param {DecodeGainFrame} base
 * @param {BitReader} reader
 */
function readSecondaryRecode(frame, base, reader) {
  for (let record = 0; record < frame.transmittedCount; record++) {
    const current = frame.records[record]
    const primary = base.records[record]
    if (current.entries === 0) continue
    const recode =
      current.entries > primary.entries ? true : reader.read(1) !== 0
    if (recode) readAIncrement(current, reader)
    else {
      current.locations.set(primary.locations.subarray(0, current.entries), 0)
    }
  }
}

/**
 * Dispatch gain-location reconstruction to the direct, A-family, previous-record, or stereo predictor selected on the wire.
 *
 * @param {DecodeGainFrame} frame
 * @param {DecodeGainFrame|null} base
 * @param {boolean} secondary
 * @param {BitReader} reader
 */
function readLocations(frame, base, secondary, reader) {
  const count = frame.transmittedCount
  const mode = frame.locationMode
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      readAscending(frame.records[record], 0, reader)
    }
  } else if (!secondary && mode === 1) {
    for (let record = 0; record < count; record++) {
      readAIncrement(frame.records[record], reader)
    }
  } else if (!secondary && mode === 2) {
    readPrimaryPrevious(frame, reader)
  } else if (!secondary && mode === 3) {
    frame.locationWidth = reader.read(2) + 1
    frame.locationBase = reader.read(5)
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        current.locations[entry] =
          reader.read(frame.locationWidth) + frame.locationBase + entry
      }
    }
  } else if (mode === 1) {
    readSecondaryBaseDelta(frame, base, reader)
  } else if (mode === 2) {
    readSecondaryRecode(frame, base, reader)
  } else {
    for (let record = 0; record < count; record++) {
      const current = frame.records[record]
      const primary = base.records[record]
      const copied = Math.min(current.entries, primary.entries)
      current.locations.set(primary.locations.subarray(0, copied), 0)
      readAscending(current, copied, reader)
    }
  }
}

/**
 * Enforce gain-point count, level, and strictly increasing location invariants after decoding.
 *
 * @param {DecodeGainFrame} frame
 */
function validateRecords(frame) {
  for (let record = 0; record < frame.transmittedCount; record++) {
    const current = frame.records[record]
    if (current.entries > 7) {
      throw new GainDecodeError('point count exceeds seven', { record })
    }
    let previous = -1
    for (let entry = 0; entry < current.entries; entry++) {
      const level = current.levels[entry]
      const location = current.locations[entry]
      if (level > LEVEL_MASK) {
        throw new GainDecodeError('level exceeds fifteen', {
          record,
          entry,
          level,
        })
      }
      if (location > LOCATION_MASK || location <= previous) {
        throw new GainDecodeError('locations are not strictly ascending', {
          record,
          entry,
          location,
        })
      }
      previous = location
    }
  }
}

/**
 * Decode one channel's complete gain frame.
 *
 * @param {GainChannelSyntax} destination Channel syntax to overwrite.
 * @param {GainChannelSyntax|null} base Optional primary-channel syntax.
 * @param {number} channelOrdinal Coding-unit channel ordinal.
 * @param {BitReader} reader Source bit reader.
 * @returns {GainChannelSyntax} The destination syntax.
 */
export function unpackGainChannel(destination, base, channelOrdinal, reader) {
  validateRequest(destination, base, channelOrdinal, reader)
  destination.clear()
  destination.hasData = reader.read(1)
  if (destination.hasData === 0) return destination
  destination.transmittedCount = reader.read(4) + 1
  destination.hasDelta = reader.read(1)
  destination.effectiveCount =
    destination.hasDelta === 0
      ? destination.transmittedCount
      : reader.read(4) + 1
  if (
    destination.effectiveCount < destination.transmittedCount ||
    destination.effectiveCount > 16
  ) {
    throw new GainDecodeError('record extension range is invalid', {
      transmittedCount: destination.transmittedCount,
      effectiveCount: destination.effectiveCount,
    })
  }
  const secondary = channelOrdinal === 1
  destination.pointCountMode = reader.read(2)
  readPointCounts(destination, base, secondary, reader)
  destination.levelMode = reader.read(2)
  readLevels(destination, base, secondary, reader)
  destination.locationMode = reader.read(2)
  readLocations(destination, base, secondary, reader)
  validateRecords(destination)
  if (destination.hasDelta !== 0) {
    const source = destination.records[destination.transmittedCount - 1]
    for (
      let record = destination.transmittedCount;
      record < destination.effectiveCount;
      record++
    ) {
      source.copyTo(destination.records[record])
    }
  }
  return destination
}
