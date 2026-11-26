const { constants } = require('node:fs')
const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises')
const { dirname, extname, join, posix } = require('node:path')
const { ArchivePaths, contentExtension } = require('./archive-paths.cjs')

const models = new Set(['.glb', '.gltf', '.fbx', '.obj', '.dae', '.ply', '.stl', '.usdz', '.usd', '.usdc', '.usda', '.splat', '.spz'])
const textures = new Set(['.ktx', '.ktx2', '.dds', '.basis', '.hdr', '.exr', '.tga', '.pvr', '.astc'])
const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.tif', '.tiff'])
const buffers = new Set(['.drc', '.glbin', '.glbuf', '.mtl', '.mesh', '.meshopt', '.geom'])
const inspectLimit = 128 * 1024 * 1024
const jsonChunk = 0x4e4f534a
const binaryChunk = 0x004e4942

function fileExtension(asset) {
  const pathname = new URL(asset.url).pathname
  const suffix = extname(pathname).toLowerCase()
  const type = asset.contentType.split(';', 1)[0].trim().toLowerCase()
  if (type.startsWith('model/') || type === 'image/ktx' || type === 'image/ktx2') {
    return contentExtension(type) || suffix
  }
  return suffix || contentExtension(type)
}

function category(asset, extension) {
  if (models.has(extension)) return 'models'
  if (textures.has(extension)) return 'textures'
  const pathname = new URL(asset.url).pathname
  if (images.has(extension) &&
      /(?:^|[/_.-])(?:textures?|materials?|albedo|normal|roughness|metalness|metallic|matcap|cubemap|lightmap|displacement|occlusion)(?:$|[/_.-])/i.test(pathname)) {
    return 'textures'
  }
  if (buffers.has(extension) || /^application\/gltf-buffer\b/i.test(asset.contentType)) return 'dependencies'
  if (['.js', '.mjs', '.wasm'].includes(extension) &&
      /(?:\bdraco\b|draco_|basis_transcoder|meshopt_decoder)/i.test(pathname)) return 'decoders'
  return null
}

function parseModel(body, extension) {
  if (extension === '.gltf') {
    return { document: JSON.parse(body.toString('utf8').replace(/^\uFEFF/, '')) }
  }
  if (body.length < 20 || body.readUInt32LE(0) !== 0x46546c67 ||
      body.readUInt32LE(4) !== 2 || body.readUInt32LE(8) !== body.length) {
    throw new Error('Invalid GLB header')
  }
  const length = body.readUInt32LE(12)
  const end = 20 + length
  if (body.readUInt32LE(16) !== jsonChunk || end > body.length || length % 4 !== 0) {
    throw new Error('Invalid GLB JSON chunk')
  }
  let binary
  if (end + 8 <= body.length && body.readUInt32LE(end + 4) === binaryChunk) {
    const binaryEnd = end + 8 + body.readUInt32LE(end)
    if (binaryEnd <= body.length) binary = body.subarray(end + 8, binaryEnd)
  }
  return { document: JSON.parse(body.toString('utf8', 20, end)), tail: body.subarray(end), binary }
}

function serializeModel(document, tail) {
  const json = Buffer.from(JSON.stringify(document))
  if (!tail) return json
  const length = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(header.length + length + tail.length, 8)
  header.writeUInt32LE(length, 12)
  header.writeUInt32LE(jsonChunk, 16)
  return Buffer.concat([header, json, Buffer.alloc(length - json.length, 0x20), tail])
}

function dataUri(uri) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(uri)
  return match && { type: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
}

