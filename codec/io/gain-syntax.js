/** ATRAC3plus gain syntax capture, exact pricing, and mode selection. */

import { packableSymbolBits, writeCanonicalSymbol } from '../coding/entropy.js'
import {
  GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
  GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS,
  LEVEL_CODE_LENGTHS,
  LOCATION_CODE_LENGTHS,
} from '../core/tables.js'
import {
  CODING_UNIT_MAX_CHANNELS,
  GAIN_LEVEL_DEFAULT,
  GAIN_LEVEL_MAX,
  GAIN_LOCATION_MAX,
  GAIN_SLOT_COUNT,
  GAIN_MODE_FORBIDDEN_BITS,
  GAIN_POINT_COUNT_MAXIMUM,
  GAIN_ROLE,
  LOCATION_CODEBOOK,
  GAIN_RECORDS,
} from '../core/constants.js'
import { GainCodingPlan, GainSyntaxModeProfile } from '../state/gain.js'

/**
 * Translate an unavailable entropy symbol to the shared forbidden-cost sentinel.
 *
 * @param {number} bits
 * @returns {number}
 */
function forbiddenIfNull(bits) {
  return bits === null ? GAIN_MODE_FORBIDDEN_BITS : bits
}

/**
 * Return the Huffman width of one gain point-count symbol or the forbidden sentinel.
 *
 * @param {number} delta
 * @param {number} symbol
 * @returns {number}
 */
function pointCountSymbolBits(delta, symbol) {
  return forbiddenIfNull(
    packableSymbolBits(
      delta
        ? GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS
        : GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
      symbol
    )
  )
}

/**
 * Return the Huffman width of one gain-level symbol or the forbidden sentinel.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @returns {number}
 */
function levelSymbolBits(codebook, symbol) {
  const table = LEVEL_CODE_LENGTHS[codebook]
  return forbiddenIfNull(packableSymbolBits(table, symbol))
}

/**
 * Return the Huffman width of one gain-location symbol or the forbidden sentinel.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @returns {number}
 */
function locationSymbolBits(codebook, symbol) {
  const table = LOCATION_CODE_LENGTHS[codebook]
  return forbiddenIfNull(packableSymbolBits(table, symbol))
}

/**
 * Accumulate a candidate field width while propagating the forbidden-syntax sentinel.
 *
 * @param {number} total
 * @param {number} bits
 * @returns {number}
 */
function addMeasuredBits(total, bits) {
  return total >= GAIN_MODE_FORBIDDEN_BITS || bits >= GAIN_MODE_FORBIDDEN_BITS
    ? GAIN_MODE_FORBIDDEN_BITS
    : total + bits
}

/**
 * Wrap a predictor-relative gain value into its finite syntax alphabet.
 *
 * @param {number} current
 * @param {number} base
 * @param {number} mask
 * @returns {number}
 */
function moduloDelta(current, base, mask) {
  return (current - base) & mask
}

/**
 * Return the minimum unsigned width needed to represent a syntax value.
 *
 * @param {number} value
 * @returns {number}
 */
function bitWidth(value) {
  return value === 0 ? 0 : 32 - Math.clz32(value)
}

/**
 * Resolve whether a channel is independent, primary, or secondary for gain prediction.
 *
 * @param {number} channelOrdinal
 * @returns {number}
 */
function channelRole(channelOrdinal) {
  return channelOrdinal & 1 ? GAIN_ROLE.SECONDARY : GAIN_ROLE.PRIMARY
}

/**
 * Count consecutive active records from the start of a gain sidechain.
 *
 * @param {GainRecord[]} records
 * @param {number} recordCount
 * @returns {number}
 */
function activePrefixCount(records, recordCount) {
  let count = Math.min(recordCount, records.length)
  while (count > 0 && records[count - 1].entries === 0) count--
  return count
}

/**
 * Count the nonrepeating prefix shared by predictor-relative gain syntax.
 *
 * @param {GainRecord[]} records
 * @param {number} recordCount
 * @returns {number}
 */
function uniquePrefixCount(records, recordCount) {
  let count = Math.min(recordCount, records.length)
  while (count > 1 && records[count - 1].codedEquals(records[count - 2])) {
    count--
  }
  return count
}

/**
 * Derive effective and transmitted gain-record counts before comparing syntax modes.
 *
 * @param {GainCodingChannel} channel
 * @param {number} recordCount
 */
function prepareSyntaxCounts(channel, recordCount) {
  const effective = activePrefixCount(channel.records, recordCount)
  const transmitted =
    effective < 2 ? effective : uniquePrefixCount(channel.records, effective)
  const syntax = channel.syntax
  syntax.hasData = effective === 0 ? 0 : 1
  syntax.transmittedCount = transmitted
  syntax.hasDelta = effective === transmitted ? 0 : 1
  syntax.effectiveCount = effective
}

/**
 * Return a gain-point level or the neutral level used beyond the active record prefix.
 *
 * @param {GainRecord} record
 * @param {number} entry
 * @returns {number}
 */
function gainRecordLevelOrDefault(record, entry) {
  return entry < record.entries ? record.levels[entry] : GAIN_LEVEL_DEFAULT
}

/**
 * Report whether two gain records contain the same number of active points.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {boolean}
 */
