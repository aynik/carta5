#!/usr/bin/env node

/**
 * Carta5 Audio Codec - Command Line Interface
 *
 * Usage:
 *   carta5 --encode input.wav output.atracx.wav
 *   carta5 --decode input.atracx.wav output.wav
 */

import { once } from 'node:events'
import fs from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import cliProgress from 'cli-progress'
import { Command } from 'commander'
import {
  DELAY_SAMPLES,
  FRAME_SAMPLES,
  WAVE_FORMAT_CHUNK_BYTES,
  WAVE_FORMAT_TAG,
} from '../codec/core/constants.js'
import { resolveProfile, resolveWaveProfile } from '../codec/core/profiles.js'
import { ATRACX_GUID_BYTES } from '../codec/core/tables.js'
import { createWaveStreamingDecoder } from '../codec/io/wave-decoder.js'
import { createWaveStreamingEncoder } from '../codec/io/wave-encoder.js'
import { createWaveHeader } from '../codec/io/wave.js'
import {
  createPcmWaveHeader,
  interleavePcm16,
} from '../codec/io/serialization.js'
import { PCM_SCALE } from '../codec/io/pcm.js'

/**
 * Format a duration in seconds as MM:SS.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/**
 * Display frame progress and real-time processing speed.
 */
class ProgressTracker {
  /**
   * Create a tracker for one encode or decode operation.
   *
   * @param {number} frameCount
   * @param {string} operation
   * @param {boolean} [quiet]
   * @param {number} [frameSamples]
   * @param {number} [sampleRate]
   */
  constructor(
    frameCount,
    operation,
    quiet = false,
    frameSamples = FRAME_SAMPLES,
    sampleRate = 44100
  ) {
    this.totalFrames = frameCount
    this.quiet = quiet || frameCount === 0
    this.startTime = performance.now()
    this.frameCount = 0
    this.frameSamples = frameSamples
    this.sampleRate = sampleRate
    if (!this.quiet) {
      this.bar = new cliProgress.SingleBar(
        {
          autopadding: true,
          format: `${operation} |{bar}| {percentage}% | {value}/{total} frames | {elapsed}/{remaining} | RT: {speed}x`,
        },
        cliProgress.Presets.rect
      )
      this.bar.start(frameCount, 0, {
        elapsed: '00:00',
        remaining: '00:00',
        speed: '0.0',
      })
    }
  }

  /**
   * Set the number of source or container frames processed so far.
   *
   * @param {number} frameCount
   */
  update(frameCount) {
    this.frameCount = Math.min(frameCount, this.totalFrames)
    if (this.quiet) return
    const elapsed = (performance.now() - this.startTime) / 1000
    const audioProcessed =
      (this.frameCount * this.frameSamples) / this.sampleRate
    const speed = elapsed > 0 ? audioProcessed / elapsed : 0
    const fraction = this.frameCount / this.totalFrames
    const totalTime = fraction > 0 ? elapsed / fraction : 0
    this.bar.update(this.frameCount, {
      elapsed: formatTime(elapsed),
      remaining: formatTime(Math.max(0, totalTime - elapsed)),
      speed: speed.toFixed(1),
    })
  }

  /**
   * Complete and stop the progress display.
   *
   * @param {boolean} [completed]
   */
  stop(completed = false) {
    if (this.quiet || !this.bar) return
    if (completed) this.update(this.totalFrames)
    this.bar.stop()
  }
}

/**
 * Error caused by an invalid combination of command-line arguments.
 */
class CliUsageError extends Error {}

/**
 * Read exactly one fixed-size region from an open file.
 *
 * @param {import("node:fs/promises").FileHandle} handle
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
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {number} size
 * @param {string} label
 * @param {boolean} [zeroDataToEnd]
 * @returns {AsyncGenerator<{chunkBytes: number, id: string, payload: number}>}
 */
