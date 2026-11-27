<script setup lang="ts">
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { formatCaptureBytes, type CaptureActivity, type CaptureEntry } from '~/utils/capture-display'
import type { FailedArchivePage, RepairCandidate, RepairTarget } from '~/utils/archive-repair'

type Counts = { pages: number; failedPages: number; failedResources?: number; files: number; bytes: number; skipped: number }
type CapturePhase = 'opening' | 'installingBrowser' | 'awaitingLogin' | 'awaitingScene' | 'capturing' | 'saving' | 'offline'
type SceneAssets = { manifest: string; models: number; textures: number }
type ArchiveInfo = { folder: string; offlineHtml: string | null; hasSceneAssets: boolean; failedPages: FailedArchivePage[] }
type ReplayMissing = { type: 'replayMissing'; url: string; resourceType: string; requestUrl: string; kind: RepairTarget['kind'] }
type ArchiveAction = 'localHtml' | 'folder' | 'sceneAssets'
type CaptureEvent =
  | ({ type: 'progress'; phase: CapturePhase; currentUrl: string; currentPage: number; activity: CaptureActivity } & Counts)
  | ({ type: 'complete'; folder: string; offlineEntryFile: string | null; sceneAssets: SceneAssets | null; pageLimitReached: boolean; failedPageEntries: FailedArchivePage[] } & Counts)
  | { type: 'cancelled' }

useHead({ title: 'Site Downloader', htmlAttrs: { lang: 'ru' } })

const url = ref('')
const directory = ref('')
const waitSeconds = ref(15)
const pageLimit = ref(10)
const login = ref(false)
const includePaths = ref('')
const excludePaths = ref('/logout\n/signout')
const skipVideo = ref(false)
const manualScene = ref(false)
const running = ref(false)
const choosing = ref(false)
const cancelling = ref(false)
const confirming = ref(false)
const phase = ref<CapturePhase | 'idle' | 'complete' | 'cancelled' | 'error'>('idle')
const canCancel = ref(false)
const emptyCounts: Counts = { pages: 0, failedPages: 0, files: 0, bytes: 0, skipped: 0 }
const counts = ref<Counts>(emptyCounts)
const currentUrl = ref('')
const currentPage = ref(0)
const activity = ref<CaptureActivity>()
const captureEntries = ref<CaptureEntry[]>([])
const omittedEntries = ref(0)
const captureRun = ref(0)
const pageLimitReached = ref(false)
const resultFolder = ref('')
const resultFailedPages = ref<FailedArchivePage[]>([])
const offlineEntryFile = ref<string | null>(null)
const sceneAssets = ref<SceneAssets | null>(null)
const error = ref('')
const archiveError = ref('')
const replayError = ref('')
const replayStatus = ref('')
const replayUrl = ref('')
const useOriginalReplayAddress = ref(false)
const replayFolder = ref('')
const replayMissing = ref<ReplayMissing[]>([])
const previewing = ref(false)
const choosingArchive = ref(false)
const selectedArchive = ref<ArchiveInfo | null>(null)
const archiveBrowser = ref<{ show: (directory: string) => Promise<void> } | null>(null)
const archiveRepair = ref<{ show: (directory: string, entries: RepairCandidate[]) => void } | null>(null)
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

const status = computed(() => ({
  idle: 'Готов к захвату',
  opening: 'Открываем страницу',
  installingBrowser: 'Скачиваем Chromium',
  awaitingLogin: 'Ожидаем входа',
  awaitingScene: 'Записываем 3D-сцену',
  capturing: 'Собираем ресурсы',
  saving: 'Завершаем сохранение',
  offline: 'Готовим офлайн-версию',
  complete: 'Архив сохранён',
  cancelled: 'Захват отменён',
  error: 'Ошибка захвата',
})[phase.value])

const size = computed(() => formatCaptureBytes(counts.value.bytes))

async function chooseDirectory() {
  choosing.value = true
  error.value = ''
  try {
    if (!isTauri()) throw new Error('Открой приложение через npm run tauri dev.')
    const selected = await open({ directory: true, multiple: false, title: 'Куда сохранить архив?' })
    if (selected) directory.value = selected
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    choosing.value = false
  }
}