function recordsHaveEqualCounts(channel, base) {
  const count = channel.syntax.transmittedCount
  for (let record = 0; record < count; record++) {
    if (channel.records[record].entries !== base.records[record].entries) {
      return false
    }
  }
  return true
}

/**
 * Compare a gain record's active levels with the selected predictor record.
 *
 * @param {GainRecord} record
 * @param {GainRecord} base
 * @returns {boolean}
 */
function recordLevelsEqualToBase(record, base) {
  for (let entry = 0; entry < record.entries; entry++) {
    if (record.levels[entry] !== gainRecordLevelOrDefault(base, entry)) {
      return false
    }
  }
  return true
}

/**
 * Compare corresponding active gain levels across two records.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {boolean}
 */
function recordsHaveEqualLevels(channel, base) {
  const count = channel.syntax.transmittedCount
  for (let record = 0; record < count; record++) {
    if (
      !recordLevelsEqualToBase(channel.records[record], base.records[record])
    ) {
      return false
    }
  }
  return true
}

/**
 * Compare a gain record's active locations with the selected predictor record.
 *
 * @param {GainRecord} record
 * @param {GainRecord} base
 * @returns {boolean}
 */
function recordLocationsEqualToBase(record, base) {
  if (record.entries > base.entries) return false
  for (let entry = 0; entry < record.entries; entry++) {
    if (record.locations[entry] !== base.locations[entry]) return false
  }
  return true
}

/**
 * Compare the predictor-covered prefix of two gain-location arrays.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {boolean}
 */
function recordsHaveEqualLocationPrefixes(channel, base) {
  const count = channel.syntax.transmittedCount
  for (let record = 0; record < count; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    const prefix = Math.min(current.entries, primary.entries, GAIN_SLOT_COUNT)
    for (let entry = 0; entry < prefix; entry++) {
      if (current.locations[entry] !== primary.locations[entry]) return false
    }
  }
  return true
}

/**
 * Measure one point-count mode exactly while populating its fixed-width or predictor-local fields.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {number} role
 * @param {number} mode
 * @param {number} coreMode
 * @returns {number}
 */
function measurePointCountCandidate(channel, base, role, mode, coreMode) {
  const syntax = channel.syntax
  syntax.countWidth = 0
  syntax.countBase = 0
  const count = syntax.transmittedCount

  if (mode === 0) return count * 3
  if (mode === 1) {
    let bits = 0
    for (let record = 0; record < count; record++) {
      bits = addMeasuredBits(
        bits,
        pointCountSymbolBits(false, channel.records[record].entries)
      )
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    if (coreMode > 0x1b) return GAIN_MODE_FORBIDDEN_BITS
    let bits = 0
    for (let record = 0; record < count; record++) {
      const current = channel.records[record].entries
      const symbol =
        record === 0
          ? current
          : moduloDelta(current, channel.records[record - 1].entries, 7)
      bits = addMeasuredBits(bits, pointCountSymbolBits(record !== 0, symbol))
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    if (coreMode > 0x1b || coreMode === 0x0f) {
      return GAIN_MODE_FORBIDDEN_BITS
    }
    let minimum = 7
    let maximum = 0
    for (let record = 0; record < count; record++) {
      minimum = Math.min(minimum, channel.records[record].entries)
      maximum = Math.max(maximum, channel.records[record].entries)
    }
    const width = bitWidth(Math.max(0, maximum - minimum))
    if (width > 3) return GAIN_MODE_FORBIDDEN_BITS
    syntax.countWidth = width
    syntax.countBase = minimum
    return 2 + 3 + width * count
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    if (!base) return GAIN_MODE_FORBIDDEN_BITS
    let bits = 0
    for (let record = 0; record < count; record++) {
      bits = addMeasuredBits(
        bits,
        pointCountSymbolBits(
          true,
          moduloDelta(
            channel.records[record].entries,
            base.records[record].entries,
            GAIN_POINT_COUNT_MAXIMUM
          )
        )
      )
    }
    return bits
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 3) {
    return base && recordsHaveEqualCounts(channel, base)
      ? 0
      : GAIN_MODE_FORBIDDEN_BITS
  }
  return GAIN_MODE_FORBIDDEN_BITS
}

/**
 * Measure one record's absolute first level and wrapped intra-record level deltas.
 *
 * @param {GainRecord} record
 * @returns {number}
 */
function measureIntraRecordLevels(record) {
  let bits = 0
  for (let entry = 0; entry < record.entries; entry++) {
    const symbol =
      entry === 0
        ? record.levels[entry]
        : moduloDelta(
            record.levels[entry],
            record.levels[entry - 1],
            GAIN_LEVEL_MAX
          )
    bits = addMeasuredBits(bits, levelSymbolBits(entry === 0 ? 0 : 1, symbol))
  }
  return bits
}

/**
 * Measure one gain-level mode exactly while populating its flags or fixed-width fields.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {number} role
 * @param {number} mode
 * @returns {number}
 */
function measureLevelCandidate(channel, base, role, mode) {
  const syntax = channel.syntax
  syntax.levelWidth = 0
  syntax.levelBase = 0
  const count = syntax.transmittedCount

  if (mode === 0) {
    let entries = 0
    for (let record = 0; record < count; record++) {
      entries += channel.records[record].entries
    }
    return entries * 4
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 1) {
    let bits = 0
    for (let record = 0; record < count; record++) {
      bits = addMeasuredBits(
        bits,
        measureIntraRecordLevels(channel.records[record])
      )
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    let bits = measureIntraRecordLevels(channel.records[0])
    for (let record = 1; record < count; record++) {
      const current = channel.records[record]
      const previous = channel.records[record - 1]
      for (let entry = 0; entry < current.entries; entry++) {
        bits = addMeasuredBits(
          bits,
          levelSymbolBits(
            2,
            moduloDelta(
              current.levels[entry],
              gainRecordLevelOrDefault(previous, entry),
              GAIN_LEVEL_MAX
            )
          )
        )
      }
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    let minimum = 15
    let maximum = 0
    let entries = 0
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        minimum = Math.min(minimum, current.levels[entry])
        maximum = Math.max(maximum, current.levels[entry])
        entries++
      }
    }
    const width = bitWidth(Math.max(0, maximum - minimum))
    if (width > 3) return GAIN_MODE_FORBIDDEN_BITS
    syntax.levelWidth = width
    syntax.levelBase = minimum
    return 2 + 4 + width * entries
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 1) {
    if (!base) return GAIN_MODE_FORBIDDEN_BITS
    let bits = 0
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      const primary = base.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        bits = addMeasuredBits(
          bits,
          levelSymbolBits(
            3,
            moduloDelta(
              current.levels[entry],
              gainRecordLevelOrDefault(primary, entry),
              GAIN_LEVEL_MAX
            )
          )
        )
      }
    }
    return bits
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    if (!base) return GAIN_MODE_FORBIDDEN_BITS
    syntax.levelFlags.fill(0)
    let bits = 0
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      const flag =
        current.entries === 0
          ? 0
          : recordLevelsEqualToBase(current, base.records[record])
            ? 0
            : 1
      syntax.levelFlags[record] = flag
      if (current.entries === 0) continue
      bits++
      if (flag !== 0) {
        bits = addMeasuredBits(bits, measureIntraRecordLevels(current))
      }
    }
    return bits
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 3) {
    return base && recordsHaveEqualLevels(channel, base)
      ? 0
      : GAIN_MODE_FORBIDDEN_BITS
  }
  return GAIN_MODE_FORBIDDEN_BITS
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
  if (aFamily) {
    return release ? LOCATION_CODEBOOK.A_RELEASE : LOCATION_CODEBOOK.A_ATTACK
  }
  return release ? LOCATION_CODEBOOK.B_RELEASE : LOCATION_CODEBOOK.B_ATTACK
}

