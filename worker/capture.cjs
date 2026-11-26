const { chromium } = require('playwright-core')
const { execFile } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { constants } = require('node:fs')
const { access, mkdir, mkdtemp, rename, rm, writeFile } = require('node:fs/promises')
const { dirname, extname, join } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const { promisify } = require('node:util')
const { createOffline } = require('./offline.cjs')
const { ArchivePaths, contentExtension } = require('./archive-paths.cjs')
const { replay } = require('./replay.cjs')
const { exportSceneAssets } = require('./scene-assets.cjs')
const { captureActivity } = require('./capture-activity.cjs')

function send(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

const cancellation = new AbortController()
const { signal } = cancellation
const commands = new EventEmitter()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (command) => {
  if (command === 'cancel') cancellation.abort()
  if (command === 'continue') commands.emit('continue')
})
input.once('close', () => cancellation.abort())

function webUrl(address, base) {
  try {
    const url = new URL(address, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function resourceUrl(address, base) {
  const url = webUrl(address, base)
  if (url) url.hash = ''
  return url
}

function isHtml(contentType) {
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)
}

function pathPrefixes(text = '') {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((path) => {
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path)) {
      throw new Error('Укажи фильтры путей с начальным /, по одному на строку. Например, /docs.')
    }
    const { pathname } = new URL(path, 'https://example.invalid')
    return pathname.replace(/\/+$/, '') || '/'
  })
}

function matchesPrefix(path, prefix) {
  return prefix === '/' || path === prefix || path.startsWith(prefix + '/')
}

function isVideo(response, address) {
  const type = response.headers()['content-type'] || ''
  return /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)(?:;|$))/i.test(type) ||
    /\.(?:mp4|webm|m4v|mov|ogv|mkv|mpg|mpeg|avi|m3u8|mpd|m4s)$/i.test(new URL(address).pathname)
}

async function waitForConfirmation(page, onReady, closedMessage) {
  const waiting = new AbortController()
  const options = { signal: AbortSignal.any([signal, waiting.signal]) }
  try {
    const confirmed = Promise.race([
      once(commands, 'continue', options),
      once(page, 'close', options).then(() => {
        throw new Error(closedMessage)
      }),
    ])
    onReady()
    await confirmed
  } finally {
    waiting.abort()
  }
}

class PageCaptureError extends Error {}