async function* readWaveChunks(handle, size, label, zeroDataToEnd = false) {
  const header = await readExactly(handle, 12, 0)
  if (
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new RangeError(`Invalid ${label} RIFF/WAVE signature`)
  }
  for (let offset = 12; offset + 8 <= size; ) {
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
 * @returns {Promise<{dataBytes: number, dataOffset: number, fact: {sampleCount: number, alignmentSampleCount: number|null}, frameCount: number, profile: CodecProfile}>}
 */
async function readAtracWaveMetadata(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let format = null
    let fact = null
    let dataOffset = -1
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
 * @returns {Promise<{dataBytes: number, dataOffset: number, duration: number, format: {channels: number, sampleRate: number, blockAlign: number, bitDepth: number}, sampleCount: number}>}
 */
async function readPcmWaveMetadata(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let format = null
    let dataOffset = -1
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
 * @param {{dataOffset: number, dataBytes: number}} metadata
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
 * @param {{dataOffset: number, dataBytes: number, profile: CodecProfile}} metadata
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
 * @param {number} channelCount
 * @returns {AsyncGenerator<Float32Array[]>}
 */
async function* readPlanarPcm(chunks, channelCount) {
  let carry = Buffer.alloc(0)
  const blockBytes = channelCount * 2
  for await (const source of chunks) {
    const chunk = carry.length === 0 ? source : Buffer.concat([carry, source])
    const completeBytes = chunk.length - (chunk.length % blockBytes)
    carry = chunk.subarray(completeBytes)
    const sampleCount = completeBytes / blockBytes
    const channels = Array.from(
      { length: channelCount },
      () => new Float32Array(sampleCount)
    )
    for (let sample = 0; sample < sampleCount; sample++) {
      for (let channel = 0; channel < channelCount; channel++) {
        channels[channel][sample] =
          chunk.readInt16LE(sample * blockBytes + channel * 2) / PCM_SCALE
      }
    }
    if (sampleCount !== 0) yield channels
  }
  if (carry.length !== 0) throw new RangeError('Truncated PCM sample')
}

/**
 * Write bytes while respecting stream backpressure.
 *
 * @param {import("node:stream").Writable} stream
 * @param {Uint8Array} bytes
 */
async function writeBytes(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain')
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
    const output = fs.createWriteStream(outputFile)
    await writeBytes(output, createWaveHeader(profile, 0))
    let frameCount = 0
    let processedSamples = 0
    const chunks = readDataChunks(inputFile, metadata)
    for await (const channels of readPlanarPcm(
      chunks,
      metadata.format.channels
    )) {
      for (const frame of encoder.write(channels)) {
        await writeBytes(output, frame)
        frameCount++
      }
      processedSamples += channels[0].length
      progress.update(Math.ceil(processedSamples / FRAME_SAMPLES))
    }
    for (const frame of encoder.finish()) {
      await writeBytes(output, frame)
      frameCount++
    }
    output.end()
    await finished(output)

    const waveHeader = createWaveHeader(
      profile,
      frameCount * profile.bytesPerFrame,
      undefined,
      encoder.sampleCount
    )
    const handle = await open(outputFile, 'r+')
    try {
      await handle.write(waveHeader, 0, waveHeader.length, 0)
    } finally {
      await handle.close()
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
    const output = fs.createWriteStream(outputFile)
    await writeBytes(
      output,
      createPcmWaveHeader({
        sampleCount,
        sampleRate: metadata.profile.sampleRate,
        channels: metadata.profile.channels,
      })
    )
    let frameCount = 0
    for await (const frame of readAtracFrames(inputFile, metadata)) {
      const pcm = decoder.write(frame)
      if (pcm[0].length !== 0) {
        await writeBytes(output, interleavePcm16(pcm))
      }
      frameCount++
      progress.update(frameCount)
    }
    decoder.finish()
    output.end()
    await finished(output)
    completed = true
  } finally {
    progress.stop(completed)
  }
}

/**
 * Build the root-flag CLI shared by direct execution and CLI tests.
 *
 * @returns {Command}
 */
function createProgram() {
  const { version } = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  )
  return new Command()
    .name('carta5')
    .description('ATRAC3plus Audio Codec')
    .version(version)
    .option('-e, --encode', 'Encode PCM WAVE to ATRACX WAVE')
    .option('-d, --decode', 'Decode ATRACX WAVE to PCM WAVE')
    .option('-q, --quiet', 'Suppress all output except errors')
    .option('-f, --force', 'Overwrite the output file if it exists')
    .option(
      '-b, --bitrate <kbps>',
      'ATRAC3plus encoding bitrate in kbps',
      '128'
    )
    .argument('<input>', 'Input file path')
    .argument('<output>', 'Output file path')
}

/**
 * Parse arguments, validate shared CLI policy, and run one operation.
 *
 * @param {string[]} [argv]
 */
async function main(argv = process.argv) {
  const cli = createProgram()
  cli.parse(argv)
  const options = cli.opts()
  const [inputFile, outputFile] = cli.args
  const operationCount = [options.encode, options.decode].filter(Boolean).length
  if (operationCount === 0) {
    throw new CliUsageError('Must specify one of --encode or --decode')
  }
  if (operationCount > 1) {
    throw new CliUsageError('Cannot specify multiple operation modes')
  }
  if (options.decode && cli.getOptionValueSource('bitrate') === 'cli') {
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

/**
 * Execute the CLI and translate failures to a conventional exit status.
 */
async function run() {
  try {
    await main()
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: File not found - ${error.path}`)
    } else {
      console.error(`Error: ${error.message}`)
      if (
        !(error instanceof CliUsageError) &&
        !process.argv.includes('--quiet') &&
        !process.argv.includes('-q')
      ) {
        console.error(error.stack)
      }
    }
    process.exitCode = 1
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(process.argv[1]))
  : null
if (entryPath?.href === import.meta.url) await run()

export {
  CliUsageError,
  ProgressTracker,
  createProgram,
  formatTime,
  main,
  readAtracWaveMetadata,
  readPcmWaveMetadata,
  run,
}
