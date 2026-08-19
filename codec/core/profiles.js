/** Canonical ATRAC3plus stream profile resolution. */

import {
  CHANNEL_MASK,
  FRAME_SAMPLES,
  SAMPLE_RATE_INDEX,
  STREAM_CHANNEL_MODE,
  CORE_MODE_MIN_INCLUSIVE_THRESHOLD,
  LFE_BUDGET_BITS,
} from './constants.js'
import {
  framePayloadCapacityBits,
  quantizationUnitCountForCoefficientLimit,
} from './geometry.js'
import {
  CHANNEL_MODE_4_BANDWIDTH_SCALE,
  PROFILE_ROWS,
  CHANNELS_BY_STREAM_MODE,
  CODING_UNIT_BUDGET_DIVISORS,
  CODING_UNIT_LAYOUTS,
  CORE_MODE_EXCLUSIVE_THRESHOLDS,
} from './tables.js'

/**
 * Quantize the reference coding-unit byte/rate product to a core mode.
 *
 * @param {number} scaled Reference sample-rate/byte product.
 * @returns {number} Selected ATRAC3plus core mode.
 */
export function coreModeFromScaled(scaled) {
  for (const [threshold, mode] of CORE_MODE_EXCLUSIVE_THRESHOLDS) {
    if (scaled > threshold) return mode
  }
  return scaled >= CORE_MODE_MIN_INCLUSIVE_THRESHOLD ? 1 : 0
}

/**
 * Return the channel count selected by an ATRAC3plus coding-unit mode.
 *
 * @param {number} channelMode Coding-unit channel mode.
 * @returns {number} One, two, or zero when the mode is unsupported.
 */
export function channelsForCodingUnitMode(channelMode) {
  if (channelMode === 1 || channelMode === 4) return 1
  if (channelMode === 2 || channelMode === 3) return 2
  return 0
}

/**
 * Apply encoder tone-analysis policy after core-mode selection.
 *
 * @param {number} channelMode Coding-unit channel mode.
 * @param {number} coreMode Selected core mode.
 * @returns {number} One when tone analysis is enabled, otherwise zero.
 */
export function toneAnalysisEnabled(channelMode, coreMode) {
  return channelsForCodingUnitMode(channelMode) === 2 && coreMode > 0x16 ? 1 : 0
}

/**
 * Fill fixed stream-topology storage with derived coding-unit policy.
 *
 * @param {CodecProfile} profile Immutable maintained profile.
 * @param {CodingUnitProfiles} destination Preallocated coding-unit profile owner.
 * @returns {CodingUnitProfiles|null} `destination`, or `null` for invalid geometry.
 */
export function configureCodingUnitProfiles(profile, destination) {
  const layout = CODING_UNIT_LAYOUTS[profile?.streamChannelMode]
  const divisor = CODING_UNIT_BUDGET_DIVISORS[profile?.streamChannelMode]
  if (!layout || !divisor || !destination?.channelModes) return null
  destination.clear()
  const hasLfe = layout.some(([kind]) => kind === 'lfe')
  const fixedTailBits = hasLfe ? LFE_BUDGET_BITS : 0
  const payloadBits = framePayloadCapacityBits(
    profile.bytesPerFrame,
    layout.length
  )
  const weightedBudget = payloadBits - fixedTailBits
  const budgetUnit = Math.trunc(weightedBudget / divisor)

  for (let unit = 0; unit < layout.length; unit++) {
    const [kind, weight] = layout[unit]
    const channelMode =
      kind === 'profile'
        ? profile.primaryCodingUnitChannelMode
        : kind === 'lfe'
          ? 4
          : 1
    const budgetBits = kind === 'lfe' ? fixedTailBits : budgetUnit * weight
    let bandwidth = profile.bandwidthHz
    if (channelMode === 4) {
      bandwidth = Math.trunc(
        profile.sampleRate * CHANNEL_MODE_4_BANDWIDTH_SCALE
      )
    }
    const coefficientLimit = Math.trunc((bandwidth * 4096) / profile.sampleRate)
    const quantizationUnitCount =
      quantizationUnitCountForCoefficientLimit(coefficientLimit)
    const bytesForUnit = (budgetBits + 7) >> 3
    const scaled = (profile.sampleRate * bytesForUnit) >> 8
    let coreMode = coreModeFromScaled(scaled)
    if (profile.streamChannelMode === 5) {
      if (
        (profile.sampleRate === 44100 && profile.bytesPerFrame === 1488) ||
        (profile.sampleRate === 48000 && profile.bytesPerFrame === 1368)
      ) {
        if (unit === 0 || unit === 2) coreMode = (coreMode - 1) >>> 0
        else if (unit === 1) coreMode = (coreMode + 2) >>> 0
      }
    } else if (
      profile.streamChannelMode === 7 &&
      unit === 1 &&
      ((profile.sampleRate === 44100 && profile.bytesPerFrame === 2232) ||
        (profile.sampleRate === 48000 && profile.bytesPerFrame === 2048))
    ) {
      coreMode = (coreMode + 2) >>> 0
    }
    destination.channelModes[unit] = channelMode
    destination.quantizationUnitCounts[unit] = quantizationUnitCount
    destination.coreModes[unit] = coreMode
    destination.toneAnalysisEnabled[unit] = toneAnalysisEnabled(
      channelMode,
      coreMode
    )
    destination.budgetBits[unit] = budgetBits
  }
  destination.length = layout.length
  return destination
}

