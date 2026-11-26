const { once } = require('node:events')
const { readFile, realpath, stat, open } = require('node:fs/promises')
const { basename, isAbsolute, resolve, relative, sep } = require('node:path')
const { parse, serialize, defaultTreeAdapter } = require('parse5')

const cacheParameters = new Set(['v', 'ver', 'version', '_', 't', 'ts', 'cb', 'cachebust'])
const replayHeader = 'x-site-downloader-replay'
const localOrigin = 'http://site-downloader.localhost'

function httpUrl(value) {
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url
  } catch {
    // Invalid addresses in an archive cannot be replayed.
  }
  return null
}

function requestKey(url) {
  const key = new URL(url)
  key.hash = ''
  return key.href
}

function cacheKey(url) {
  const key = new URL(requestKey(url))
  const query = [...key.searchParams]
  key.search = ''
  for (const [name, value] of query) {
    if (cacheParameters.has(name.toLowerCase()) && /^\d{9,}$/.test(value)) continue
    key.searchParams.append(name, value)
  }
  return key.href
}

function inside(folder, path) {
  const name = relative(folder, path)
  return name && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)
}

async function archiveFile(folder, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file)) return null
  const candidate = resolve(folder, file)
  if (!inside(folder, candidate)) return null
  const path = await realpath(candidate).catch(() => null)
  if (!path || !inside(folder, path)) return null
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? { path, size: info.size } : null
}

async function readArchive(directory) {
  const folder = await realpath(directory)
  const index = await archiveFile(folder, 'manifest.json')
  if (!index) throw new Error('Выбери папку архива с файлом manifest.json.')
  let manifest
  try {
    manifest = JSON.parse(await readFile(index.path, 'utf8'))
  } catch {
    throw new Error('Не удалось прочитать manifest.json.')
  }
  if (!Array.isArray(manifest?.files)) throw new Error('В манифесте нет списка сохранённых файлов.')
  const start = httpUrl(manifest.url)
  const entry = httpUrl(manifest.finalUrl) || start
  if (!entry) throw new Error('В манифесте нет стартового URL.')
  if (!entry.hash && start?.hash) entry.hash = start.hash

  const exact = new Map()
  const cache = new Map()
  function add(item) {
    const url = httpUrl(item?.url)
    if (!url || typeof item.file !== 'string' || (item.method && item.method !== 'GET')) return
    exact.set(requestKey(url), item)
    const key = cacheKey(url)
    if (!cache.has(key)) cache.set(key, item)
    else if (cache.get(key)?.file !== item.file) cache.set(key, null)
  }
  for (const item of manifest.files) add(item)
  // A document and a fetch can share a URL. Keep the document for navigations.
  const documents = new Map()
  for (const item of Array.isArray(manifest.pages) ? manifest.pages : []) {
    const url = httpUrl(item?.url)
    if (url && typeof item.file === 'string') documents.set(requestKey(url), item)
  }
  if (!documents.has(requestKey(entry)) && typeof manifest.entryFile === 'string') {
    const existing = exact.get(requestKey(entry))
    if (existing?.file === manifest.entryFile) documents.set(requestKey(entry), existing)
  }
  const page = documents.get(requestKey(entry))
  if (!page || !await archiveFile(folder, page.file)) {
    throw new Error('Стартовая страница отсутствует в архиве.')
  }

  const aliases = new Map()
  for (const field of ['redirects', 'resourceRedirects']) {
    for (const redirect of Array.isArray(manifest[field]) ? manifest[field] : []) {
      const source = httpUrl(redirect?.url)
      const target = httpUrl(redirect?.finalUrl)
      if (source && target && (exact.has(requestKey(target)) || documents.has(requestKey(target)))) {
        aliases.set(requestKey(source), requestKey(target))
      }
    }
  }
  return { folder, entry, exact, cache, documents, aliases }
}