async function start() {
  if (running.value || choosing.value) return
  error.value = ''

  let address: URL
  try {
    address = new URL(url.value.trim())
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
      throw new Error()
    }
  } catch {
    error.value = 'Введи полный HTTP или HTTPS URL, например https://example.com.'
    return
  }
  if (!directory.value) {
    await chooseDirectory()
    if (!directory.value) return
  }

  phase.value = 'opening'
  counts.value = emptyCounts
  currentUrl.value = ''
  currentPage.value = 0
  activity.value = undefined
  captureEntries.value = []
  omittedEntries.value = 0
  captureRun.value++
  pageLimitReached.value = false
  resultFolder.value = ''
  resultFailedPages.value = []
  offlineEntryFile.value = null
  sceneAssets.value = null
  archiveError.value = ''
  running.value = true
  const events = new Channel<CaptureEvent>()
  events.onmessage = (event) => {
    if (event.type === 'cancelled') {
      phase.value = 'cancelled'
      counts.value = emptyCounts
      return
    }
    counts.value = {
      pages: event.pages,
      failedPages: event.failedPages,
      files: event.files,
      bytes: event.bytes,
      skipped: event.skipped,
      failedResources: event.failedResources,
    }
    if (event.type === 'complete') {
      resultFolder.value = event.folder
      resultFailedPages.value = event.failedPageEntries ?? []
      offlineEntryFile.value = event.offlineEntryFile
      sceneAssets.value = event.sceneAssets
      pageLimitReached.value = event.pageLimitReached
      phase.value = 'complete'
      canCancel.value = false
    } else {
      if (phase.value !== event.phase) confirming.value = false
      phase.value = event.phase
      currentUrl.value = event.currentUrl
      currentPage.value = event.currentPage
      canCancel.value = true
      if (event.activity) {
        activity.value = event.activity
        const updated = [...event.activity.entries.slice().reverse(), ...captureEntries.value]
        captureEntries.value = updated.slice(0, 200)
        omittedEntries.value += event.activity.omitted + Math.max(0, updated.length - 200)
      }
    }
  }

  try {
    await invoke('start_capture', {
      request: {
        url: address.href,
        directory: directory.value,
        waitSeconds: waitSeconds.value,
        pageLimit: pageLimit.value,
        options: {
          login: login.value,
          includePaths: includePaths.value,
          excludePaths: excludePaths.value,
          skipVideo: skipVideo.value,
          manualScene: manualScene.value,
        },
      },
      events,
    })
  } catch (cause) {
    phase.value = 'error'
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    running.value = false
    canCancel.value = false
    cancelling.value = false
    confirming.value = false
  }
}

