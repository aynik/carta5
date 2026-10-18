/** Web MiniDisc API v1 adapter. Heavy encoding uses the existing codec worker. */
const CODEC = 'A3+'
const BITRATES = [48, 64, 192, 256, 352]

export default class CartaWmeEncoder {
  static customConstructionParameters = []

  constructor(api) {
    this.api = api
    this.ffmpeg = api.getBuiltinEncoder('ffmpeg')
    this.workerURL = null
    this.worker = null
    this.rejectJob = null
    this.busy = false
  }

  async init() {
    if (this.workerURL) return
    try {
      await this.ffmpeg.init()
      this.workerURL = URL.createObjectURL(
        new Blob([this.api.getOwnFile('worker.js')], {
          type: 'text/javascript',
        })
      )
    } catch (error) {
      await this.ffmpeg.deinit()
      throw error
    }
  }

  async deinit() {
    this.rejectJob?.(new Error('Encoder was stopped'))
    this.worker?.terminate()
    this.worker = null
    if (this.workerURL) URL.revokeObjectURL(this.workerURL)
    this.workerURL = null
    await this.ffmpeg.deinit()
  }

  getSupportFor(codec) {
    if (codec === CODEC) {
      return { state: 'perfect', gapless: false, bitrates: [...BITRATES] }
    }
    if (codec === 'PCM' || codec === 'MP3') {
      return this.ffmpeg.getSupportFor(codec)
    }
    return { state: 'unsupported', gapless: false }
  }

  getUserFriendyStageName(stage) {
    if (stage === 'carta') return 'Encoding ATRAC3plus...'
    if (stage === 'ffmpeg') return 'Preparing audio...'
    return this.ffmpeg.getUserFriendyStageName(stage)
  }

  async transcode(source, sourceFileName, exportParams, progress) {
    if (!this.workerURL) throw new Error('Encoder is not initialized')
    if (this.busy) throw new Error('Encoder is already processing a track')
    const { codec, bitrate } = exportParams.format
    if (
      codec !== 'PCM' &&
      codec !== 'MP3' &&
      (codec !== CODEC || !BITRATES.includes(bitrate))
    ) {
      throw new RangeError('Unsupported carta5 recording format')
    }
    this.busy = true
    try {
      if (codec === 'PCM' || codec === 'MP3') {
        return await this.ffmpeg.transcode(
          source,
          sourceFileName,
          exportParams,
          progress
        )
      }
      return await this.encodeAtrac(
        source,
        sourceFileName,
        exportParams,
        progress
      )
    } finally {
      this.busy = false
    }
  }

  async encodeAtrac(source, sourceFileName, exportParams, progress) {
    const extension = sourceFileName.split('.').pop()
    const inputName = `carta5-input.${/^[a-z0-9]+$/i.test(extension) ? extension : 'audio'}`
    const outputName = 'carta5-pcm.f32'
    const process = this.ffmpeg.ffmpegProcess
    try {
      progress?.({ stage: 'ffmpeg', progress: 0, total: 1 })
      await process.write(inputName, source)
      // API v1 supplies stereo/44.1 kHz conversion and optional ReplayGain.
      const command = this.ffmpeg.createFfmpegParams(
        exportParams,
        'f32le',
        '-c:a pcm_f32le'
      )
      await process.transcode(inputName, outputName, command)
      const { data } = await process.read(outputName)
      if (data.byteLength === 0 || data.byteLength % 8 !== 0) {
        throw new RangeError('Expected nonempty stereo float32 PCM')
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const samples = data.byteLength / 8
      const pcmData = [new Float32Array(samples), new Float32Array(samples)]
      for (let sample = 0; sample < samples; sample++) {
        pcmData[0][sample] = view.getFloat32(sample * 8, true)
        pcmData[1][sample] = view.getFloat32(sample * 8 + 4, true)
      }
      progress?.({ stage: 'ffmpeg', progress: 1, total: 1 })
      progress?.({ stage: 'carta', progress: 0, total: 1 })
      const wave = await this.encodeInWorker(
        pcmData,
        exportParams.format.bitrate
      )
      const encoding = this.api.getATRACWAVEncoding(wave)
      if (
        !encoding ||
        encoding.format.codec !== CODEC ||
        encoding.format.bitrate !== exportParams.format.bitrate ||
        encoding.headerLength <= 0 ||
        encoding.headerLength >= wave.byteLength
      ) {
        throw new Error('Worker returned an incompatible ATRAC WAVE file')
      }
      progress?.({ stage: 'carta', progress: 1, total: 1 })
      // API v1 expects raw ATRAC frames, without RIFF/fact headers.
      // Keep the codec's canonical priming and drain frames; no gapless claim.
      return wave.slice(encoding.headerLength)
    } finally {
      // FFmpeg 0.6 tracks pending FS jobs by action, not job ID. Parallel
      // removals overwrite the resolver and leave one promise pending forever.
      for (const filename of [inputName, outputName]) {
        try {
          await process.remove(filename)
        } catch {
          // A failed conversion may not have created both temporary files.
        }
      }
    }
  }

  async encodeInWorker(pcmData, bitrateKbps) {
    const worker = new Worker(this.workerURL)
    this.worker = worker
    try {
      const result = await new Promise((resolve, reject) => {
        this.rejectJob = reject
        worker.onmessage = ({ data }) => {
          if (data.jobId !== 1) return
          if (data.error) reject(new Error(data.error))
          else resolve(data.result)
        }
        worker.onerror = (event) =>
          reject(new Error(event.message || 'Codec worker failed'))
        worker.onmessageerror = () =>
          reject(new Error('Invalid codec worker response'))
        worker.postMessage(
          {
            jobId: 1,
            type: 'encode',
            pcmData,
            options: { bitrateKbps, channels: 2, sampleRate: 44100 },
          },
          pcmData.map((channel) => channel.buffer)
        )
      })
      return new Uint8Array(await result.waveBlob.arrayBuffer())
    } finally {
      this.rejectJob = null
      worker.terminate()
      this.worker = null
    }
  }
}
