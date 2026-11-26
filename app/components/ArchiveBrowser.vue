<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { captureAddress, formatCaptureBytes } from '~/utils/capture-display'

const categories = [
  { id: 'all', label: 'Все' },
  { id: 'html', label: 'HTML' },
  { id: 'js', label: 'JavaScript' },
  { id: 'css', label: 'CSS' },
  { id: 'images', label: 'Картинки' },
  { id: 'scene', label: '3D' },
  { id: 'fonts', label: 'Шрифты' },
  { id: 'media', label: 'Медиа' },
  { id: 'data', label: 'Данные' },
  { id: 'other', label: 'Прочее' },
] as const
type Category = typeof categories[number]['id']
type ArchiveFile = {
  path: string
  url: string | null
  bytes: number | null
  category: Exclude<Category, 'all'>
  variant: 'original' | 'snapshot' | 'export'
  preview: string | null
}

const dialog = ref<HTMLDialogElement | null>(null)
const detail = ref<HTMLElement | null>(null)
const folder = ref('')
const files = shallowRef<ArchiveFile[]>([])
const activeCategory = ref<Category>('all')
const search = ref('')
const shown = ref(40)
const loading = ref(false)
const listError = ref('')
const selected = ref<ArchiveFile | null>(null)
const previewError = ref('')
const previewLoading = ref(false)
const source = ref('')
const image = ref('')
const truncated = ref(false)
let requestId = 0
let previewId = 0

const categoryCounts = computed(() => {
  const totals = new Map<Category, number>([['all', files.value.length]])
  for (const entry of files.value) totals.set(entry.category, (totals.get(entry.category) ?? 0) + 1)
  return totals
})
const matches = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return files.value.filter(entry =>
    (activeCategory.value === 'all' || entry.category === activeCategory.value) &&
    (!query || entry.path.toLocaleLowerCase().includes(query) ||
      (entry.url && captureAddress(entry.url).toLocaleLowerCase().includes(query))),
  )
})
const visible = computed(() => matches.value.slice(0, shown.value))
const variantLabels = { original: '', snapshot: 'Снимок', export: 'Экспорт' }

function clearPreview() {
  previewId++
  if (image.value) URL.revokeObjectURL(image.value)
  selected.value = null
  image.value = ''
  source.value = ''
  previewError.value = ''
  previewLoading.value = false
  truncated.value = false
}

async function show(directory: string) {
  if (!dialog.value) return
  if (!dialog.value.open) dialog.value.showModal()
  folder.value = directory
  search.value = ''
  activeCategory.value = 'all'
  files.value = []
  shown.value = 40
  listError.value = ''
  clearPreview()
  loading.value = true
  const request = ++requestId
  try {
    const list = await invoke<ArchiveFile[]>('list_archive_files', { directory })
    if (request === requestId) files.value = list
  } catch (cause) {
    if (request === requestId) listError.value = String(cause)
  } finally {
    if (request === requestId) loading.value = false
  }
}
defineExpose({ show })

watch([activeCategory, search], () => {
  shown.value = 40
  clearPreview()
})

function close() {
  requestId++
  clearPreview()
}

onUnmounted(close)

async function select(entry: ArchiveFile) {
  clearPreview()
  selected.value = entry
  const current = previewId
  if (window.matchMedia('(max-width: 699px)').matches) {
    await nextTick()
    if (current === previewId) detail.value?.scrollIntoView({ block: 'nearest' })
  }
  if (!entry.preview) return
  if (current !== previewId) return
  previewLoading.value = true
  try {
    const body = await invoke<ArrayBuffer>('preview_archive_file', { directory: folder.value, path: entry.path })
    if (current !== previewId) return
    const bytes = new Uint8Array(body)
    if (entry.preview === 'text/plain') {
      const limit = 256 * 1024
      source.value = new TextDecoder().decode(bytes.subarray(0, limit))
      truncated.value = bytes.length > limit
    } else {
      image.value = URL.createObjectURL(new Blob([bytes], { type: entry.preview }))
    }
  } catch (cause) {
    if (current === previewId) previewError.value = String(cause)
  } finally {
    if (current === previewId) previewLoading.value = false
  }
}