/**
 * Compute the exact cost of ascending gain-location deltas for one record.
 *
 * @param {number} previous
 * @returns {number}
 */
function ascendingLocationBits(previous) {
  if (previous <= 0x0e) return 5
  if (previous <= 0x16) return 4
  if (previous <= 0x1a) return 3
  if (previous <= 0x1c) return 2
  if (previous === 0x1d) return 1
  return 0
}

/**
 * Measure a strictly ascending location sequence using predecessor-dependent field widths.
 *
 * @param {GainRecord} record
 * @param {number} [startEntry]
 * @returns {number}
 */
function measureAscendingRecordLocations(record, startEntry = 0) {
  let bits = 0
  for (let entry = startEntry; entry < record.entries; entry++) {
    bits += entry === 0 ? 5 : ascendingLocationBits(record.locations[entry - 1])
  }
  return bits
}

/**
 * Measure one A-family location sequence with attack/release-dependent canonical codebooks.
 *
 * @param {GainRecord} record
 * @returns {number}
 */
function measureAIncrementRecordLocations(record) {
  let bits = record.entries === 0 ? 0 : 5
  for (let entry = 1; entry < record.entries; entry++) {
    bits = addMeasuredBits(
      bits,
      locationSymbolBits(
        releaseCodebook(true, isRelease(record, entry)),
        record.locations[entry] - record.locations[entry - 1]
      )
    )
  }
  return bits
}

/**
 * Measure primary-channel locations predicted from the preceding gain record.
 *
 * @param {GainCodingChannel} channel
 * @returns {number}
 */
function measurePrimaryPreviousLocations(channel) {
  const count = channel.syntax.transmittedCount
  let bits = measureAscendingRecordLocations(channel.records[0])
  for (let record = 1; record < count; record++) {
    const current = channel.records[record]
    const previous = channel.records[record - 1]
    for (let entry = 0; entry < current.entries; entry++) {
      let codebook
      let symbol
      if (entry === 0) {
        codebook = LOCATION_CODEBOOK.B_ATTACK
        symbol =
          previous.entries > 0
            ? moduloDelta(
                current.locations[entry],
                previous.locations[entry],
                GAIN_LOCATION_MAX
              )
            : current.locations[entry]
      } else if (entry >= previous.entries) {
        codebook = releaseCodebook(true, isRelease(current, entry))
        symbol = current.locations[entry] - current.locations[entry - 1]
      } else {
        codebook = releaseCodebook(false, isRelease(current, entry))
        symbol = moduloDelta(
          current.locations[entry],
          previous.locations[entry],
          GAIN_LOCATION_MAX
        )
      }
      bits = addMeasuredBits(bits, locationSymbolBits(codebook, symbol))
    }
  }
  return bits
}

