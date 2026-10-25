/** Build-only Porffor adapters. Nothing generated here enters the npm tree. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync, types as t } from '@babel/core'

const configuration = process.env.NATIVE_BUILD
if (!configuration) throw new Error('Expected NATIVE_BUILD JSON configuration')
const codec = JSON.parse(configuration)
const root = path.resolve(codec.root || '.')
const constants = await import(
  pathToFileURL(path.resolve(root, codec.constants)).href
)
const work = fs.mkdtempSync(path.join(os.tmpdir(), codec.name + '-aot-'))
const output = path.resolve(process.argv[2] || path.join(work, codec.name))
const porffor = process.env.PORFFOR || 'porf'

const resolvedOutput = fs.existsSync(output)
  ? fs.realpathSync(output)
  : path.join(fs.realpathSync(path.dirname(output)), path.basename(output))
const packageOutput = path.relative(fs.realpathSync(root), resolvedOutput)
if (
  !packageOutput.startsWith('..' + path.sep) &&
  !path.isAbsolute(packageOutput)
) {
  throw new Error('Native output must be outside the npm package directory')
}

// The host adapter below uses the memory layout of this pinned compiler release.
const compilerVersion = spawnSync(porffor, ['--help'], { encoding: 'utf8' })
if (compilerVersion.error) throw compilerVersion.error
if (!compilerVersion.stdout.includes('alpha 19 (0c135ce 2026-10-21)')) {
  throw new Error('This native adapter requires Porffor alpha-19 (0c135ce)')
}

/* global Porffor */
/* eslint-disable no-unused-vars -- Embedded C refers to local bindings. */

/** UTF-8 encoding for file metadata and native terminal output. */
class NativeTextEncoder {
  encode(input = '') {
    const source = String(input)
    const output = new Uint8Array(source.length * 3)
    return output.slice(0, this.encodeInto(source, output).written)
  }
  encodeInto(source, output) {
    let read = 0
    let written = 0
    while (read < source.length) {
      let point = source.charCodeAt(read)
      let units = 1
      if (point >= 0xd800 && point <= 0xdbff) {
        const next = source.charCodeAt(read + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          point = 0x10000 + (point - 0xd800) * 1024 + next - 0xdc00
          units = 2
        } else point = 0xfffd
      } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd
      const size = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
      if (written + size > output.length) break
      if (size === 1) output[written++] = point
      else {
        output[written++] =
          size === 2
            ? 0xc0 | (point >> 6)
            : size === 3
              ? 0xe0 | (point >> 12)
              : 0xf0 | (point >> 18)
        if (size === 4) output[written++] = 0x80 | ((point >> 12) & 63)
        if (size >= 3) output[written++] = 0x80 | ((point >> 6) & 63)
        output[written++] = 0x80 | (point & 63)
      }
      read += units
    }
    return {
      read,
      written,
    }
  }
}

/** Decode UTF-8 with replacement characters for malformed byte sequences. */
class NativeTextDecoder {
  constructor(label = 'utf-8', options = {}) {
    this.ignoreBOM = Boolean(options.ignoreBOM)
  }
  decode(bytes) {
    let output = ''
    let offset = 0
    let first = true
    while (offset < bytes.length) {
      const lead = bytes[offset++]
      let point = lead
      let count = 0
      let lower = 128
      let upper = 191
      if (lead >= 194 && lead <= 223) {
        point = lead & 31
        count = 1
      } else if (lead >= 224 && lead <= 239) {
        point = lead & 15
        count = 2
        if (lead === 224) lower = 160
        if (lead === 237) upper = 159
      } else if (lead >= 240 && lead <= 244) {
        point = lead & 7
        count = 3
        if (lead === 240) lower = 144
        if (lead === 244) upper = 143
      } else if (lead >= 128) point = 0xfffd
      for (let index = 0; index < count; index++) {
        const byte = bytes[offset]
        if (offset === bytes.length || byte < lower || byte > upper) {
          point = 0xfffd
          break
        }
        offset++
        point = (point << 6) | (byte & 63)
        lower = 128
        upper = 191
      }
      if (!(first && point === 0xfeff && !this.ignoreBOM))
        output += String.fromCodePoint(point)
      first = false
    }
    return output
  }
}

/** The Buffer operations used by streaming command-line applications. */
class NativeBuffer extends Uint8Array {
  static alloc(length) {
    return new NativeBuffer(length)
  }
  static from(value) {
    return new NativeBuffer(
      typeof value === 'string' ? new NativeTextEncoder().encode(value) : value
    )
  }
  static concat(parts) {
    const result = new NativeBuffer(parts.reduce((n, b) => n + b.length, 0))
    let offset = 0
    for (const part of parts) {
      result.set(part, offset)
      offset += part.length
    }
    return result
  }
  readUInt16LE(i) {
    return this[i] | (this[i + 1] << 8)
  }
  readUInt32LE(i) {
    return (
      (this[i] |
        (this[i + 1] << 8) |
        (this[i + 2] << 16) |
        (this[i + 3] << 24)) >>>
      0
    )
  }
  readInt16LE(i) {
    return ((this[i] | (this[i + 1] << 8)) << 16) >> 16
  }
  readInt32LE(i) {
    return (
      this[i] | (this[i + 1] << 8) | (this[i + 2] << 16) | (this[i + 3] << 24)
    )
  }
  static decode(buffer, encoding = 'utf8', start = 0, end = buffer.length) {
    if (encoding === 'ascii' || encoding === 'latin1') {
      let output = ''
      const mask = encoding === 'ascii' ? 127 : 255
      for (let index = start; index < end; index++)
        output += String.fromCharCode(buffer[index] & mask)
      return output
    }
    return new NativeTextDecoder().decode(buffer.subarray(start, end))
  }
}

/** Encode a NUL-terminated UTF-8 filesystem path. */
function encodeNativePath(value) {
  if (value.includes('\0')) throw new Error('Invalid NUL in path')
  const bytes = new NativeTextEncoder().encode(value)
  const out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  return out
}

/** Open a buffered C file and expose the FileHandle methods used by the CLI. */
function openNativeFile(filename, mode) {
  const filenameBytes = encodeNativePath(filename)
  const modeBytes = encodeNativePath(
    mode === 'r' ? 'rb' : mode === 'wx' ? 'wbx' : 'wb'
  )
  const filenamePointer = Porffor.IR.ptr(filenameBytes.buffer)
  const modePointer = Porffor.IR.ptr(modeBytes.buffer)
  let handle = 0
  Porffor.c`
    FILE *stream = fopen(
      (char*)MEM + (u32)filenamePointer.val + 8,
      (char*)MEM + (u32)modePointer.val + 8
    );
    handle = (f64)(uintptr_t)stream;
  `
  if (!handle) {
    const error = new Error('Cannot open file: ' + filename)
    error.path = filename
    throw error
  }
  return {
    handle,
    read: readNativeFile,
    write: writeNativeFile,
    stat: statNativeFile,
    close: closeNativeFile,
  }
}

/** Read one bounded block into an existing buffer at the requested file position. */
function readNativeFile(buffer, offset, length, position) {
  const handle = this.handle
  const pointer = Porffor.IR.ptr(buffer.buffer)
  const start = buffer.byteOffset
  let seek = 0
  if (position !== null && position !== undefined) seek = 1
  let count = 0
  Porffor.c`
    FILE *stream = (FILE*)(uintptr_t)handle.val;
    if (seek) fseeko(stream, (off_t)position.val, SEEK_SET);
    count = fread(
      MEM + (u32)pointer.val + 8 + (u32)start.val + (u32)offset.val,
      1, (size_t)length.val, stream
    );
  `
  return {
    bytesRead: count,
  }
}

/** Write one byte block, returning the actual number of bytes written. */
function writeNativeFile(
  buffer,
  offset = 0,
  length = buffer.length,
  position = null
) {
  const handle = this.handle
  const pointer = Porffor.IR.ptr(buffer.buffer)
  const start = buffer.byteOffset
  let seek = 0
  if (position !== null && position !== undefined) seek = 1
  let count = 0
  Porffor.c`
    FILE *stream = (FILE*)(uintptr_t)handle.val;
    if (seek) fseeko(stream, (off_t)position.val, SEEK_SET);
    count = fwrite(
      MEM + (u32)pointer.val + 8 + (u32)start.val + (u32)offset.val,
      1, (size_t)length.val, stream
    );
  `
  return {
    bytesWritten: count,
  }
}

/** Measure an open file without changing its read/write position. */
function statNativeFile() {
  const handle = this.handle
  let size = 0
  Porffor.c`
    FILE *stream = (FILE*)(uintptr_t)handle.val;
    off_t old = ftello(stream);
    fseeko(stream, 0, SEEK_END);
    size = ftello(stream);
    fseeko(stream, old, SEEK_SET);
  `
  return {
    size,
  }
}

/** Release an open native file handle. */
function closeNativeFile() {
  const handle = this.handle
  Porffor.c`
    fclose((FILE*)(uintptr_t)handle.val);
  `
}

/** Read filesystem metadata through a temporary file handle. */
function statNativePath(filename) {
  const file = openNativeFile(filename, 'r')
  try {
    return file.stat()
  } finally {
    file.close()
  }
}

/** Check whether a path can be opened without retaining a file handle. */
function nativePathExists(filename) {
  try {
    statNativePath(filename)
    return true
  } catch {
    return false
  }
}

/** Yield bounded file blocks without collecting the file. */
function* readNativeStream(filename, options = {}) {
  const file = openNativeFile(filename, 'r')
  const size = file.stat().size
  const end = options.end === undefined ? size : Math.min(size, options.end + 1)
  let position = options.start || 0
  try {
    while (position < end) {
      const bytes = NativeBuffer.alloc(Math.min(65536, end - position))
      const count = file.read(bytes, 0, bytes.length, position).bytesRead
      if (!count) throw new Error('Truncated input')
      position += count
      yield bytes.subarray(0, count)
    }
  } finally {
    file.close()
  }
}

/** Decode one command-line argument, preserving a leading Unicode BOM. */
function readNativeArgument(argIndex) {
  let length = 0
  Porffor.c`
    length = strlen(porf_argv[(int)argIndex.val]);
  `
  const bytes = new Uint8Array(length)
  const pointer = Porffor.IR.ptr(bytes.buffer)
  Porffor.c`
    memcpy(MEM + (u32)pointer.val + 8, porf_argv[(int)argIndex.val], (size_t)length);
  `
  return new NativeTextDecoder('utf-8', {
    ignoreBOM: true,
  }).decode(bytes)
}

/** Read the working directory for lexical absolute-path resolution. */
function readNativeWorkingDirectory() {
  let address = 0
  let length = 0
  Porffor.c`
    char *directory = getcwd(NULL, 0);
    address = (f64)(uintptr_t)directory;
    if (directory) length = strlen(directory);
  `
  if (!address) throw new Error('Cannot read the working directory')
  const bytes = new Uint8Array(length)
  const pointer = Porffor.IR.ptr(bytes.buffer)
  Porffor.c`
    memcpy(MEM + (u32)pointer.val + 8, (void*)(uintptr_t)address, (size_t)length);
    free((void*)(uintptr_t)address);
  `
  return new NativeTextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

/** Expose TTY detection and flushed writes for the shared progress display. */
function createNativeTerminal(fd) {
  let tty = 0
  Porffor.c`
    tty = isatty((int)fd);
  `
  return {
    fd,
    isTTY: tty !== 0,
    columns: 100,
    write(value) {
      const bytes = new NativeTextEncoder().encode(value)
      const pointer = Porffor.IR.ptr(bytes.buffer)
      const length = bytes.length
      const descriptor = this.fd
      Porffor.c`
        FILE *target = descriptor.val == 1 ? stdout : stderr;
        fwrite(MEM + (u32)pointer.val + 8, 1, (size_t)length.val, target);
        fflush(target);
      `
      return true
    },
  }
}

/** Terminate the compiled CLI with its original exit status. */
function exitNativeProcess(code) {
  Porffor.c`
    exit((int)code.val);
  `
}

/** Install build-only host bindings before loading the original CLI. */
function installNativeRuntime(argvPrefix) {
  let count = 0
  Porffor.c`
    count = porf_argc;
  `
  const argv = argvPrefix
  for (let index = 1; index < count; index++)
    argv.push(readNativeArgument(index))
  globalThis.TextEncoder = NativeTextEncoder
  globalThis.TextDecoder = NativeTextDecoder
  globalThis.Buffer = NativeBuffer
  globalThis.process = {
    argv,
    env: {},
    platform: 'posix',
    stdout: createNativeTerminal(1),
    stderr: createNativeTerminal(2),
    exit: exitNativeProcess,
    exitCode: 0,
    cwd: readNativeWorkingDirectory,
  }
  globalThis.__nativeFs = {
    promises: {
      open: openNativeFile,
    },
    statSync: statNativePath,
    existsSync: nativePathExists,
    createReadStream: readNativeStream,
    realpathSync: (value) => value,
  }
}

/** Emit the small builtin-module adapters beside the temporary source tree. */
function prepareRuntime() {
  fs.mkdirSync(path.join(work, 'node_modules'))
  const definitions = [
    NativeTextEncoder,
    NativeTextDecoder,
    NativeBuffer,
    encodeNativePath,
    openNativeFile,
    readNativeFile,
    writeNativeFile,
    statNativeFile,
    closeNativeFile,
    statNativePath,
    nativePathExists,
    readNativeStream,
    readNativeArgument,
    createNativeTerminal,
    readNativeWorkingDirectory,
    exitNativeProcess,
    ...nativeHelpers,
    installNativeRuntime,
  ]
  fs.writeFileSync(
    path.join(work, 'host.js'),
    definitions
      .map(
        (definition) =>
          (nativeHelpers.includes(definition) ? 'export ' : '') +
          (nativeIntrinsics.includes(definition) ||
          [readNativeFieldValue, readNativeStableFieldValue].includes(
            definition
          )
            ? nativeNumericSource(definition)
            : definition.toString())
      )
      .join('\n\n')
      .replaceAll('NATIVE_FIELD_CACHE_SIZE', String(nativeFieldSites + 1)) +
      '\ninstallNativeRuntime(' +
      JSON.stringify(codec.argv) +
      ')\n'
  )
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ type: 'module' })
  )
  const aliases = {
    fs: 'module.exports = globalThis.__nativeFs',
    process: 'module.exports = globalThis.process',
    path: 'module.exports = (' + createNativePath.toString() + ')()',
  }
  for (const [name, source] of Object.entries(aliases)) {
    const directory = path.join(work, 'node_modules', name)
    fs.mkdirSync(directory)
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ main: 'index.cjs' })
    )
    fs.writeFileSync(path.join(directory, 'index.cjs'), source)
  }
}

/** Path operations used by command-line file handling. */
function createNativePath() {
  function basename(filename, extension = '') {
    const name = filename.slice(filename.lastIndexOf('/') + 1)
    return extension && name.endsWith(extension)
      ? name.slice(0, -extension.length)
      : name
  }
  function dirname(filename) {
    return filename.slice(0, filename.lastIndexOf('/')) || '.'
  }
  function extname(filename) {
    const name = basename(filename)
    const offset = name.lastIndexOf('.')
    return offset > 0 ? name.slice(offset) : ''
  }
  function resolve(...parts) {
    let absolute = process.cwd()
    for (const part of parts) {
      if (!part) continue
      absolute = part.startsWith('/') ? part : absolute + '/' + part
    }
    const components = []
    for (const part of absolute.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') components.pop()
      else components.push(part)
    }
    return '/' + components.join('/')
  }
  return { basename, dirname, extname, resolve }
}

/**
 * Read a numeric element without boxing each arithmetic operand.
 * The low three kind bits select storage; bit 3 marks caller-proven bounds,
 * and bit 4 selects zero for a missing element before nullish or bitwise use.
 * Checked reads return NaN for missing elements, matching numeric coercion.
 */
