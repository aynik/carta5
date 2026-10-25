#!/usr/bin/env node

/**
 * Carta5 Audio Codec - Command Line Interface
 *
 * Usage:
 *   carta5 --encode input.wav output.atracx.wav
 *   carta5 --decode input.atracx.wav output.wav
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DELAY_SAMPLES,
  FRAME_SAMPLES,
  WAVE_FORMAT_CHUNK_BYTES,
  WAVE_FORMAT_TAG,
} from '../codec/core/constants.js'
import { resolveProfile, resolveWaveProfile } from '../codec/core/profiles.js'
import { ATRACX_GUID_BYTES } from '../codec/core/tables.js'
import {
  createWaveStreamingDecoder,
  createWaveStreamingEncoder,
} from '../codec/boundary/stream.js'
import { createWaveHeader } from '../codec/boundary/container.js'
import {
  PCM_SCALE,
  createPcmWaveHeader,
  interleavePcm16,
} from '../codec/boundary/pcm.js'

/**
 * @typedef {object} CliOptions
 * @property {string} bitrate Encoding bitrate in kilobits per second.
 * @property {boolean} [encode] Encode the input WAVE file.
 * @property {boolean} [decode] Decode the input ATRACX file.
 * @property {boolean} [quiet] Suppress informational output and progress.
 * @property {boolean} [force] Allow overwriting the destination.
 */

/**
 * Format a duration in seconds as MM:SS.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/**
 * Display frame progress and real-time processing speed.
 */
export class ProgressTracker {
  /**
   * Create a progress tracker.
   *
   * @param {number} frameCount - Total number of frames to process
   * @param {string} operation - Operation name ('Encoding' or 'Decoding')
   * @param {boolean} [quiet=false] - Suppress progress display
   * @param {number} [frameSamples=FRAME_SAMPLES] - Samples coded per frame
   * @param {number} [sampleRate=44100] - Source sample rate in hertz
   */
  constructor(
    frameCount,
    operation,
    quiet = false,
    frameSamples = FRAME_SAMPLES,
    sampleRate = 44100
  ) {
    this.totalFrames = frameCount
    this.operation = operation
    this.frameSamples = frameSamples
    this.sampleRate = sampleRate
    this.enabled = !quiet && process.stderr.isTTY
    this.startTime = performance.now()
    this.lastRender = -Infinity
    this.frameCount = 0
    this.render()
  }

  /**
   * Update progress with a new processed frame.
   *
   * @param {number} frameCount - Number of source or container frames processed
   */
  update(frameCount) {
    this.frameCount = Math.min(frameCount, this.totalFrames)
    this.render()
  }

  /**
   * Render a throttled progress update on an interactive terminal.
   *
   * @param {boolean} [force=false] - Render even inside the throttle interval
   */
  render(force = false) {
    if (!this.enabled) return
    const now = performance.now()
    if (!force && now - this.lastRender < 100) return
    this.lastRender = now
    const elapsed = (now - this.startTime) / 1000
    const fraction =
      this.totalFrames > 0 ? Math.min(1, this.frameCount / this.totalFrames) : 1
    const filled = Math.floor(fraction * 24)
    const remaining = fraction > 0 ? elapsed * (1 / fraction - 1) : 0
    const speed =
      elapsed > 0
        ? (this.frameCount * this.frameSamples) / this.sampleRate / elapsed
        : 0
    process.stderr.write(
      `\r\x1b[2K${this.operation} |${'█'.repeat(filled)}${'░'.repeat(24 - filled)}| ${Math.floor(fraction * 100)}% | ${this.frameCount}/${this.totalFrames} frames | ${formatTime(elapsed)}/${formatTime(remaining)} | RT: ${speed.toFixed(1)}x`
    )
  }

  /**
   * Stop the display, completing its frame count only after successful output.
   * @param {boolean} [completed=false] Whether the operation finished.
   */
  stop(completed = false) {
    if (completed) this.frameCount = this.totalFrames
    this.render(true)
    if (this.enabled) process.stderr.write('\n')
  }
}

/**
 * Error caused by an invalid combination of command-line arguments.
 */
export class CliUsageError extends Error {}

