<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { captureAddress, formatCaptureBytes } from '~/utils/capture-display'
import { isArchiveModel, type ModelFile } from '~/utils/archive-model'

const ArchiveModelViewer = defineAsyncComponent(() => import('./ArchiveModelViewer.vue'))

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
type ArchiveFile = ModelFile & {
  bytes: number | null
  category: Exclude<Category, 'all'>
  preview: string | null
}
type Shader = {
  name: string | null
  stage: 'vertex' | 'fragment'
  line: number
  code: string
  truncated: boolean
  usages: { line: number; label: string }[]
}
type Analysis = { code: string; truncated: boolean; sourceMap: 'inline' | 'linked' | null; shaders: Shader[]; shaderCount: number }

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
const viewModel = ref(false)
const previewError = ref('')
const previewLoading = ref(false)
const source = ref('')
const image = ref('')
const truncated = ref(false)
const analysis = shallowRef<Analysis | null>(null)
const analyzing = ref(false)
const analysisTab = ref<'code' | 'shaders'>('code')
const shaderSearch = ref('')
const shaderIndex = ref(0)
const codeSearch = ref('')
const codeMatchIndex = ref(0)
const codeJumpLine = ref(0)
const codeRadius = ref(20)
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
const matchingShaders = computed(() => {
  const query = shaderSearch.value.trim().toLowerCase()
  return (analysis.value?.shaders ?? []).filter(shader =>
    !query || shader.name?.toLowerCase().includes(query) || shader.code.toLowerCase().includes(query),
  )
})
const activeShader = computed(() => matchingShaders.value[shaderIndex.value])
watch(shaderSearch, () => { shaderIndex.value = 0 })
watch(codeSearch, () => { codeMatchIndex.value = 0 })
watch([codeSearch, codeMatchIndex, codeJumpLine], () => { codeRadius.value = 20 })

const codeLines = computed(() => analysis.value?.code.split('\n') ?? [])
const codeMatches = computed(() => {
  const query = codeSearch.value.trim().toLowerCase()
  return query ? codeLines.value.flatMap((line, index) => line.toLowerCase().includes(query) ? [index + 1] : []) : []
})
const currentCodeLine = computed(() => codeSearch.value.trim() ? codeMatches.value[codeMatchIndex.value] : codeJumpLine.value)
const codeContext = computed(() => {
  const line = currentCodeLine.value
  if (!line) return ''
  const start = Math.max(0, line - codeRadius.value - 1)
  return codeLines.value.slice(start, line + codeRadius.value).map((code, offset) => {
    const number = start + offset + 1
    return `${number === line ? '›' : ' '} ${String(number).padStart(5)}  ${code}`
  }).join('\n')
})

function jumpToCode(line: number) {
  codeSearch.value = ''
  codeJumpLine.value = line
  analysisTab.value = 'code'
}