function readNativeNumber(array, sampleIndex, kind) {
  const pointer = Porffor.IR.ptr(array)
  let result = NaN
  Porffor.c`
    u32 view = (u32)pointer.val;
    f64 offset = sampleIndex;
    u32 element = (u32)kind;
    if (element & 16) result = 0;
    if ((element & 8) || (offset >= 0 && offset < *(i32*)(MEM + view) && offset == trunc(offset))) {
      u8 *data = MEM + *(u32*)(MEM + view + 4) + 4;
      switch (element & 7) {
        case 0:
          result = (f64)((f32*)data)[(u32)offset];
          break;
        case 1:
          result = ((f64*)data)[(u32)offset];
          break;
        case 2:
          result = (f64)((i32*)data)[(u32)offset];
          break;
        case 3:
          result = (f64)data[(u32)offset];
          break;
        case 4:
          result = (f64)((int16_t*)data)[(u32)offset];
          break;
        case 5:
          result = (f64)((uint16_t*)data)[(u32)offset];
          break;
        case 6:
          result = (f64)((u32*)data)[(u32)offset];
          break;
        case 7:
          result = (f64)((int8_t*)data)[(u32)offset];
          break;
      }
    }
  `
  return result
}

/** Read a signed word from a caller-validated, fixed DataView range. */
function readNativeViewWord(view, byteIndex, littleEndian) {
  const pointer = Porffor.IR.ptr(view)
  let result = 0
  Porffor.c`
    u32 address = *(u32*)(MEM + (u32)pointer.val + 4) + 4 + (u32)byteIndex;
    u32 word;
    memcpy(&word, MEM + address, sizeof(word));
    #if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    if (!littleEndian) word = __builtin_bswap32(word);
    #else
    if (littleEndian) word = __builtin_bswap32(word);
    #endif
    result = (i32)word;
  `
  return result
}

/** Store an i32 word in a caller-owned, validated DataView range. */
function writeNativeViewWord(view, byteIndex, value, littleEndian) {
  const pointer = Porffor.IR.ptr(view)
  Porffor.c`
    u32 address = *(u32*)(MEM + (u32)pointer.val + 4) + 4 + (u32)byteIndex;
    u32 word = (u32)(i32)value;
    #if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    if (!littleEndian) word = __builtin_bswap32(word);
    #else
    if (littleEndian) word = __builtin_bswap32(word);
    #endif
    memcpy(MEM + address, &word, sizeof(word));
  `
  return 0
}

/** Read a numeric ArrayLike while retaining its runtime storage and fallback. */
function readNativeArrayLikeNumber(array, sampleIndex) {
  let result = NaN
  let found = 0
  Porffor.c`
    u32 view = (u32)array.val;
    f64 offset = sampleIndex;
    if (offset >= 0 && offset < 4294967295.0 && offset == trunc(offset)) {
      u32 index = (u32)offset;
      if (array.type == 72) {
        jsval value = porf_arr_get(view, index);
        if (value.type == 1) {
          result = value.val;
          found = 1;
        }
      } else if (array.type >= 80 && array.type <= 90 &&
                 array.type != 87 && array.type != 88 &&
                 *(i32*)(MEM + view) >= 0 &&
                 index < (u32)*(i32*)(MEM + view)) {
        u8 *data = MEM + *(u32*)(MEM + view + 4) + 4;
        found = 1;
        switch (array.type) {
          case 80: case 81: result = data[index]; break;
          case 82: result = ((int8_t*)data)[index]; break;
          case 83: result = ((uint16_t*)data)[index]; break;
          case 84: result = ((int16_t*)data)[index]; break;
          case 85: result = ((u32*)data)[index]; break;
          case 86: result = ((i32*)data)[index]; break;
          case 89: result = ((f32*)data)[index]; break;
          case 90: result = ((f64*)data)[index]; break;
        }
      }
    }
  `
  return found ? result : +array[sampleIndex]
}

/**
 * Store a numeric result with bounds checks and JavaScript integer conversion.
 * Kind bit 4 marks a value already proven to be a signed 32-bit integer.
 */
function writeNativeNumber(array, sampleIndex, value, kind) {
  const pointer = Porffor.IR.ptr(array)
  Porffor.c`
    u32 view = (u32)pointer.val;
    f64 offset = sampleIndex;
    u32 element = (u32)kind;
    if ((element & 8) || (offset >= 0 && offset < *(i32*)(MEM + view) && offset == trunc(offset))) {
      u8 *data = MEM + *(u32*)(MEM + view + 4) + 4;
      u32 integerValue = element & 16;
      element &= 7;
      if (element == 0) ((f32*)data)[(u32)offset] = value;
      else if (element == 1) ((f64*)data)[(u32)offset] = value;
      else {
        f64 integer = integerValue ? value : isfinite(value) ? trunc(value) : 0;
        if (integerValue) {
          if (element == 2 || element == 6) ((i32*)data)[(u32)offset] = (i32)integer;
          else if (element == 4 || element == 5) ((uint16_t*)data)[(u32)offset] = (uint16_t)(i32)integer;
          else data[(u32)offset] = (u8)(i32)integer;
        } else if (element == 2 && integer >= -2147483648.0 && integer < 2147483648.0) {
          ((i32*)data)[(u32)offset] = (i32)integer;
        } else if (element == 3 && integer >= 0 && integer < 256) {
          data[(u32)offset] = (u8)integer;
        } else if (element == 4 && integer >= -32768 && integer < 32768) {
          ((int16_t*)data)[(u32)offset] = (int16_t)integer;
        } else if (element == 5 && integer >= 0 && integer < 65536) {
          ((uint16_t*)data)[(u32)offset] = (uint16_t)integer;
        } else if (element == 6 && integer >= 0 && integer < 4294967296.0) {
          ((u32*)data)[(u32)offset] = (u32)integer;
        } else if (element == 7 && integer >= -128 && integer < 128) {
          ((int8_t*)data)[(u32)offset] = (int8_t)integer;
        } else {
          f64 reduced = fmod(integer, 4294967296.0);
          if (reduced < 0) reduced += 4294967296.0;
          if (element == 2 || element == 6) ((u32*)data)[(u32)offset] = (u32)reduced;
          else if (element == 4 || element == 5) ((uint16_t*)data)[(u32)offset] = (uint16_t)(u32)reduced;
          else data[(u32)offset] = (u8)(u32)reduced;
        }
      }
    }
  `
  return value
}

/** Evaluate scalar IEEE-754 operations without boxing their numeric result. */
function evaluateNativeMath(value, operation) {
  let result = NaN
  Porffor.c`
    switch ((u32)operation) {
      case 0: result = fabs(value); break;
      case 1: result = (f64)(f32)value; break;
      case 2: result = floor(value); break;
      case 3: result = ceil(value); break;
      case 4: result = trunc(value); break;
      case 5: result = isfinite(value) && trunc(value) == value; break;
      case 6: result = isnan(value) != 0; break;
      case 7: result = isfinite(value) != 0; break;
    }
  `
  return result
}

/** Convert numeric bitwise operands with a fast path for the codec's integers. */
function bitwiseNativeNumber(left, right, operation) {
  let result = 0
  Porffor.c`
    f64 inputs[2] = {left, right};
    u32 values[2];
    for (u32 index = 0; index < 2; index++) {
      f64 value = inputs[index];
      if (value >= -2147483648.0 && value < 2147483648.0) values[index] = (u32)(i32)value;
      else if (value >= 0 && value < 4294967296.0) values[index] = (u32)value;
      else {
        f64 reduced = isfinite(value) ? fmod(trunc(value), 4294967296.0) : 0;
        if (reduced < 0) reduced += 4294967296.0;
        values[index] = (u32)reduced;
      }
    }
    u32 first = values[0];
    u32 second = values[1];
    switch ((u32)operation) {
      case 0: result = (f64)(i32)(first & second); break;
      case 1: result = (f64)(i32)(first | second); break;
      case 2: result = (f64)(i32)(first ^ second); break;
      case 3: result = (f64)(i32)(first << (second & 31)); break;
      case 4: result = (f64)((i32)first >> (second & 31)); break;
      case 5: result = (f64)(first >> (second & 31)); break;
      case 6: result = (f64)(i32)(first * second); break;
    }
  `
  return result
}

/** Reinterpret one 32-bit numeric lane without a shared scratch buffer. */
function reinterpretNativeNumber(value, source, destination) {
  const integer = source === 0 ? 0 : bitwiseNativeNumber(value, 0, 5)
  let result = 0
  Porffor.c`
    u32 bits = (u32)integer.val;
    if (source == 0) {
      f32 rounded = (f32)value;
      memcpy(&bits, &rounded, sizeof(bits));
    }
    if (destination == 0) {
      f32 floating;
      memcpy(&floating, &bits, sizeof(floating));
      result = (f64)floating;
    } else if (destination == 2) {
      result = (f64)(i32)bits;
    } else {
      result = (f64)bits;
    }
  `
  return result
}

/** Porffor emits fmod even for bounded integer ring indices. */
function remainderNativeInteger(left, right) {
  let result = NaN
  Porffor.c`
    i32 dividend = (i32)left;
    i32 divisor = (i32)right;
    if (divisor != 0) {
      if (dividend == (-2147483647 - 1) && divisor == -1) result = -0.0;
      else {
        i32 remainder = dividend % divisor;
        result = remainder == 0 && dividend < 0 ? -0.0 : (f64)remainder;
      }
    }
  `
  return result
}

/** Bit masks use exact powers of two; avoid libm for bounded integer exponents. */
function powerNativeTwo(exponent) {
  let result = 0
  Porffor.c`
    if (exponent >= 0 && exponent <= 63 && exponent == trunc(exponent)) {
      result = (f64)(UINT64_C(1) << (u32)exponent);
    } else {
      result = pow(2.0, exponent);
    }
  `
  return result
}

/** Two-number Math.min, including NaN propagation and signed zero. */
function minimumNativeNumber(left, right) {
  let result = NaN
  Porffor.c`
    if (left == left && right == right) {
      result = left < right ? left : right;
      if (left == 0 && right == 0) {
        result = signbit(left) || signbit(right) ? -0.0 : 0.0;
      }
    }
  `
  return result
}

/** Two-number Math.max, including NaN propagation and signed zero. */
function maximumNativeNumber(left, right) {
  let result = NaN
  Porffor.c`
    if (left == left && right == right) {
      result = left > right ? left : right;
      if (left == 0 && right == 0) {
        result = signbit(left) && signbit(right) ? -0.0 : 0.0;
      }
    }
  `
  return result
}

/** Clear a typed-array range to positive zero. The return is unused. */
function clearNativeArray(array, kind, start, end) {
  const pointer = Porffor.IR.ptr(array)
  Porffor.c`
    u32 view = (u32)pointer.val;
    u32 element = (u32)kind;
    size_t width = element == 1 ? 8 : element == 3 || element == 7 ? 1 : element == 4 || element == 5 ? 2 : 4;
    u8 *data = MEM + *(u32*)(MEM + view + 4) + 4;
    f64 length = *(i32*)(MEM + view);
    f64 first = isnan(start) ? 0 : trunc(start);
    f64 last = isnan(end) ? 0 : trunc(end);
    if (first < 0) first += length;
    if (last < 0) last += length;
    first = first < 0 ? 0 : first > length ? length : first;
    last = last < 0 ? 0 : last > length ? length : last;
    if (last > first) memset(data + (size_t)first * width, 0, (size_t)(last - first) * width);
  `
  return 0
}

/** Fill a numeric typed-array range with one converted value. */
function fillNativeArray(array, kind, value, start, end) {
  const pointer = Porffor.IR.ptr(array)
  Porffor.c`
    u32 view = (u32)pointer.val;
    u32 element = (u32)kind;
    u8 *data = MEM + *(u32*)(MEM + view + 4) + 4;
    f64 length = *(i32*)(MEM + view);
    f64 first = isnan(start) ? 0 : trunc(start);
    f64 last = isnan(end) ? 0 : trunc(end);
    if (first < 0) first += length;
    if (last < 0) last += length;
    first = first < 0 ? 0 : first > length ? length : first;
    last = last < 0 ? 0 : last > length ? length : last;
    u32 begin = (u32)first;
    u32 limit = (u32)last;
    if (element == 0) {
      for (u32 i = begin; i < limit; i++) ((f32*)data)[i] = (f32)value;
    } else if (element == 1) {
      for (u32 i = begin; i < limit; i++) ((f64*)data)[i] = value;
    } else {
      u32 integer = porf_f64_to_u32(value);
      if (element == 2 || element == 6) {
        for (u32 i = begin; i < limit; i++) ((u32*)data)[i] = integer;
      } else if (element == 4 || element == 5) {
        for (u32 i = begin; i < limit; i++) ((u16*)data)[i] = (u16)integer;
      } else {
        for (u32 i = begin; i < limit; i++) data[i] = (u8)integer;
      }
    }
  `
  return 0
}

/** Copy compatible typed-array lanes, including overlapping views. */
function copyNativeArray(target, source, kind, offset) {
  const targetPointer = Porffor.IR.ptr(target)
  const sourcePointer = Porffor.IR.ptr(source)
  let valid = 0
  Porffor.c`
    u32 destination = (u32)targetPointer.val;
    u32 origin = (u32)sourcePointer.val;
    f64 start = isnan(offset) ? 0 : trunc(offset);
    i32 count = *(i32*)(MEM + origin);
    i32 length = *(i32*)(MEM + destination);
    if (start >= 0 && start <= length && count >= 0 && count <= length - start) {
      u32 element = (u32)kind;
      size_t width = element == 1 ? 8 : element == 3 || element == 7 ? 1 : element == 4 || element == 5 ? 2 : 4;
      u8 *output = MEM + *(u32*)(MEM + destination + 4) + 4;
      u8 *input = MEM + *(u32*)(MEM + origin + 4) + 4;
      memmove(output + (size_t)start * width, input, (size_t)count * width);
      valid = 1;
    }
  `
  if (!valid) throw new RangeError('Typed-array copy exceeds destination')
  return 0
}

/** Copy a fixed typed-array range without allocating a temporary subarray view. */
function copyNativeArrayRange(
  target,
  source,
  kind,
  offset,
  sourceStart,
  sourceEnd
) {
  let valid = 0
  Porffor.c`
    u32 destination = (u32)target.val;
    u32 origin = (u32)source.val;
    i32 length = *(i32*)(MEM + destination);
    i32 sourceLength = *(i32*)(MEM + origin);
    f64 start = isnan(offset) ? 0 : trunc(offset);
    f64 first = isnan(sourceStart) ? 0 : trunc(sourceStart);
    f64 last = isnan(sourceEnd) ? 0 : trunc(sourceEnd);
    if (first < 0) first += sourceLength;
    if (last < 0) last += sourceLength;
    first = first < 0 ? 0 : first > sourceLength ? sourceLength : first;
    last = last < 0 ? 0 : last > sourceLength ? sourceLength : last;
    f64 count = last > first ? last - first : 0;
    if (sourceLength >= 0 && start >= 0 && start <= length && count <= length - start) {
      u32 element = (u32)kind;
      size_t width = element == 1 ? 8 : element == 3 || element == 7 ? 1 : element == 4 || element == 5 ? 2 : 4;
      u8 *output = MEM + *(u32*)(MEM + destination + 4) + 4;
      u8 *input = MEM + *(u32*)(MEM + origin + 4) + 4;
      memmove(output + (size_t)start * width, input + (size_t)first * width, (size_t)count * width);
      valid = 1;
    }
  `
  if (!valid) throw new RangeError('Typed-array copy exceeds destination')
  return 0
}

/**
 * Locate an own data field without boxing its numeric payload. Cache offsets,
 * never object pointers: collection and object growth may relocate entries.
 * A miss, accessor, or non-object retains the ordinary property operation.
 */
function lookupNativeField(owner, hash, site) {
  let result = 0
  Porffor.c`
    static u32 offsets[NATIVE_FIELD_CACHE_SIZE];
    if (owner.type == 7 && owner.val != 0) {
      u32 object = (u32)owner.val;
      u32 entries = *(u32*)(MEM + object + 12);
      u32 size = (u32)*(u16*)(MEM + object) * 20;
      u32 offset = offsets[(u32)site];
      if (offset != 0 && offset - 1 < size &&
          *(u32*)(MEM + entries + offset - 1) == (u32)(i32)hash) {
        result = (f64)(entries + offset - 1);
      } else {
        for (offset = 0; offset < size; offset += 20) {
          if (*(u32*)(MEM + entries + offset) == (u32)(i32)hash) {
            offsets[(u32)site] = offset + 1;
            result = (f64)(entries + offset);
            break;
          }
        }
      }
      if (result != 0 && (MEM[(u32)result + 16] & 1)) result = 0;
    }
  `
  return result
}