/**
 * Determine the raw gain-location span and bit width required by one candidate mode.
 *
 * @param {GainCodingChannel} channel
 * @returns {number}
 */
function prepareLocationRawSpan(channel) {
  const syntax = channel.syntax
  let minimum = 0xffffffff
  let maximum = 0
  let any = false
  let entries = 0
  for (let record = 0; record < syntax.transmittedCount; record++) {
    const current = channel.records[record]
    for (let entry = 0; entry < current.entries; entry++) {
      const biased = current.locations[entry] - entry
      if (biased < 0) return -1
      minimum = Math.min(minimum, biased)
      maximum = Math.max(maximum, biased)
      any = true
      entries++
    }
  }
  if (!any) {
    syntax.locationWidth = 1
    syntax.locationBase = 0
    return 0
  }
  const width = Math.max(1, bitWidth(maximum - minimum))
  if (width > 4) return -1
  syntax.locationWidth = width
  syntax.locationBase = minimum
  return entries
}

/**
 * Measure secondary locations as deltas from matching primary-channel points where available.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {number}
 */
function measureSecondaryBaseDeltaLocations(channel, base) {
  let bits = 0
  for (let record = 0; record < channel.syntax.transmittedCount; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    for (let entry = 0; entry < current.entries; entry++) {
      if (entry === 0) {
        const symbol =
          primary.entries > 0
            ? moduloDelta(
                current.locations[entry],
                primary.locations[entry],
                GAIN_LOCATION_MAX
              )
            : current.locations[entry]
        bits = addMeasuredBits(
          bits,
          locationSymbolBits(LOCATION_CODEBOOK.C_ATTACK, symbol)
        )
        continue
      }
      if (isRelease(current, entry) && entry < primary.entries) {
        bits++
        if (current.locations[entry] !== primary.locations[entry]) {
          bits += ascendingLocationBits(current.locations[entry - 1])
        }
        continue
      }
      const inBase = entry < primary.entries
      const codebook = inBase
        ? LOCATION_CODEBOOK.C_ATTACK
        : releaseCodebook(true, isRelease(current, entry))
      const symbol = inBase
        ? moduloDelta(
            current.locations[entry],
            primary.locations[entry],
            GAIN_LOCATION_MAX
          )
        : current.locations[entry] - current.locations[entry - 1]
      bits = addMeasuredBits(bits, locationSymbolBits(codebook, symbol))
    }
  }
  return bits
}

/**
 * Choose per secondary record between copying primary locations and emitting a complete A-family recode.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {number}
 */
function measureSecondaryRecodeLocations(channel, base) {
  const syntax = channel.syntax
  syntax.locationFlags.fill(0)
  let bits = 0
  for (let record = 0; record < syntax.transmittedCount; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    const flag =
      current.entries === 0
        ? 1
        : recordLocationsEqualToBase(current, primary)
          ? 0
          : 1
    syntax.locationFlags[record] = flag
    if (current.entries === 0) continue
    if (current.entries <= primary.entries) {
      bits++
      if (flag === 0) continue
    }
    bits = addMeasuredBits(bits, measureAIncrementRecordLocations(current))
  }
  return bits
}

/**
 * Require the primary-covered prefix to match, then measure only the secondary record's remaining locations.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @returns {number}
 */
function measureSecondaryCopyPrefixLocations(channel, base) {
  if (!recordsHaveEqualLocationPrefixes(channel, base)) {
    return GAIN_MODE_FORBIDDEN_BITS
  }
  let bits = 0
  for (let record = 0; record < channel.syntax.transmittedCount; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    bits += measureAscendingRecordLocations(
      current,
      Math.min(current.entries, primary.entries)
    )
  }
  return bits
}

/**
 * Measure one location mode exactly while populating its raw span, recode, or copy flags.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {number} role
 * @param {number} mode
 * @param {number} coreMode
 * @returns {number}
 */
function measureLocationCandidate(channel, base, role, mode, coreMode) {
  const syntax = channel.syntax
  syntax.locationWidth = 0
  syntax.locationBase = 0
  const count = syntax.transmittedCount

  if (mode === 0) {
    let bits = 0
    for (let record = 0; record < count; record++) {
      bits += measureAscendingRecordLocations(channel.records[record])
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 1) {
    if (coreMode === 0x1d) return GAIN_MODE_FORBIDDEN_BITS
    let bits = 0
    for (let record = 0; record < count; record++) {
      bits = addMeasuredBits(
        bits,
        measureAIncrementRecordLocations(channel.records[record])
      )
    }
    return bits
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    return measurePrimaryPreviousLocations(channel)
  }
  if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    if (coreMode === 0x0f) return GAIN_MODE_FORBIDDEN_BITS
    const entries = prepareLocationRawSpan(channel)
    return entries < 0
      ? GAIN_MODE_FORBIDDEN_BITS
      : 2 + 5 + syntax.locationWidth * entries
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 1) {
    if ((coreMode !== 0x13 && coreMode !== 0x17) || !base) {
      return GAIN_MODE_FORBIDDEN_BITS
    }
    return measureSecondaryBaseDeltaLocations(channel, base)
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    return base
      ? measureSecondaryRecodeLocations(channel, base)
      : GAIN_MODE_FORBIDDEN_BITS
  }
  if (role === GAIN_ROLE.SECONDARY && mode === 3) {
    return base
      ? measureSecondaryCopyPrefixLocations(channel, base)
      : GAIN_MODE_FORBIDDEN_BITS
  }
  return GAIN_MODE_FORBIDDEN_BITS
}