async function confirmCaptureStep() {
  confirming.value = true
  error.value = ''
  try {
    await invoke('continue_capture')
  } catch (cause) {
    confirming.value = false
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function cancel() {
  cancelling.value = true
  try {
    await invoke('cancel_capture')
  } catch (cause) {
    cancelling.value = false
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function openArchive(directory: string, action: ArchiveAction) {
  archiveError.value = ''
  try {
    await invoke('open_archive', { directory, action })
  } catch (cause) {
    archiveError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function chooseArchive() {
  if (choosingArchive.value) return
  archiveError.value = ''
  choosingArchive.value = true
  try {
    const directory = await open({ directory: true, multiple: false, title: 'Выбери папку с manifest.json' })
    if (directory) selectedArchive.value = await invoke<ArchiveInfo>('inspect_archive', { directory })
  } catch (cause) {
    archiveError.value = String(cause)
  } finally {
    choosingArchive.value = false
  }
}

async function replayArchive(directory: string) {
  if (previewing.value) return
  replayError.value = ''
  previewing.value = true
  replayFolder.value = directory
  replayMissing.value = []
  replayUrl.value = ''
  replayStatus.value = 'Открываем Chromium…'
  const events = new Channel<
    { type: 'replayReady'; url: string } | { type: 'replayInstalling' } |
    ReplayMissing
  >()
  events.onmessage = (event) => {
    if (event.type === 'replayMissing') {
      replayMissing.value.push(event)
      return
    }
    if (event.type === 'replayReady') {
      replayStatus.value = 'Офлайн-архив открыт в Chromium'
      replayUrl.value = event.url
    } else {
      replayStatus.value = 'Скачиваем Chromium…'
    }
  }
  try {
    await invoke('replay_archive', { directory, events, useOriginalAddress: useOriginalReplayAddress.value })
  } catch (cause) {
    replayError.value = String(cause)
  } finally {
    previewing.value = false
    replayStatus.value = ''
    replayUrl.value = ''
  }
}

function showRepair(folder: string) {
  const failed = [
    ...(folder === resultFolder.value ? resultFailedPages.value : []),
    ...(folder === selectedArchive.value?.folder ? selectedArchive.value.failedPages ?? [] : []),
  ]
  const missing = folder === replayFolder.value ? replayMissing.value : []
  archiveRepair.value?.show(folder, [
    ...missing.map(item => ({ url: item.requestUrl, kind: item.kind, description: item.resourceType })),
    ...failed.map(item => ({ url: item.url, kind: 'page' as const, description: item.message })),
  ])
}

function removeRepaired(folder: string, targets: RepairTarget[]) {
  const pages = new Set(targets.filter(item => item.kind === 'page').map(item => item.url))
  const stillFailed = (item: FailedArchivePage) => !pages.has(item.url.split('#')[0] ?? item.url)
  if (folder === resultFolder.value) resultFailedPages.value = resultFailedPages.value.filter(stillFailed)
  if (folder === selectedArchive.value?.folder) {
    selectedArchive.value.failedPages = (selectedArchive.value.failedPages ?? []).filter(stillFailed)
  }
  if (folder === replayFolder.value) {
    const repaired = new Set(targets.map(item => item.kind + ':' + item.url))
    replayMissing.value = replayMissing.value.filter(item => !repaired.has(item.kind + ':' + item.requestUrl))
  }
}

async function stopReplay() {
  try {
    await invoke('stop_replay')
  } catch (cause) {
    if (previewing.value) replayError.value = String(cause)
  }
}
</script>

<template>
  <header class="app-header">
    <div class="brand mx-auto flex max-w-[64rem] items-center gap-3">
      <div class="brand-icon grid size-9 place-items-center rounded-xl">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3v12m-4-4 4 4 4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
      </div>
      <span class="min-w-0 truncate font-semibold tracking-tight">Site Downloader</span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <AppUpdates :busy="running || previewing" />
        <AppHelp />
        <AppearanceSettings />
      </div>
    </div>
  </header>

  <main class="workspace mx-auto max-w-[64rem]">
    <h1 class="text-[clamp(1.9rem,5vw,2.85rem)] leading-tight font-semibold tracking-[-.045em]">
      Скачать страницы сайта
    </h1>
    <p class="mt-2 text-[.93rem] leading-relaxed muted">
      Сохрани страницы и ресурсы сайта, чтобы открыть их без интернета.
    </p>

    <div class="capture-layout mt-7">
      <form class="panel capture-form" aria-labelledby="capture-title" @submit.prevent="start">
        <h2 id="capture-title" class="mb-4 text-base font-semibold">Параметры захвата</h2>
        <div>
          <label for="url">Адрес страницы</label>
          <div class="input-shell mt-2 flex items-center gap-3">
            <svg class="field-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18m-9-9c2 2.5 3 5.5 3 9s-1 6.5-3 9c-2-2.5-3-5.5-3-9s1-6.5 3-9Z" />
            </svg>
            <input id="url" v-model="url" type="text" inputmode="url" autocomplete="url" placeholder="https://example.com" required :disabled="running || choosing">
          </div>
        </div>

        <div class="mt-5 grid grid-cols-2 gap-4">
          <div class="col-span-2">
            <label for="directory">Папка для сохранения</label>
            <div class="mt-2 flex gap-2">
              <div class="input-shell flex min-w-0 flex-1 items-center gap-3">
                <svg class="field-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 19V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
                </svg>
                <input id="directory" :value="directory" :title="directory" placeholder="Выбери папку" readonly>
              </div>
              <button type="button" class="secondary" :disabled="running || choosing" @click="chooseDirectory">
                Обзор…
              </button>
            </div>
          </div>
          <div>
            <label for="wait" title="Сколько ждать после загрузки каждой страницы">Ожидание</label>
            <div class="input-shell mt-2 flex items-center gap-2">
              <input id="wait" v-model.number="waitSeconds" type="number" min="1" max="60" required :disabled="running || choosing">
              <span class="text-sm muted" aria-hidden="true">с</span>
            </div>
          </div>
          <div>
            <label for="page-limit" title="Сколько страниц открыть, включая стартовую">Лимит страниц</label>
            <div class="input-shell mt-2">
              <input id="page-limit" v-model.number="pageLimit" type="number" min="1" max="100" required :disabled="running || choosing">
            </div>
          </div>
        </div>

        <label class="capture-checkbox mt-5">
          <input v-model="login" type="checkbox" :disabled="running || choosing">
          Скачать после входа
        </label>
        <p v-if="login" class="mt-2 text-xs muted">
          Войди на сайте в окне Chromium и вернись в приложение. Архив может содержать данные твоего аккаунта.
        </p>

        <label class="capture-checkbox mt-3">
          <input v-model="manualScene" type="checkbox" :disabled="running || choosing">
          Ручной захват 3D-сцены
        </label>
        <p v-if="manualScene" class="mt-2 text-xs muted">
          Покрути сцену и открой нужные объекты в Chromium. Стартовая страница записывается, пока ты не завершишь захват вручную.
        </p>

        <details class="capture-filters mt-4">
          <summary>Фильтры обхода</summary>
          <fieldset class="mt-3 grid gap-3 sm:grid-cols-2" :disabled="running || choosing">
            <p class="sm:col-span-2 text-xs muted">
              По одному пути на строку. Например, /docs включает весь раздел. Стартовый адрес открывается в любом случае.
            </p>
            <div>
              <label for="include-paths">Только эти разделы</label>
              <textarea id="include-paths" v-model="includePaths" class="filter-paths mt-2" placeholder="/docs" rows="2" maxlength="4096" />
            </div>
            <div>
              <label for="exclude-paths">Пропустить разделы</label>
              <textarea id="exclude-paths" v-model="excludePaths" class="filter-paths mt-2" placeholder="/logout" rows="2" maxlength="4096" />
            </div>
            <label class="capture-checkbox sm:col-span-2">
              <input v-model="skipVideo" type="checkbox">
              Не сохранять видео
            </label>
          </fieldset>
        </details>

        <div v-if="error" class="error mt-4" role="alert">{{ error }}</div>
        <div class="capture-actions mt-5 flex flex-wrap items-center gap-3">
          <button v-if="phase === 'awaitingLogin'" type="button" class="primary" :disabled="confirming || cancelling" @click="confirmCaptureStep">
            {{ confirming ? 'Продолжаем…' : 'Я вошёл, начать захват' }}
          </button>
          <button v-else-if="phase === 'awaitingScene'" type="button" class="primary" :disabled="confirming || cancelling" @click="confirmCaptureStep">
            {{ confirming ? 'Завершаем…' : 'Завершить захват сцены' }}
          </button>
          <button v-else type="submit" class="primary inline-flex items-center gap-2" :disabled="running || choosing">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12m-4-4 4 4 4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </svg>
            {{ login && !running ? 'Открыть окно входа' : manualScene && !running ? 'Открыть сцену' : 'Начать захват' }}
          </button>
          <button v-if="running" type="button" class="secondary" :disabled="!canCancel || cancelling" @click="cancel">
            {{ cancelling ? 'Отменяем…' : 'Отменить' }}
          </button>
        </div>
      </form>

      <section class="panel capture-status" aria-labelledby="status-title">
        <div class="flex items-center justify-between gap-3">
          <h2 id="status-title" class="text-base font-semibold">Захват</h2>
          <div class="status" :data-phase="phase" role="status">
            <span class="status-dot" aria-hidden="true" />
            {{ status }}
          </div>
        </div>
        <div v-if="running && !activity" class="progress-track mt-4" role="progressbar" aria-label="Подготовка захвата">
          <div />
        </div>
        <dl class="stats mt-4 grid grid-cols-2 gap-2">
          <div><dt>Страницы</dt><dd>{{ number.format(counts.pages) }}</dd></div>
          <div><dt>Файлы</dt><dd>{{ number.format(counts.files) }}</dd></div>
          <div><dt>Объём</dt><dd>{{ size }}</dd></div>
          <div><dt>Ошибки</dt><dd>{{ number.format(counts.failedPages + counts.skipped + (counts.failedResources ?? 0)) }}</dd></div>
        </dl>
        <CaptureTelemetry v-if="activity" :key="captureRun" :activity="activity" :entries="captureEntries"
                          :omitted="omittedEntries" :page="currentPage" :address="currentUrl" :phase="phase" :running="running" />
        <div v-if="resultFolder" class="archive-result mt-4">
          <h3 class="text-sm font-semibold">Архив готов</h3>
          <p class="mt-1 break-all font-mono text-xs muted" :title="resultFolder">{{ resultFolder }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="primary" :disabled="previewing" @click="replayArchive(resultFolder)">Запустить с JavaScript</button>
            <button type="button" class="secondary" @click="archiveBrowser?.show(resultFolder)">Файлы архива</button>
            <button v-if="resultFailedPages.length" type="button" class="secondary" @click="showRepair(resultFolder)">Докачать пропущенное</button>
            <button v-if="offlineEntryFile" type="button" class="secondary" @click="openArchive(resultFolder, 'localHtml')">Открыть HTML-снимок</button>
            <button type="button" class="secondary" @click="openArchive(resultFolder, 'folder')">Открыть папку</button>
            <button v-if="sceneAssets" type="button" class="secondary" @click="openArchive(resultFolder, 'sceneAssets')">Открыть 3D-файлы</button>
          </div>
          <p v-if="sceneAssets" class="mt-2 text-xs muted">
            Модели {{ number.format(sceneAssets.models) }} · Текстуры {{ number.format(sceneAssets.textures) }}
          </p>
        </div>
        <p v-if="pageLimitReached" class="mt-3 text-xs muted">
          Достигнут лимит страниц. В очереди остались ссылки.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" class="secondary" :disabled="choosingArchive" @click="chooseArchive">
            Выбрать папку архива…
          </button>
          <button v-if="previewing" type="button" class="text-action" @click="stopReplay">Закрыть просмотр</button>
        </div>
        <div v-if="selectedArchive" class="archive-result mt-3">
          <h3 class="text-sm font-semibold">Выбранный архив</h3>
          <p class="mt-1 break-all font-mono text-xs muted">{{ selectedArchive.folder }}</p>
          <p v-if="selectedArchive.offlineHtml" class="mt-1 break-all font-mono text-xs muted">{{ selectedArchive.offlineHtml }}</p>
          <p v-else class="mt-2 text-xs muted">В папке нет статического HTML-снимка. Запуск с JavaScript доступен.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="primary" @click="archiveBrowser?.show(selectedArchive.folder)">Файлы архива</button>
            <button v-if="selectedArchive.failedPages?.length" type="button" class="secondary" @click="showRepair(selectedArchive.folder)">Докачать пропущенное</button>
            <button type="button" class="secondary" :disabled="previewing" @click="replayArchive(selectedArchive.folder)">Запустить с JavaScript</button>
            <button v-if="selectedArchive.offlineHtml" type="button" class="secondary" @click="openArchive(selectedArchive.folder, 'localHtml')">Открыть HTML-снимок</button>
            <button type="button" class="secondary" @click="openArchive(selectedArchive.folder, 'folder')">Открыть папку</button>
            <button v-if="selectedArchive.hasSceneAssets" type="button" class="secondary" @click="openArchive(selectedArchive.folder, 'sceneAssets')">Открыть 3D-файлы</button>
          </div>
        </div>
        <div v-if="resultFolder || selectedArchive" class="mt-3">
          <label class="capture-checkbox">
            <input v-model="useOriginalReplayAddress" type="checkbox" :disabled="previewing">
            Использовать исходный адрес
          </label>
          <p class="mt-1 text-xs muted">Включи, если скрипты сайта зависят от его домена. HTML-снимок открывается без скриптов.</p>
        </div>
        <p v-if="archiveError" class="error mt-2" role="alert">{{ archiveError }}</p>
        <p v-if="replayStatus" class="mt-2 text-xs muted" role="status">{{ replayStatus }}</p>
        <p v-if="replayUrl" class="mt-1 break-all font-mono text-xs muted">{{ replayUrl }}</p>
        <p v-if="replayError" class="error mt-2" role="alert">{{ replayError }}</p>
        <div v-if="replayMissing.length" class="archive-result mt-4">
          <p class="text-sm font-semibold">Не хватило ресурсов ({{ replayMissing.length }}{{ replayMissing.length === 100 ? '+' : '' }})</p>
          <button type="button" class="secondary mt-2" @click="showRepair(replayFolder)">Докачать пропущенное</button>
        </div>
      </section>
    </div>
  </main>
  <ArchiveBrowser ref="archiveBrowser" />
  <ArchiveRepair ref="archiveRepair" :wait-seconds="waitSeconds" @repaired="removeRepaired" />
</template>
