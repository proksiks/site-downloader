<script setup lang="ts">
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

type Counts = { pages: number; failedPages: number; files: number; bytes: number; skipped: number }
type CapturePhase = 'opening' | 'awaitingLogin' | 'capturing' | 'saving' | 'offline'
type CaptureEvent =
  | ({ type: 'progress'; phase: CapturePhase; currentUrl: string; currentPage: number } & Counts)
  | ({ type: 'complete'; folder: string; offlineEntryFile: string | null; pageLimitReached: boolean } & Counts)
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
const pageLimitReached = ref(false)
const resultFolder = ref('')
const offlineEntryFile = ref<string | null>(null)
const error = ref('')
const archiveError = ref('')
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

const status = computed(() => ({
  idle: 'Готов к захвату',
  opening: 'Открываем страницу',
  awaitingLogin: 'Ожидаем входа',
  capturing: 'Собираем ресурсы',
  saving: 'Завершаем сохранение',
  offline: 'Готовим офлайн-версию',
  complete: 'Архив сохранён',
  cancelled: 'Захват отменён',
  error: 'Ошибка захвата',
})[phase.value])

const size = computed(() => {
  const { bytes } = counts.value
  if (bytes >= 1024 ** 3) return `${number.format(bytes / 1024 ** 3)} ГБ`
  if (bytes >= 1024 ** 2) return `${number.format(bytes / 1024 ** 2)} МБ`
  if (bytes >= 1024) return `${number.format(bytes / 1024)} КБ`
  return `${number.format(bytes)} Б`
})

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
  pageLimitReached.value = false
  resultFolder.value = ''
  offlineEntryFile.value = null
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
    }
    if (event.type === 'complete') {
      resultFolder.value = event.folder
      offlineEntryFile.value = event.offlineEntryFile
      pageLimitReached.value = event.pageLimitReached
      phase.value = 'complete'
      canCancel.value = false
    } else {
      phase.value = event.phase
      currentUrl.value = event.currentUrl
      currentPage.value = event.currentPage
      canCancel.value = true
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

async function confirmLogin() {
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

async function openArchive(offlinePreview: boolean) {
  archiveError.value = ''
  try {
    await invoke('open_archive', { offlinePreview })
  } catch (cause) {
    archiveError.value = cause instanceof Error ? cause.message : String(cause)
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
      <span class="font-semibold tracking-tight">Site Downloader</span>
      <AppearanceSettings />
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
          <button v-if="phase === 'awaitingLogin'" type="button" class="primary" :disabled="confirming || cancelling" @click="confirmLogin">
            {{ confirming ? 'Продолжаем…' : 'Я вошёл, начать захват' }}
          </button>
          <button v-else type="submit" class="primary inline-flex items-center gap-2" :disabled="running || choosing">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12m-4-4 4 4 4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </svg>
            {{ login && !running ? 'Открыть окно входа' : 'Начать захват' }}
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
        <div v-if="running && phase !== 'awaitingLogin'" class="progress-track mt-4" role="progressbar" aria-label="Захват выполняется">
          <div />
        </div>
        <p v-if="running && currentPage && (phase === 'opening' || phase === 'capturing')" class="mt-3 text-xs muted">
          <span class="font-semibold">Страница {{ currentPage }} · лимит {{ pageLimit }}</span>
          <span class="mt-1 block truncate" :title="currentUrl">{{ currentUrl }}</span>
        </p>
        <dl class="stats mt-4 grid grid-cols-2 gap-2">
          <div><dt>Страницы</dt><dd>{{ number.format(counts.pages) }}</dd></div>
          <div><dt>Файлы</dt><dd>{{ number.format(counts.files) }}</dd></div>
          <div><dt>Объём</dt><dd>{{ size }}</dd></div>
          <div><dt>Ошибки</dt><dd>{{ number.format(counts.failedPages + counts.skipped) }}</dd></div>
        </dl>
        <div v-if="resultFolder" class="archive-result mt-4">
          <h3 class="text-sm font-semibold">Архив готов</h3>
          <p class="mt-1 break-all font-mono text-xs muted" :title="resultFolder">{{ resultFolder }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button v-if="offlineEntryFile" type="button" class="primary" @click="openArchive(true)">Смотреть офлайн</button>
            <button type="button" class="secondary" @click="openArchive(false)">Открыть папку</button>
          </div>
          <p v-if="archiveError" class="error mt-3" role="alert">{{ archiveError }}</p>
        </div>
        <p v-if="pageLimitReached" class="mt-3 text-xs muted">
          Достигнут лимит страниц. В очереди остались ссылки.
        </p>
      </section>
    </div>
  </main>
</template>