function clearPreview() {
  previewId++
  if (image.value) URL.revokeObjectURL(image.value)
  selected.value = null
  viewModel.value = false
  image.value = ''
  source.value = ''
  previewError.value = ''
  previewLoading.value = false
  truncated.value = false
  analysis.value = null
  analyzing.value = false
  analysisTab.value = 'code'
  shaderSearch.value = ''
  shaderIndex.value = 0
  codeSearch.value = ''
  codeMatchIndex.value = 0
  codeJumpLine.value = 0
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

async function analyze(entry: ArchiveFile) {
  const current = previewId
  analyzing.value = true
  previewError.value = ''
  try {
    const result = await invoke<Analysis>('analyze_archive_javascript', { directory: folder.value, path: entry.path })
    if (current === previewId) analysis.value = result
  } catch (cause) {
    if (current === previewId) previewError.value = String(cause)
  } finally {
    if (current === previewId) analyzing.value = false
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
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="secondary" @click="reveal(selected)">Показать файл</button>
            <button v-if="isArchiveModel(selected)" type="button" class="secondary" :aria-expanded="viewModel" @click="viewModel = !viewModel">
              {{ viewModel ? 'Закрыть 3D-просмотр' : 'Просмотреть 3D' }}
            </button>
            <button v-if="selected.category === 'js' && !analysis" type="button" class="secondary" :disabled="analyzing" @click="analyze(selected)">
              {{ analyzing ? 'Разбираем JavaScript…' : 'Разобрать JavaScript' }}
            </button>
          </div>
          <p v-if="previewLoading && !viewModel" class="mt-3 text-xs muted" role="status">Читаем файл…</p>
          <p v-if="previewError" class="error mt-3" role="alert">{{ previewError }}</p>
          <ArchiveModelViewer v-if="viewModel" :key="selected.path" :directory="folder" :model="selected" :files="files" />
          <template v-else-if="analysis">
            <div class="mt-3 flex flex-wrap gap-2" aria-label="Результаты разбора">
              <button type="button" class="archive-category" :aria-pressed="analysisTab === 'code'" @click="analysisTab = 'code'">Читаемый код</button>
              <button type="button" class="archive-category" :aria-pressed="analysisTab === 'shaders'" @click="analysisTab = 'shaders'">
                Шейдеры GLSL <span class="archive-category-count">{{ analysis.shaderCount }}</span>
              </button>
            </div>
            <template v-if="analysisTab === 'code'">
              <p v-if="analysis.sourceMap" class="mt-2 text-xs muted">{{ analysis.sourceMap === 'inline' ? 'В бандле есть встроенная карта исходников.' : 'В бандле есть ссылка на карту исходников.' }}</p>
              <p v-if="analysis.truncated" class="mt-2 text-xs muted">Показано начало отформатированного файла.</p>
              <div class="input-shell mt-2 flex items-center">
                <label for="archive-code-search" class="sr-only">Поиск по JavaScript</label>
                <input id="archive-code-search" v-model="codeSearch" type="search" placeholder="Поиск по JavaScript, например buildWater">
              </div>
              <div v-if="codeSearch.trim() && codeMatches.length" class="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <span class="muted">Совпадение {{ codeMatchIndex + 1 }} из {{ codeMatches.length }}</span>
                <button type="button" class="text-action" :disabled="codeMatchIndex === 0" @click="codeMatchIndex--">Предыдущее</button>
                <button type="button" class="text-action" :disabled="codeMatchIndex + 1 >= codeMatches.length" @click="codeMatchIndex++">Следующее</button>
              </div>
              <p v-if="codeSearch.trim() && !codeMatches.length" class="mt-2 text-xs muted">Совпадений в JavaScript нет.</p>
              <template v-else-if="codeContext">
                <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span class="muted">Строка {{ currentCodeLine }}</span>
                  <div class="flex flex-wrap items-center gap-3">
                    <button type="button" class="text-action" @click="codeRadius += 30">Больше строк</button>
                    <button type="button" class="text-action" @click="codeJumpLine = 0; codeSearch = ''">Показать весь код</button>
                  </div>
                </div>
                <pre class="archive-code-preview mt-2">{{ codeContext }}</pre>
              </template>
              <pre v-else class="archive-code-preview mt-2">{{ analysis.code }}</pre>
            </template>
            <template v-else>
              <p v-if="analysis.shaderCount === 0" class="mt-2 text-xs muted">Встроенные GLSL-шейдеры не найдены.</p>
              <template v-else>
                <div class="input-shell mt-2 flex items-center">
                  <label for="shader-search" class="sr-only">Поиск в шейдерах</label>
                  <input id="shader-search" v-model="shaderSearch" type="search" placeholder="Поиск в шейдерах, например ripple">
                </div>
                <template v-if="activeShader">
                  <label for="shader-select" class="sr-only">Выбрать шейдер</label>
                  <select id="shader-select" v-model.number="shaderIndex" class="settings-select mt-2">
                    <option v-for="(shader, index) in matchingShaders" :key="index" :value="index">
                      {{ shader.name || 'GLSL' }} · {{ shader.stage === 'vertex' ? 'вершинный' : 'фрагментный' }} · строка {{ shader.line }}
                    </option>
                  </select>
                  <pre class="archive-code-preview mt-2">{{ activeShader.code }}</pre>
                  <p v-if="activeShader.truncated" class="mt-2 text-xs muted">Показано начало шейдера.</p>
                  <div v-if="activeShader.usages?.length" class="mt-3">
                    <h4 class="text-xs font-semibold">Связанный JavaScript</h4>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <button v-for="usage in activeShader.usages" :key="usage.line" type="button"
                              class="archive-category" @click="jumpToCode(usage.line)">
                        {{ usage.label }} · строка {{ usage.line }}
                      </button>
                    </div>
                  </div>
                </template>
                <p v-else class="mt-2 text-xs muted">Шейдеры по этому запросу не найдены.</p>
                <p v-if="analysis.shaderCount > analysis.shaders.length" class="mt-2 text-xs muted">Показаны первые {{ analysis.shaders.length }} шейдеров.</p>
              </template>
            </template>
          </template>
          <img v-else-if="image" :src="image" :alt="name(selected.path)" class="archive-image-preview mt-3">
          <template v-else-if="selected.preview === 'text/plain' && !previewLoading">
            <p v-if="truncated" class="mt-3 text-xs muted">Показаны первые 256 КБ.</p>
            <pre v-if="source" class="archive-code-preview mt-3">{{ source }}</pre>
            <p v-else class="mt-3 text-xs muted">Файл пуст.</p>
          </template>
          <p v-else-if="!selected.preview && !isArchiveModel(selected)" class="mt-3 text-xs muted">Открой файл из папки архива в подходящей программе.</p>
        </template>
      </section>
    </div>
  </dialog>
</template>