function mediaType(item, path) {
  const type = item.contentType?.toString().trim()
  if (type && !/[\r\n]/.test(type) && type !== 'application/octet-stream') return type
  const name = basename(path).toLowerCase()
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'application/javascript'
  if (name.endsWith('.wasm')) return 'application/wasm'
  if (name.endsWith('.css')) return 'text/css'
  if (name.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start <= end ? { start, end } : null
}

function atOrigin(url, origin) {
  const mapped = new URL(origin)
  mapped.pathname = url.pathname
  mapped.search = url.search
  mapped.hash = url.hash
  return mapped
}

function alternatePageUrl(address) {
  if (address.pathname === '/' || address.pathname.endsWith('//')) return null
  const alternate = new URL(address)
  const path = alternate.pathname
  alternate.pathname = path.endsWith('/') ? path.slice(0, -1) : path + '/'
  return requestKey(alternate)
}

async function localHtml(file, type, source, requested, previewOrigin) {
  const charset = /\bcharset\s*=\s*["']?([^"'\s;]+)/i.exec(type)?.[1] || 'utf-8'
  let decoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder()
  }
  const tree = parse(decoder.decode(await readFile(file)))
  let head
  let base
  const links = []
  function visit(node) {
    if (node.tagName === 'head') head = node
    const href = node.attrs?.find(attribute => attribute.name === 'href' && !attribute.namespace)
    if (href) {
      if (node.tagName === 'base' && !base) base = href
      if (node.tagName === 'a' || node.tagName === 'area') links.push(href)
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(tree)
  const original = httpUrl(source)
  let linkBase = original
  if (base) {
    try {
      linkBase = new URL(base.value, original)
      if (linkBase.origin === original.origin) base.value = atOrigin(linkBase, previewOrigin).href
    } catch {
      // Keep an existing base with an invalid URL.
    }
  } else if (requestKey(original) !== requestKey(requested) && head) {
    const href = atOrigin(original, previewOrigin).href
    const node = defaultTreeAdapter.createElement('base', 'http://www.w3.org/1999/xhtml', [{ name: 'href', value: href }])
    if (head.childNodes.length) defaultTreeAdapter.insertBefore(head, node, head.childNodes[0])
    else defaultTreeAdapter.appendChild(head, node)
  }
  for (const href of links) {
    if (!/^(?:https?:)?\/\//i.test(href.value.trim())) continue
    try {
      const link = new URL(href.value, linkBase)
      if (link.origin === original.origin) href.value = atOrigin(link, previewOrigin).href
    } catch {
      // Ignore malformed links.
    }
  }
  return serialize(tree)
}

async function installReplayRoutes(context, archive, onMissing = () => {}, previewOrigin) {
  await context.routeWebSocket('**/*', socket => socket.close())
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = httpUrl(request.url())
    const method = request.method()
    if (!url || !['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.abort('blockedbyclient')

    const requestHeaders = request.headers()
    const headers = { 'cache-control': 'no-store', [replayHeader]: 'archive' }
    const origin = requestHeaders.origin
    if (origin && (origin === 'null' || httpUrl(origin)?.origin === origin)) {
      headers['access-control-allow-origin'] = origin
      headers['access-control-allow-credentials'] = 'true'
      headers.vary = 'Origin'
    }

    const address = url.origin === previewOrigin ? atOrigin(url, archive.entry.origin) : url
    const key = requestKey(address)
    const lookup = address => (request.isNavigationRequest() && archive.documents.get(address)) || archive.exact.get(address)
    const alias = archive.aliases.get(key)
    const documentRequest = request.isNavigationRequest() || ['fetch', 'xhr'].includes(request.resourceType())
    const alternate = documentRequest && alternatePageUrl(address)
    const item = lookup(key) || (alias && lookup(alias)) || (alternate && archive.documents.get(alternate)) ||
      (!request.isNavigationRequest() && archive.cache.get(cacheKey(address)))
    const file = item && await archiveFile(archive.folder, item.file)
    if (!file) {
      onMissing(address.origin + address.pathname, request.resourceType())
      return route.fulfill({ status: 404, headers, body: 'This URL was not saved in the archive.' })
    }

    if (method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
      headers['access-control-allow-headers'] = requestHeaders['access-control-request-headers'] || '*'
      return route.fulfill({ status: 204, headers })
    }
    headers['content-type'] = mediaType(item, file.path)
    headers['accept-ranges'] = 'bytes'
    if (method === 'HEAD') {
      headers['content-length'] = String(file.size)
      return route.fulfill({ status: 200, headers })
    }
    if (requestHeaders.range) {
      const range = byteRange(requestHeaders.range, file.size)
      if (!range) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${file.size}` } })
      const { start, end } = range
      const handle = await open(file.path, 'r')
      let body
      try {
        const result = await handle.read({ position: start, length: end - start + 1, buffer: Buffer.alloc(end - start + 1) })
        body = result.buffer.subarray(0, result.bytesRead)
      } finally {
        await handle.close()
      }
      headers['content-range'] = `bytes ${start}-${start + body.length - 1}/${file.size}`
      return route.fulfill({ status: 206, headers, body })
    }
    if (previewOrigin && url.origin === previewOrigin &&
        /^text\/html\b/i.test(headers['content-type']) && httpUrl(item.url)) {
      const body = await localHtml(file.path, headers['content-type'], item.url, address, previewOrigin)
      headers['content-type'] = 'text/html; charset=utf-8'
      return route.fulfill({ status: 200, headers, body })
    }
    return route.fulfill({ status: 200, headers, path: file.path })
  })
}

function showArchiveMarker() {
  if (window.self !== window.top) return
  const show = () => {
    const host = document.createElement('div')
    host.setAttribute('data-site-downloader-archive', '')
    const position = {
      all: 'initial',
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      'z-index': '2147483647',
      'pointer-events': 'none',
    }
    for (const [property, value] of Object.entries(position)) {
      host.style.setProperty(property, value, 'important')
    }
    const badge = document.createElement('span')
    badge.textContent = 'Офлайн-архив · Site Downloader'
    badge.setAttribute('role', 'status')
    Object.assign(badge.style, {
      display: 'block',
      padding: '7px 11px',
      borderRadius: '8px',
      background: '#164734',
      color: '#fff',
      boxShadow: '0 2px 8px #0004',
      font: '600 12px system-ui, sans-serif',
    })
    host.attachShadow({ mode: 'open' }).append(badge)
    document.documentElement.append(host)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true })
  else show()
}

async function replay(directory, { launch, signal, send, useOriginalAddress = false }) {
  const archive = await readArchive(directory)
  const previewOrigin = useOriginalAddress ? undefined : localOrigin
  const start = previewOrigin ? atOrigin(archive.entry, previewOrigin) : archive.entry
  const browser = await launch({
    headless: false,
    args: ['--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  })
  async function close() {
    await browser.close().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })
  const lifetime = new AbortController()
  try {
    signal.throwIfAborted()
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', acceptDownloads: false })
    await context.addInitScript(showArchiveMarker)
    const missing = new Set()
    await installReplayRoutes(context, archive, (url, resourceType) => {
      if (missing.size >= 100 || missing.has(url)) return
      missing.add(url)
      send({ type: 'replayMissing', url, resourceType })
    }, previewOrigin)
    const page = await context.newPage()
    const closed = once(page, 'close', { signal: lifetime.signal })
    // Attach the lifecycle listener before navigation, including pages that close themselves.
    const response = await Promise.race([page.goto(start.href, { waitUntil: 'commit', timeout: 30_000 }), closed])
    if (!page.isClosed()) {
      if (!response?.ok?.() || response.headers()[replayHeader] !== 'archive') {
        throw new Error('Не удалось подтвердить загрузку стартовой страницы из офлайн-архива.')
      }
      send({ type: 'replayReady', url: start.href })
      await closed
    }
  } finally {
    lifetime.abort()
    signal.removeEventListener('abort', close)
    await close()
  }
}

module.exports = { replay, readArchive, installReplayRoutes }
