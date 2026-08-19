# Carta5

Carta5 is a streaming ATRAC3plus encoder and decoder in JavaScript. It provides
complete WAVE conversion, stateful frame and chunk APIs, a command-line tool,
and browser Web Worker bundles.

Frame coding is composed from explicit stages. Persistent state lives in
reusable buffer pools, and every multichannel frame is committed
transactionally so a failed coding unit cannot partially advance the stream.

## Supported profiles

Carta5 maintains 41 mono, stereo, 5.1, and 7.1 ATRAC3plus profiles. Each frame
represents 2,048 PCM samples per channel.

| Channels | Sample rate | Maintained bitrates (kbps)                   |
| -------: | ----------: | -------------------------------------------- |
|        1 |    44.1 kHz | 32, 48, 64, 96, 128                          |
|        2 |    44.1 kHz | 24, 48, 64, 96, 128, 160, 192, 256, 320, 352 |
|        6 |    44.1 kHz | 192, 256, 320, 384, 512                      |
|        8 |    44.1 kHz | 384, 768                                     |
|        1 |      48 kHz | 32, 48, 64, 96, 128                          |
|        2 |      48 kHz | 64, 96, 128, 160, 192, 256, 320              |
|        6 |      48 kHz | 192, 256, 320, 384, 512                      |
|        8 |      48 kHz | 384, 768                                     |

Encoded files use the ATRACX subtype of `WAVE_FORMAT_EXTENSIBLE`, including
the canonical `fact` alignment timeline.

## Installation

Carta5 is an ES module and requires Node.js 20.16 or newer.

```bash
npm install carta5
```

To work from a repository checkout instead:

```bash
npm install
npm run check
```

## PCM convention

JavaScript encoder APIs accept planar PCM as one `Float32Array` per channel.
Every channel in a chunk must have the same length. Samples use signed 16-bit
amplitude values represented as floats: `-32768` through `32767`, rather than
normalized Web Audio values.

When using an `AudioBuffer`, scale its normalized samples before encoding:

```js
const channels = Array.from(
  { length: audioBuffer.numberOfChannels },
  (_, channel) =>
    Float32Array.from(audioBuffer.getChannelData(channel), (value) =>
      Math.fround(value * 32768)
    )
)
```

Decoded JavaScript PCM uses the same signed-sample amplitude domain.

## JavaScript API

### Complete WAVE files

Use `encodeWavePcm()` and `decodeWavePcm()` when the complete input fits in
memory:

```js
import { decodeWavePcm, encodeWavePcm } from 'carta5'

const wave = encodeWavePcm([left, right], {
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 44100,
})

const [decodedLeft, decodedRight] = decodeWavePcm(wave)
```

`encodeWavePcm()` returns a `Uint8Array` containing a complete ATRACX WAVE
file. `decodeWavePcm()` accepts that byte image and returns one equally sized
`Float32Array` per encoded channel.

### Stateful frames

`encode()` and `decode()` create persistent closures for chronological,
complete 2,048-sample frames. Reuse each closure for one stream; codec history
advances only after a frame succeeds.

```js
import { BufferPool, decode, encode } from 'carta5'

const options = { bitrateKbps: 128, channels: 2, sampleRate: 44100 }
const encodeFrame = encode(options, new BufferPool())
const decodeFrame = decode(options, new BufferPool())
const pcm = [new Float32Array(2048), new Float32Array(2048)]

// ATRAC3plus analysis delays output for the first seven input frames.
let encoded = null
for (let index = 0; index < 8; index++) encoded = encodeFrame(pcm)

const [decodedLeft, decodedRight] = decodeFrame(encoded)
```

Encoded frame sizes are fixed by the selected profile. A caller normally does
not need to provide a `BufferPool`; the optional argument exists when ownership
and reuse need to be explicit.

### Arbitrary PCM chunks

`WaveStreamingEncoder` accepts arbitrary, equally sized planar PCM chunks and
lazily emits every complete encoded frame available from each chunk:

```js
import { WaveStreamingEncoder, createWave } from 'carta5'

const encoder = new WaveStreamingEncoder({
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 44100,
})
const frames = []

for (const chunk of pcmChunks) frames.push(...encoder.frames(chunk))
frames.push(...encoder.finish())

const wave = createWave(frames, {
  bitrateKbps: encoder.profile.bitrateKbps,
  channels: encoder.profile.channels,
  sampleRate: encoder.profile.sampleRate,
  sampleCount: encoder.sampleCount,
})
```

Use `frames()` for bounded streaming. `write()` remains a convenience that
collects one chunk's output into an array. Call `finish()` once to flush the
partial frame and codec-delay drain frames.
`WaveStreamingDecoder` performs the inverse operation when given the profile,
visible sample count, and alignment sample count from the WAVE container.
`createWaveStreamingEncoder()` and `createWaveStreamingDecoder()` are factory
forms of the two constructors.

### Profiles and containers

`resolveProfile({ bitrateKbps, channels, sampleRate })` returns an immutable
descriptor for a maintained profile, or `null` for unsupported geometry.
`resolveWaveProfile(format)` performs the same lookup from parsed WAVE fields.

`createWave(frames, options)` combines complete profile-sized frames into a
WAVE byte image. `parseWave(bytes)` validates an ATRACX WAVE image and returns
its profile, optional `fact` metadata, data geometry, frame count, and a lazy
`frames()` generator of zero-copy frame views.