/**
 * Read exactly one fixed-size region from an open file.
 *
 * @param {object} handle
 * @param {number} length
 * @param {number} position
 * @returns {Promise<Buffer>}
 */
async function readExactly(handle, length, position) {
  const output = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      length - offset,
      position + offset
    )
    if (bytesRead === 0) throw new RangeError('Truncated WAVE file')
    offset += bytesRead
  }
  return output
}

/**
 * Traverse bounded RIFF chunks without retaining their payloads.
 *
 * @param {object} handle
 * @param {number} size
 * @param {string} label
 * @param {boolean} [zeroDataToEnd]
 * @returns {AsyncGenerator<object>}
 */
async function* readWaveChunks(handle, size, label, zeroDataToEnd = false) {
  const header = await readExactly(handle, 12, 0)
  if (
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new RangeError(`Invalid ${label} RIFF/WAVE signature`)
  }
  /** @type {f64} Absolute RIFF file position. */
  let offset = 12
  for (; offset + 8 <= size; ) {
    const chunkHeader = await readExactly(handle, 8, offset)
    const id = chunkHeader.toString('ascii', 0, 4)
    const declaredBytes = chunkHeader.readUInt32LE(4)
    const payload = offset + 8
    const chunkBytes =
      zeroDataToEnd && id === 'data' && declaredBytes === 0
        ? size - payload
        : declaredBytes
    if (payload + chunkBytes > size) {
      throw new RangeError(`Truncated ${label} WAVE ${id} chunk`)
    }
    yield { chunkBytes, id, payload }
    offset = payload + chunkBytes + (chunkBytes & 1)
  }
}

/**
 * Parse ATRACX profile and data geometry without retaining encoded frames.
 *
 * @param {string} filePath
 * @returns {Promise<object>} Parsed streaming input.
 */