/**
 * Choose the cheapest legal syntax mode for one gain field plane.
 *
 * @param {function(number): number} measureCandidate Exact cost function for one mode.
 * @param {function(number): void} setMode Publishes the selected mode.
 * @returns {number}
 */
function selectPlaneMode(measureCandidate, setMode) {
  let selectedMode = 0
  let selectedBits = GAIN_MODE_FORBIDDEN_BITS
  for (let mode = 0; mode < 4; mode++) {
    const bits = measureCandidate(mode)
    if (bits < selectedBits) {
      selectedMode = mode
      selectedBits = bits
    }
  }
  setMode(selectedMode)
  return selectedBits
}

/**
 * Choose count, level, and location modes for every channel role.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {number} coreMode
 * @returns {number}
 */
function selectChannelModes(channel, base, coreMode) {
  const role = channelRole(channel.channelOrdinal)
  const pointCount = selectPlaneMode(
    (mode) => measurePointCountCandidate(channel, base, role, mode, coreMode),
    (mode) => {
      channel.syntax.pointCountMode = mode
    }
  )
  const level = selectPlaneMode(
    (mode) => measureLevelCandidate(channel, base, role, mode),
    (mode) => {
      channel.syntax.levelMode = mode
    }
  )
  const location = selectPlaneMode(
    (mode) => measureLocationCandidate(channel, base, role, mode, coreMode),
    (mode) => {
      channel.syntax.locationMode = mode
    }
  )
  return addMeasuredBits(addMeasuredBits(pointCount, level), location)
}

/**
 * Bind validated channel records and prepare their reusable syntax fields.
 *
 * @param {(EncodeChannelState|GainCandidateBlock)[]} sources
 * @param {number} recordCount
 * @param {GainCodingPlan} destination
 * @returns {GainCodingPlan}
 */
function prepareSyntaxSources(sources, recordCount, destination) {
  if (
    !Array.isArray(sources) ||
    sources.length < 1 ||
    sources.length > CODING_UNIT_MAX_CHANNELS
  ) {
    throw new RangeError('ATRAC3plus gain plans require one or two channels')
  }
  if (
    !Number.isInteger(recordCount) ||
    recordCount < 0 ||
    recordCount > GAIN_RECORDS
  ) {
    throw new RangeError('ATRAC3plus gain record count must be in 0..16')
  }
  if (!(destination instanceof GainCodingPlan)) {
    throw new TypeError('ATRAC3plus gain syntax requires caller-owned storage')
  }
  destination.channelCount = sources.length
  destination.bits = 0
  for (let channel = 0; channel < sources.length; channel++) {
    destination.channels[channel].bind(sources[channel])
    prepareSyntaxCounts(destination.channels[channel], recordCount)
  }
  return destination
}

/**
 * Copy selected gain syntax modes into caller-owned storage.
 *
 * @param {GainCodingPlan} plan
 * @param {GainSyntaxModeProfile} destination
 * @returns {GainSyntaxModeProfile}
 */
export function captureGainSyntaxModes(plan, destination) {
  if (
    !(plan instanceof GainCodingPlan) ||
    !(destination instanceof GainSyntaxModeProfile)
  ) {
    throw new TypeError('ATRAC3plus gain mode capture requires fixed storage')
  }
  destination.clear()
  for (let channel = 0; channel < plan.channelCount; channel++) {
    const syntax = plan.channels[channel].syntax
    destination.pointCount[channel] = syntax.pointCountMode
    destination.level[channel] = syntax.levelMode
    destination.location[channel] = syntax.locationMode
  }
  return destination
}

/**
 * Select every gain plane into retained or temporary caller-owned syntax storage.
 *
 * @param {(EncodeChannelState|GainCodingChannel)[]} sources Gain-record sources by channel.
 * @param {number} recordCount Active gain-record count.
 * @param {number} coreMode Profile core-mode selector.
 * @param {GainCodingPlan} destination Syntax storage to overwrite.
 * @returns {GainCodingPlan} The selected syntax state.
 */
export function selectGainSyntax(sources, recordCount, coreMode, destination) {
  const plan = prepareSyntaxSources(sources, recordCount, destination)
  for (let channel = 0; channel < plan.channelCount; channel++) {
    const current = plan.channels[channel]
    let bits = current.syntax.fixedBits
    if (current.syntax.hasData !== 0) {
      bits += selectChannelModes(
        current,
        channel === 0 ? null : plan.channels[0],
        coreMode
      )
    }
    plan.bits += bits
  }
  return plan
}

/**
 * Force caller-selected gain modes and recompute their exact syntax accounting.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {number} channelIndex
 * @param {number} coreMode
 * @param {ArrayLike<number>} modes
 * @returns {null|number}
 */