async function ensureChromium(onInstall) {
  if (process.env.SITE_DOWNLOADER_AUTO_INSTALL_BROWSER !== '1') return
  const available = async () => access(chromium.executablePath(), constants.X_OK).then(() => true, () => false)
  if (await available()) return

  onInstall()
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js')
  try {
    await promisify(execFile)(process.execPath, [cli, 'install', 'chromium', '--no-shell', '--no-remove', '--no-progress'], {
      signal,
      windowsHide: true,
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('Не удалось скачать Chromium. Проверь подключение к интернету и попробуй ещё раз.')
  }
  if (!await available()) throw new Error('Установленный Chromium не найден.')
}

async function launchBrowser(options) {
  return chromium.launch({
    channel: 'chromium',
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...options,
  }).catch((error) => {
    if (error.message.includes('Executable doesn\'t exist')) {
      throw new Error('Chromium не установлен. Выполни npm run browser:install.')
    }
    throw error
  })
}

async function capture(target, directory, waitSeconds, pageLimit, options) {
  const url = webUrl(target)
  if (!url) throw new Error('Укажи HTTP или HTTPS URL без логина и пароля.')
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 60) {
    throw new Error('Укажи время ожидания от 1 до 60 секунд.')
  }
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new Error('Укажи лимит от 1 до 100 страниц.')
  }
  const { login = false, skipVideo = false, manualScene = false } = options
  const include = pathPrefixes(options.includePaths)
  const exclude = pathPrefixes(options.excludePaths)

  function allowedPath(path) {
    return !exclude.some((prefix) => matchesPrefix(path, prefix)) &&
      (!include.length || include.some((prefix) => matchesPrefix(path, prefix)))
  }

  const host = url.hostname.replace(/[^a-z0-9-]+/gi, '-').slice(0, 70)
  const staging = await mkdtemp(join(directory, '.capture-'))
  const folder = join(directory, `${host}-${staging.slice(-6)}`)
  const assets = new Map()
  const assetAliases = new Map()
  const pages = new Map()
  const snapshots = new Map()
  const archivePaths = new ArchivePaths()
  const offlinePaths = new ArchivePaths()
  const failedPages = []
  const redirects = []
  const queue = new Set([resourceUrl(url.href).href])
  const visited = new Set()
  const activity = captureActivity()
  const inFlight = new Map()
  const pending = new Map()
  let browser
  let origin
  let currentUrl = url.href
  let currentPage = 0
  let phase = 'opening'
  let bytes = 0
  let skipped = 0
  let failedResources = 0
  let processedPages = 0

  function counts() {
    return {
      files: assets.size + pages.size,
      bytes,
      skipped,
      pages: pages.size,
      failedPages: failedPages.length,
      failedResources,
    }
  }

  function progress() {
    const active = [...new Set([...inFlight.values(), ...pending.keys()])]
    send({
      type: 'progress', phase, currentUrl, currentPage, pageLimit, ...counts(),
      activity: {
        ...activity.snapshot(),
        processedPages,
        queuedPages: Math.min(queue.size, pageLimit - currentPage),
        activeCount: active.length,
        activeUrls: active.slice(-3).reverse(),
      },
    })
  }

  async function save(response, address, file, body) {
    const destination = join(staging, file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, body)
    bytes += body.length
    activity.saved(body.length)
    return {
      url: address,
      file,
      contentType: response.headers()['content-type'] || '',
      method: response.request().method(),
      bytes: body.length,
      status: response.status(),
    }
  }

  async function discoverLinks(page) {
    if (webUrl(page.url())?.origin !== origin) return null
    const rendered = await page.evaluate(() => ({
      base: document.baseURI,
      links: Array.from(document.querySelectorAll('a[href]:not([download]), area[href]'), link => link.getAttribute('href')),
    })).catch(() => null)
    if (!rendered) return null
    for (const href of rendered.links) {
      if (!href || href.startsWith('#')) continue
      const link = resourceUrl(href, rendered.base)
      if (link?.origin === origin && allowedPath(link.pathname) &&
          !pages.has(link.href) && !visited.has(link.href)) {
        queue.add(link.href)
      }
    }
    return rendered.base
  }

  async function capturePage(page, address) {
    let writeError

    function track(request) {
      if (request.resourceType() === 'document') return
      const url = resourceUrl(request.url())
      if (url && !assets.has(url.href)) inFlight.set(request, url.href)
    }

    function untrack(request) {
      inFlight.delete(request)
    }

    function failed(request) {
      const assetUrl = inFlight.get(request)
      const message = request.failure()?.errorText
      untrack(request)
      if (!assetUrl || signal.aborted || message === 'net::ERR_ABORTED') return
      failedResources++
      activity.record('error', 'Запрос не удался', assetUrl, message)
    }

    function onResponse(response) {
      const request = response.request()
      if (request.isNavigationRequest() && response.frame() === page.mainFrame()) return

      const assetUrl = resourceUrl(response.url())?.href
      const status = response.status()
      if (!assetUrl) return
      if (status >= 400 && !assets.has(assetUrl)) {
        failedResources++
        activity.record('error', 'Сервер вернул ошибку', assetUrl, `HTTP ${status}`)
      }
      if (!response.ok() || status === 204 || status === 206) return
      if (skipVideo && isVideo(response, assetUrl)) return
      for (let redirect = request.redirectedFrom(); redirect; redirect = redirect.redirectedFrom()) {
        const source = resourceUrl(redirect.url())
        if (source) assetAliases.set(source.href, assetUrl)
      }
      if (assets.has(assetUrl) || pending.has(assetUrl)) return

      const task = response.body().catch(() => {
        if (!signal.aborted) {
          skipped++
          activity.record('error', 'Не удалось прочитать файл', assetUrl)
        }
        return null
      }).then(async (body) => {
        if (body && !signal.aborted) {
          const type = response.headers()['content-type'] || ''
          const file = archivePaths.asset(assetUrl, type)
          const asset = await save(response, assetUrl, file, body)
          assets.set(assetUrl, asset)
          activity.record('resource', 'Сохранён файл', assetUrl, file, asset.bytes)
        }
      }).catch((error) => {
        writeError ??= error
      }).finally(() => pending.delete(assetUrl))
      pending.set(assetUrl, task)
    }

    page.on('response', onResponse)
    page.on('request', track)
    page.on('requestfinished', untrack)
    page.on('requestfailed', failed)
    try {
      const response = await page.goto(currentPage === 1 ? url.href : address, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      }).catch(() => {
        throw new PageCaptureError('Не удалось открыть страницу.')
      })
      if (!response?.ok()) {
        throw new PageCaptureError(response
          ? `Страница вернула HTTP ${response.status()}.`
          : 'Страница не вернула HTTP-ответ.')
      }

      const final = resourceUrl(response.url())
      if (!final || (origin && final.origin !== origin)) {
        throw new PageCaptureError('Перенаправление за пределы сайта.')
      }
      origin ??= final.origin
      if (address !== final.href) redirects.push({ url: address, finalUrl: final.href })
      if (currentPage > 1 && !allowedPath(final.pathname)) return
      if (skipVideo && isVideo(response, final.href)) {
        if (currentPage === 1) throw new PageCaptureError('По стартовому адресу находится видео. Сними фильтр, чтобы сохранить его.')
        return
      }
      if (pages.has(final.href)) return
      queue.delete(final.href)
      currentUrl = final.href
      phase = 'capturing'
      progress()

      const body = await response.body().catch(() => {
        throw new PageCaptureError('Не удалось прочитать ответ страницы.')
      })
      const contentType = response.headers()['content-type'] || ''
      const html = isHtml(contentType)
      const sourceExtension = extname(final.pathname).toLowerCase()
      const extension = contentExtension(contentType) ||
        (html ? '.html' : (/^\.[a-z0-9]{1,12}$/.test(sourceExtension) ? sourceExtension : '.bin'))
      const file = archivePaths.page(final.href, extension)

      if (html) {
        await discoverLinks(page)
        progress()
      }
      if (manualScene && currentPage === 1 && html) {
        await waitForConfirmation(page, () => {
          phase = 'awaitingScene'
          activity.record('system', 'Ожидаем завершения ручного захвата')
          progress()
        }, 'Окно Chromium закрыто до завершения захвата сцены.')
      } else {
        await delay(waitSeconds * 1000, undefined, { signal })
      }
      if (html) {
        const base = await discoverLinks(page)
        const snapshot = base && await page.content().catch(() => null)
        if (snapshot && webUrl(page.url())?.origin === origin) {
          const snapshotFile = offlinePaths.page(final.href)
          const destination = join(staging, 'offline', snapshotFile)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, snapshot, 'utf8')
          snapshots.set(final.href, { file: snapshotFile, base })
        }
      }

      page.off('response', onResponse)
      const drain = new AbortController()
      try {
        await Promise.race([
          Promise.all(pending.values()),
          delay(5000, undefined, { signal: drain.signal }),
        ])
      } finally {
        drain.abort()
      }
      signal.throwIfAborted()
      const savedPage = await save(response, final.href, file, body)
      pages.set(final.href, savedPage)
      activity.record('page', 'Сохранена страница', final.href, file, savedPage.bytes)
    } finally {
      page.off('response', onResponse)
      page.off('request', track)
      page.off('requestfinished', untrack)
      page.off('requestfailed', failed)
      inFlight.clear()
      if (login && !signal.aborted && !page.isClosed()) {
        // The original tab keeps sessionStorage while previous requests are released.
        await page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => {
          return page.close().catch(() => {})
        })
      } else {
        await page.close().catch(() => {})
      }
      await Promise.all(pending.values())
      if (writeError) throw writeError
    }
  }

  function closeBrowser() {
    void browser?.close().catch(() => {})
  }

  signal.addEventListener('abort', closeBrowser, { once: true })
  const timer = setInterval(progress, 500)
  try {
    activity.record('system', 'Запуск захвата')
    progress()
    await ensureChromium(() => {
      phase = 'installingBrowser'
      activity.record('system', 'Подготавливаем Chromium')
      progress()
    })
    signal.throwIfAborted()
    phase = 'opening'
    progress()
    browser = await launchBrowser({ headless: !login && !manualScene })
    signal.throwIfAborted()
    const context = await browser.newContext({ acceptDownloads: false })
    const loginPage = login ? await context.newPage() : null
    if (loginPage) {
      await loginPage.goto(url.href, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {
        throw new Error('Не удалось открыть страницу для входа.')
      })
      await waitForConfirmation(loginPage, () => {
        phase = 'awaitingLogin'
        activity.record('system', 'Ожидаем входа в Chromium')
        progress()
      }, 'Окно входа закрыто. Запусти захват заново.')
      await loginPage.goto('about:blank', { waitUntil: 'commit', timeout: 5000 })
    }
    while (queue.size && currentPage < pageLimit) {
      signal.throwIfAborted()
      const address = queue.values().next().value
      queue.delete(address)
      visited.add(address)
      currentUrl = address
      currentPage++
      phase = 'opening'
      activity.record('page', 'Открываем страницу', currentUrl)
      progress()
      try {
        const page = loginPage ?? await context.newPage()
        if (page.isClosed()) throw new Error('Окно Chromium закрыто во время захвата.')
        await capturePage(page, address)
      } catch (error) {
        signal.throwIfAborted()
        activity.record('error', 'Не удалось сохранить страницу', currentUrl, error.message)
        if (!(error instanceof PageCaptureError) || currentPage === 1) throw error
        failedPages.push({ url: address, message: error.message })
      } finally {
        processedPages++
        progress()
      }
    }

    phase = 'saving'
    activity.record('system', 'Собираем архив и 3D-ресурсы')
    progress()
    const documents = [...pages.values()]
    const [entry] = documents
    const pageLimitReached = queue.size > 0 && currentPage === pageLimit
    const sceneAssets = await exportSceneAssets({ staging, assets: new Map([...documents.map(page => [page.url, page]), ...assets]), assetAliases, signal })
    phase = 'offline'
    activity.record('system', 'Готовим офлайн-копию')
    progress()
    const offlineEntryFile = await createOffline({
      staging, entryUrl: entry.url, snapshots, pages, resources: assets, redirects, assetAliases, offlinePaths, signal,
    })
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({
      url: url.href,
      finalUrl: entry.url,
      entryFile: entry.file,
      offlineEntryFile,
      sceneAssets,
      pages: documents,
      redirects,
      resourceRedirects: [...assetAliases].filter(([, finalUrl]) => assets.has(finalUrl))
        .map(([url, finalUrl]) => ({ url, finalUrl })),
      failedPages,
      pageLimitReached,
      files: [...documents, ...assets.values()],
    }, null, 2) + '\n')
    signal.throwIfAborted()
    await rename(staging, folder)
    activity.record('system', 'Архив сохранён')
    progress()
    send({ type: 'complete', folder, offlineEntryFile, sceneAssets, pageLimitReached, ...counts() })
  } catch (error) {
    activity.record('system', signal.aborted ? 'Захват отменён' : 'Захват остановлен')
    progress()
    throw error
  } finally {
    clearInterval(timer)
    signal.removeEventListener('abort', closeBrowser)
    if (browser) await browser.close().catch(() => {})
    await rm(staging, { recursive: true, force: true })
  }
}

const [target, directory, waitSeconds, pageLimit = '1', options = '{}'] = process.argv.slice(2)
async function run() {
  if (target === '--replay') {
    await ensureChromium(() => send({ type: 'replayInstalling' }))
    await replay(directory, { launch: launchBrowser, signal, send, useOriginalAddress: waitSeconds === 'original' })
    signal.throwIfAborted()
    send({ type: 'complete' })
  } else if (target === '--analyze-js') {
    const { analyzeJavaScript } = require('./analyze-js.cjs')
    send({ type: 'analysis', result: await analyzeJavaScript(directory) })
  } else {
    await capture(target, directory, Number(waitSeconds), Number(pageLimit), JSON.parse(options))
  }
}

run().catch((error) => {
  if (signal.aborted) {
    send({ type: 'cancelled' })
  } else {
    send({ type: 'error', message: error.message })
    process.exitCode = 1
  }
}).finally(() => {
  input.close()
  process.stdin.destroy()
})
