/**
 * Promise-based client for the Carta5 ATRAC3plus Web Worker.
 */

export class Carta5Worker {
  /**
   * Create a worker client and install job-resolution handlers.
   *
   * @param {string|URL} [workerPath] Worker bundle location.
   */
  constructor(workerPath = 'carta5-worker.min.js') {
    this.worker = new Worker(workerPath)
    this.nextJobId = 1
    this.jobs = new Map()
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.jobId)
      if (!job) return
      this.jobs.delete(data.jobId)
      if (data.error) job.reject(new Error(data.error))
      else job.resolve(data.result)
    }
    this.worker.onerror = (error) => {
      for (const { reject } of this.jobs.values()) reject(error)
      this.jobs.clear()
    }
  }

  /**
   * Submit one typed worker request and resolve its correlated response.
   *
   * @param {string} type Worker operation identifier.
   * @param {Record<string, unknown>} [payload] Structured-cloneable operation payload.
   * @returns {Promise<WorkerEncodeResult|WorkerDecodeResult|WorkerMetadata|WorkerProfileDescriptor[]>} Correlated worker result.
   */
  request(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('Worker is terminated'))
    const jobId = this.nextJobId++
    return new Promise((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject })
      this.worker.postMessage({ jobId, type, ...payload })
    })
  }

  /**
   * Encode normalized planar PCM into an ATRACX WAVE blob.
   *
   * @param {Float32Array[]} pcmData Maintained-topology normalized planar PCM.
   * @param {CodecProfileOptions} [options] Encoder profile options.
   * @returns {Promise<WorkerEncodeResult>} Encoded blob and metadata.
   */
  encode(pcmData, options = {}) {
    return this.request('encode', { pcmData, options })
  }

  /**
   * Decode an ATRACX WAVE image into a PCM WAVE blob.
   *
   * @param {ArrayBuffer|ArrayBufferView|Blob} wave Encoded WAVE input.
   * @returns {Promise<WorkerDecodeResult>} Decoded blob and metadata.
   */
  decode(wave) {
    return this.request('decode', { wave })
  }

  /**
   * Read container and profile metadata without decoding samples.
   *
   * @param {ArrayBuffer|ArrayBufferView|Blob} wave Encoded WAVE input.
   * @returns {Promise<WorkerMetadata>} Container and ATRAC3plus profile metadata.
   */
  inspect(wave) {
    return this.request('inspect', { wave })
  }

  /**
   * Return codec profiles supported by the worker build.
   *
   * @returns {Promise<WorkerProfileDescriptor[]>} Maintained profile descriptors.
   */
  getProfiles() {
    return this.request('getProfiles')
  }

  /**
   * Terminate the worker and reject every outstanding request.
   *
   * @returns {void}
   */
  terminate() {
    if (!this.worker) return
    this.worker.terminate()
    this.worker = null
    for (const { reject } of this.jobs.values()) {
      reject(new Error('Worker is terminated'))
    }
    this.jobs.clear()
  }
}

export default Carta5Worker