### Audio processor facade

`AudioProcessor` also provides async iterable adapters:

- `encodeStream(pcmChunks, options)` yields encoded frames with WAVE timeline
  alignment.
- `decodeStream(encodedFrames, options)` yields complete untrimmed decoded
  frames.
- `decodeWaveStream(encodedFrames, options)` yields timeline-trimmed chunks.
- `frameBufferToFrames(buffers, frameSize)` divides complete planar buffers
  into zero-padded frames.
- `encodeWavePcm(channels, options)` and `decodeWavePcm(bytes)` expose the
  complete-file helpers through the facade.
- `createWaveBlob()`, `parseWaveBlob()`, and `createPcmWaveBlob()` provide
  browser-oriented container helpers.

The supported package surface is exported from `codec/index.js`. Concrete
codec modules remain importable for tests and development, but are not part of
the package compatibility contract.

## Browser worker

The production build writes a worker and an ES module client to `dist/`. Serve
both files from the same origin as the application, for example by copying them
from `node_modules/carta5/dist/` into the application's public assets:

```js
import { Carta5Worker } from '/vendor/carta5-worker-interface.min.js'

const codec = new Carta5Worker('/vendor/carta5-worker.min.js')

const { waveBlob, info } = await codec.encode([left, right], {
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 44100,
})
const inspected = await codec.inspect(waveBlob)
const { wavBlob } = await codec.decode(waveBlob)
const profiles = await codec.getProfiles()

codec.terminate()
```

`encode()` accepts encoder-domain planar PCM and returns an ATRACX WAVE `Blob`.
`decode()` accepts a `Blob`, `ArrayBuffer`, or `Uint8Array` and returns a signed
16-bit PCM WAVE `Blob`. `inspect()` reads container metadata without decoding.
Always call `terminate()` when the worker is no longer needed.

The build also produces `dist/carta5.min.js`, a UMD bundle exposing the main
JavaScript API as the global `Carta5` object.

## CLI

Run the installed executable directly or use `npx carta5` from a project that
depends on Carta5:

```bash
carta5 --encode input.wav output.atracx.wav
carta5 --encode --bitrate 256 input.wav output.atracx.wav
carta5 --decode input.atracx.wav output.wav

npx carta5 --encode input.wav output.atracx.wav
```

The encoder accepts 44.1 or 48 kHz signed 16-bit PCM WAVE input with 1, 2, 6,
or 8 channels. The selected bitrate must exist for that topology; 128 kbps is
the default for mono and stereo input. Decoding produces a signed 16-bit PCM
WAVE file with the encoded channel layout.

| Option                 | Meaning                                       |
| ---------------------- | --------------------------------------------- |
| `-e, --encode`         | Encode PCM WAVE to ATRACX WAVE.               |
| `-d, --decode`         | Decode ATRACX WAVE to PCM WAVE.               |
| `-b, --bitrate <kbps>` | Select a maintained bitrate; defaults to 128. |
| `-q, --quiet`          | Suppress normal output and progress.          |
| `-f, --force`          | Overwrite an existing output file.            |
| `-V, --version`        | Print the Carta5 version.                     |
| `-h, --help`           | Print command help.                           |

Exactly one of `--encode` and `--decode` is required. `--bitrate` only applies
when encoding, and input and output paths must be different.

## Compatibility and limitations

- Encoding and decoding are limited to the 41 profiles listed above.
- JavaScript APIs require planar `Float32Array` input in signed-sample amplitude
  scale; they do not accept normalized Web Audio samples directly.
- The maintained container contract is RIFF/WAVE with the ATRACX subtype,
  canonical extension fields, frame alignment, and timeline metadata.
- Stateful frame APIs must receive frames in order and must not be shared
  between independent streams.
- Browser workers must be served from a location allowed by the application's
  worker and Content Security Policy settings.

## Development

The codec keeps its top-level encode and decode pipelines explicit. Existing
directories divide implementation concerns without changing those pipelines:

| Path                | Responsibility                                                  |
| ------------------- | --------------------------------------------------------------- |
| `codec/pipeline/`   | Ordered encoder and decoder stage composition.                  |
| `codec/analysis/`   | Signal measurements and encoder decisions.                      |
| `codec/coding/`     | Allocation, quantization, entropy, and coding policy.           |
| `codec/transforms/` | QMF, MDCT, gain, tone, and spectral transforms.                 |
| `codec/io/`         | Bitstream syntax, WAVE framing, and streaming adapters.         |
| `codec/state/`      | Structured persistent state and non-trivial scratch classes.    |
| `codec/core/`       | Profiles, constants, tables, geometry, and buffer ownership.    |
| `codec/browser/`    | Web Worker implementation and client.                           |
| `bin/`              | Command-line boundary.                                          |
| `tests/`            | Unit, transaction, byte-vector, streaming, WAVE, and CLI tests. |

Common commands are:

```bash
npm test            # Run the test suite once
npm run test:watch  # Re-run affected tests while editing
npm run lint        # Check JavaScript and formatting
npm run format      # Apply repository formatting
npm run build       # Build the three browser bundles
npm run check       # Run lint, tests, and the production build
```

Run `npm run check` before submitting a change. Pull requests and release tags
run the same gate in CI. Algorithm changes should preserve or deliberately
update the exact reference vectors and transactional failure expectations
covered by the tests.

## License

ISC