async function exportSceneAssets({ staging, assets, assetAliases, signal }) {
  const entries = new Map()
  const paths = new ArchivePaths()
  const embedded = []
  const issues = []

  function add(asset, group, extension) {
    if (entries.has(asset.url)) return entries.get(asset.url)
    const source = paths.asset(asset.url, asset.contentType, extension || undefined).slice('assets/'.length)
    const file = posix.join('3d', group, 'files', source)
    const record = { url: asset.url, source: asset.file, file, category: group }
    entries.set(asset.url, record)
    return record
  }

  for (const asset of assets.values()) {
    const extension = fileExtension(asset)
    const group = category(asset, extension)
    if (group) add(asset, group, extension)
  }
  if (!entries.size) return null

  async function write(file, data) {
    const path = join(staging, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }

  function issue(record, detail, uri) {
    issues.push({ model: record.url, detail, ...(uri && { uri }) })
  }

  const rewritten = new Set()
  for (const record of entries.values()) {
    signal.throwIfAborted()
    if (record.category !== 'models') continue
    const asset = assets.get(record.url)
    const extension = fileExtension(asset)
    if (extension !== '.glb' && extension !== '.gltf') continue
    if (asset.bytes > inspectLimit) {
      issue(record, 'Model exceeds the size limit for inspecting embedded resources.')
      continue
    }
    let model
    try {
      model = parseModel(await readFile(join(staging, record.source)), extension)
      if (!/^2\./.test(model.document?.asset?.version)) throw new Error('Unsupported glTF version')
    } catch {
      issue(record, 'Could not read glTF 2.0 metadata.')
      continue
    }

    const { document, tail } = model
    const fields = Array.isArray(document.buffers) ? document.buffers : []
    const images = Array.isArray(document.images) ? document.images : []
    const views = Array.isArray(document.bufferViews) ? document.bufferViews : []
    const imageBuffers = new Map([[0, model.binary]])
    let changed = false

    async function resolve(item, group) {
      if (typeof item?.uri !== 'string' || /^data:/i.test(item.uri)) return null
      let target
      try {
        const url = new URL(item.uri, record.url)
        url.hash = ''
        target = assets.get(url.href) || assets.get(assetAliases.get(url.href))
      } catch {
        // Invalid or missing dependencies are reported alongside the model.
      }
      if (!target) {
        issue(record, 'Referenced file was not captured.', item.uri)
        return null
      }
      const dependency = add(target, group, fileExtension(target))
      item.uri = posix.relative(posix.dirname(record.file), dependency.file).split('/').map(encodeURIComponent).join('/')
      changed = true
      return target
    }

    for (let i = 0; i < fields.length; i++) {
      const item = fields[i]
      const target = await resolve(item, 'dependencies')
      if (target) imageBuffers.set(i, target)
      else if (typeof item?.uri === 'string') imageBuffers.set(i, dataUri(item.uri)?.data)
    }

    for (let i = 0; i < images.length; i++) {
      signal.throwIfAborted()
      const image = images[i]
      if (await resolve(image, 'textures') || !image) continue
      let decoded = typeof image.uri === 'string' ? dataUri(image.uri) : null
      if (!decoded && Number.isSafeInteger(image.bufferView) && image.bufferView >= 0) {
        const view = views[image.bufferView]
        const start = view?.byteOffset ?? 0
        let buffer = imageBuffers.get(view?.buffer)
        if (buffer?.file && buffer.bytes <= inspectLimit) {
          buffer = await readFile(join(staging, buffer.file))
          imageBuffers.set(view.buffer, buffer)
        }
        if (Buffer.isBuffer(buffer) && Number.isSafeInteger(start) && start >= 0 &&
            Number.isSafeInteger(view.byteLength) && view.byteLength > 0 && start + view.byteLength <= buffer.length) {
          decoded = { type: image.mimeType, data: buffer.subarray(start, start + view.byteLength) }
        }
      }
      if (typeof decoded?.type !== 'string' || !decoded.type.startsWith('image/') || !decoded.data.length) continue
      const extension = contentExtension(decoded.type)
      if (!extension || extension === '.svg') continue
      const name = record.file.slice('3d/models/files/'.length)
      const file = posix.join('3d/textures/embedded', name, `image-${i + 1}${extension}`)
      await write(file, decoded.data)
      embedded.push({ model: record.url, image: i, file, bytes: decoded.data.length })
    }

    if (changed) {
      await write(record.file, serializeModel(document, tail))
      rewritten.add(record.url)
    }
  }

  for (const record of entries.values()) {
    signal.throwIfAborted()
    if (rewritten.has(record.url)) continue
    const destination = join(staging, record.file)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(staging, record.source), destination, constants.COPYFILE_FICLONE)
  }
  const manifest = '3d/manifest.json'
  await write(manifest, JSON.stringify({ assets: [...entries.values()], embedded, issues }, null, 2) + '\n')
  return {
    manifest,
    models: [...entries.values()].filter(entry => entry.category === 'models').length,
    textures: [...entries.values()].filter(entry => entry.category === 'textures').length + embedded.length,
  }
}

module.exports = { exportSceneAssets }