function applyFixedChannelModes(channel, base, channelIndex, coreMode, modes) {
  const role = channelRole(channel.channelOrdinal)
  const pointMode = modes.pointCount[channelIndex]
  const pointBits = measurePointCountCandidate(
    channel,
    base,
    role,
    pointMode,
    coreMode
  )
  if (pointBits >= GAIN_MODE_FORBIDDEN_BITS) return null
  channel.syntax.pointCountMode = pointMode

  const levelMode = modes.level[channelIndex]
  const levelBits = measureLevelCandidate(channel, base, role, levelMode)
  if (levelBits >= GAIN_MODE_FORBIDDEN_BITS) return null
  channel.syntax.levelMode = levelMode

  const locationMode = modes.location[channelIndex]
  const locationBits = measureLocationCandidate(
    channel,
    base,
    role,
    locationMode,
    coreMode
  )
  if (locationBits >= GAIN_MODE_FORBIDDEN_BITS) return null
  channel.syntax.locationMode = locationMode
  return pointBits + levelBits + locationBits
}

/**
 * Return the exact cost of records under a supplied three-plane profile.
 *
 * @param {(EncodeChannelState|GainCodingChannel)[]} sources Gain-record sources by channel.
 * @param {number} recordCount Active gain-record count.
 * @param {number} coreMode Profile core-mode selector.
 * @param {GainSyntaxModeProfile} modes Supplied plane modes.
 * @param {GainCodingPlan} destination Non-retaining pricing state to overwrite.
 * @returns {number} Exact bit cost or the forbidden sentinel.
 */
export function measureGainSyntaxBitsWithModes(
  sources,
  recordCount,
  coreMode,
  modes,
  destination
) {
  if (
    !(modes?.pointCount instanceof Uint8Array) ||
    !(modes?.level instanceof Uint8Array) ||
    !(modes?.location instanceof Uint8Array)
  ) {
    throw new TypeError('ATRAC3plus gain repricing requires a mode profile')
  }
  const plan = prepareSyntaxSources(sources, recordCount, destination)
  for (let channel = 0; channel < plan.channelCount; channel++) {
    const current = plan.channels[channel]
    let bits = current.syntax.fixedBits
    if (current.syntax.hasData !== 0) {
      const payload = applyFixedChannelModes(
        current,
        channel === 0 ? null : plan.channels[0],
        channel,
        coreMode,
        modes
      )
      if (payload === null) return GAIN_MODE_FORBIDDEN_BITS
      bits += payload
    }
    plan.bits += bits
  }
  return plan.bits
}

/**
 * Emit one canonical gain symbol and identify the rejected field when its codebook forbids the value.
 *
 * @param {ArrayLike<number>} table
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 * @param {string} field
 */
function writeGainCanonical(table, symbol, sink, field) {
  if (!writeCanonicalSymbol(table, symbol, sink)) {
    throw new RangeError(`ATRAC3plus gain ${field} symbol is not packable`)
  }
}

/**
 * Emit one gain point-count symbol from the absolute or delta codebook family.
 *
 * @param {number} delta
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function packPointCountSymbol(delta, symbol, sink) {
  writeGainCanonical(
    delta
      ? GAIN_POINT_COUNT_CODEBOOK_B_CODE_LENGTHS
      : GAIN_POINT_COUNT_CODEBOOK_A_CODE_LENGTHS,
    symbol,
    sink,
    'point-count'
  )
}

/**
 * Emit one gain-level symbol from the selected canonical codebook.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function packLevelSymbol(codebook, symbol, sink) {
  writeGainCanonical(LEVEL_CODE_LENGTHS[codebook], symbol, sink, 'level')
}

/**
 * Emit one gain-location symbol from the selected attack/release codebook.
 *
 * @param {number} codebook
 * @param {number} symbol
 * @param {BitWriter|BitCounter} sink
 */
function packLocationSymbol(codebook, symbol, sink) {
  writeGainCanonical(LOCATION_CODE_LENGTHS[codebook], symbol, sink, 'location')
}

/**
 * Emit point counts using the planned literal, intra-frame, fixed-width, or stereo predictor.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {BitWriter|BitCounter} sink
 */
function packPointCounts(channel, base, sink) {
  const syntax = channel.syntax
  const count = syntax.transmittedCount
  const role = channelRole(channel.channelOrdinal)
  const mode = syntax.pointCountMode & 3
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      sink.write(channel.records[record].entries, 3)
    }
  } else if (mode === 1) {
    for (let record = 0; record < count; record++) {
      packPointCountSymbol(false, channel.records[record].entries, sink)
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    for (let record = 0; record < count; record++) {
      const current = channel.records[record].entries
      packPointCountSymbol(
        record !== 0,
        record === 0
          ? current
          : moduloDelta(
              current,
              channel.records[record - 1].entries,
              GAIN_POINT_COUNT_MAXIMUM
            ),
        sink
      )
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    sink.write(syntax.countWidth, 2)
    sink.write(syntax.countBase, 3)
    for (let record = 0; record < count; record++) {
      sink.write(
        channel.records[record].entries - syntax.countBase,
        syntax.countWidth
      )
    }
  } else if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    for (let record = 0; record < count; record++) {
      packPointCountSymbol(
        true,
        moduloDelta(
          channel.records[record].entries,
          base.records[record].entries,
          GAIN_POINT_COUNT_MAXIMUM
        ),
        sink
      )
    }
  }
}

/**
 * Emit one record's first absolute gain level followed by wrapped intra-record deltas.
 *
 * @param {GainRecord} record
 * @param {BitWriter|BitCounter} sink
 */