/**
 * Use offsets proven from a class's fixed constructor initialization sequence.
 * The count guard also handles partially initialized constructor instances.
 * Only offsets are retained; moving collection can relocate both allocations.
 */
function lookupNativeStableField(owner, offset) {
  /** @type {f64} */
  let result = 0
  Porffor.c`
    if (owner.type == 7 && owner.val != 0) {
      u32 object = (u32)owner.val;
      if ((u32)offset < (u32)*(u16*)(MEM + object) * 20)
        result = *(u32*)(MEM + object + 12) + (u32)offset;
    }
  `
  return result
}

/** Read a numeric data field whose type and layout are stable after construction. */
function readNativeStableFieldNumber(owner, key, hash, site, offset) {
  /** @type {f64} */
  const entry = lookupNativeStableField(owner, offset)
  if (entry === 0) return readNativeFieldNumber(owner, key, hash, site)
  let result = 0
  Porffor.c`memcpy(&result, MEM + (u32)entry + 8, sizeof(result));`
  return result
}

/** A custom i32 field contract already bounds its numeric payload. */
function readNativeStableFieldInteger(owner, key, hash, site, offset) {
  /** @type {f64} */
  const entry = lookupNativeStableField(owner, offset)
  if (entry === 0) return readNativeFieldNumber(owner, key, hash, site) | 0
  /** @type {i32} */
  let result = 0
  Porffor.c`
    f64 payload;
    memcpy(&payload, MEM + (u32)entry + 8, sizeof(payload));
    result = (i32)payload;
  `
  return result
}

/** Retain the actual value tag of a stable own data field. */
function readNativeStableFieldValue(owner, key, hash, site, offset) {
  /** @type {f64} */
  const entry = lookupNativeStableField(owner, offset)
  if (entry === 0) return readNativeFieldValue(owner, key, hash, site)
  let result
  Porffor.c`
    f64 payload;
    memcpy(&payload, MEM + (u32)entry + 8, sizeof(payload));
    result = porf_box(payload, MEM[(u32)entry + 17]);
  `
  return result
}

/** Initialize absent fields normally, then update stable numeric data directly. */
function writeNativeStableFieldNumber(owner, key, hash, site, offset, value) {
  /** @type {f64} */
  const entry = lookupNativeStableField(owner, offset)
  if (entry === 0) return writeNativeFieldNumber(owner, key, hash, site, value)
  Porffor.c`memcpy(MEM + (u32)entry + 8, &value, sizeof(value));`
  return value
}

/** Read a documented number, with normal coercion on a representation miss. */
function readNativeFieldNumber(owner, key, hash, site) {
  /** @type {f64} */
  const entry = lookupNativeField(owner, hash, site)
  let result = 0
  Porffor.c`
    if (entry != 0 && MEM[(u32)entry + 17] == 1) {
      memcpy(&result, MEM + (u32)entry + 8, sizeof(result));
    } else {
      extern jsval p_builtins___Porffor_object_get_withHash(jsval, jsval, i32);
      extern jsval p_builtins___ecma262_ToNumber(jsval);
      jsval value = p_builtins___Porffor_object_get_withHash(owner, key, (i32)hash);
      result = value.type == 1 ? value.val : p_builtins___ecma262_ToNumber(value).val;
    }
  `
  return result
}

/** Read a documented array while retaining its actual runtime value tag. */
function readNativeFieldValue(owner, key, hash, site) {
  /** @type {f64} */
  const entry = lookupNativeField(owner, hash, site)
  let result
  Porffor.c`
    if (entry != 0) {
      f64 payload;
      memcpy(&payload, MEM + (u32)entry + 8, sizeof(payload));
      result = porf_box(payload, MEM[(u32)entry + 17]);
    } else {
      extern jsval p_builtins___Porffor_object_get_withHash(jsval, jsval, i32);
      result = p_builtins___Porffor_object_get_withHash(owner, key, (i32)hash);
    }
  `
  return result
}

/** Store a primitive number directly only when the own field is writable. */
function writeNativeFieldNumber(owner, key, hash, site, value) {
  /** @type {f64} */
  const entry = lookupNativeField(owner, hash, site)
  Porffor.c`
    if (entry != 0 && MEM[(u32)entry + 17] == 1 &&
        (MEM[(u32)entry + 16] & 8)) {
      memcpy(MEM + (u32)entry + 8, &value, sizeof(value));
    } else {
      extern jsval p_builtins___Porffor_object_setStrict_withHash(jsval, jsval, jsval, i32);
      p_builtins___Porffor_object_setStrict_withHash(owner, key, porf_box_num(value), (i32)hash);
    }
  `
  return value
}

const nativeIntrinsics = [
  readNativeNumber,
  readNativeViewWord,
  writeNativeViewWord,
  readNativeArrayLikeNumber,
  writeNativeNumber,
  evaluateNativeMath,
  bitwiseNativeNumber,
  reinterpretNativeNumber,
  remainderNativeInteger,
  powerNativeTwo,
  minimumNativeNumber,
  maximumNativeNumber,
  clearNativeArray,
  fillNativeArray,
  copyNativeArray,
  copyNativeArrayRange,
  lookupNativeField,
  lookupNativeStableField,
  readNativeFieldNumber,
  writeNativeFieldNumber,
  readNativeStableFieldNumber,
  readNativeStableFieldInteger,
  writeNativeStableFieldNumber,
]
/** Preserve a boxed value when storing it in a captured closure binding. */
function boxNativeValue(value) {
  return value
}

const nativeHelpers = [
  ...nativeIntrinsics,
  readNativeFieldValue,
  readNativeStableFieldValue,
  boxNativeValue,
]

/** Number of boxed receiver/key parameters before an intrinsic's numbers. */
function nativeNumericOffset(definition) {
  if (
    [
      copyNativeArray,
      copyNativeArrayRange,
      readNativeFieldNumber,
      writeNativeFieldNumber,
      readNativeFieldValue,
      readNativeStableFieldNumber,
      readNativeStableFieldInteger,
      writeNativeStableFieldNumber,
      readNativeStableFieldValue,
    ].includes(definition)
  )
    return 2
  return [
    readNativeNumber,
    readNativeViewWord,
    writeNativeViewWord,
    readNativeArrayLikeNumber,
    writeNativeNumber,
    clearNativeArray,
    fillNativeArray,
    lookupNativeField,
    lookupNativeStableField,
  ].includes(definition)
    ? 1
    : 0
}

/** Give the numeric intrinsic an unboxed signature in the native compiler. */
function nativeNumericSource(definition) {
  return transformSync(definition.toString(), {
    babelrc: false,
    configFile: false,
    plugins: [
      () => ({
        visitor: {
          Function: {
            enter(p) {
              for (const parameter of p.node.params.slice(
                nativeNumericOffset(definition)
              )) {
                parameter.typeAnnotation = t.tsTypeAnnotation(
                  t.tsTypeReference(t.identifier('f64'))
                )
              }
              if (
                ![readNativeFieldValue, readNativeStableFieldValue].includes(
                  definition
                )
              )
                p.node.returnType = t.tsTypeAnnotation(
                  t.tsTypeReference(
                    t.identifier(
                      [
                        readNativeStableFieldInteger,
                        readNativeViewWord,
                      ].includes(definition)
                        ? 'i32'
                        : 'f64'
                    )
                  )
                )
            },
            exit(p) {
              if (
                ![readNativeFieldValue, readNativeStableFieldValue].includes(
                  definition
                ) ||
                !p.isFunctionDeclaration()
              )
                return
              // This private intrinsic is a value reader, never a constructor.
              p.replaceWith(
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    p.node.id,
                    t.arrowFunctionExpression(p.node.params, p.node.body)
                  ),
                ])
              )
              p.skip()
            },
          },
          VariableDeclarator(p) {
            const tag = documentedTags(p).find((tag) => tag.kind === 'type')
            const type = tag && documentedType(tag.type)
            if (type && t.isIdentifier(p.node.id))
              p.node.id.typeAnnotation = t.tsTypeAnnotation(type)
          },
        },
      }),
    ],
  }).code
}

/** Array and scalar fields whose representation is explicit in codec source. */
const numericArrayFields = new Set()
const numericFields = new Set()
const scalarFields = new Map()
const integerFields = new Set()
const nonIntegerFields = new Set()
const arrayFields = new Map()
const arrayGlobals = new Map()
const matrixGlobals = new Map()
const matrixFields = new Map()
const objectFields = new Map()
const numericGlobals = new Set()
const integerGlobals = new Set()
const functionContracts = new Map()
const classFields = new Map()
const classParents = new Map()
const nativeStableClasses = new Set()
const nativeClassFieldOrders = new Map()
const documentedClassFields = new Map()
const classSources = new Map()
const plainObjectClasses = new Set()
const moduleTypes = new Map()
let nativeFieldSites = 0

/**
 * Match the pinned compiler's property hash, including non-ASCII names.
 *
 * @param {string} name - Statically known property name.
 * @returns {number} Signed 32-bit property hash.
 */
function nativeFieldHash(name) {
  let hash = 374761393
  let word = 0
  let shift = 0
  const mix = () => {
    hash = (hash + Math.imul(word, 3266489917)) | 0
    hash = Math.imul((hash << 17) | (hash >>> 15), 668265263)
    word = 0
    shift = 0
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index)
    word |= (code & 255) << shift
    shift += 8
    if (shift === 32) mix()
    if (code > 255) {
      word |= (code >>> 8) << shift
      shift += 8
      if (shift === 32) mix()
    }
  }
  if (shift) mix()
  hash = Math.imul(hash ^ (hash >>> 15), 2246822519)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489917)
  return hash ^ (hash >>> 16)
}

/**
 * Preserve an ordinary property operation's receiver and static key.
 *
 * @param {object} member - Noncomputed Babel member expression.
 * @param {string} helper - Field operation to emit.
 * @param {object} scope - Containing lexical scope.
 * @param {object[]} [values=[]] - Additional arguments for a store.
 * @returns {object} Babel call expression.
 */
function nativeFieldCall(member, helper, scope, values = []) {
  const fields = nativeObjectFields(member.object, scope)
  const offset = fields?.nativeOffsets?.get(member.property.name)
  if (offset !== undefined)
    helper = {
      readNativeFieldNumber: 'readNativeStableFieldNumber',
      readNativeFieldValue: 'readNativeStableFieldValue',
      writeNativeFieldNumber: 'writeNativeStableFieldNumber',
    }[helper]
  if (
    helper === 'readNativeStableFieldNumber' &&
    fields.get(member.property.name) === 'i32'
  )
    helper = 'readNativeStableFieldInteger'
  return t.callExpression(t.identifier(helper), [
    t.cloneNode(member.object, true),
    t.stringLiteral(member.property.name),
    t.numericLiteral(nativeFieldHash(member.property.name)),
    t.numericLiteral(nativeFieldSites++),
    ...(offset === undefined ? [] : [t.numericLiteral(offset)]),
    ...values,
  ])
}

/**
 * Read JSDoc tags, including custom types, nested records, and optional names.
 *
 * @param {object[]} comments - Babel comment nodes.
 * @returns {object[]} Parsed tags.
 */
function documentationTags(comments = []) {
  const text = comments.map((comment) => comment.value).join('\n')
  const tags = []
  const pattern =
    /@(param|returns?|type|typedef|property|nativeUnchecked|nativeBitcast|nativeStable)\b[ \t]*/g
  for (const match of text.matchAll(pattern)) {
    let cursor = match.index + match[0].length
    if (['nativeUnchecked', 'nativeStable'].includes(match[1])) {
      tags.push({ kind: match[1] })
      continue
    }
    if (text[cursor] !== '{') continue
    cursor++
    const start = cursor
    let depth = 1
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '{') depth++
      if (text[cursor] === '}') depth--
      cursor++
    }
    if (depth !== 0) continue
    const name = text.slice(cursor).match(/^\s*(\[[^\]]+\]|[^\s*]+)/)?.[1]
    tags.push({
      kind: match[1] === 'return' ? 'returns' : match[1],
      type: text.slice(start, cursor - 1).trim(),
      name: name?.replace(/^\[|\]$/g, '').split('=')[0],
    })
  }
  return tags
}

/** @param {object} p - Babel node path. @returns {object[]} Its JSDoc tags. */
function documentedTags(p) {
  const comments =
    p.node.leadingComments || p.parentPath?.node.leadingComments || []
  return comments.flatMap((comment) => {
    const tags = documentationTags([comment])
    // Standalone typedefs describe their own records, not the next declaration.
    return tags.some((tag) => tag.kind === 'typedef') ? [] : tags
  })
}

/**
 * Keep typedefs scoped to their source module, including record properties.
 *
 * @param {object} p - Babel program path.
 * @param {object} state - Babel file state.
 */
function collectDocumentedTypes(p, state) {
  p.scope.nativeSource = state.file.opts.filename
  const aliases = new Map()
  for (const comment of state.file.ast.comments || []) {
    const tags = documentationTags([comment])
    const definition = tags.find((tag) => tag.kind === 'typedef')
    if (!definition?.name) continue
    aliases.set(definition.name, {
      type: definition.type,
      fields: new Map(
        tags
          .filter((tag) => tag.kind === 'property')
          .map((tag) => [tag.name, tag.type])
      ),
    })
  }
  p.scope.nativeTypes = aliases
  moduleTypes.set(p.scope.nativeSource, aliases)
}

