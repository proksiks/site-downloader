const { open, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { basename, dirname, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { ArchivePaths, contentExtension } = require('./archive-paths.cjs')
const { readArchive } = require('./replay.cjs')

function address(value, base) {
  try {
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

async function lockArchive(root) {
  const file = join(root, '.repair.lock')
  let handle
  try {
    handle = await open(file, 'wx')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('Архив заблокирован для докачки. Если приложение было принудительно закрыто и докачка больше не идёт, удали файл .repair.lock в папке архива.')
  }
  return async () => {
    await handle.close()
    await rm(file, { force: true })
  }
}

function getType(headers) {
  return headers['content-type'] || 'application/octet-stream'
}

function isPage(type) {
  return /^(?:text\/html|application\/xhtml\+xml)\b/i.test(type)
}

function successful(status) {
  return status >= 200 && status < 300 && ![204, 206].includes(status)
}

function array(value) {
  return Array.isArray(value) ? value : []
}

async function repairArchive(directory, options, { launch, signal, send, waitForConfirmation }) {
  let archive = await readArchive(directory)
  if (!options || !Array.isArray(options.targets) || options.targets.length < 1 || options.targets.length > 100) {
    throw new Error('Выбери от 1 до 100 адресов для докачки.')
  }
  const wait = options.waitSeconds ?? 5
  if (!Number.isInteger(wait) || wait < 1 || wait > 60) throw new Error('Ожидание страницы должно быть от 1 до 60 секунд.')
  const targets = new Map()
  for (const item of options.targets) {
    const url = address(item?.url)
    if (!url || !['page', 'resource'].includes(item?.kind)) throw new Error('В списке докачки есть недопустимый адрес.')
    if (item.kind === 'page' && url.origin !== archive.entry.origin) {
      throw new Error('Можно повторить загрузку только страниц из этого архива.')
    }
    targets.set(item.kind + ':' + url.href, { url, kind: item.kind })
  }

  signal.throwIfAborted()
  const root = archive.folder
  const release = await lockArchive(root)
  const manifestPath = join(root, 'manifest.json')
  const done = []
  const failed = []
  const newResources = new Map()
  const newPages = new Map()
  const redirects = new Map()
  const resourceAliases = new Map()
  const paths = new ArchivePaths()
  let browser
  let stage
  let destination
  let committed = false

  const closeBrowser = () => { void browser?.close().catch(() => {}) }
  signal.addEventListener('abort', closeBrowser, { once: true })

  async function writeRecord(url, file, type, body, status, group, prefix) {
    const path = join(stage, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
    group.set(url.href, { url: url.href, file: prefix + '/' + file, contentType: type, method: 'GET', bytes: body.length, status })
  }

  async function resource(response, requested, prefix) {
    const actual = address(response.url())
    if (!actual || !successful(response.status())) return false
    const type = getType(response.headers())
    if (!newResources.has(actual.href)) {
      const body = await response.body()
      await writeRecord(actual, paths.asset(actual.href, type), type, body, response.status(), newResources, prefix)
    }
    if (requested.href !== actual.href) resourceAliases.set(requested.href, actual.href)
    return true
  }

  async function pageRepair(page, requested, prefix) {
    const pending = new Set()
    const seen = new Set()
    function track(response) {
      const request = response.request()
      if (request.method() !== 'GET' || (request.isNavigationRequest() && response.frame() === page.mainFrame())) return
      const actual = address(response.url())
      if (!actual || seen.has(actual.href) || archive.exact.has(actual.href) || newResources.has(actual.href) ||
          !successful(response.status())) return
      seen.add(actual.href)
      const alias = address(request.redirectedFrom()?.url()) ?? actual
      const task = resource(response, alias, prefix)
        .catch(() => {})
        .finally(() => pending.delete(task))
      pending.add(task)
    }

    page.on('response', track)
    try {
      const response = await page.goto(requested.href, { timeout: 30_000, waitUntil: 'domcontentloaded' })
      if (!response || !successful(response.status())) throw new Error(response ? `HTTP ${response.status()}` : 'Сервер не вернул ответ.')
      const type = getType(response.headers())
      const final = address(response.url())
      if (!final || final.origin !== archive.entry.origin || !isPage(type)) {
        throw new Error('Страница перенаправила на другой сайт или вернула не HTML.')
      }
      if (final.href !== requested.href && archive.documents.has(final.href)) {
        throw new Error('Сервер перенаправил на другую сохранённую страницу.')
      }
      const body = await response.body()
      await delay(wait * 1000, undefined, { signal })
      const extension = contentExtension(type) || '.html'
      await writeRecord(final, paths.page(final.href, extension), type, body, response.status(), newPages, prefix)
      if (final.href !== requested.href) redirects.set(requested.href, final.href)
    } finally {
      page.off('response', track)
      if (!signal.aborted && !page.isClosed()) {
        const timeout = new AbortController()
        try {
          await Promise.race([Promise.all(pending), delay(3000, undefined, { signal: timeout.signal })])
        } finally {
          timeout.abort()
        }
        await page.goto('about:blank', { timeout: 5000, waitUntil: 'commit' }).catch(() => page.close().catch(() => {}))
      }
      await Promise.all(pending)
    }
  }

  try {
    archive = await readArchive(root)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    stage = await mkdtemp(join(root, '.repair-'))
    const batch = basename(stage).slice(1)
    const prefix = 'repairs/' + batch
    browser = await launch({ headless: !options.login })
    signal.throwIfAborted()
    const context = await browser.newContext({ acceptDownloads: false })
    let page
    if (options.login) {
      page = await context.newPage()
      await page.goto(archive.entry.href, { timeout: 30_000, waitUntil: 'commit' })
      await waitForConfirmation(page, () => send({ type: 'repairAwaitingLogin' }), 'Окно входа закрыто. Запусти докачку заново.')
    }
    for (const item of targets.values()) {
      signal.throwIfAborted()
      const url = item.url.href
      send({ type: 'repairProgress', url, completed: done.length + failed.length, total: targets.size })
      try {
        if (item.kind === 'page') {
          if (!page || page.isClosed()) page = await context.newPage()
          await pageRepair(page, item.url, prefix)
        } else {
          const referrer = new URL(archive.entry.origin)
          if (archive.entry.origin === item.url.origin) referrer.pathname = archive.entry.pathname
          const response = await context.request.get(url, {
            timeout: 30_000, maxRedirects: 10, failOnStatusCode: false,
            headers: { referer: referrer.href },
          })
          try {
            if (!await resource(response, item.url, prefix)) throw new Error(`HTTP ${response.status()}`)
          } finally {
            await response.dispose()
          }
        }
        signal.throwIfAborted()
        done.push({ url, kind: item.kind })
      } catch (error) {
        signal.throwIfAborted()
        const message = error?.message ?? ''
        failed.push({ url, kind: item.kind, message: /^(HTTP |Страница|Сервер)/.test(message)
          ? message : 'Не удалось загрузить адрес.' })
      }
    }

    const results = { done, failed, files: newResources.size + newPages.size }
    if (!results.files) return results
    const replacedPages = new Set(array(manifest.pages).filter(item => newPages.has(item.url)).map(item => item.file))
    const existingPages = new Set(array(manifest.pages).map(item => item.file))
    manifest.files = manifest.files.filter(item => !replacedPages.has(item.file) &&
      (!newResources.has(item.url) || existingPages.has(item.file)))
    manifest.files.push(...newPages.values(), ...newResources.values())
    manifest.pages = array(manifest.pages).filter(item => !newPages.has(item.url)).concat([...newPages.values()])
    const savedPages = new Set(done.filter(item => item.kind === 'page').map(item => item.url))
    manifest.failedPages = array(manifest.failedPages).filter(item => !savedPages.has(address(item.url)?.href))
    for (const [field, latest] of [['redirects', redirects], ['resourceRedirects', resourceAliases]]) {
      manifest[field] = array(manifest[field]).filter(item => !latest.has(item.url))
        .concat([...latest].map(([url, finalUrl]) => ({ url, finalUrl })))
    }
    const pendingManifest = '.updated-manifest'
    await writeFile(join(stage, pendingManifest), JSON.stringify(manifest, null, 2) + '\n')
    signal.throwIfAborted()
    const repairs = join(root, 'repairs')
    await mkdir(repairs, { recursive: true })
    if (!(await lstat(repairs)).isDirectory()) throw new Error('В архиве недоступна папка repairs.')
    const target = join(root, prefix)
    await rename(stage, target)
    destination = target
    signal.throwIfAborted()
    await rename(join(destination, pendingManifest), manifestPath)
    committed = true
    return results
  } finally {
    signal.removeEventListener('abort', closeBrowser)
    await browser?.close().catch(() => {})
    try {
      if (stage) await rm(stage, { recursive: true, force: true })
      if (destination && !committed) await rm(destination, { recursive: true, force: true })
    } finally {
      await release()
    }
  }
}

module.exports = { repairArchive }