async function reveal(entry: ArchiveFile) {
  previewError.value = ''
  try {
    await invoke('reveal_archive_file', { directory: folder.value, path: entry.path })
  } catch (cause) {
    previewError.value = String(cause)
  }
}

function name(path: string) {
  return path.split(/[/\\]/).at(-1) || path
}
</script>

<template>
  <dialog ref="dialog" class="panel archive-browser" aria-labelledby="archive-browser-title" @close="close">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 id="archive-browser-title" class="text-lg font-semibold">Файлы архива</h2>
        <p class="mt-1 truncate font-mono text-xs muted" :title="folder">{{ folder }}</p>
      </div>
      <form method="dialog">
        <button type="submit" class="dialog-close" aria-label="Закрыть файлы архива">
          <span aria-hidden="true">×</span>
        </button>
      </form>
    </header>

    <div class="input-shell mt-4 flex items-center">
      <label for="archive-search" class="sr-only">Поиск по файлам</label>
      <input id="archive-search" v-model="search" type="search" placeholder="Поиск по имени, пути или домену">
    </div>

    <nav class="archive-categories mt-3 flex flex-wrap gap-2" aria-label="Типы файлов">
      <button v-for="category in categories" :key="category.id" type="button"
              class="archive-category" :aria-pressed="activeCategory === category.id" @click="activeCategory = category.id">
        {{ category.label }}
        <span class="archive-category-count">{{ categoryCounts.get(category.id) ?? 0 }}</span>
      </button>
    </nav>

    <p v-if="loading" class="mt-4 text-sm muted" role="status">Читаем содержимое архива…</p>
    <p v-else-if="listError" class="error mt-4" role="alert">{{ listError }}</p>
    <p v-else-if="!matches.length" class="mt-4 text-sm muted">Файлы не найдены.</p>
    <div v-else class="archive-browser-grid mt-4">
      <div class="archive-file-list">
        <ul>
          <li v-for="entry in visible" :key="entry.path">
            <button type="button" class="archive-file-row" :aria-pressed="selected?.path === entry.path" @click="select(entry)">
              <span class="min-w-0">
                <span class="block truncate font-semibold" :title="entry.path">{{ name(entry.path) }}</span>
                <span class="block truncate text-xs muted" :title="entry.path">{{ entry.path }}</span>
              </span>
              <span class="archive-file-meta">
                <span v-if="variantLabels[entry.variant]">{{ variantLabels[entry.variant] }}</span>
                <span v-if="entry.bytes !== null">{{ formatCaptureBytes(entry.bytes) }}</span>
              </span>
            </button>
          </li>
        </ul>
        <button v-if="shown < matches.length" type="button" class="text-action my-3 ml-3" @click="shown += 40">
          Показать ещё · {{ matches.length - shown }}
        </button>
      </div>

      <section ref="detail" class="archive-file-detail" aria-label="Просмотр файла">
        <p v-if="!selected" class="text-sm muted">Выбери файл для просмотра.</p>
        <template v-else>
          <h3 class="break-all text-sm font-semibold">{{ name(selected.path) }}</h3>
          <p class="mt-1 break-all font-mono text-xs muted">{{ selected.path }}</p>
          <p v-if="selected.url" class="mt-1 break-all text-xs muted">{{ captureAddress(selected.url) }}</p>
          <button type="button" class="secondary mt-3" @click="reveal(selected)">Показать файл</button>
          <p v-if="previewLoading" class="mt-3 text-xs muted" role="status">Читаем файл…</p>
          <p v-else-if="previewError" class="error mt-3" role="alert">{{ previewError }}</p>
          <img v-else-if="image" :src="image" :alt="name(selected.path)" class="archive-image-preview mt-3">
          <template v-else-if="selected.preview === 'text/plain'">
            <p v-if="truncated" class="mt-3 text-xs muted">Показаны первые 256 КБ.</p>
            <pre v-if="source" class="archive-code-preview mt-3">{{ source }}</pre>
            <p v-else class="mt-3 text-xs muted">Файл пуст.</p>
          </template>
          <p v-else class="mt-3 text-xs muted">Открой файл из папки архива в подходящей программе.</p>
        </template>
      </section>
    </div>
  </dialog>
</template>