/** Resolve a local or imported JSDoc definition in its declaring module. */
function documentedDefinition(name, scope) {
  const program = scope.getProgramParent()
  const imported = name.match(/^import\(['"](.+?)['"]\)\.(\w+)$/)
  const source = imported
    ? path.resolve(path.dirname(program.nativeSource), imported[1])
    : program.nativeSource
  return {
    source,
    name: imported?.[2] || name,
    definition: moduleTypes.get(source)?.get(imported?.[2] || name),
  }
}

/** Keep record references relative to the module that declares their fields. */
function qualifyDocumentedType(type, source) {
  if (typeof type !== 'string') return type
  const rows = type.match(/^(?:Array<(.+)>|(.+)\[\])$/)
  if (rows) {
    const element = qualifyDocumentedType(rows[1] || rows[2], source)
    return rows[1] ? 'Array<' + element + '>' : element + '[]'
  }
  if (type.includes('|'))
    return type
      .split('|')
      .map((part) => qualifyDocumentedType(part, source))
      .join('|')
  const imported = type.match(/^import\(['"](.+?)['"]\)\.(\w+)$/)
  if (imported)
    return (
      'import(' +
      JSON.stringify(path.resolve(path.dirname(source), imported[1])) +
      ').' +
      imported[2]
    )
  return moduleTypes.get(source)?.has(type)
    ? 'import(' + JSON.stringify(source) + ').' + type
    : type
}

/** Match JSDoc parameter paths to direct or destructured argument bindings. */
function documentedParameters(p, tags) {
  const roots = tags.filter(
    (tag) => tag.kind === 'param' && tag.name && !tag.name.includes('.')
  )
  const parameters = []
  for (const tag of tags.filter((tag) => tag.kind === 'param' && tag.name)) {
    const [rootName, ...fields] = tag.name.split('.')
    const index = roots.findIndex((root) => root.name === rootName)
    let parameter = p.node.params.find((candidate) =>
      t.isIdentifier(
        t.isAssignmentPattern(candidate) ? candidate.left : candidate,
        { name: rootName }
      )
    )
    if (!parameter) {
      const candidate = p.node.params[index]
      const pattern = t.isAssignmentPattern(candidate)
        ? candidate.left
        : candidate
      if (t.isObjectPattern(pattern)) parameter = candidate
    }
    if (!parameter) continue
    const direct = fields.length === 0
    for (const field of fields) {
      const pattern = t.isAssignmentPattern(parameter)
        ? parameter.left
        : parameter
      if (!t.isObjectPattern(pattern)) {
        parameter = null
        break
      }
      parameter = pattern.properties.find(
        (property) =>
          t.isObjectProperty(property) &&
          t.isIdentifier(property.key, { name: field })
      )?.value
      if (!parameter) break
    }
    const target = t.isAssignmentPattern(parameter) ? parameter.left : parameter
    if (!t.isIdentifier(target)) continue
    const binding = p.scope.getBinding(target.name)
    if (binding)
      parameters.push({ binding, parameter, target, direct, type: tag.type })
  }
  return parameters
}

/** Resolve a local JSDoc typedef without changing its underlying JS type. */
function resolveDocumentedType(name, scope, visited = new Set()) {
  name = name.trim().replace(/Array\.</g, 'Array<')
  const { definition, source } = documentedDefinition(name, scope)
  if (!definition || definition.type === 'object' || visited.has(name))
    return name
  visited.add(name)
  const imported = definition.type.match(/^import\(['"](.+?)['"]\)\.(\w+)$/)
  const target = imported
    ? 'import(' +
      JSON.stringify(path.resolve(path.dirname(source), imported[1])) +
      ').' +
      imported[2]
    : definition.type
  return resolveDocumentedType(target, scope, visited)
}

/** Resolve the fields of a documented record, allowing an absent value. */
function documentedFields(name, scope) {
  if (typeof name !== 'string') return null
  const valueType = resolveDocumentedType(
    name.replace(/^(?:null|undefined)\||\|(?:null|undefined)$/g, ''),
    scope
  )
  const program = scope.getProgramParent()
  const imported = documentedDefinition(valueType, scope)
  if (imported.definition?.fields.size) return imported.definition.fields
  const binding = program.getBinding(valueType)
  let classKey = imported.source + '\0' + imported.name
  if (binding?.kind === 'module') {
    const declaration = binding.path.parentPath.node
    const imported = binding.path.node.imported?.name
    if (t.isImportDeclaration(declaration) && imported) {
      classKey =
        path.resolve(
          path.dirname(program.nativeSource),
          declaration.source.value
        ) +
        '\0' +
        imported
    }
  } else if (!binding && classSources.get(valueType)) {
    classKey = classSources.get(valueType)
  }
  return (
    program.nativeTypes?.get(valueType)?.fields || classFields.get(classKey)
  )
}

/** Identify the class that owns a lexical `this`, keeping module names separate. */
function owningClassKey(scope) {
  let owner = scope.getFunctionParent()?.path
  while (owner?.isArrowFunctionExpression())
    owner = owner.parentPath.getFunctionParent()
  if (!owner?.isClassMethod()) return null
  const declaration = owner.findParent((p) => p.isClass())
  const name = declaration?.node.id?.name
  return name ? scope.getProgramParent().nativeSource + '\0' + name : null
}

/** Look up fields owned by a class or a documented record. */
function nativeObjectFields(node, scope) {
  if (node?.nativeFields) return node.nativeFields
  if (t.isIdentifier(node)) return scope.getBinding(node.name)?.nativeFields
  if (t.isThisExpression(node)) return classFields.get(owningClassKey(scope))
  if (t.isMemberExpression(node) && node.computed)
    return documentedFields(rowType(node.object, scope), scope)
  if (t.isMemberExpression(node) && !node.computed) {
    const field = nativeObjectFields(node.object, scope)?.get(
      node.property.name
    )
    if (field instanceof Map) return field
    return documentedFields(field, scope)
  }
  return null
}

/** Record the scalar, array, and field types documented on a binding. */
function recordDocumentedBinding(binding, name) {
  name = resolveDocumentedType(name, binding.scope)
  const fields = documentedFields(name, binding.scope)
  if (fields?.size) binding.nativeFields = fields
  if (/^(Float|Int|Uint)\d+Array\|null$/.test(name))
    binding.nativeNullableArrayType = name.split('|')[0]
  if (/^(Float|Int|Uint)\d+Array$/.test(name) || name === 'Buffer') {
    binding.nativeArrayType = name === 'Buffer' ? 'Uint8Array' : name
  }
  if (
    name.includes('|') &&
    name.split('|').every((type) => /^(Float|Int|Uint)\d+Array$/.test(type))
  )
    binding.nativeArrayType = name
  if (name === 'number' || name === 'f64') binding.nativeShape = 'number'
  if (name === 'i32') {
    binding.nativeShape = 'integer'
    binding.nativeIntegerContract = true
  }
  if (name === 'boolean') binding.nativeBoolean = true
  if (name === 'DataView') binding.nativeDataView = true
  if (
    name === 'Array<number>' ||
    name === 'ArrayLike<number>' ||
    name === 'number[]' ||
    name === 'i32[]' ||
    name.split('|').every((type) => /^(Float|Int|Uint)\d+Array$/.test(type))
  )
    binding.nativeShape = 'array'
  const rows = name.match(/^(?:Array<(.+)>|(.+)\[\])$/)
  if (rows) {
    binding.nativeJsArray = true
    const element = rows[1] || rows[2]
    if (/^(Float|Int|Uint)\d+Array$/.test(element))
      binding.nativeShape = 'arrays'
    binding.nativeElementType = element
  }
}

/** Numeric return contract already declared by a function's JSDoc. */
function returnType(binding) {
  if (!binding) return null
  if (binding.kind === 'module') {
    return (
      functionContracts.get(binding.path.node.imported?.name)?.returned || null
    )
  }
  const tag = documentedTags(binding.path).find((tag) => tag.kind === 'returns')
  return tag ? resolveDocumentedType(tag.type, binding.scope) : null
}

/** Keep a documented instance method's result type without changing its dispatch. */
function documentedMethodReturn(member, scope) {
  if (member.computed || !t.isIdentifier(member.property)) return null
  return (
    nativeObjectFields(member.object, scope)?.nativeMethodReturns?.get(
      member.property.name
    ) || null
  )
}

/** Recognize boolean values before lowering an explicit Number conversion. */
function booleanValue(node, scope, visited = new Set()) {
  if (t.isParenthesizedExpression(node))
    return booleanValue(node.expression, scope, visited)
  if (t.isTSAsExpression(node)) return t.isTSBooleanKeyword(node.typeAnnotation)
  if (t.isBooleanLiteral(node) || t.isUnaryExpression(node, { operator: '!' }))
    return true
  if (t.isBinaryExpression(node))
    return [
      '===',
      '!==',
      '==',
      '!=',
      '<',
      '>',
      '<=',
      '>=',
      'in',
      'instanceof',
    ].includes(node.operator)
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name)
    if (!binding || visited.has(binding)) return false
    if (binding.nativeBoolean) return true
    visited.add(binding)
    return (
      binding.constant && booleanValue(binding.path.node.init, scope, visited)
    )
  }
  if (t.isMemberExpression(node) && !node.computed)
    return (
      nativeObjectFields(node.object, scope)?.get(node.property.name) ===
      'boolean'
    )
  if (t.isCallExpression(node)) {
    if (t.isIdentifier(node.callee))
      return (
        node.callee.name === 'Boolean' ||
        returnType(scope.getBinding(node.callee.name)) === 'boolean'
      )
    if (t.isMemberExpression(node.callee))
      return (
        t.isIdentifier(node.callee.object, { name: 'Number' }) &&
        ['isNaN', 'isFinite', 'isInteger'].includes(node.callee.property.name)
      )
  }
  return false
}

/** Check a direct call's JSDoc before unboxing one numeric argument. */
function numericArgument(argument) {
  const call = argument.parentPath
  if (!call.isCallExpression() || !t.isIdentifier(call.node.callee))
    return false
  const index = call.node.arguments.indexOf(argument.node)
  if (index < 0) return false
  const intrinsic = nativeIntrinsics.find(
    (definition) => definition.name === call.node.callee.name
  )
  if (intrinsic) {
    return index >= nativeNumericOffset(intrinsic)
  }
  const binding = call.scope.getBinding(call.node.callee.name)
  if (!binding) return false
  let type
  if (binding.kind === 'module') {
    type = functionContracts.get(binding.path.node.imported?.name)
      ?.parameters?.[index]
  } else {
    const parameter = binding.path.node.params?.[index]
    const name = t.isAssignmentPattern(parameter)
      ? parameter.left.name
      : parameter?.name
    type = documentedTags(binding.path).find(
      (tag) => tag.kind === 'param' && tag.name === name
    )?.type
  }
  return (
    type &&
    ['number', 'f64', 'i32'].includes(resolveDocumentedType(type, call.scope))
  )
}

/** Select element storage and honor explicit JSDoc access preconditions. */
function nativeElementKind(array, p, writing = false) {
  const kinds = [
    'Float32Array',
    'Float64Array',
    'Int32Array',
    'Uint8Array',
    'Int16Array',
    'Uint16Array',
    'Uint32Array',
    'Int8Array',
  ]
  let kind = kinds.indexOf(array)
  if (kind === -1 && writing && array?.includes('|')) {
    const types = array.split('|')
    if (types.every((type) => kinds.includes(type)) && nativeCopyLane(array))
      kind =
        { 2: 6, 4: 5, 7: 3 }[kinds.indexOf(types[0])] ?? kinds.indexOf(types[0])
  }
  if (kind === -1) return kind
  return nativeUncheckedScope(p.scope) ? kind + 8 : kind
}

/** Whether the containing function documents complete numeric access bounds. */
function nativeUncheckedScope(scope) {
  const owner = scope.getFunctionParent()?.path
  return (
    owner && documentedTags(owner).some((tag) => tag.kind === 'nativeUnchecked')
  )
}

/** Storage families for a copy that requires no per-element conversion. */
function nativeCopyLane(array) {
  const lanes = array
    ?.split('|')
    .map((type) => type.replace(/^(?:Uint|Int)(\d+)Array$/, 'Integer$1Array'))
  return lanes?.length && lanes.every((lane) => lane === lanes[0])
    ? lanes[0]
    : null
}

/** Identify a constructed class in its declaring module, including imports. */
function constructedType(node, scope) {
  if (!t.isNewExpression(node) || !t.isIdentifier(node.callee)) return null
  const binding = scope.getBinding(node.callee.name)
  if (!binding) return null
  const program = scope.getProgramParent()
  let source = program.nativeSource
  let name = node.callee.name
  if (binding.kind === 'module') {
    const declaration = binding.path.parentPath.node
    name = binding.path.node.imported?.name
    if (!name || !t.isImportDeclaration(declaration)) return null
    source = path.resolve(path.dirname(source), declaration.source.value)
  } else if (!binding.path.isClassDeclaration()) return null
  return 'import(' + JSON.stringify(source) + ').' + name
}

/** Follow documented collection elements and explicit array construction. */
function rowType(node, scope, visited = new Set()) {
  if (!node) return null
  if (node.nativeElementType) return node.nativeElementType
  if (t.isTSAsExpression(node)) return rowType(node.expression, scope, visited)
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name)
    if (!binding || visited.has(binding)) return null
    if (binding.nativeElementType) return binding.nativeElementType
    if (binding.kind === 'module')
      return matrixGlobals.get(binding.path.node.imported?.name) || null
    visited.add(binding)
    return rowType(binding.path.node?.init, binding.path.scope, visited)
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: 'Object' }) &&
    ['freeze', 'seal', 'preventExtensions'].includes(node.callee.property.name)
  )
    return rowType(node.arguments[0], scope, visited)
  if (t.isMemberExpression(node) && node.computed) {
    const parent = rowType(node.object, scope, visited)
    return (
      parent
        ?.match(/^(?:Array<(.+)>|(.+)\[\])$/)
        ?.slice(1)
        .find(Boolean) || null
    )
  }
  if (t.isMemberExpression(node) && !node.computed) {
    const fields = nativeObjectFields(node.object, scope)
    const documented = fields?.get(node.property.name)
    return (
      (typeof documented === 'string'
        ? documented
            .match(/^(?:Array<(.+)>|(.+)\[\])$/)
            ?.slice(1)
            .find(Boolean)
        : null) ||
      matrixFields.get(node.property.name) ||
      null
    )
  }
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    const returned = returnType(scope.getBinding(node.callee.name))
    return (
      returned
        ?.match(/^(?:Array<(.+)>|(.+)\[\])$/)
        ?.slice(1)
        .find(Boolean) || null
    )
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    ['from', 'map'].includes(node.callee.property.name)
  ) {
    const mapper = node.arguments[node.callee.property.name === 'from' ? 1 : 0]
    if (t.isArrowFunctionExpression(mapper) || t.isFunctionExpression(mapper)) {
      const returned = t.isBlockStatement(mapper.body)
        ? mapper.body.body.find((statement) => t.isReturnStatement(statement))
            ?.argument
        : mapper.body
      const type =
        arrayType(returned, scope) || constructedType(returned, scope)
      if (type) return type
      const nested = rowType(returned, scope, visited)
      if (nested) return nested + '[]'
      if (
        node.callee.property.name === 'map' &&
        t.isCallExpression(returned) &&
        t.isMemberExpression(returned.callee) &&
        t.isIdentifier(returned.callee.object, {
          name: mapper.params[0]?.name,
        }) &&
        ['slice', 'subarray'].includes(returned.callee.property.name)
      )
        return rowType(node.callee.object, scope, visited)
    }
  }
  // Numeric-key dictionaries retain object lookup semantics even when values share a type.
  const rows = t.isArrayExpression(node) ? node.elements : []
  if (!rows.length) return null
  const types = rows.map(
    (row) => arrayType(row, scope) || constructedType(row, scope)
  )
  return types[0] && types.every((type) => type === types[0]) ? types[0] : null
}

/** Recognize ordinary arrays through explicit construction and JSDoc contracts. */
function documentedJsArray(node, scope, visited = new Set()) {
  if (t.isArrayExpression(node)) return true
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name)
    if (!binding || visited.has(binding)) return false
    if (binding.nativeJsArray) return true
    if (!binding.constant) return false
    visited.add(binding)
    return documentedJsArray(binding.path.node.init, binding.scope, visited)
  }
  if (t.isMemberExpression(node) && !node.computed) {
    const type = nativeObjectFields(node.object, scope)?.get(node.property.name)
    return typeof type === 'string' && /^(?:Array<.+>|.+\[\])$/.test(type)
  }
  if (t.isCallExpression(node)) {
    if (t.isIdentifier(node.callee))
      return /^(?:Array<.+>|.+\[\])$/.test(
        returnType(scope.getBinding(node.callee.name))
      )
    if (t.isMemberExpression(node.callee)) {
      if (
        t.isIdentifier(node.callee.object, { name: 'Array' }) &&
        t.isIdentifier(node.callee.property, { name: 'from' })
      )
        return true
      if (
        t.isIdentifier(node.callee.object, { name: 'Object' }) &&
        t.isIdentifier(node.callee.property, { name: 'freeze' })
      )
        return documentedJsArray(node.arguments[0], scope, visited)
      if (['map', 'filter', 'slice'].includes(node.callee.property.name))
        return documentedJsArray(node.callee.object, scope, visited)
    }
  }
  return false
}

/**
 * Follow explicit typed-array construction and aliases in the native copy.
 *
 * @param {object} node - Expression to inspect
 * @param {object} scope - Containing lexical scope
 * @param {Set<object>} [visited] - Bindings already followed
 * @returns {string|null} Concrete typed-array constructor, when proven
 */
