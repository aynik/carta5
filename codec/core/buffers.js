/** Typed-array ownership for one reusable ATRAC3plus codec instance. */

import { IntensityScratch } from '../state/analysis.js'
import { GainAnalysisScratch } from '../state/gain-analysis.js'
import { ToneAnalysisScratch, ToneSwapGate } from '../state/tone.js'
import { SpectrumSyntaxScratch } from '../state/spectrum.js'
import { EncoderFrameState, EncoderState } from '../state/encoder.js'
import { DecoderFrameState, DecoderState } from '../state/decoder.js'
import { FrameDecodeStorage } from '../state/decoder-syntax.js'
import {
  MdctScratch,
  QmfAnalysisScratch,
  SpectralReconstructionScratch,
  ToneSynthesisScratch,
} from '../state/transform.js'
import {
  FRAME_PACK_SCRATCH_SLACK_BYTES,
  MAX_CODING_UNITS,
  MAX_FRAME_BYTES,
} from './constants.js'

/**
 * Own reusable codec storage according to the lifetime of its contents.
 *
 * - `state` is committed stream history, topology, and control state;
 * - `frame` is the detached transaction and named data passed between stages;
 * - `scratch` is private to one algorithm call and has no stage meaning.
 *
 * Complex state and topology owners live in `codec/state`. Raw buffers that
 * need no invariants or behavior are allocated here at their ownership site.
 */
export class BufferPool {
  /**
   * Allocate profile-neutral encoder and decoder storage.
   */
  constructor() {
    this.encoder = {
      state: new EncoderState(),
      frame: new EncoderFrameState(),
      scratch: {
        qmf: new QmfAnalysisScratch(),
        intensity: new IntensityScratch(),
        tone: new ToneAnalysisScratch(),
        toneSwapGates: Array.from(
          { length: MAX_CODING_UNITS },
          () => new ToneSwapGate()
        ),
        mdct: new MdctScratch(),
        gain: new GainAnalysisScratch(),
        spectrumSyntax: new SpectrumSyntaxScratch(),
        packedFrame: new Uint8Array(
          MAX_FRAME_BYTES + FRAME_PACK_SCRATCH_SLACK_BYTES
        ),
      },
    }

    this.decoder = {
      state: new DecoderState(),
      frame: new DecoderFrameState(),
      scratch: {
        syntax: new FrameDecodeStorage(),
        spectralReconstruction: new SpectralReconstructionScratch(),
        inverseMdct: new MdctScratch(),
        toneSynthesis: new ToneSynthesisScratch(),
      },
    }
  }
}
