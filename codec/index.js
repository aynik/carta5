/**
 * Carta5 ATRAC3plus/ATRACX public API.
 *
 * Codec internals remain importable from their concrete modules for testing and
 * development, but they are not part of the package contract. Keeping this
 * boundary explicit prevents transform scratch, syntax work images, and
 * individual transaction stages from becoming accidental public APIs.
 */

export { BufferPool } from './core/buffers.js'
export { resolveProfile, resolveWaveProfile } from './core/profiles.js'
export { decode } from './pipeline/decoder.js'
export { createFrameEncoder as encode } from './pipeline/encoder.js'
export {
  WaveStreamingDecoder,
  createWaveStreamingDecoder,
  decodeWavePcm,
} from './io/wave-decoder.js'
export {
  WaveStreamingEncoder,
  createWaveStreamingEncoder,
  encodeWavePcm,
} from './io/wave-encoder.js'
export { createWave, parseWave } from './io/wave.js'
export { AudioProcessor } from './io/processor.js'
