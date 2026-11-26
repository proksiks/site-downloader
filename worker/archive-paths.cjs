const { createHash } = require('node:crypto')
const { posix } = require('node:path')

const extensions = new Map(Object.entries({
  'application/javascript': '.js', 'text/javascript': '.js', 'application/ecmascript': '.js',
  'application/json': '.json', 'text/plain': '.txt', 'text/html': '.html', 'application/xhtml+xml': '.xhtml',
  'application/pdf': '.pdf', 'application/wasm': '.wasm', 'application/xml': '.xml', 'text/xml': '.xml',
  'text/css': '.css', 'text/csv': '.csv', 'application/manifest+json': '.webmanifest',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'image/tiff': '.tiff', 'font/woff': '.woff', 'font/woff2': '.woff2',
  'font/ttf': '.ttf', 'font/otf': '.otf', 'application/font-woff': '.woff',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/aac': '.aac',
  'audio/mp4': '.m4a', 'audio/webm': '.webm', 'video/mp4': '.mp4', 'video/webm': '.webm',
  'video/ogg': '.ogv', 'video/quicktime': '.mov', 'text/vtt': '.vtt',
}))

function mediaType(contentType) {
  return contentType.split(';', 1)[0].trim().toLowerCase()
}

function contentExtension(contentType) {
  return extensions.get(mediaType(contentType))
}

function isPreviewType(type) {
  return /^(?:image|font|audio|video)\//.test(type) ||
    ['text/css', 'text/vtt', 'application/font-woff'].includes(type)
}

const previewExtensions = new Set(
  [...extensions].filter(([type]) => isPreviewType(type)).map(([, extension]) => extension),
)
previewExtensions.add('.jpeg')

function previewExtension(address, contentType) {
  const type = mediaType(contentType)
  const suffix = posix.extname(new URL(address).pathname).toLowerCase()
  if (type === 'image/jpeg' && suffix === '.jpeg') return suffix
  if (isPreviewType(type)) return extensions.get(type)
  if ((!type || type === 'application/octet-stream') && previewExtensions.has(suffix)) return suffix
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function shorten(value, limit) {
  if (Buffer.byteLength(value) <= limit) return value
  let prefix = ''
  for (const char of value) {
    if (Buffer.byteLength(prefix + char) > limit - 13) break
    prefix += char
  }
  return prefix + '~' + hash(value)
}

function portableName(segment, fallback, limit = 105) {
  const value = decodeSegment(segment).normalize('NFC')
  let name = value.replace(/[^\p{L}\p{N}\p{M} ._~-]/gu, '_').replace(/^[ .]+|[ .]+$/g, '')
  if (!name) name = fallback
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name
  return shorten(name, limit)
}

function routeSegments(url) {
  const all = url.pathname.slice(1).split('/')
  if (all.at(-1) === '') all.pop()
  return all
}

function addSuffix(file, suffix) {
  const extension = posix.extname(file)
  return (extension ? file.slice(0, -extension.length) : file) + suffix + extension
}

class ArchivePaths {
  #names = new Map()

  #claim(parent, preferred, key, file = false) {
    let siblings = this.#names.get(parent)
    if (!siblings) {
      siblings = { keys: new Map(), names: new Set() }
      this.#names.set(parent, siblings)
    }
    if (siblings.keys.has(key)) return siblings.keys.get(key)

    const comparisonKey = name => name.normalize('NFD').toUpperCase().toLowerCase()
    let name = preferred
    for (let i = 0; siblings.names.has(comparisonKey(name)); i++) {
      const suffix = '~' + hash(key) + (i ? '-' + i : '')
      name = file ? addSuffix(preferred, suffix) : preferred + suffix
    }
    siblings.keys.set(key, name)
    siblings.names.add(comparisonKey(name))
    return name
  }

  #directories(parent, segments) {
    let path = parent
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const name = portableName(segment, '_', 70)
      if (Buffer.byteLength(path + '/' + name) > 160) {
        const remaining = segments.slice(i).join('/')
        const collapsed = shorten(name, 32) + '~' + hash(remaining)
        return posix.join(path, this.#claim(path, collapsed, 'tail:' + remaining))
      }
      path = posix.join(path, this.#claim(path, name, 'dir:' + segment))
    }
    return path
  }

  constructor() {
    for (const name of ['assets', 'offline', 'manifest.json']) {
      this.#claim('', name, 'reserved:' + name)
    }
  }

  page(address, extension = '.html') {
    const url = new URL(address)
    const segments = routeSegments(url)
    const path = this.#directories('', segments)
    const suffix = url.search ? '~q-' + hash(url.search) : ''
    const name = this.#claim(path, 'index' + suffix + extension, 'page:' + url.href, true)
    return posix.join(path, name)
  }

  asset(address, contentType, extensionOverride) {
    const url = new URL(address)
    const segments = routeSegments(url)
    const leaf = url.pathname.endsWith('/') ? 'index' : segments.pop()
    const host = portableName(url.hostname, 'host', 55) + (url.port ? '_' + url.port : '')
    const hostDir = posix.join('assets', this.#claim('assets', host, url.origin))
    const path = this.#directories(hostDir, segments)
    const original = portableName(leaf || 'index', 'index')
    const existingExtension = posix.extname(original)
    const expected = extensionOverride || contentExtension(contentType)
    const needsExtension = expected && (!existingExtension ||
      (extensionOverride && existingExtension.toLowerCase() !== extensionOverride))
    const preferred = needsExtension ? original + expected : original
    const suffix = url.search ? '~q-' + hash(url.search) : ''
    const name = this.#claim(path, addSuffix(preferred, suffix), 'asset:' + url.href, true)
    return posix.join(path, name)
  }
}

module.exports = { ArchivePaths, contentExtension, previewExtension }