function arrayType(node, scope, visited = new Set()) {
  if (!node) return null
  if (t.isParenthesizedExpression(node))
    return arrayType(node.expression, scope, visited)
  if (t.isTSAsExpression(node)) {
    const type = node.typeAnnotation.typeName?.name
    if (/^(Float|Int|Uint)\d+Array$/.test(type)) return type
    if (t.isTSUnionType(node.typeAnnotation)) {
      const types = node.typeAnnotation.types.map((type) => type.typeName?.name)
      if (types.every((type) => /^(Float|Int|Uint)\d+Array$/.test(type)))
        return types.join('|')
    }
    return arrayType(node.expression, scope, visited)
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: 'Object' }) &&
    ['freeze', 'seal', 'preventExtensions'].includes(node.callee.property.name)
  )
    return arrayType(node.arguments[0], scope, visited)
  if (
    t.isNewExpression(node) &&
    t.isIdentifier(node.callee) &&
    /^(Float|Int|Uint)\d+Array$/.test(node.callee.name)
  )
    return node.callee.name
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name)
    if (!binding || visited.has(binding)) return null
    if (binding.nativeArrayType) return binding.nativeArrayType
    visited.add(binding)
    if (binding.kind === 'module')
      return arrayGlobals.get(binding.path.node.imported?.name) || null
    return arrayType(binding.path.node?.init, binding.path.scope, visited)
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (node.computed) {
      const row = rowType(node.object, scope)
      if (/^(Float|Int|Uint)\d+Array$/.test(row)) return row
    }
    if (node.computed && t.isIdentifier(node.object)) {
      const binding = scope.getBinding(node.object.name)
      if (/^(Float|Int|Uint)\d+Array$/.test(binding?.nativeElementType))
        return binding.nativeElementType
    }
    if (!node.computed && t.isIdentifier(node.property)) {
      const type = nativeObjectFields(node.object, scope)?.get(
        node.property.name
      )
      if (/^(Float|Int|Uint)\d+Array$/.test(type)) return type
      return arrayFields.get(node.property.name) || null
    }
  }
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object) &&
    /^(Float|Int|Uint)\d+Array$/.test(node.callee.object.name) &&
    ['from', 'of'].includes(node.callee.property.name)
  )
    return node.callee.object.name
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    ['slice', 'subarray', 'fill'].includes(node.callee.property.name)
  )
    return arrayType(node.callee.object, scope, visited)
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    const type = returnType(scope.getBinding(node.callee.name))
    if (/^(Float|Int|Uint)\d+Array$/.test(type)) return type
  }
  if (
    t.isLogicalExpression(node) &&
    node.operator === '??' &&
    t.isCallExpression(node.right) &&
    t.isIdentifier(node.right.callee, { name: 'throwError' })
  )
    return arrayType(node.left, scope, visited)
  if (t.isLogicalExpression(node) && node.operator === '??') {
    const fallback = arrayType(node.right, scope, visited)
    if (
      fallback &&
      t.isIdentifier(node.left) &&
      scope.getBinding(node.left.name)?.nativeNullableArrayType === fallback
    )
      return fallback
  }
  if (
    t.isCallExpression(node) &&
    t.isArrowFunctionExpression(node.callee) &&
    t.isBlockStatement(node.callee.body)
  ) {
    const returned = node.callee.body.body.find((statement) =>
      t.isReturnStatement(statement)
    )?.argument
    if (t.isIdentifier(returned)) {
      for (const statement of node.callee.body.body) {
        if (!t.isVariableDeclaration(statement)) continue
        const declaration = statement.declarations.find((declaration) =>
          t.isIdentifier(declaration.id, { name: returned.name })
        )
        if (declaration) return arrayType(declaration.init, scope, visited)
      }
    }
  }
  return null
}

/** Record a field type only when its explicit initializers agree. */
function recordFieldType(fields, name, type) {
  if (!fields.has(name)) fields.set(name, type)
  else if (fields.get(name) !== type) fields.set(name, null)
}

/** Follow only linear own-field initialization and local initializer methods. */
function classInitializationOrder(node) {
  if (
    node.superClass ||
    node.body.body.some((member) => !t.isClassMethod(member))
  )
    return null
  const methods = new Map(
    node.body.body.map((method) => [method.key.name, method])
  )
  const fields = new Set()
  const active = new Set()
  function exposesReceiver(value) {
    if (!value) return false
    if (t.isThisExpression(value)) return true
    if (t.isMemberExpression(value)) return false
    return (t.VISITOR_KEYS[value.type] || []).some((key) => {
      const child = value[key]
      return Array.isArray(child)
        ? child.some(exposesReceiver)
        : exposesReceiver(child)
    })
  }
  function hasUnknownMutation(statement) {
    let unknown = false
    const root = t.isExpressionStatement(statement)
      ? statement.expression
      : null
    t.traverseFast(statement, (part) => {
      if (
        part !== root &&
        ((t.isAssignmentExpression(part) &&
          t.isMemberExpression(part.left) &&
          t.isThisExpression(part.left.object)) ||
          (t.isCallExpression(part) &&
            t.isMemberExpression(part.callee) &&
            t.isThisExpression(part.callee.object)))
      )
        unknown = true
      if (
        t.isUnaryExpression(part, { operator: 'delete' }) ||
        t.isUpdateExpression(part)
      )
        unknown = true
      if (!t.isCallExpression(part) && !t.isNewExpression(part)) return
      if (!part.arguments.some(exposesReceiver)) return
      const freezing =
        t.isCallExpression(part) &&
        t.isMemberExpression(part.callee) &&
        !part.callee.computed &&
        t.isIdentifier(part.callee.object, { name: 'Object' }) &&
        t.isIdentifier(part.callee.property, { name: 'freeze' })
      if (!freezing) unknown = true
    })
    return unknown
  }
  function visit(method) {
    if (!method || active.has(method)) return false
    active.add(method)
    for (const statement of method.body.body) {
      if (hasUnknownMutation(statement)) return false
      if (t.isReturnStatement(statement)) break
      if (t.isVariableDeclaration(statement)) continue
      if (!t.isExpressionStatement(statement)) return false
      const expression = statement.expression
      if (
        t.isAssignmentExpression(expression) &&
        t.isMemberExpression(expression.left) &&
        t.isThisExpression(expression.left.object)
      ) {
        if (
          expression.left.computed ||
          expression.operator !== '=' ||
          exposesReceiver(expression.right)
        )
          return false
        fields.add(expression.left.property.name)
      } else if (
        t.isCallExpression(expression) &&
        t.isMemberExpression(expression.callee) &&
        t.isThisExpression(expression.callee.object)
      ) {
        if (
          expression.callee.computed ||
          !visit(methods.get(expression.callee.property.name))
        )
          return false
      }
    }
    active.delete(method)
    return true
  }
  return visit(methods.get('constructor')) ? [...fields] : null
}

/**
 * Translate a documented numeric type without guessing an array representation.
 *
 * @param {string} name - Existing JSDoc type
 * @returns {object|null} Babel type annotation for the native copy
 */
function documentedType(name) {
  name = name.trim().replace(/Array\.</g, 'Array<')
  if (name === 'Buffer') return t.tsTypeReference(t.identifier('Uint8Array'))
  if (name === 'number' || name === 'f64')
    return t.tsTypeReference(t.identifier('f64'))
  if (name === 'i32') return t.tsTypeReference(t.identifier('i32'))
  if (name === 'boolean') return t.tsBooleanKeyword()
  if (name === 'Function') return t.tsTypeReference(t.identifier('Function'))
  if (name === 'DataView') return t.tsTypeReference(t.identifier('DataView'))
  if (/^(Float|Int|Uint)\d+Array$/.test(name)) {
    return t.tsTypeReference(t.identifier(name))
  }
  if (name === 'Array<number>' || name === 'number[]') {
    return t.tsArrayType(t.tsNumberKeyword())
  }
  if (name.includes('|')) {
    const types = name.split('|').map(documentedType)
    if (types.every(Boolean)) return t.tsUnionType(types)
  }
  const arrays = name.match(/^(?:Array<(.+)>|(.+)\[\])$/)
  if (arrays) {
    const element = documentedType(arrays[1] || arrays[2]) || t.tsAnyKeyword()
    return t.tsArrayType(element)
  }
  return null
}

/**
 * Determine the numeric shape of an expression without changing array storage.
 *
 * @param {object} node - Babel expression node
 * @param {object} scope - Lexical scope containing the expression
 * @param {Set<object>} [visited] - Bindings already inspected
 * @returns {string|null} Numeric scalar, integer, numeric array, or array of arrays
 */
function numericShape(node, scope, visited = new Set()) {
  if (!node) return null
  if (node.nativeShape) return node.nativeShape
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: 'Number' }) &&
    node.arguments.length === 1 &&
    booleanValue(node.arguments[0], scope)
  )
    return 'integer'
  if (t.isParenthesizedExpression(node))
    return numericShape(node.expression, scope, visited)
  if (t.isTSAsExpression(node)) {
    const type = node.typeAnnotation.typeName?.name
    if (type === 'i32') return 'integer'
    if (type === 'f64') return 'number'
    return numericShape(node.expression, scope, visited)
  }
  if (t.isNumericLiteral(node))
    return Number.isInteger(node.value) &&
      node.value >= -2147483648 &&
      node.value <= 2147483647
      ? 'integer'
      : 'number'
  if (arrayType(node, scope)) return 'array'
  if (t.isIdentifier(node)) {
    if (node.name === 'Infinity' || node.name === 'NaN') return 'number'
    const binding = scope.getBinding(node.name)
    if (!binding || visited.has(binding)) return null
    if (binding.nativeShape) return binding.nativeShape
    if (
      binding.kind === 'module' &&
      numericGlobals.has(binding.path.node.imported?.name)
    )
      return integerGlobals.has(binding.path.node.imported?.name)
        ? 'integer'
        : 'number'
    if (binding.constantViolations.length) return null
    visited.add(binding)
    return numericShape(binding.path.node?.init, binding.path.scope, visited)
  }
  if (
    t.isNewExpression(node) &&
    t.isIdentifier(node.callee) &&
    /^(Float|Int|Uint)\d+Array$/.test(node.callee.name)
  )
    return 'array'
  if (t.isUnaryExpression(node) && ['+', '-', '~'].includes(node.operator))
    return node.operator === '~' ? 'integer' : 'number'
  if (t.isBinaryExpression(node)) {
    const left = numericShape(node.left, scope, new Set(visited))
    const right = numericShape(node.right, scope, new Set(visited))
    if (
      ['+', '-', '*', '%'].includes(node.operator) &&
      left === 'integer' &&
      right === 'integer'
    )
      return 'integer'
    if (['|', '&', '^', '<<', '>>'].includes(node.operator)) return 'integer'
    if (['-', '*', '/', '%', '**', '>>>'].includes(node.operator))
      return 'number'
    if (
      node.operator === '+' &&
      ['number', 'integer'].includes(
        numericShape(node.left, scope, new Set(visited))
      ) &&
      ['number', 'integer'].includes(
        numericShape(node.right, scope, new Set(visited))
      )
    )
      return 'number'
  }
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    if (node.callee.name === 'Number') return 'number'
    const type = returnType(scope.getBinding(node.callee.name))
    if (type === 'i32') return 'integer'
    if (type === 'number' || type === 'f64') return 'number'
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    const returned = documentedMethodReturn(node.callee, scope)
    if (returned === 'i32') return 'integer'
    if (returned === 'number' || returned === 'f64') return 'number'
    if (t.isIdentifier(node.callee.object, { name: 'Math' })) {
      if (
        ['floor', 'ceil', 'trunc'].includes(node.callee.property.name) &&
        node.arguments.length === 1
      ) {
        const argument = node.arguments[0]
        // Rounding a bounded integer ratio with a positive divisor stays i32.
        if (
          numericShape(argument, scope, new Set(visited)) === 'integer' ||
          (t.isBinaryExpression(argument, { operator: '/' }) &&
            numericShape(argument.left, scope, new Set(visited)) ===
              'integer' &&
            t.isNumericLiteral(argument.right) &&
            argument.right.value >= 1)
        )
          return 'integer'
      }
      if (
        ['min', 'max'].includes(node.callee.property.name) &&
        node.arguments.every(
          (argument) =>
            numericShape(argument, scope, new Set(visited)) === 'integer'
        )
      )
        return 'integer'
      return 'number'
    }
    if (
      t.isIdentifier(node.callee.property) &&
      ['slice', 'subarray'].includes(node.callee.property.name)
    )
      return numericShape(node.callee.object, scope, visited)
  }
  if (t.isConditionalExpression(node)) {
    const consequent = numericShape(node.consequent, scope, new Set(visited))
    const alternate = numericShape(node.alternate, scope, new Set(visited))
    if (
      ['number', 'integer'].includes(consequent) &&
      ['number', 'integer'].includes(alternate)
    )
      return consequent === 'integer' && alternate === 'integer'
        ? 'integer'
        : 'number'
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!node.computed && t.isIdentifier(node.property)) {
      const type = nativeObjectFields(node.object, scope)?.get(
        node.property.name
      )
      if (type === 'i32') return 'integer'
      if (type === 'number' || type === 'f64') return 'number'
      if (['number[]', 'i32[]', 'Array<number>'].includes(type)) return 'array'
      if (integerFields.has(node.property.name)) return 'integer'
      if (
        node.property.name === 'length' &&
        (arrayType(node.object, scope) || documentedJsArray(node.object, scope))
      )
        return 'integer'
      if (
        node.property.name === 'length' ||
        numericFields.has(node.property.name)
      )
        return 'number'
      if (numericArrayFields.has(node.property.name)) return 'array'
    }
    if (node.computed) {
      const element = rowType(node.object, scope)
      if (element === 'i32')
        return nativeUncheckedScope(scope) ? 'integer' : 'number'
      if (element === 'number' || element === 'f64') return 'number'
      if (
        [
          'Int32Array',
          'Uint8Array',
          'Int16Array',
          'Uint16Array',
          'Int8Array',
        ].includes(arrayType(node.object, scope))
      )
        return nativeUncheckedScope(scope) ? 'integer' : 'number'
      const array = numericShape(node.object, scope, visited)
      if (array === 'array') return 'number'
      if (array === 'arrays') return 'array'
    }
  }
  if (
    t.isLogicalExpression(node) &&
    node.operator === '??' &&
    t.isCallExpression(node.right) &&
    t.isIdentifier(node.right.callee, { name: 'throwError' })
  )
    return numericShape(node.left, scope, visited)
  return null
}

/**
 * Read explicit field initializers before preparing native source copies.
 *
 * @param {string} directory - Codec directory to inspect
 */