export async function readAtracWaveMetadata(filePath) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let format = null
    let fact = null
    /** @type {f64} Absolute data chunk position. */
    let dataOffset = -1
    /** @type {f64} Encoded data length. */
    let dataBytes = 0
    for await (const { chunkBytes, id, payload } of readWaveChunks(
      handle,
      size,
      'ATRACX'
    )) {
      if (id === 'fmt ') {
        if (chunkBytes < WAVE_FORMAT_CHUNK_BYTES) {
          throw new RangeError('Unsupported ATRACX WAVE format chunk')
        }
        const bytes = await readExactly(
          handle,
          WAVE_FORMAT_CHUNK_BYTES,
          payload
        )
        let guidMatches = true
        for (let index = 0; index < ATRACX_GUID_BYTES.length; index++) {
          if (bytes[24 + index] !== ATRACX_GUID_BYTES[index]) {
            guidMatches = false
            break
          }
        }
        if (bytes.readUInt16LE(0) !== WAVE_FORMAT_TAG || !guidMatches) {
          throw new RangeError('Unsupported ATRACX WAVE format chunk')
        }
        format = {
          channels: bytes.readUInt16LE(2),
          sampleRate: bytes.readUInt32LE(4),
          blockAlign: bytes.readUInt16LE(12),
          samplesPerBlock: bytes.readUInt16LE(18),
        }
      } else if (id === 'fact' && chunkBytes >= 4) {
        const bytes = await readExactly(
          handle,
          Math.min(chunkBytes, 12),
          payload
        )
        fact = {
          sampleCount: bytes.readUInt32LE(0),
          alignmentSampleCount:
            chunkBytes >= 12
              ? bytes.readUInt32LE(8)
              : chunkBytes >= 8
                ? bytes.readUInt32LE(4) + DELAY_SAMPLES
                : null,
        }
      } else if (id === 'data') {
        if (dataOffset !== -1) {
          throw new RangeError('Duplicate ATRACX WAVE data chunk')
        }
        dataOffset = payload
        dataBytes = chunkBytes
      }
    }

    const profile = format ? resolveWaveProfile(format) : null
    if (
      !profile ||
      !fact ||
      dataOffset < 0 ||
      dataBytes % profile.bytesPerFrame !== 0
    ) {
      throw new RangeError('Incomplete or invalid ATRACX WAVE file')
    }
    return {
      dataBytes,
      dataOffset,
      fact,
      frameCount: dataBytes / profile.bytesPerFrame,
      profile,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Parse the PCM format and data geometry needed for streaming input.
 *
 * @param {string} filePath
 * @returns {Promise<object>} Parsed PCM WAVE metadata.
 */
export async function readPcmWaveMetadata(filePath) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let format = null
    /** @type {f64} Absolute data chunk position. */
    let dataOffset = -1
    /** @type {f64} PCM data length. */
    let dataBytes = -1
    for await (const { chunkBytes, id, payload } of readWaveChunks(
      handle,
      size,
      'PCM',
      true
    )) {
      if (id === 'fmt ') {
        if (chunkBytes < 16) {
          throw new RangeError('Invalid PCM WAVE format chunk')
        }
        const bytes = await readExactly(
          handle,
          Math.min(chunkBytes, 40),
          payload
        )
        const audioFormat = bytes.readUInt16LE(0)
        const extensiblePcm =
          audioFormat === 0xfffe &&
          chunkBytes >= 40 &&
          bytes.readUInt32LE(24) === 1
        if (audioFormat !== 1 && !extensiblePcm) {
          throw new RangeError('Input must use signed integer PCM')
        }
        format = {
          channels: bytes.readUInt16LE(2),
          sampleRate: bytes.readUInt32LE(4),
          blockAlign: bytes.readUInt16LE(12),
          bitDepth: bytes.readUInt16LE(14),
        }
      } else if (id === 'data') {
        dataOffset = payload
        dataBytes = chunkBytes
      }

      if (format && dataOffset !== -1) break
    }

    if (!format || dataOffset === -1) {
      throw new RangeError('Incomplete PCM WAVE file')
    }
    if (
      format.bitDepth !== 16 ||
      ![1, 2, 6, 8].includes(format.channels) ||
      format.sampleRate <= 0 ||
      format.blockAlign !== format.channels * 2 ||
      dataBytes % format.blockAlign !== 0
    ) {
      throw new RangeError(
        'Input must be signed 16-bit PCM with 1, 2, 6, or 8 channels'
      )
    }
    const sampleCount = dataBytes / format.blockAlign
    return {
      dataBytes,
      dataOffset,
      duration: sampleCount / format.sampleRate,
      format,
      sampleCount,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Yield one WAVE data chunk without retaining its complete payload.
 *
 * @param {string} filePath
 * @param {object} metadata
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* readDataChunks(filePath, metadata) {
  if (metadata.dataBytes === 0) return
  const stream = fs.createReadStream(filePath, {
    start: metadata.dataOffset,
    end: metadata.dataOffset + metadata.dataBytes - 1,
  })
  for await (const chunk of stream) yield chunk
}

/**
 * Split an ATRACX data chunk into complete encoded frame views.
 *
 * @param {string} filePath
 * @param {object} metadata
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* readAtracFrames(filePath, metadata) {
  const frameBytes = metadata.profile.bytesPerFrame
  let carry = null
  let carryBytes = 0

  for await (const chunk of readDataChunks(filePath, metadata)) {
    let offset = 0
    if (carryBytes !== 0) {
      const count = Math.min(frameBytes - carryBytes, chunk.length)
      carry.set(chunk.subarray(0, count), carryBytes)
      carryBytes += count
      offset = count
      if (carryBytes === frameBytes) {
        yield carry
        carry = null
        carryBytes = 0
      }
    }
    while (chunk.length - offset >= frameBytes) {
      yield chunk.subarray(offset, offset + frameBytes)
      offset += frameBytes
    }
    if (offset < chunk.length) {
      carry = new Uint8Array(frameBytes)
      carry.set(chunk.subarray(offset))
      carryBytes = chunk.length - offset
    }
  }

  if (carryBytes !== 0) throw new RangeError('Truncated ATRACX WAVE frame')
}

/**
 * Convert interleaved signed PCM chunks to normalized planar PCM.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {i32} channelCount
 * @returns {AsyncGenerator<Float32Array[]>}
 * @nativeUnchecked Only complete interleaved samples are read from each chunk.
 */
async function* readPlanarPcm(chunks, channelCount) {
  let carry = Buffer.alloc(0)
  const blockBytes = channelCount * 2
  for await (const source of chunks) {
    /** @type {Uint8Array} */
    const chunk = carry.length === 0 ? source : Buffer.concat([carry, source])
    const completeBytes = chunk.length - (chunk.length % blockBytes)
    carry = chunk.subarray(completeBytes)
    const sampleCount = completeBytes / blockBytes
    const channels = Array.from(
      { length: channelCount },
      () => new Float32Array(sampleCount)
    )
    for (let channel = 0; channel < channelCount; channel++) {
      const destination = channels[channel]
      let offset = channel * 2
      for (let sample = 0; sample < sampleCount; sample++) {
        const value = ((chunk[offset] | (chunk[offset + 1] << 8)) << 16) >> 16
        destination[sample] = value / PCM_SCALE
        offset += blockBytes
      }
    }
    if (sampleCount !== 0) yield channels
  }
  if (carry.length !== 0) throw new RangeError('Truncated PCM sample')
}

/**
 * Write a complete byte block, handling partial filesystem writes.
 *
 * @param {import('node:fs/promises').FileHandle} handle - Open output file
 * @param {Uint8Array} bytes - Bytes to write
 * @param {number|null} [position=null] - Absolute offset or the current position
 * @returns {Promise<void>}
 */
async function writeBytes(handle, bytes, position = null) {
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      position === null ? null : position + offset
    )
    if (result.bytesWritten === 0) throw new Error('Could not write output')
    offset += result.bytesWritten
  }
}