/**
 * Build the packed ATRAC3plus codec configuration stored by the profile.
 *
 * @param {CodecConfigurationGeometry} geometry Stream mode, sample rate, and frame size to pack.
 * @returns {number|null} Packed configuration, or `null` when invalid.
 */
export function packCodecConfiguration({
  streamChannelMode,
  sampleRate,
  bytesPerFrame,
}) {
  const sampleRateIndex = SAMPLE_RATE_INDEX[sampleRate]
  if (
    sampleRateIndex === undefined ||
    !Object.values(STREAM_CHANNEL_MODE).includes(streamChannelMode) ||
    !Number.isInteger(bytesPerFrame) ||
    bytesPerFrame < 8 ||
    (bytesPerFrame - 8) % 8 !== 0 ||
    bytesPerFrame > 8192
  ) {
    return null
  }
  return (
    (1 << 24) |
    (sampleRateIndex << 13) |
    (streamChannelMode << 10) |
    ((bytesPerFrame - 8) >> 3)
  )
}

/**
 * Return the two big-endian codec-info bytes stored by the ATRACX extension.
 *
 * @param {number} codecConfiguration Packed codec configuration.
 * @returns {Uint8Array|null} Two codec-info bytes, or `null`.
 */
export function codecInfoBytes(codecConfiguration) {
  if (!Number.isInteger(codecConfiguration)) return null
  return new Uint8Array([
    (codecConfiguration >>> 8) & 0xff,
    codecConfiguration & 0xff,
  ])
}

/**
 * Return the maintained channel count represented by a stream mode.
 *
 * @param {number} streamChannelMode Packed stream topology selector.
 * @returns {number|null} Maintained channel count, or `null`.
 */
export function channelsForStreamMode(streamChannelMode) {
  return CHANNELS_BY_STREAM_MODE[streamChannelMode] ?? null
}

/**
 * Return the WAVE speaker mask for a maintained channel count.
 *
 * @param {number} channels Maintained channel count.
 * @returns {number} Canonical speaker mask, or zero when unsupported.
 */
export function channelMask(channels) {
  return CHANNEL_MASK[channels] ?? 0
}

/**
 * Freeze derived lookup tables and limits onto one resolved codec profile.
 *
 * @param {CodecProfileRow} row Maintained profile-table entry.
 * @returns {CodecProfile} Immutable profile with all derived fields attached.
 */
function materializeProfile(row) {
  const channels = channelsForStreamMode(row.streamChannelMode)
  const codecConfiguration = packCodecConfiguration({
    streamChannelMode: row.streamChannelMode,
    sampleRate: row.sampleRate,
    bytesPerFrame: row.bytesPerFrame,
  })
  return Object.freeze({
    ...row,
    channels,
    frameSamples: FRAME_SAMPLES,
    channelMask: channelMask(channels),
    codecConfiguration,
    codecInfoBytes: codecInfoBytes(codecConfiguration),
  })
}

/**
 * Resolve one canonical ATRAC3plus encode profile.
 *
 * @param {CodecProfileOptions} [options] Requested bitrate, channel topology, and sample rate.
 * @returns {CodecProfile|null} Immutable profile, or `null` when unsupported.
 */
export function resolveProfile({
  bitrateKbps = 128,
  channels = 2,
  sampleRate = 44100,
} = {}) {
  const streamChannelMode = STREAM_CHANNEL_MODE[channels]
  if (streamChannelMode === undefined) return null
  const row = PROFILE_ROWS.find(
    (candidate) =>
      candidate.bitrateKbps === bitrateKbps &&
      candidate.sampleRate === sampleRate &&
      candidate.streamChannelMode === streamChannelMode
  )
  return row ? materializeProfile(row) : null
}

/**
 * Resolve one canonical profile from validated ATRACX WAVE geometry.
 * Container metadata that does not select a profile is intentionally ignored.
 *
 * @param {WaveProfileGeometry} format Parsed channel count, sample rate, frame size, and samples per frame.
 * @returns {CodecProfile|null} Immutable matching profile, or `null`.
 */
export function resolveWaveProfile({
  channels,
  sampleRate,
  blockAlign,
  samplesPerBlock,
}) {
  if (samplesPerBlock !== FRAME_SAMPLES) return null
  const streamChannelMode = STREAM_CHANNEL_MODE[channels]
  if (streamChannelMode === undefined) return null
  const row = PROFILE_ROWS.find(
    (candidate) =>
      candidate.bytesPerFrame === blockAlign &&
      candidate.sampleRate === sampleRate &&
      candidate.streamChannelMode === streamChannelMode
  )
  return row ? materializeProfile(row) : null
}