function collectNumericFields(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectNumericFields(filename)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    transformSync(fs.readFileSync(filename, 'utf8'), {
      filename,
      babelrc: false,
      configFile: false,
      plugins: [
        () => ({
          visitor: {
            Program(p, state) {
              collectDocumentedTypes(p, state)
            },
            Class(p) {
              if (!p.node.id) return
              const key =
                p.scope.getProgramParent().nativeSource + '\0' + p.node.id.name
              recordFieldType(classSources, p.node.id.name, key)
              if (t.isIdentifier(p.node.superClass)) {
                const parent = p.scope.getBinding(p.node.superClass.name)
                if (parent?.path.isClassDeclaration()) {
                  classParents.set(
                    key,
                    parent.scope.getProgramParent().nativeSource +
                      '\0' +
                      parent.path.node.id.name
                  )
                } else if (parent?.kind === 'module') {
                  const declaration = parent.path.parentPath.node
                  const name = parent.path.node.imported?.name
                  if (name && t.isImportDeclaration(declaration))
                    classParents.set(
                      key,
                      path.resolve(
                        path.dirname(filename),
                        declaration.source.value
                      ) +
                        '\0' +
                        name
                    )
                }
              }
              if (documentedTags(p).some((tag) => tag.kind === 'nativeStable'))
                nativeStableClasses.add(key)
              nativeClassFieldOrders.set(key, classInitializationOrder(p.node))
              if (!p.node.superClass) plainObjectClasses.add(key)
              if (!classFields.has(key)) classFields.set(key, new Map())
              const methods = new Map()
              for (const method of p.get('body.body')) {
                if (
                  !method.isClassMethod({ kind: 'method' }) ||
                  method.node.static ||
                  method.node.computed
                )
                  continue
                const returned = documentedTags(method).find(
                  (tag) => tag.kind === 'returns'
                )
                methods.set(
                  method.node.key.name,
                  returned
                    ? resolveDocumentedType(returned.type, method.scope)
                    : null
                )
              }
              classFields.get(key).nativeMethodReturns = methods
              const fields = documentedTags(p).filter(
                (tag) => tag.kind === 'property'
              )
              if (fields.length)
                documentedClassFields.set(
                  key,
                  new Map(
                    fields.map((tag) => [
                      tag.name,
                      resolveDocumentedType(tag.type, p.scope),
                    ])
                  )
                )
            },
            Function(p) {
              const tags = documentedTags(p)
              if (p.node.id && p.parentPath.isExportNamedDeclaration()) {
                const returned = tags.find((tag) => tag.kind === 'returns')
                functionContracts.set(p.node.id.name, {
                  returned: returned
                    ? resolveDocumentedType(returned.type, p.scope)
                    : null,
                  fields: returned
                    ? documentedFields(returned.type, p.scope)
                    : null,
                  parameters: p.node.params.map((parameter) => {
                    const name = t.isAssignmentPattern(parameter)
                      ? parameter.left.name
                      : parameter.name
                    const tag = tags.find(
                      (tag) => tag.kind === 'param' && tag.name === name
                    )
                    return tag ? resolveDocumentedType(tag.type, p.scope) : null
                  }),
                })
              }
              for (const parameter of documentedParameters(p, tags)) {
                recordDocumentedBinding(parameter.binding, parameter.type)
              }
            },
            VariableDeclarator(p) {
              if (
                t.isIdentifier(p.node.id) &&
                (p.parentPath.parentPath.isProgram() ||
                  p.parentPath.parentPath.isExportNamedDeclaration())
              ) {
                const type = arrayType(p.node.init, p.scope)
                if (type) arrayGlobals.set(p.node.id.name, type)
                const row = rowType(p.node.init, p.scope)
                if (row) matrixGlobals.set(p.node.id.name, row)
                if (
                  ['number', 'integer'].includes(
                    numericShape(p.node.init, p.scope)
                  )
                )
                  numericGlobals.add(p.node.id.name)
                if (numericShape(p.node.init, p.scope) === 'integer')
                  integerGlobals.add(p.node.id.name)
              }
            },
            ObjectProperty(p) {
              if (!p.parentPath.isObjectExpression()) return
              const row = rowType(p.node.value, p.scope)
              if (t.isIdentifier(p.node.key)) {
                const shape = numericShape(p.node.value, p.scope)
                recordFieldType(
                  scalarFields,
                  p.node.key.name,
                  ['number', 'integer'].includes(shape) ? 'f64' : null
                )
              }
              if (t.isIdentifier(p.node.key))
                recordFieldType(matrixFields, p.node.key.name, row)
              if (t.isIdentifier(p.node.key))
                recordFieldType(
                  arrayFields,
                  p.node.key.name,
                  arrayType(p.node.value, p.scope)
                )
              if (
                t.isIdentifier(p.node.key) &&
                numericShape(p.node.value, p.scope) === 'array'
              )
                numericArrayFields.add(p.node.key.name)
            },
            AssignmentExpression(p) {
              if (
                !t.isMemberExpression(p.node.left) ||
                p.node.left.computed ||
                !t.isIdentifier(p.node.left.property)
              )
                return
              if (t.isThisExpression(p.node.left.object)) {
                const key = owningClassKey(p.scope)
                if (key) {
                  recordFieldType(classSources, key.split('\0')[1], key)
                  if (!classFields.has(key)) classFields.set(key, new Map())
                  const fields = classFields.get(key)
                  const name = p.node.left.property.name
                  const row = rowType(p.node.right, p.scope)
                  const type =
                    arrayType(p.node.right, p.scope) ||
                    constructedType(p.node.right, p.scope) ||
                    (row ? row + '[]' : null)
                  if (!fields.has(name)) fields.set(name, type)
                  else if (fields.get(name) !== type) fields.set(name, null)
                }
              }
              if (t.isObjectExpression(p.node.right)) {
                const fields = new Map()
                for (const property of p.node.right.properties) {
                  if (
                    !t.isObjectProperty(property) ||
                    !t.isIdentifier(property.key)
                  )
                    continue
                  const type = arrayType(property.value, p.scope)
                  if (type) fields.set(property.key.name, type)
                }
                if (fields.size)
                  objectFields.set(p.node.left.property.name, fields)
              }
              recordFieldType(
                arrayFields,
                p.node.left.property.name,
                arrayType(p.node.right, p.scope)
              )
              const row = rowType(p.node.right, p.scope)
              recordFieldType(matrixFields, p.node.left.property.name, row)
              const shape = numericShape(p.node.right, p.scope)
              recordFieldType(
                scalarFields,
                p.node.left.property.name,
                ['number', 'integer'].includes(shape) ? 'f64' : null
              )
              if (shape === 'array')
                numericArrayFields.add(p.node.left.property.name)
              if (shape === 'number' || shape === 'integer')
                numericFields.add(p.node.left.property.name)
              const name = p.node.left.property.name
              if (shape === 'integer' && !nonIntegerFields.has(name)) {
                integerFields.add(name)
              } else {
                nonIntegerFields.add(name)
                integerFields.delete(name)
              }
            },
          },
        }),
      ],
    })
  }
}

/** Keep captured scalars boxed for Porffor's closure environment layout. */
function capturedBinding(binding) {
  if (binding.scope.path.isProgram()) return false
  const owner = binding.scope.getFunctionParent()
  return [...binding.referencePaths, ...binding.constantViolations].some(
    (reference) => reference.scope.getFunctionParent() !== owner
  )
}

/**
 * Lower documented parameter and return types for native compilation.
 *
 * @param {object} p - Babel node path
 */
function annotateNativeFunction(p) {
  p.node.async = false
  const tags = documentedTags(p)
  const returned = tags.find((tag) => tag.kind === 'returns')
  const annotation =
    returned && documentedType(resolveDocumentedType(returned.type, p.scope))
  if (annotation) p.node.returnType = t.tsTypeAnnotation(annotation)
  const bitcast = tags.find((tag) => tag.kind === 'nativeBitcast')
  if (bitcast) {
    const kinds = { Float32Array: 0, Int32Array: 2, Uint32Array: 6 }
    const source = kinds[bitcast.type]
    const destination = kinds[bitcast.name]
    if (
      source === undefined ||
      destination === undefined ||
      p.node.params.length !== 1 ||
      !t.isIdentifier(p.node.params[0])
    ) {
      throw new Error(
        'A native bitcast requires one value and two 32-bit lane types'
      )
    }
    p.node.body = t.blockStatement([
      t.returnStatement(
        nativeCast(
          t.callExpression(t.identifier('reinterpretNativeNumber'), [
            t.identifier(p.node.params[0].name),
            t.numericLiteral(source),
            t.numericLiteral(destination),
          ]),
          documentedType('f64')
        )
      ),
    ])
  }
  for (const documented of documentedParameters(p, tags)) {
    const { binding, parameter, target, direct } = documented
    const type = resolveDocumentedType(documented.type, p.scope)
    recordDocumentedBinding(binding, type)
    if (!direct) continue
    for (const tag of tags) {
      if (tag.kind !== 'param' || !tag.name?.startsWith(target.name + '.'))
        continue
      const path = tag.name.split('.').slice(1)
      let fields = (binding.nativeFields ??= new Map())
      for (const field of path.slice(0, -1)) {
        if (!(fields.get(field) instanceof Map)) fields.set(field, new Map())
        fields = fields.get(field)
      }
      fields.set(path.at(-1), resolveDocumentedType(tag.type, p.scope))
    }
    // Porffor's scalar coercion must not erase a nonzero or object default.
    const preservesDefault =
      !t.isAssignmentPattern(parameter) ||
      t.isNumericLiteral(parameter.right, { value: 0 })
    const fields = documentedFields(type, p.scope)
    const record =
      !type.includes('|') &&
      fields?.size &&
      (documentedDefinition(type, p.scope).definition?.type === 'object' ||
        plainObjectClasses.has(classSources.get(type)))
    const annotation =
      documentedType(type) || (record ? t.tsObjectKeyword() : null)
    if (
      annotation &&
      preservesDefault &&
      !(['i32', 'f64', 'number'].includes(type) && capturedBinding(binding))
    )
      target.typeAnnotation = t.tsTypeAnnotation(annotation)
  }
}

/**
 * Infer numeric locals and typed-array aliases without narrowing file totals.
 *
 * @param {object} p - Babel node path
 */
function annotateNativeVariable(p) {
  if (
    t.isObjectPattern(p.node.id) &&
    (t.isIdentifier(p.node.init) || t.isThisExpression(p.node.init))
  ) {
    const properties = p.node.id.properties
    if (
      properties.every(
        (property) =>
          t.isObjectProperty(property) &&
          t.isIdentifier(property.key) &&
          t.isIdentifier(property.value)
      )
    ) {
      const scope = p.scope
      const replacements = p.replaceWithMultiple(
        properties.map((property) =>
          t.variableDeclarator(
            property.value,
            t.memberExpression(t.cloneNode(p.node.init), property.key)
          )
        )
      )
      for (const replacement of replacements) {
        const binding = scope.getBinding(replacement.node.id.name)
        if (binding) {
          binding.path = replacement
          const row = rowType(replacement.node.init, scope)
          if (row) binding.nativeElementType = row
          const array = arrayType(replacement.node.init, scope)
          if (array) {
            replacement.node.id.typeAnnotation = t.tsTypeAnnotation(
              documentedType(array)
            )
            binding.nativeArrayType = array
          } else if (
            !capturedBinding(binding) &&
            ['number', 'integer'].includes(
              numericShape(replacement.node.init, scope)
            )
          ) {
            replacement.node.id.typeAnnotation = t.tsTypeAnnotation(
              t.tsTypeReference(
                t.identifier(
                  numericShape(replacement.node.init, scope) === 'integer'
                    ? 'i32'
                    : 'f64'
                )
              )
            )
            binding.nativeShape = numericShape(replacement.node.init, scope)
          }
        }
      }
    }
    return
  }
  if (!t.isIdentifier(p.node.id)) return
  const binding = p.scope.getBinding(p.node.id.name)
  if (binding.constant) {
    const fields = nativeObjectFields(p.node.init, p.scope)
    if (fields?.size) binding.nativeFields = fields
  }
  const constructed = constructedType(p.node.init, p.scope)
  if (constructed) recordDocumentedBinding(binding, constructed)
  if (
    binding.constant &&
    t.isMemberExpression(p.node.init) &&
    p.node.init.computed
  ) {
    const element = rowType(p.node.init.object, p.scope)
    if (element) recordDocumentedBinding(binding, element)
  }
  if (
    binding.constant &&
    t.isCallExpression(p.node.init) &&
    t.isIdentifier(p.node.init.callee)
  ) {
    const called = p.scope.getBinding(p.node.init.callee.name)
    const returned = returnType(called)
    const fields =
      (called?.kind === 'module'
        ? functionContracts.get(called.path.node.imported?.name)?.fields
        : null) || documentedFields(returned, p.scope)
    if (fields?.size) binding.nativeFields = fields
    if (returned && (fields?.size || /^(?:Array<|.+\[\]$)/.test(returned)))
      recordDocumentedBinding(binding, returned)
  }
  const declared = documentedTags(p).find((tag) => tag.kind === 'type')
  if (declared) {
    const binding = p.scope.getBinding(p.node.id.name)
    const type = resolveDocumentedType(declared.type, p.scope)
    recordDocumentedBinding(binding, type)
    const annotation = documentedType(type)
    if (
      annotation &&
      !(['i32', 'f64', 'number'].includes(type) && capturedBinding(binding))
    ) {
      p.node.id.typeAnnotation = t.tsTypeAnnotation(annotation)
      return
    }
  }
  if (t.isMemberExpression(p.node.init) && !p.node.init.computed) {
    const fields = objectFields.get(p.node.init.property.name)
    if (fields && !binding.nativeFields) binding.nativeFields = fields
  }
  const row = rowType(p.node.init, p.scope)
  if (row) p.scope.getBinding(p.node.id.name).nativeElementType = row
  if (binding.constant && documentedJsArray(p.node.init, p.scope)) {
    binding.nativeJsArray = true
    p.node.id.typeAnnotation = t.tsTypeAnnotation(
      t.tsArrayType(t.tsAnyKeyword())
    )
    return
  }
  const array = arrayType(p.node.init, p.scope)
  if (array) {
    p.node.id.typeAnnotation = t.tsTypeAnnotation(documentedType(array))
    p.scope.getBinding(p.node.id.name).nativeArrayType = array
    return
  }
  const shape = numericShape(p.node.init, p.scope)
  if (shape !== 'number' && shape !== 'integer') return
  if (capturedBinding(binding)) return
  const writesNumbers = binding.constantViolations.every(
    (write) =>
      write.isUpdateExpression() ||
      (write.isAssignmentExpression() &&
        ['number', 'integer'].includes(
          numericShape(write.node.right, write.scope)
        ))
  )
  if (!writesNumbers) return
  const writesIntegers = binding.constantViolations.every(
    (write) =>
      write.isUpdateExpression() ||
      (write.isAssignmentExpression() &&
        numericShape(write.node.right, write.scope) === 'integer')
  )
  const type =
    shape === 'integer' &&
    writesIntegers &&
    !p.parentPath.parentPath.isExportNamedDeclaration()
      ? 'i32'
      : 'f64'
  p.node.id.typeAnnotation = t.tsTypeAnnotation(
    t.tsTypeReference(t.identifier(type))
  )
  binding.nativeShape = type === 'i32' ? 'integer' : 'number'
}

/**
 * Parenthesize type assertions so comparisons stay unambiguous to Porffor.
 * @param {object} expression - Value being asserted.
 * @param {object} type - Native type annotation.
 * @returns {object} Parenthesized Babel expression.
 */
function nativeCast(expression, type) {
  return t.parenthesizedExpression(t.tsAsExpression(expression, type))
}

/**
 * Adapt syntax and type hints in temporary copies, leaving codec sources intact.
 * Generator yields and per-stream state ownership remain unchanged.
 *
 * @param {string} source - Original JavaScript source
 * @param {string} relative - Repository-relative source path
 * @returns {string} Source consumed only by Porffor
 */