/** Buffer frame writes without retaining the encoded or decoded stream. */
class BufferedWriter {
  /** @param {import('node:fs/promises').FileHandle} handle - Open output file */
  constructor(handle) {
    this.handle = handle
    this.buffer = Buffer.alloc(65536)
    this.used = 0
  }

  /**
   * @param {Uint8Array} bytes - Next frame's bytes
   * @returns {Promise<void>}
   */
  async write(bytes) {
    if (this.used + bytes.length > this.buffer.length) await this.flush()
    if (bytes.length >= this.buffer.length) {
      await writeBytes(this.handle, bytes)
      return
    }
    this.buffer.set(bytes, this.used)
    this.used += bytes.length
  }

  /** @returns {Promise<void>} Resolves when all pending bytes are written. */
  async flush() {
    if (this.used === 0) return
    await writeBytes(this.handle, this.buffer.subarray(0, this.used))
    this.used = 0
  }
}

/**
 * Encode signed 16-bit PCM WAVE to ATRACX WAVE_FORMAT_EXTENSIBLE.
 *
 * @param {string} inputFile Source PCM WAVE path.
 * @param {string} outputFile Destination ATRACX WAVE path.
 * @param {CliOptions} options Parsed command-line switches.
 */
async function encodeFile(inputFile, outputFile, options) {
  const bitrateKbps = Number(options.bitrate)
  const metadata = await readPcmWaveMetadata(inputFile)
  const profileOptions = {
    bitrateKbps,
    channels: metadata.format.channels,
    sampleRate: metadata.format.sampleRate,
  }
  const profile = resolveProfile(profileOptions)
  if (!profile) {
    throw new RangeError(
      'Unsupported ATRAC3plus bitrate, channel count, or sample rate'
    )
  }
  const totalFrames = Math.ceil(metadata.sampleCount / FRAME_SAMPLES)

  if (!options.quiet) {
    console.log(
      `${inputFile} (WAV ${metadata.format.sampleRate}Hz ${metadata.format.channels}ch ${formatTime(metadata.duration)}) → ` +
        `${outputFile} (ATRAC3plus ${bitrateKbps}kbps ${profile.channels}ch)`
    )
  }

  const progress = new ProgressTracker(
    totalFrames,
    'Encoding',
    options.quiet,
    profile.frameSamples,
    profile.sampleRate
  )
  let completed = false
  try {
    const encoder = createWaveStreamingEncoder(profileOptions)
    const output = await fs.promises.open(
      outputFile,
      options.force ? 'w' : 'wx'
    )
    const writer = new BufferedWriter(output)
    try {
      await writeBytes(output, createWaveHeader(profile, 0))
      /** @type {f64} Total encoded frames, including codec delay. */
      let frameCount = 0
      /** @type {f64} Total input samples consumed. */
      let processedSamples = 0
      const chunks = readDataChunks(inputFile, metadata)
      for await (const channels of readPlanarPcm(
        chunks,
        metadata.format.channels
      )) {
        for (const frame of encoder.frames(channels)) {
          await writer.write(frame)
          frameCount++
        }
        processedSamples += channels[0].length
        progress.update(Math.ceil(processedSamples / FRAME_SAMPLES))
      }
      for (const frame of encoder.finish()) {
        await writer.write(frame)
        frameCount++
      }
      await writer.flush()

      const waveHeader = createWaveHeader(
        profile,
        frameCount * profile.bytesPerFrame,
        undefined,
        encoder.sampleCount
      )
      await writeBytes(output, waveHeader, 0)
    } finally {
      await output.close()
    }
    completed = true
  } finally {
    progress.stop(completed)
  }
}

