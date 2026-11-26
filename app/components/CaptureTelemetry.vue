<script setup lang="ts">
import { captureAddress, captureDuration, formatCaptureBytes, type CaptureActivity, type CaptureEntry } from '~/utils/capture-display'

const props = defineProps<{
  activity: CaptureActivity
  entries: CaptureEntry[]
  omitted: number
  page: number
  address: string
  phase: string
  running: boolean
}>()

const filter = ref<'all' | 'resource' | 'error'>('all')
const expanded = ref(false)
const steps = ['Подготовка', 'Страницы', 'Архив']
const stage = computed(() => {
  if (['complete', 'saving', 'offline'].includes(props.phase)) return 2
  return props.page > 0 ? 1 : 0
})
const total = computed(() => Math.max(props.page, props.activity.processedPages) + props.activity.queuedPages)
const pageInProgress = computed(() => props.running && props.page > props.activity.processedPages)
const speed = computed(() => `${formatCaptureBytes(props.running ? props.activity.bytesPerSecond : 0)}/с`)
const filteredEntries = computed(() => props.entries.filter(entry => filter.value === 'all' || entry.kind === filter.value))
const visibleEntries = computed(() => expanded.value ? filteredEntries.value : filteredEntries.value.slice(0, 4))
const hasMoreEntries = computed(() => filteredEntries.value.length > 4)
</script>

<template>
  <div class="capture-telemetry mt-4">
    <ol class="capture-steps" aria-label="Этапы захвата">
      <li v-for="(step, index) in steps" :key="step"
          :data-state="index < stage || phase === 'complete' ? 'done' : running && index === stage ? 'active' : 'waiting'"
          :aria-current="running && index === stage ? 'step' : undefined">
        <span aria-hidden="true" />
        {{ step }}
      </li>
    </ol>

    <div class="mt-3 grid gap-1">
      <div class="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs">
        <span class="font-semibold">Обработано {{ activity.processedPages }}{{ total > 0 ? ` из ${total}` : '' }}</span>
        <span class="muted">В очереди {{ activity.queuedPages }}</span>
      </div>
      <progress v-if="total > 0" class="page-meter" :value="activity.processedPages" :max="total" aria-label="Прогресс по обнаруженным страницам" />
      <div v-if="running && (total === 0 || phase === 'saving' || phase === 'offline')" class="progress-track" aria-hidden="true">
        <div />
      </div>
    </div>

    <dl class="capture-metrics mt-3">
      <div>
        <dt title="Объём сохранённых данных за последние три секунды">Запись</dt>
        <dd>{{ speed }}</dd>
      </div>
      <div><dt>Активные файлы</dt><dd>{{ running ? activity.activeCount : 0 }}</dd></div>
      <div><dt>Время</dt><dd>{{ captureDuration(activity.elapsedMs) }}</dd></div>
    </dl>

    <p v-if="pageInProgress" class="mt-3 text-xs muted">
      <span class="font-semibold">Страница {{ page }}</span>
      <span class="mt-1 block truncate" :title="captureAddress(address)">{{ captureAddress(address) }}</span>
    </p>
    <ul v-if="running && activity.activeUrls.length" class="active-capture-files mt-2" aria-label="Файлы в работе">
      <li v-for="url in activity.activeUrls" :key="url" class="truncate" :title="captureAddress(url)">
        {{ captureAddress(url) }}
      </li>
    </ul>

    <section class="capture-log mt-3" aria-labelledby="capture-log-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="capture-log-title" class="text-xs font-semibold">Журнал захвата</h3>
        <label class="sr-only" for="capture-log-filter">Фильтр журнала</label>
        <select id="capture-log-filter" v-model="filter" class="capture-log-filter">
          <option value="all">Все события</option>
          <option value="resource">Файлы</option>
          <option value="error">Ошибки</option>
        </select>
      </div>
      <ol v-if="visibleEntries.length" class="capture-log-list mt-2" :class="{ 'capture-log-list-expanded': expanded }">
        <li v-for="entry in visibleEntries" :key="entry.id" class="capture-log-entry" :data-kind="entry.kind">
          <span class="capture-log-time">{{ captureDuration(entry.elapsedMs) }}</span>
          <div class="min-w-0">
            <p class="truncate" :title="entry.url ? captureAddress(entry.url) : entry.label">
              {{ entry.url ? captureAddress(entry.url) : entry.label }}
            </p>
            <p v-if="entry.url || entry.detail" class="truncate text-[.7rem] muted" :title="entry.detail">
              {{ entry.url ? entry.label : '' }}{{ entry.url && entry.detail ? ' · ' : '' }}{{ entry.detail }}
            </p>
          </div>
          <span v-if="entry.bytes !== undefined" class="capture-log-size">{{ formatCaptureBytes(entry.bytes) }}</span>
        </li>
      </ol>
      <p v-else class="mt-2 text-xs muted">{{ filter === 'all' ? 'Пока нет событий.' : 'Нет событий для этого фильтра.' }}</p>
      <button v-if="hasMoreEntries" type="button" class="text-action mt-2" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? 'Свернуть журнал' : 'Показать весь журнал' }}
      </button>
      <p v-if="expanded && omitted" class="mt-2 text-xs muted">Скрыто более ранних событий · {{ omitted }}</p>
    </section>
  </div>
</template>
