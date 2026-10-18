/** Package the bundled API v1 module and existing worker as a WME SAR archive.
 * Wire format: asivery/webminidisc src/services/audio/apiv1/external-archive.ts
 * (9637bed5), with big-endian lengths and metadata.json as the first entry.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The host imports blobs; relative source-map URLs cannot resolve there.
function bundledScript(contents) {
  return Buffer.from(
    Buffer.from(contents)
      .toString('utf8')
      .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
  )
}

export function createWmeArchive(metadata, index, worker) {
  const parts = [Buffer.from('SARFile')]
  const subMagic = Buffer.from('Web MiniDisc Dynamic Encoder')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(subMagic.length)
  parts.push(length, subMagic)
  for (const [name, contents] of [
    ['metadata.json', Buffer.from(JSON.stringify(metadata))],
    ['index.js', bundledScript(index)],
    ['worker.js', bundledScript(worker)],
  ]) {
    const filename = Buffer.from(name)
    const nameLength = Buffer.alloc(2)
    nameLength.writeUInt16BE(filename.length)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(contents.length)
    parts.push(nameLength, filename, size, contents)
  }
  const archive = Buffer.concat(parts)
  if (archive.length > 50 * 1024 * 1024) {
    throw new RangeError('WME archive exceeds the host 50 MiB limit')
  }
  return archive
}

async function main() {
  const root = new URL('../', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const [index, worker] = await Promise.all([
    readFile(new URL('dist/wme/index.js', root)),
    readFile(new URL(`dist/${pkg.name}-worker.min.js`, root)),
  ])
  const archive = createWmeArchive(
    {
      encoderId: pkg.name,
      userFriendlyName: 'Carta5 (ATRAC3PLUS)',
      description:
        'ATRAC3PLUS codec for Hi-MD recording. Stereo, 44.1 kHz; 48, 64, 192, 256, 352 kbps. Not for standard MD LP2/LP4.',
      version: pkg.version,
      encoderDependencies: [],
      apiVersion: '1',
    },
    index,
    worker
  )
  const output = new URL(`dist/${pkg.name}.wme`, root)
  await writeFile(output, archive)
  console.log(`Built ${fileURLToPath(output)} (${archive.length} bytes)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