/**
 * Decode ATRACX WAVE_FORMAT_EXTENSIBLE to signed 16-bit PCM WAVE.
 *
 * @param {string} inputFile Source ATRACX WAVE path.
 * @param {string} outputFile Destination PCM WAVE path.
 * @param {CliOptions} options Parsed command-line switches.
 */
async function decodeFile(inputFile, outputFile, options) {
  const metadata = await readAtracWaveMetadata(inputFile)
  const sampleCount = metadata.fact.sampleCount
  const duration = sampleCount / metadata.profile.sampleRate
  if (!options.quiet) {
    console.log(
      `${inputFile} (ATRAC3plus ${metadata.profile.bitrateKbps}kbps ${metadata.profile.channels}ch ${formatTime(duration)}) → ` +
        `${outputFile} (WAV ${metadata.profile.sampleRate}Hz ${metadata.profile.channels}ch)`
    )
  }

  const progress = new ProgressTracker(
    metadata.frameCount,
    'Decoding',
    options.quiet,
    metadata.profile.frameSamples,
    metadata.profile.sampleRate
  )
  let completed = false
  try {
    const decoder = createWaveStreamingDecoder({
      bitrateKbps: metadata.profile.bitrateKbps,
      channels: metadata.profile.channels,
      sampleRate: metadata.profile.sampleRate,
      alignmentSampleCount: metadata.fact.alignmentSampleCount,
      sampleCount,
    })
    const output = await fs.promises.open(
      outputFile,
      options.force ? 'w' : 'wx'
    )
    const writer = new BufferedWriter(output)
    try {
      await writeBytes(
        output,
        createPcmWaveHeader({
          sampleCount,
          sampleRate: metadata.profile.sampleRate,
          channels: metadata.profile.channels,
        })
      )
      /** @type {f64} Total encoded frames consumed. */
      let frameCount = 0
      for await (const frame of readAtracFrames(inputFile, metadata)) {
        const pcm = decoder.write(frame)
        if (pcm[0].length !== 0) {
          await writer.write(interleavePcm16(pcm))
        }
        progress.update(++frameCount)
      }
      decoder.finish()
      await writer.flush()
    } finally {
      await output.close()
    }
    completed = true
  } finally {
    progress.stop(completed)
  }
}

/** Command-line options shared by parsing and help output. */
const CLI_OPTIONS = [
  { short: 'V', name: 'version', description: 'output the version number' },
  { short: 'e', name: 'encode', description: 'Encode PCM WAVE to ATRACX WAVE' },
  { short: 'd', name: 'decode', description: 'Decode ATRACX WAVE to PCM WAVE' },
  {
    short: 'q',
    name: 'quiet',
    description: 'Suppress all output except errors',
  },
  {
    short: 'f',
    name: 'force',
    description: 'Overwrite output file if it exists',
  },
  {
    short: 'b',
    name: 'bitrate',
    value: 'kbps',
    description: 'ATRAC3plus encoding bitrate in kbps (default: 128)',
  },
  { short: 'h', name: 'help', description: 'display help for command' },
]

/** Print usage and the supported options. */
function printHelp() {
  console.log(`Usage: carta5 [options] <input> <output>

ATRAC3plus Audio Codec

Arguments:
  input                Input file path
  output               Output file path

Options:`)
  for (const option of CLI_OPTIONS) {
    const value = option.value ? ` <${option.value}>` : ''
    const flags = `-${option.short}, --${option.name}${value}`
    console.log(`  ${flags.padEnd(21)}${option.description}`)
  }
}