function transformForNative(source, relative) {
  let numericLoads = false
  return transformSync(source, {
    filename: path.join(root, relative),
    babelrc: false,
    configFile: false,
    plugins: [
      () => ({
        visitor: {
          ImportDeclaration(p) {
            p.node.source.value = p.node.source.value.replace(/^node:/, '')
          },
          LogicalExpression: {
            exit(p) {
              if (p.node.operator === '??' && t.isBooleanLiteral(p.node.left))
                p.replaceWith(p.node.left)
              if (
                p.node.operator !== '??' ||
                !t.isNumericLiteral(p.node.right, { value: 0 }) ||
                !t.isMemberExpression(p.node.left) ||
                !p.node.left.computed
              )
                return
              const member = p.node.left
              if (
                !['number', 'integer'].includes(
                  numericShape(member.property, p.scope)
                )
              )
                return
              const kind = nativeElementKind(
                arrayType(member.object, p.scope),
                p
              )
              if (kind === -1) return
              numericLoads = true
              p.replaceWith(
                nativeCast(
                  t.callExpression(t.identifier('readNativeNumber'), [
                    member.object,
                    member.property,
                    t.numericLiteral((kind & ~8) | 16),
                  ]),
                  documentedType(
                    [2, 3, 4, 5, 7].includes(kind & 7) ? 'i32' : 'f64'
                  )
                )
              )
            },
          },
          ReferencedIdentifier(p) {
            if (p.parentPath.isExportSpecifier()) return
            const binding = p.scope.getBinding(p.node.name)
            if (binding?.kind !== 'module') return
            const declaration = binding.path.parentPath.node
            if (!t.isImportDeclaration(declaration)) return
            if (
              path.resolve(
                path.dirname(path.join(root, relative)),
                declaration.source.value
              ) !== path.join(root, codec.constants)
            )
              return
            const value = constants[binding.path.node.imported?.name]
            if (typeof value === 'number' && Number.isFinite(value))
              p.replaceWith(t.numericLiteral(value))
          },
          Program: {
            enter(p, state) {
              collectDocumentedTypes(p, state)
            },
            exit(p) {
              p.scope.crawl()
              for (const declaration of p.get('body')) {
                if (
                  !declaration.isImportDeclaration() ||
                  declaration.node.source.value !== 'url'
                )
                  continue
                if (
                  declaration.node.specifiers.every(
                    (specifier) =>
                      !p.scope.getBinding(specifier.local.name)?.referenced
                  )
                )
                  declaration.remove()
              }
              if (numericLoads) {
                p.node.body.unshift(
                  t.importDeclaration(
                    nativeHelpers.map((definition) =>
                      t.importSpecifier(
                        t.identifier(definition.name),
                        t.identifier(definition.name)
                      )
                    ),
                    t.stringLiteral(
                      path.relative(path.dirname(relative), 'host.js')
                    )
                  )
                )
              }
            },
          },
          Function(p) {
            annotateNativeFunction(p)
            if (documentedTags(p).some((tag) => tag.kind === 'nativeBitcast'))
              numericLoads = true
          },
          VariableDeclarator(p) {
            annotateNativeVariable(p)
          },
          UnaryExpression: {
            exit(p) {
              if (
                p.node.operator !== '~' ||
                !['number', 'integer'].includes(
                  numericShape(p.node.argument, p.scope)
                )
              )
                return
              // XOR preserves ToInt32 semantics and exposes typed integer operands.
              p.replaceWith(
                nativeCast(
                  t.binaryExpression(
                    '^',
                    p.node.argument,
                    nativeCast(t.numericLiteral(-1), documentedType('i32'))
                  ),
                  documentedType('i32')
                )
              )
              p.skip()
            },
          },
          AwaitExpression(p) {
            p.replaceWith(p.node.argument)
          },
          UpdateExpression(p) {
            if (!t.isIdentifier(p.node.argument)) return
            const binding = p.scope.getBinding(p.node.argument.name)
            if (binding?.nativeShape !== 'integer') return
            const discarded =
              p.parentPath.isExpressionStatement() ||
              (p.parentPath.isForStatement() &&
                p.parentPath.node.update === p.node)
            if (!discarded) return
            // Porffor lowers ++ through f64 even for bounded i32 loop indices.
            p.replaceWith(
              t.assignmentExpression(
                '=',
                t.cloneNode(p.node.argument),
                t.binaryExpression(
                  '|',
                  t.binaryExpression(
                    p.node.operator === '++' ? '+' : '-',
                    t.cloneNode(p.node.argument),
                    t.numericLiteral(1)
                  ),
                  t.numericLiteral(0)
                )
              )
            )
          },
          AssignmentExpression: {
            exit(p) {
              if (p.node.operator === '=' && t.isIdentifier(p.node.left)) {
                const binding = p.scope.getBinding(p.node.left.name)
                if (binding && capturedBinding(binding)) {
                  numericLoads = true
                  p.node.right = t.callExpression(
                    t.identifier('boxNativeValue'),
                    [p.node.right]
                  )
                  return
                }
              }
              const target = p.node.left
              if (
                t.isIdentifier(target) &&
                ['+=', '-=', '*='].includes(p.node.operator)
              ) {
                const binding = p.scope.getBinding(target.name)
                if (
                  binding?.nativeIntegerContract &&
                  !capturedBinding(binding) &&
                  numericShape(p.node.right, p.scope) === 'integer'
                ) {
                  p.replaceWith(
                    t.assignmentExpression(
                      '=',
                      target,
                      t.binaryExpression(
                        p.node.operator[0],
                        t.cloneNode(target),
                        nativeCast(p.node.right, documentedType('i32'))
                      )
                    )
                  )
                  p.skip()
                  return
                }
              }
              if (t.isMemberExpression(target) && !target.computed) {
                const type = nativeObjectFields(target.object, p.scope)?.get(
                  target.property.name
                )
                if (
                  ['number', 'f64', 'i32'].includes(type) &&
                  p.node.operator === '=' &&
                  ['number', 'integer'].includes(
                    numericShape(p.node.right, p.scope)
                  )
                ) {
                  numericLoads = true
                  p.replaceWith(
                    nativeFieldCall(target, 'writeNativeFieldNumber', p.scope, [
                      nativeCast(p.node.right, documentedType('f64')),
                    ])
                  )
                  p.skip()
                  return
                }
              }
              if (
                ['+=', '-=', '*=', '/='].includes(p.node.operator) &&
                t.isMemberExpression(target) &&
                !target.computed &&
                t.isIdentifier(target.object) &&
                t.isIdentifier(target.property)
              ) {
                const binding = p.scope.getBinding(target.object.name)
                const type = binding?.nativeFields?.get(target.property.name)
                if (
                  binding?.constant &&
                  ['number', 'f64', 'i32'].includes(type) &&
                  ['number', 'integer'].includes(
                    numericShape(p.node.right, p.scope)
                  )
                ) {
                  p.replaceWith(
                    t.assignmentExpression(
                      '=',
                      target,
                      t.binaryExpression(
                        p.node.operator[0],
                        nativeCast(t.cloneNode(target), documentedType('f64')),
                        nativeCast(p.node.right, documentedType('f64'))
                      )
                    )
                  )
                  return
                }
              }
              if (!t.isMemberExpression(target) || !target.computed) return
              const compound = p.node.operator !== '='
              if (
                compound &&
                (!['+=', '-=', '*=', '/='].includes(p.node.operator) ||
                  !['number', 'integer'].includes(
                    numericShape(target.property, p.scope)
                  ))
              )
                return
              const kind = nativeElementKind(
                arrayType(target.object, p.scope),
                p,
                true
              )
              if (
                kind === -1 ||
                (compound &&
                  nativeElementKind(arrayType(target.object, p.scope), p) ===
                    -1) ||
                (kind & 7) === 4 ||
                !['number', 'integer'].includes(
                  numericShape(p.node.right, p.scope)
                )
              )
                return
              numericLoads = true
              const prefix = []
              if (compound) {
                // Preserve reference evaluation before reading the value or evaluating the RHS.
                const array = p.scope.generateUidIdentifier('nativeArray')
                const index = p.scope.generateUidIdentifier('nativeIndex')
                index.typeAnnotation = t.tsTypeAnnotation(documentedType('f64'))
                p.scope.push({ id: t.cloneNode(array), kind: 'let' })
                p.scope.push({ id: t.cloneNode(index), kind: 'let' })
                prefix.push(
                  t.assignmentExpression(
                    '=',
                    t.cloneNode(array),
                    target.object
                  ),
                  t.assignmentExpression(
                    '=',
                    t.identifier(index.name),
                    target.property
                  )
                )
                target.object = array
                target.property = t.identifier(index.name)
              }
              const value = compound
                ? t.binaryExpression(
                    p.node.operator[0],
                    nativeCast(
                      t.callExpression(t.identifier('readNativeNumber'), [
                        t.cloneNode(target.object),
                        t.cloneNode(target.property),
                        t.numericLiteral(kind),
                      ]),
                      documentedType('f64')
                    ),
                    nativeCast(p.node.right, documentedType('f64'))
                  )
                : p.node.right
              const integerValue =
                !compound &&
                numericShape(value, p.scope) === 'integer' &&
                (!t.isBinaryExpression(value) ||
                  ['|', '&', '^', '<<', '>>'].includes(value.operator))
              const written = nativeCast(
                t.callExpression(t.identifier('writeNativeNumber'), [
                  target.object,
                  target.property,
                  value,
                  t.numericLiteral(integerValue ? kind | 16 : kind),
                ]),
                t.tsTypeReference(t.identifier('f64'))
              )
              p.replaceWith(
                prefix.length
                  ? t.sequenceExpression([...prefix, written])
                  : written
              )
              p.skip()
            },
          },
          BinaryExpression: {
            exit(p) {
              const bitwise = ['&', '|', '^', '<<', '>>', '>>>'].indexOf(
                p.node.operator
              )
              if (bitwise !== -1) {
                const left = numericShape(p.node.left, p.scope)
                const right = numericShape(p.node.right, p.scope)
                if (
                  ['number', 'integer'].includes(left) &&
                  ['number', 'integer'].includes(right) &&
                  (left !== 'integer' || right !== 'integer')
                ) {
                  numericLoads = true
                  p.replaceWith(
                    nativeCast(
                      t.callExpression(t.identifier('bitwiseNativeNumber'), [
                        p.node.left,
                        p.node.right,
                        t.numericLiteral(bitwise),
                      ]),
                      documentedType(bitwise === 5 ? 'f64' : 'i32')
                    )
                  )
                  return
                }
              }
              if (
                p.node.operator === '**' &&
                t.isNumericLiteral(p.node.left, { value: 2 })
              ) {
                numericLoads = true
                p.replaceWith(
                  nativeCast(
                    t.callExpression(t.identifier('powerNativeTwo'), [
                      p.node.right,
                    ]),
                    t.tsTypeReference(t.identifier('f64'))
                  )
                )
                return
              }
              if (
                p.node.operator !== '%' ||
                numericShape(p.node.left, p.scope) !== 'integer' ||
                numericShape(p.node.right, p.scope) !== 'integer'
              )
                return
              numericLoads = true
              p.replaceWith(
                nativeCast(
                  t.callExpression(t.identifier('remainderNativeInteger'), [
                    p.node.left,
                    p.node.right,
                  ]),
                  t.tsTypeReference(t.identifier('f64'))
                )
              )
            },
          },
          ForOfStatement(p) {
            p.node.await = false
            const declaration = p.node.left
            const identifier = t.isVariableDeclaration(declaration)
              ? declaration.declarations[0]?.id
              : declaration
            if (!t.isIdentifier(identifier)) return
            const row = rowType(p.node.right, p.scope)
            const binding = p.scope.getBinding(identifier.name)
            if (row && binding) {
              recordDocumentedBinding(binding, row)
              const type = documentedType(row)
              if (
                type &&
                t.isVariableDeclaration(declaration) &&
                !capturedBinding(binding)
              )
                identifier.typeAnnotation = t.tsTypeAnnotation(type)
              if (documentedJsArray(p.node.right, p.scope))
                p.node.right = nativeCast(
                  p.node.right,
                  t.tsArrayType(t.tsAnyKeyword())
                )
            }
          },
          OptionalMemberExpression: {
            exit(p) {
              const parent = p.parentPath
              if (
                !p.node.optional ||
                p.node.computed ||
                (!t.isIdentifier(p.node.object) &&
                  !t.isThisExpression(p.node.object)) ||
                parent.isOptionalMemberExpression() ||
                parent.isOptionalCallExpression() ||
                (parent.isCallExpression() && parent.node.callee === p.node) ||
                parent.isUnaryExpression({ operator: 'delete' })
              )
                return
              // A literal member keeps Porffor's property cache available after the null guard.
              const receiver = p.node.object
              p.replaceWith(
                t.conditionalExpression(
                  t.logicalExpression(
                    '||',
                    t.binaryExpression(
                      '===',
                      t.cloneNode(receiver),
                      t.nullLiteral()
                    ),
                    t.binaryExpression(
                      '===',
                      t.cloneNode(receiver),
                      t.unaryExpression('void', t.numericLiteral(0))
                    )
                  ),
                  t.unaryExpression('void', t.numericLiteral(0)),
                  t.memberExpression(t.cloneNode(receiver), p.node.property)
                )
              )
            },
          },
          MemberExpression: {
            exit(p) {
              if (
                t.isMetaProperty(p.node.object) &&
                p.node.object.meta.name === 'import' &&
                p.node.object.property.name === 'meta'
              ) {
                if (t.isIdentifier(p.node.property, { name: 'main' })) {
                  p.replaceWith(t.booleanLiteral(relative === codec.entry))
                  return
                }
                if (t.isIdentifier(p.node.property, { name: 'url' })) {
                  p.replaceWith(
                    t.stringLiteral(
                      pathToFileURL(path.join(root, relative)).href
                    )
                  )
                  return
                }
              }
              if (
                t.isIdentifier(p.node.object, { name: 'Symbol' }) &&
                t.isIdentifier(p.node.property, { name: 'asyncIterator' })
              )
                p.node.property.name = 'iterator'
              if (!p.node.computed) {
                const fields = nativeObjectFields(p.node.object, p.scope)
                const type = fields?.get(p.node.property.name)
                const parent = p.parentPath
                if (
                  parent.isAssignmentExpression({ left: p.node }) ||
                  parent.isUpdateExpression() ||
                  parent.isUnaryExpression({ operator: 'delete' })
                )
                  return
                const nested =
                  type instanceof Map ? type : documentedFields(type, p.scope)
                if (nested) {
                  numericLoads = true
                  const value = nativeFieldCall(
                    p.node,
                    'readNativeFieldValue',
                    p.scope
                  )
                  value.nativeFields = nested
                  p.replaceWith(value)
                  p.skip()
                  return
                }
                if (
                  type === 'boolean' ||
                  type === 'DataView' ||
                  /^(Float|Int|Uint)\d+Array$/.test(type) ||
                  /^(?:Array<.+>|.+\[\])$/.test(type)
                ) {
                  numericLoads = true
                  const value = nativeCast(
                    nativeFieldCall(p.node, 'readNativeFieldValue', p.scope),
                    documentedType(type)
                  )
                  value.nativeElementType = rowType(p.node, p.scope)
                  value.nativeShape = numericShape(p.node, p.scope)
                  p.replaceWith(value)
                  p.skip()
                  return
                }
                if (!['i32', 'f64', 'number'].includes(type)) return
                numericLoads = true
                p.replaceWith(
                  nativeCast(
                    nativeFieldCall(p.node, 'readNativeFieldNumber', p.scope),
                    documentedType(type)
                  )
                )
                p.skip()
                return
              }
              const shape = numericShape(p.node.object, p.scope)
              const array = arrayType(p.node.object, p.scope)
              const parent = p.parentPath
              let kind = nativeElementKind(array, p)
              // Discarding a lane's sign extension makes signed/unsigned reads equivalent.
              const width = Number(
                nativeCopyLane(array)?.match(/^Integer(\d+)Array$/)?.[1]
              )
              if (
                kind === -1 &&
                width &&
                parent.isBinaryExpression({ operator: '<<' }) &&
                parent.node.left === p.node &&
                t.isNumericLiteral(parent.node.right) &&
                (parent.node.right.value & 31) >= 32 - width &&
                ['number', 'integer'].includes(
                  numericShape(p.node.property, p.scope)
                )
              )
                kind = nativeElementKind(array, p, true)
              const numericContext =
                numericArgument(p) ||
                (parent.isReturnStatement() &&
                  documentedTags(p.getFunctionParent()).some(
                    (tag) =>
                      tag.kind === 'returns' &&
                      ['number', 'f64', 'i32'].includes(
                        resolveDocumentedType(tag.type, p.scope)
                      )
                  )) ||
                (parent.isCallExpression() &&
                  (t.isIdentifier(parent.node.callee, { name: 'Number' }) ||
                    (t.isMemberExpression(parent.node.callee) &&
                      t.isIdentifier(parent.node.callee.object, {
                        name: 'Math',
                      })))) ||
                parent.isTSAsExpression() ||
                parent.isUnaryExpression({ operator: '+' }) ||
                (parent.isBinaryExpression() &&
                  ['===', '!=='].includes(parent.node.operator) &&
                  ['number', 'integer'].includes(
                    numericShape(
                      parent.node.left === p.node
                        ? parent.node.right
                        : parent.node.left,
                      p.scope
                    )
                  )) ||
                (parent.isBinaryExpression() &&
                  [
                    '+',
                    '-',
                    '*',
                    '/',
                    '%',
                    '**',
                    '<',
                    '>',
                    '<=',
                    '>=',
                    '|',
                    '&',
                    '^',
                    '<<',
                    '>>',
                    '>>>',
                  ].includes(parent.node.operator)) ||
                (parent.isVariableDeclarator() &&
                  parent.node.id.typeAnnotation) ||
                (parent.isAssignmentExpression() &&
                  parent.node.right === p.node &&
                  ((t.isMemberExpression(parent.node.left) &&
                    arrayType(parent.node.left.object, p.scope)) ||
                    (t.isIdentifier(parent.node.left) &&
                      ['number', 'integer'].includes(
                        p.scope.getBinding(parent.node.left.name)?.nativeShape
                      ))))
              if (kind !== -1 && numericContext) {
                numericLoads = true
                const bitwiseInteger =
                  [2, 3, 4, 5, 7].includes(kind & 7) &&
                  parent.isBinaryExpression() &&
                  ['&', '|', '^', '<<', '>>', '>>>'].includes(
                    parent.node.operator
                  )
                // Bitwise coercion maps an out-of-bounds undefined value to zero.
                if (bitwiseInteger) kind |= 16
                const integer =
                  bitwiseInteger ||
                  ((kind & 8) !== 0 && [2, 3, 4, 5, 7].includes(kind & 7))
                p.replaceWith(
                  nativeCast(
                    t.callExpression(t.identifier('readNativeNumber'), [
                      p.node.object,
                      p.node.property,
                      t.numericLiteral(kind),
                    ]),
                    t.tsTypeReference(t.identifier(integer ? 'i32' : 'f64'))
                  )
                )
                return
              }
              if (
                shape === 'array' &&
                numericContext &&
                ['number', 'integer'].includes(
                  numericShape(p.node.property, p.scope)
                ) &&
                !parent.isAssignmentExpression({ left: p.node }) &&
                !parent.isUpdateExpression() &&
                !parent.isUnaryExpression({ operator: 'delete' })
              ) {
                numericLoads = true
                p.replaceWith(
                  t.callExpression(t.identifier('readNativeArrayLikeNumber'), [
                    p.node.object,
                    p.node.property,
                  ])
                )
                p.skip()
                return
              }
              if (array && !t.isTSAsExpression(p.node.object)) {
                p.node.object = nativeCast(p.node.object, documentedType(array))
              }
              if (shape !== 'array') return
              if (
                !parent.isBinaryExpression() ||
                !['-', '*', '/', '%', '**', '<', '>', '<=', '>='].includes(
                  parent.node.operator
                )
              )
                return
              p.replaceWith(t.unaryExpression('+', t.cloneNode(p.node)))
              p.skip()
            },
          },
          CallExpression: {
            enter(p) {
              const callee = p.node.callee
              if (
                t.isMemberExpression(callee) &&
                !callee.computed &&
                t.isIdentifier(callee.object) &&
                p.scope.getBinding(callee.object.name)?.nativeDataView &&
                nativeUncheckedScope(p.scope)
              ) {
                const write = callee.property.name === 'setInt32'
                const read = callee.property.name === 'getInt32'
                const count = write ? 2 : 1
                const args = p.node.arguments
                const endian = args[count]
                if (
                  (read || (write && p.parentPath.isExpressionStatement())) &&
                  args.length >= count &&
                  args.length <= count + 1 &&
                  (!endian || t.isBooleanLiteral(endian)) &&
                  args
                    .slice(0, count)
                    .every(
                      (argument) =>
                        numericShape(argument, p.scope) === 'integer'
                    )
                ) {
                  numericLoads = true
                  const call = t.callExpression(
                    t.identifier(
                      write ? 'writeNativeViewWord' : 'readNativeViewWord'
                    ),
                    [
                      callee.object,
                      ...args.slice(0, count),
                      t.numericLiteral(Number(endian?.value || false)),
                    ]
                  )
                  p.replaceWith(
                    read ? nativeCast(call, documentedType('i32')) : call
                  )
                  return
                }
              }
              if (
                t.isIdentifier(p.node.callee, { name: 'Number' }) &&
                p.node.arguments.length === 1 &&
                booleanValue(p.node.arguments[0], p.scope)
              ) {
                p.replaceWith(
                  t.conditionalExpression(
                    p.node.arguments[0],
                    t.numericLiteral(1),
                    t.numericLiteral(0)
                  )
                )
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.object, { name: 'Math' }) &&
                t.isIdentifier(p.node.callee.property, { name: 'imul' }) &&
                p.node.arguments.length === 2 &&
                p.node.arguments.every((argument) =>
                  ['number', 'integer'].includes(
                    numericShape(argument, p.scope)
                  )
                )
              ) {
                numericLoads = true
                if (
                  p.node.arguments.every(
                    (argument) => numericShape(argument, p.scope) === 'integer'
                  )
                ) {
                  p.replaceWith(
                    nativeCast(
                      t.binaryExpression(
                        '*',
                        ...p.node.arguments.map((argument) =>
                          nativeCast(argument, documentedType('i32'))
                        )
                      ),
                      documentedType('i32')
                    )
                  )
                  p.skip()
                  return
                }
                p.replaceWith(
                  nativeCast(
                    t.callExpression(t.identifier('bitwiseNativeNumber'), [
                      ...p.node.arguments,
                      t.numericLiteral(6),
                    ]),
                    documentedType('i32')
                  )
                )
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.object, { name: 'Math' }) &&
                p.node.arguments.length === 1 &&
                ['abs', 'fround', 'floor', 'ceil', 'trunc'].includes(
                  p.node.callee.property.name
                ) &&
                ['number', 'integer'].includes(
                  numericShape(p.node.arguments[0], p.scope)
                )
              ) {
                numericLoads = true
                const operation = [
                  'abs',
                  'fround',
                  'floor',
                  'ceil',
                  'trunc',
                ].indexOf(p.node.callee.property.name)
                p.replaceWith(
                  nativeCast(
                    t.callExpression(t.identifier('evaluateNativeMath'), [
                      p.node.arguments[0],
                      t.numericLiteral(operation),
                    ]),
                    documentedType('f64')
                  )
                )
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.object, { name: 'Number' }) &&
                ['isInteger', 'isNaN', 'isFinite'].includes(
                  p.node.callee.property.name
                ) &&
                p.node.arguments.length === 1 &&
                ['number', 'integer'].includes(
                  numericShape(p.node.arguments[0], p.scope)
                )
              ) {
                numericLoads = true
                p.replaceWith(
                  t.binaryExpression(
                    '===',
                    nativeCast(
                      t.callExpression(t.identifier('evaluateNativeMath'), [
                        p.node.arguments[0],
                        t.numericLiteral(
                          5 +
                            ['isInteger', 'isNaN', 'isFinite'].indexOf(
                              p.node.callee.property.name
                            )
                        ),
                      ]),
                      documentedType('f64')
                    ),
                    t.numericLiteral(1)
                  )
                )
                return
              }
              if (
                t.isIdentifier(p.node.callee, { name: 'Number' }) &&
                p.node.arguments.length === 1 &&
                ['number', 'integer'].includes(
                  numericShape(p.node.arguments[0], p.scope)
                )
              ) {
                p.replaceWith(
                  nativeCast(p.node.arguments[0], documentedType('f64'))
                )
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.property, { name: 'set' }) &&
                p.parentPath.isExpressionStatement() &&
                p.node.arguments.length >= 1 &&
                p.node.arguments.length <= 2
              ) {
                const target = arrayType(p.node.callee.object, p.scope)
                const source = arrayType(p.node.arguments[0], p.scope)
                const lane = nativeCopyLane(target)
                const kind = nativeElementKind(target, p, true)
                if (
                  kind !== -1 &&
                  lane &&
                  lane === nativeCopyLane(source) &&
                  (!p.node.arguments[1] ||
                    ['number', 'integer'].includes(
                      numericShape(p.node.arguments[1], p.scope)
                    ))
                ) {
                  numericLoads = true
                  const range = p.node.arguments[0]
                  if (
                    t.isCallExpression(range) &&
                    t.isMemberExpression(range.callee) &&
                    t.isIdentifier(range.callee.property, {
                      name: 'subarray',
                    }) &&
                    range.arguments.length <= 2 &&
                    [...range.arguments, ...p.node.arguments.slice(1)].every(
                      (argument) =>
                        ['number', 'integer'].includes(
                          numericShape(argument, p.scope)
                        ) && p.scope.isPure(argument)
                    )
                  ) {
                    p.replaceWith(
                      t.callExpression(t.identifier('copyNativeArrayRange'), [
                        p.node.callee.object,
                        range.callee.object,
                        t.numericLiteral(kind & ~8),
                        p.node.arguments[1] || t.numericLiteral(0),
                        range.arguments[0] || t.numericLiteral(0),
                        range.arguments[1] || t.identifier('Infinity'),
                      ])
                    )
                    return
                  }
                  p.replaceWith(
                    t.callExpression(t.identifier('copyNativeArray'), [
                      p.node.callee.object,
                      p.node.arguments[0],
                      t.numericLiteral(kind & ~8),
                      p.node.arguments[1] || t.numericLiteral(0),
                    ])
                  )
                  return
                }
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.property, { name: 'fill' }) &&
                p.node.arguments.length >= 1 &&
                p.node.arguments.length <= 3 &&
                ['number', 'integer'].includes(
                  numericShape(p.node.arguments[0], p.scope)
                ) &&
                p.node.arguments
                  .slice(1)
                  .every((argument) =>
                    ['number', 'integer'].includes(
                      numericShape(argument, p.scope)
                    )
                  ) &&
                p.parentPath.isExpressionStatement()
              ) {
                const kind = nativeElementKind(
                  arrayType(p.node.callee.object, p.scope),
                  p,
                  true
                )
                if (kind !== -1) {
                  numericLoads = true
                  const zero = t.isNumericLiteral(p.node.arguments[0], {
                    value: 0,
                  })
                  p.replaceWith(
                    t.callExpression(
                      t.identifier(
                        zero ? 'clearNativeArray' : 'fillNativeArray'
                      ),
                      [
                        p.node.callee.object,
                        t.numericLiteral(kind & ~8),
                        ...(zero ? [] : [p.node.arguments[0]]),
                        p.node.arguments[1] || t.numericLiteral(0),
                        p.node.arguments[2] || t.identifier('Infinity'),
                      ]
                    )
                  )
                  return
                }
              }
              // Embed explicit UTF-8 reads of static module-relative assets.
              const filename = p.node.arguments[0]
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.property, {
                  name: 'readFileSync',
                }) &&
                t.isNewExpression(filename) &&
                t.isIdentifier(filename.callee, { name: 'URL' }) &&
                t.isStringLiteral(filename.arguments[0]) &&
                t.isMemberExpression(filename.arguments[1]) &&
                t.isMetaProperty(filename.arguments[1].object) &&
                t.isIdentifier(filename.arguments[1].property, {
                  name: 'url',
                }) &&
                t.isStringLiteral(p.node.arguments[1], { value: 'utf8' })
              ) {
                const asset = path.resolve(
                  root,
                  path.dirname(relative),
                  filename.arguments[0].value
                )
                p.replaceWith(t.stringLiteral(fs.readFileSync(asset, 'utf8')))
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.object, { name: 'Math' }) &&
                ['min', 'max'].includes(p.node.callee.property.name) &&
                p.node.arguments.length >= 2 &&
                p.node.arguments.every((argument) =>
                  ['number', 'integer'].includes(
                    numericShape(argument, p.scope)
                  )
                )
              ) {
                numericLoads = true
                const name =
                  p.node.callee.property.name === 'min'
                    ? 'minimumNativeNumber'
                    : 'maximumNativeNumber'
                p.replaceWith(
                  nativeCast(
                    p.node.arguments.reduce((left, right) =>
                      t.callExpression(t.identifier(name), [left, right])
                    ),
                    t.tsTypeReference(t.identifier('f64'))
                  )
                )
                return
              }
              if (
                t.isMemberExpression(p.node.callee) &&
                t.isIdentifier(p.node.callee.property, { name: 'toString' }) &&
                t.isStringLiteral(p.node.arguments[0])
              ) {
                p.replaceWith(
                  t.callExpression(
                    t.memberExpression(
                      t.identifier('Buffer'),
                      t.identifier('decode')
                    ),
                    [p.node.callee.object, ...p.node.arguments]
                  )
                )
                return
              }
            },
            exit(p) {
              if (
                !t.isMemberExpression(p.node.callee) ||
                p.parentPath.isTSAsExpression()
              )
                return
              const returned = documentedMethodReturn(p.node.callee, p.scope)
              if (!['number', 'f64', 'i32'].includes(returned)) return
              p.replaceWith(nativeCast(p.node, documentedType(returned)))
              p.skip()
            },
          },
        },
      }),
    ],
  }).code
}