function packIntraRecordLevels(record, sink) {
  for (let entry = 0; entry < record.entries; entry++) {
    packLevelSymbol(
      entry === 0 ? 0 : 1,
      entry === 0
        ? record.levels[entry]
        : moduloDelta(
            record.levels[entry],
            record.levels[entry - 1],
            GAIN_LEVEL_MAX
          ),
      sink
    )
  }
}

/**
 * Emit gain levels using the planned direct, intra-record, inter-record, fixed-width, or stereo mode.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {BitWriter|BitCounter} sink
 */
function packLevels(channel, base, sink) {
  const syntax = channel.syntax
  const count = syntax.transmittedCount
  const role = channelRole(channel.channelOrdinal)
  const mode = syntax.levelMode & 3
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        sink.write(current.levels[entry], 4)
      }
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 1) {
    for (let record = 0; record < count; record++) {
      packIntraRecordLevels(channel.records[record], sink)
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    if (count > 0) packIntraRecordLevels(channel.records[0], sink)
    for (let record = 1; record < count; record++) {
      const current = channel.records[record]
      const previous = channel.records[record - 1]
      for (let entry = 0; entry < current.entries; entry++) {
        packLevelSymbol(
          2,
          moduloDelta(
            current.levels[entry],
            gainRecordLevelOrDefault(previous, entry),
            GAIN_LEVEL_MAX
          ),
          sink
        )
      }
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    sink.write(syntax.levelWidth, 2)
    sink.write(syntax.levelBase, 4)
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        sink.write(current.levels[entry] - syntax.levelBase, syntax.levelWidth)
      }
    }
  } else if (role === GAIN_ROLE.SECONDARY && mode === 1) {
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      const primary = base.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        packLevelSymbol(
          3,
          moduloDelta(
            current.levels[entry],
            gainRecordLevelOrDefault(primary, entry),
            GAIN_LEVEL_MAX
          ),
          sink
        )
      }
    }
  } else if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      if (current.entries === 0) continue
      const flag = syntax.levelFlags[record] & 1
      sink.write(flag, 1)
      if (flag !== 0) packIntraRecordLevels(current, sink)
    }
  }
}

/**
 * Convert a gain location to its wrapped ascending-delta symbol.
 *
 * @param {number} previous
 * @param {number} current
 * @returns {number}
 */
function ascendingLocationSymbol(previous, current) {
  return previous <= 0x0e ? current : current - previous - 1
}

/**
 * Emit strictly ascending gain locations with widths derived from their predecessors.
 *
 * @param {GainRecord} record
 * @param {number} startEntry
 * @param {BitWriter|BitCounter} sink
 */
function packAscendingRecordLocations(record, startEntry, sink) {
  for (let entry = startEntry; entry < record.entries; entry++) {
    if (entry === 0) sink.write(record.locations[entry], 5)
    else {
      sink.write(
        ascendingLocationSymbol(
          record.locations[entry - 1],
          record.locations[entry]
        ),
        ascendingLocationBits(record.locations[entry - 1])
      )
    }
  }
}

/**
 * Emit A-family location increments with attack/release-dependent codebooks.
 *
 * @param {GainRecord} record
 * @param {BitWriter|BitCounter} sink
 */
function packAIncrementRecordLocations(record, sink) {
  if (record.entries === 0) return
  sink.write(record.locations[0], 5)
  for (let entry = 1; entry < record.entries; entry++) {
    packLocationSymbol(
      releaseCodebook(true, isRelease(record, entry)),
      record.locations[entry] - record.locations[entry - 1],
      sink
    )
  }
}

/**
 * Emit primary-channel locations predicted from the preceding gain record.
 *
 * @param {GainCodingChannel} channel
 * @param {BitWriter|BitCounter} sink
 */
function packPrimaryPreviousLocations(channel, sink) {
  const count = channel.syntax.transmittedCount
  if (count > 0) packAscendingRecordLocations(channel.records[0], 0, sink)
  for (let record = 1; record < count; record++) {
    const current = channel.records[record]
    const previous = channel.records[record - 1]
    for (let entry = 0; entry < current.entries; entry++) {
      let codebook
      let symbol
      if (entry === 0) {
        codebook = LOCATION_CODEBOOK.B_ATTACK
        symbol =
          previous.entries > 0
            ? moduloDelta(
                current.locations[entry],
                previous.locations[entry],
                GAIN_LOCATION_MAX
              )
            : current.locations[entry]
      } else if (entry >= previous.entries) {
        codebook = releaseCodebook(true, isRelease(current, entry))
        symbol = current.locations[entry] - current.locations[entry - 1]
      } else {
        codebook = releaseCodebook(false, isRelease(current, entry))
        symbol = moduloDelta(
          current.locations[entry],
          previous.locations[entry],
          GAIN_LOCATION_MAX
        )
      }
      packLocationSymbol(codebook, symbol, sink)
    }
  }
}

/**
 * Emit secondary-channel locations as deltas from matching primary points where available.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @param {BitWriter|BitCounter} sink
 */