/**
 * Report invalid command-line syntax without an internal stack trace.
 *
 * @param {string} message - Argument error to display.
 * @returns {never}
 */
function argumentError(message) {
  throw new CliUsageError(message)
}

/**
 * Parse long options, combined short flags, option values, and positional paths.
 * A double dash ends option parsing so paths may start with a dash.
 *
 * @param {string[]} args - Arguments after the executable and script names.
 * @returns {{options: CliOptions, paths: string[], bitrateSpecified: boolean}} Parsed arguments.
 */
export function parseArguments(args) {
  const { version } = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  )
  const options = { bitrate: '128' }
  let bitrateSpecified = false
  const paths = []
  let positional = false
  let unknownOption = null

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (positional || argument === '-' || !argument.startsWith('-')) {
      paths.push(argument)
      continue
    }
    if (argument === '--') {
      positional = true
      continue
    }

    const long = argument.startsWith('--')
    const equals = long ? argument.indexOf('=') : -1
    let offset = 1
    do {
      const name = long
        ? argument.slice(2, equals === -1 ? argument.length : equals)
        : argument[offset++]
      const option = CLI_OPTIONS.find((candidate) =>
        long ? candidate.name === name : candidate.short === name
      )
      const flag = long ? `--${name}` : `-${name}`
      if (
        !option ||
        (!option.value && equals !== -1) ||
        (option.name === 'help' && !long && offset < argument.length)
      ) {
        unknownOption ||= argument
        break
      }

      let value = true
      if (option.value) {
        if (equals !== -1) {
          value = argument.slice(equals + 1)
        } else if (!long && offset < argument.length) {
          value = argument.slice(offset)
        } else {
          value = args[++index]
          if (value === undefined) {
            argumentError(`option '${flag}' argument missing`)
          }
        }
        offset = argument.length
      }

      if (option.name === 'help') {
        printHelp()
        process.exit(0)
      }
      if (option.name === 'version') {
        console.log(version)
        process.exit(0)
      }
      options[option.name] = value
      if (option.name === 'bitrate') bitrateSpecified = true
    } while (!long && offset < argument.length)
  }

  if (unknownOption) argumentError(`unknown option '${unknownOption}'`)
  if (paths.length < 2) {
    argumentError(
      `missing required argument '${paths.length ? 'output' : 'input'}'`
    )
  }
  return { options, paths, bitrateSpecified }
}

/**
 * Parse arguments, validate shared CLI policy, and run one operation.
 *
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv) {
  const { options, paths, bitrateSpecified } = parseArguments(argv.slice(2))
  const [inputFile, outputFile] = paths
  const operationCount = [options.encode, options.decode].filter(Boolean).length
  if (operationCount === 0) {
    throw new CliUsageError('Must specify one of --encode or --decode')
  }
  if (operationCount > 1) {
    throw new CliUsageError('Cannot specify multiple operation modes')
  }
  if (options.decode && bitrateSpecified) {
    throw new CliUsageError('--bitrate only applies when encoding')
  }
  if (path.resolve(inputFile) === path.resolve(outputFile)) {
    throw new CliUsageError('Input and output paths must be different')
  }
  if (fs.existsSync(outputFile) && !options.force) {
    throw new CliUsageError(
      `Output file '${outputFile}' already exists. Use --force to overwrite.`
    )
  }

  if (options.encode) await encodeFile(inputFile, outputFile, options)
  else await decodeFile(inputFile, outputFile, options)
}

/** Execute the CLI and translate failures to a conventional exit status. */
export async function run() {
  try {
    await main()
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stderr.write(`Error: File not found - ${error.path}\n`)
    } else {
      process.stderr.write(`Error: ${error.message}\n`)
      if (
        !(error instanceof CliUsageError) &&
        !process.argv.includes('--quiet') &&
        !process.argv.includes('-q')
      ) {
        process.stderr.write(String(error.stack) + '\n')
      }
    }
    process.exitCode = 1
  }
}

if (
  import.meta.main ??
  (process.argv[1] &&
    pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url)
) {
  await run()
}
