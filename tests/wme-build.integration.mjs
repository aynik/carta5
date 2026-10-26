/** Exercise the generated WME module and its actual bundled worker together. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import { encodeWavePcm, parseWave } from '../codec/index.js'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const archive = await readFile(process.env.WME_ARCHIVE)
assert.equal(archive.subarray(0, 7).toString(), 'SARFile')
const subMagicLength = archive.readUInt16BE(7)
assert.equal(
  archive.subarray(9, 9 + subMagicLength).toString(),
  'Web MiniDisc Dynamic Encoder'
)
const files = new Map()
let cursor = 9 + subMagicLength
while (cursor < archive.length) {
  const nameLength = archive.readUInt16BE(cursor)
  const name = archive.subarray(cursor + 2, cursor + 2 + nameLength).toString()
  cursor += 2 + nameLength
  const length = archive.readUInt32BE(cursor)
  cursor += 4
  assert.ok(cursor + length <= archive.length)
  files.set(name, archive.subarray(cursor, cursor + length))
  cursor += length
}
assert.equal(cursor, archive.length)
assert.deepEqual([...files.keys()], ['metadata.json', 'index.js', 'worker.js'])
assert.ok(!files.get('index.js').toString().includes('sourceMappingURL='))
assert.ok(!files.get('worker.js').toString().includes('sourceMappingURL='))
const metadata = JSON.parse(files.get('metadata.json'))
assert.equal(metadata.version, pkg.version)
assert.equal(metadata.encoderId, pkg.name)
assert.equal(metadata.apiVersion, '1')
assert.ok(metadata.userFriendlyName.includes('ATRAC3plus'))
assert.ok(metadata.description.includes('ATRAC3plus'))
assert.ok(metadata.description.includes('Hi-MD'))
assert.deepEqual(metadata.encoderDependencies, [])
// Like the host's blob import, this cannot resolve relative module dependencies.
const { default: Encoder } = await import(
  `data:text/javascript;base64,${files.get('index.js').toString('base64')}`
)

// Bridge the browser Worker protocol to a real independent thread. No codec
// operations are mocked: the worker executes the bytes shipped in the archive.
const liveWorkers = new Set()
class BrowserWorker {
  constructor(url) {
    assert.ok(url.startsWith('blob:'))
    this.thread = new NodeWorker(
      `
      const { parentPort } = require('node:worker_threads');
      globalThis.self = globalThis;
      self.postMessage = data => parentPort.postMessage(data);
      parentPort.on('message', data => self.onmessage({ data }));
      ${files.get('worker.js').toString()}
    `,
      { eval: true }
    )
    liveWorkers.add(this)
    this.thread.on('message', (data) => this.onmessage?.({ data }))
    this.thread.on('error', (error) => this.onerror?.(error))
    this.thread.on('messageerror', (error) => this.onmessageerror?.(error))
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer)
  }
  terminate() {
    liveWorkers.delete(this)
    return this.thread.terminate()
  }
}

function inspectWave(wave) {
  const parsed = parseWave(wave)
  let offset = 12
  const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength)
  while (
    new TextDecoder().decode(wave.subarray(offset, offset + 4)) !== 'data'
  ) {
    const size = view.getUint32(offset + 4, true)
    offset += 8 + size + (size % 2)
  }
  return {
    format: { codec: 'A3+', bitrate: parsed.profile.bitrateKbps },
    headerLength: offset + 8,
  }
}

test(
  'packaged plugin encodes every advertised bitrate in its bundled worker',
  { timeout: 30000 },
  async () => {
    const originalWorker = globalThis.Worker
    globalThis.Worker = BrowserWorker
    const pcm = Array.from({ length: 2 }, (_, channel) =>
      Float32Array.from(
        { length: 1103 },
        (_, sample) => Math.sin(sample * 0.07 + channel) * 0.25
      )
    )
    const bytes = new Uint8Array(pcm[0].length * 8)
    const view = new DataView(bytes.buffer)
    for (let sample = 0; sample < pcm[0].length; sample++) {
      for (let channel = 0; channel < 2; channel++) {
        view.setFloat32(sample * 8 + channel * 4, pcm[channel][sample], true)
      }
    }
    const temporaryFiles = new Set()
    let currentParams
    const ffmpeg = {
      async init() {},
      async deinit() {},
      createFfmpegParams(params, format, extra) {
        currentParams = params
        assert.equal(format, 'f32le')
        assert.equal(extra, '-c:a pcm_f32le')
        return 'ffmpeg-command'
      },
      ffmpegProcess: {
        async write(name) {
          temporaryFiles.add(name)
        },
        async transcode(input, output) {
          assert.ok(temporaryFiles.has(input))
          temporaryFiles.add(output)
        },
        async read() {
          return { data: bytes }
        },
        async remove(name) {
          temporaryFiles.delete(name)
        },
      },
    }
    const encoder = new Encoder({
      getBuiltinEncoder(id) {
        assert.equal(id, 'ffmpeg')
        return ffmpeg
      },
      getOwnFile(name) {
        assert.ok(files.has(name))
        return files.get(name)
      },
      getATRACWAVEncoding: inspectWave,
    })
    try {
      await encoder.init()
      for (const bitrate of encoder.getSupportFor('A3+').bitrates) {
        // Two tracks also exercise state isolation and fresh worker creation.
        for (let track = 0; track < 2; track++) {
          const params = {
            format: { codec: 'A3+', bitrate },
            enableReplayGain: true,
            writeGapless: false,
          }
          const actual = await encoder.transcode(
            new Uint8Array([1]),
            'input.flac',
            params
          )
          assert.equal(currentParams, params)
          const wave = encodeWavePcm(pcm, { bitrateKbps: bitrate })
          assert.deepEqual(actual, wave.slice(inspectWave(wave).headerLength))
          assert.equal(temporaryFiles.size, 0)
          assert.equal(liveWorkers.size, 0)
        }
      }
    } finally {
      await encoder.deinit()
      for (const worker of liveWorkers) await worker.terminate()
      globalThis.Worker = originalWorker
    }
  }
)