function packSecondaryBaseDeltaLocations(channel, base, sink) {
  for (let record = 0; record < channel.syntax.transmittedCount; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    for (let entry = 0; entry < current.entries; entry++) {
      if (entry === 0) {
        packLocationSymbol(
          LOCATION_CODEBOOK.C_ATTACK,
          primary.entries > 0
            ? moduloDelta(
                current.locations[entry],
                primary.locations[entry],
                GAIN_LOCATION_MAX
              )
            : current.locations[entry],
          sink
        )
      } else if (isRelease(current, entry) && entry < primary.entries) {
        const changed = current.locations[entry] !== primary.locations[entry]
        sink.write(changed ? 1 : 0, 1)
        if (changed) {
          sink.write(
            ascendingLocationSymbol(
              current.locations[entry - 1],
              current.locations[entry]
            ),
            ascendingLocationBits(current.locations[entry - 1])
          )
        }
      } else if (entry < primary.entries) {
        packLocationSymbol(
          LOCATION_CODEBOOK.C_ATTACK,
          moduloDelta(
            current.locations[entry],
            primary.locations[entry],
            GAIN_LOCATION_MAX
          ),
          sink
        )
      } else {
        packLocationSymbol(
          releaseCodebook(true, isRelease(current, entry)),
          current.locations[entry] - current.locations[entry - 1],
          sink
        )
      }
    }
  }
}

/**
 * Emit each secondary record as either a primary copy or a complete A-family recode.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel} base
 * @param {BitWriter|BitCounter} sink
 */
function packSecondaryRecodeLocations(channel, base, sink) {
  for (let record = 0; record < channel.syntax.transmittedCount; record++) {
    const current = channel.records[record]
    const primary = base.records[record]
    if (current.entries === 0) continue
    const flag = channel.syntax.locationFlags[record] & 1
    if (current.entries <= primary.entries) {
      sink.write(flag, 1)
      if (flag === 0) continue
    }
    packAIncrementRecordLocations(current, sink)
  }
}

/**
 * Dispatch location emission to the direct, A-family, previous-record, or stereo predictor selected by the plan.
 *
 * @param {GainCodingChannel} channel
 * @param {GainCodingChannel|null} base
 * @param {BitWriter|BitCounter} sink
 */
function packLocations(channel, base, sink) {
  const syntax = channel.syntax
  const count = syntax.transmittedCount
  const role = channelRole(channel.channelOrdinal)
  const mode = syntax.locationMode & 3
  if (mode === 0) {
    for (let record = 0; record < count; record++) {
      packAscendingRecordLocations(channel.records[record], 0, sink)
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 1) {
    for (let record = 0; record < count; record++) {
      packAIncrementRecordLocations(channel.records[record], sink)
    }
  } else if (role === GAIN_ROLE.PRIMARY && mode === 2) {
    packPrimaryPreviousLocations(channel, sink)
  } else if (role === GAIN_ROLE.PRIMARY && mode === 3) {
    sink.write(syntax.locationWidth - 1, 2)
    sink.write(syntax.locationBase, 5)
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      for (let entry = 0; entry < current.entries; entry++) {
        sink.write(
          current.locations[entry] - syntax.locationBase - entry,
          syntax.locationWidth
        )
      }
    }
  } else if (role === GAIN_ROLE.SECONDARY && mode === 1) {
    packSecondaryBaseDeltaLocations(channel, base, sink)
  } else if (role === GAIN_ROLE.SECONDARY && mode === 2) {
    packSecondaryRecodeLocations(channel, base, sink)
  } else if (role === GAIN_ROLE.SECONDARY && mode === 3) {
    for (let record = 0; record < count; record++) {
      const current = channel.records[record]
      const primary = base.records[record]
      packAscendingRecordLocations(
        current,
        Math.min(current.entries, primary.entries),
        sink
      )
    }
  }
}

/**
 * Emit one immutable selected gain channel in header/plane wire order.
 *
 * @param {GainCodingPlan} plan Selected coding-unit plan.
 * @param {number} channelIndex Coding-unit channel ordinal.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
function packGainChannel(plan, channelIndex, sink) {
  if (
    !(plan instanceof GainCodingPlan) ||
    !Number.isInteger(channelIndex) ||
    channelIndex < 0 ||
    channelIndex >= plan.channelCount ||
    typeof sink?.write !== 'function'
  ) {
    throw new RangeError('ATRAC3plus gain pack request is invalid')
  }
  const channel = plan.channels[channelIndex]
  const base = plan.channels[0]
  const syntax = channel.syntax
  sink.write(syntax.hasData, 1)
  if (syntax.hasData === 0) return
  sink.write(syntax.transmittedCount - 1, 4)
  sink.write(syntax.hasDelta, 1)
  if (syntax.hasDelta !== 0) sink.write(syntax.effectiveCount - 1, 4)
  sink.write(syntax.pointCountMode, 2)
  packPointCounts(channel, base, sink)
  sink.write(syntax.levelMode, 2)
  packLevels(channel, base, sink)
  sink.write(syntax.locationMode, 2)
  packLocations(channel, base, sink)
}

/**
 * Emit every selected gain channel for one coding unit.
 *
 * @param {GainCodingPlan} plan Selected coding-unit plan.
 * @param {BitWriter|BitCounter} sink Bit sink exposing `write(value, bits)`.
 * @returns {void}
 */
export function packGainSection(plan, sink) {
  if (!(plan instanceof GainCodingPlan)) {
    throw new TypeError('ATRAC3plus gain section requires a selected plan')
  }
  for (let channel = 0; channel < plan.channelCount; channel++) {
    packGainChannel(plan, channel, sink)
  }
}