/** Copy transformed source files into the temporary compiler workspace. */
function stage(directory) {
  fs.mkdirSync(path.join(work, directory), { recursive: true })
  for (const entry of fs.readdirSync(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      stage(relative)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const code = transformForNative(
      fs.readFileSync(path.join(root, relative), 'utf8'),
      relative
    )
    fs.writeFileSync(path.join(work, relative), code)
  }
}
for (const directory of codec.sources)
  collectNumericFields(path.join(root, directory))
// Keep numeric fields wide; every observed initializer must agree on the type.
for (const fields of classFields.values()) {
  for (const [name, type] of fields) {
    if (type === null && scalarFields.get(name)) fields.set(name, 'f64')
  }
}
for (const [key, documented] of documentedClassFields) {
  const fields = classFields.get(key) || new Map()
  for (const [name, type] of documented) fields.set(name, type)
  classFields.set(key, fields)
}
for (const [source, definitions] of moduleTypes) {
  for (const definition of definitions.values()) {
    for (const [name, type] of definition.fields)
      definition.fields.set(name, qualifyDocumentedType(type, source))
  }
}
for (const [key, fields] of classFields) {
  const order = nativeClassFieldOrders.get(key)
  if (
    nativeStableClasses.has(key) &&
    order &&
    order.length === fields.size &&
    order.every((name) => fields.has(name))
  )
    fields.nativeOffsets = new Map(
      order.map((name, index) => [name, index * 20])
    )
  const source = key.slice(0, key.indexOf('\0'))
  for (const [name, type] of fields)
    fields.set(name, qualifyDocumentedType(type, source))
  for (const [name, type] of fields.nativeMethodReturns || [])
    fields.nativeMethodReturns.set(name, qualifyDocumentedType(type, source))
}

/** Inherit types after qualification without assuming a subclass's field layout. */
function inheritClassFields(key, visited = new Set()) {
  const fields = classFields.get(key)
  if (!fields || visited.has(key)) return fields
  visited.add(key)
  const parent = inheritClassFields(classParents.get(key), visited)
  for (const [name, type] of parent || []) {
    if (!fields.has(name)) fields.set(name, type)
  }
  for (const [name, type] of parent?.nativeMethodReturns || []) {
    if (!fields.nativeMethodReturns.has(name))
      fields.nativeMethodReturns.set(name, type)
  }
  return fields
}
for (const key of classFields.keys()) inheritClassFields(key)
for (const directory of codec.sources) stage(directory)
prepareRuntime()
fs.writeFileSync(
  path.join(work, 'entry.js'),
  "import './host.js'; import " +
    JSON.stringify('./' + codec.entry) +
    '; process.exit(process.exitCode || 0)\n'
)
/**
 * Run the compiler, reporting failures before copying output.
 *
 * @param {string} command - Executable path
 * @param {string[]} args - Command arguments
 * @param {object} [options={}] - Additional child-process options
 */
function runBuildCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(command + ' failed: ' + result.status)
}

/**
 * Compile the staged program with strict floating-point behavior.
 * Plain codec state objects expose their own length fields, so generic property
 * reads must retain JavaScript semantics instead of assuming array storage.
 *
 * @param {string} name - Temporary output name
 * @returns {string} Compiled executable path
 */
function compileNative(name) {
  const wrapper = path.join(work, name + '-cc')
  const executable = path.join(work, name)
  // Machine outlining makes Apple's LTO linker scale poorly on large codecs.
  const linkFlag =
    process.platform === 'linux'
      ? '-fuse-ld=lld'
      : process.platform === 'darwin'
        ? '-Wl,-mllvm,-enable-machine-outliner=never'
        : null
  const compilerWrapper = [
    '#!/bin/sh',
    ...(linkFlag
      ? [
          'case " $* " in',
          '  *" -c "*) ;;',
          '  *) set -- ' + linkFlag + ' "$@" ;;',
          'esac',
        ]
      : []),
    'exec "$CC" -fno-fast-math -ffp-contract=off -fno-math-errno "$@"',
    '',
  ].join('\n')
  fs.writeFileSync(wrapper, compilerWrapper, { mode: 0o755 })
  runBuildCommand(
    porffor,
    [
      'native',
      '-t',
      path.join(work, 'entry.js'),
      '-o',
      executable,
      '--compiler=' + wrapper,
      '-j2',
      '--flto',
    ],
    {
      env: {
        ...process.env,
        CC: nativeCompiler,
      },
    }
  )
  return executable
}

const nativeCompiler = process.env.CC || 'clang'
console.log('Native build staging: ' + work)
const executable = compileNative(codec.name + '-compiled')
fs.copyFileSync(executable, output)
fs.chmodSync(output, 0o755)
console.log('Built ' + output)
