<script setup lang="ts">
import { Channel, invoke } from '@tauri-apps/api/core'
import { captureAddress } from '~/utils/capture-display'
import type { RepairCandidate, RepairTarget } from '~/utils/archive-repair'

const props = defineProps<{ waitSeconds: number }>()
const emit = defineEmits<{ repaired: [folder: string, targets: RepairTarget[]] }>()
type RepairResult = { done: RepairTarget[]; failed: (RepairTarget & { message: string })[]; files: number }
type RepairEvent =
  | { type: 'repairProgress'; url: string; completed: number; total: number }
  | { type: 'repairAwaitingLogin' | 'repairInstalling' }

const dialog = ref<HTMLDialogElement | null>(null)
const directory = ref('')
const candidates = ref<RepairCandidate[]>([])
const selected = ref<RepairCandidate[]>([])
const login = ref(false)
const running = ref(false)
const waitingLogin = ref(false)
const status = ref('')
const progress = ref<{ completed: number; total: number } | null>(null)
const error = ref('')
const result = ref<RepairResult | null>(null)

function key(item: RepairTarget) {
  return item.kind + ':' + item.url
}

function show(folder: string, entries: RepairCandidate[]) {
  if (running.value) return
  directory.value = folder
  candidates.value = [...new Map(entries.map(entry => [key(entry), entry])).values()]
  selected.value = []
  login.value = false
  status.value = ''
  error.value = ''
  progress.value = null
  result.value = null
  dialog.value?.showModal()
}

defineExpose({ show })

async function start() {
  if (!selected.value.length || running.value) return
  const targets = selected.value.map(({ url, kind }) => ({ url, kind }))
  running.value = true
  status.value = 'Готовим Chromium…'
  progress.value = { completed: 0, total: targets.length }
  error.value = ''
  result.value = null
  const events = new Channel<RepairEvent>()
  events.onmessage = (event) => {
    if (event.type === 'repairProgress') {
      waitingLogin.value = false
      status.value = captureAddress(event.url)
      progress.value = event
    } else if (event.type === 'repairAwaitingLogin') {
      waitingLogin.value = true
      status.value = 'Войди в Chromium и подтверди продолжение.'
    } else {
      status.value = 'Скачиваем Chromium…'
    }
  }
  try {
    const next = await invoke<RepairResult | null>('repair_archive', {
      directory: directory.value,
      options: { targets, waitSeconds: props.waitSeconds, login: login.value },
      events,
    })
    result.value = next
    if (next) {
      progress.value = { completed: targets.length, total: targets.length }
      status.value = 'Докачка завершена'
      const completed = new Set(next.done.map(key))
      const failures = new Map(next.failed.map(item => [key(item), item.message]))
      candidates.value = candidates.value.filter(item => !completed.has(key(item)))
        .map(item => failures.has(key(item)) ? { ...item, description: failures.get(key(item)) } : item)
      selected.value = candidates.value.filter(item => failures.has(key(item)))
      emit('repaired', directory.value, next.done)
    } else {
      status.value = 'Докачка отменена'
    }
  } catch (cause) {
    error.value = String(cause)
  } finally {
    waitingLogin.value = false
    running.value = false
  }
}

async function control(command: 'continue_repair' | 'stop_repair') {
  error.value = ''
  try {
    await invoke(command)
    if (!running.value) return
    waitingLogin.value = false
    status.value = command === 'stop_repair' ? 'Отменяем докачку…' : 'Продолжаем докачку…'
  } catch (cause) {
    if (running.value) error.value = String(cause)
  }
}
</script>

<template>
  <dialog ref="dialog" class="panel archive-browser" aria-labelledby="repair-title" @cancel="running && $event.preventDefault()">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 id="repair-title" class="text-lg font-semibold">Докачать пропущенное</h2>
        <p class="mt-1 truncate font-mono text-xs muted" :title="directory">{{ directory }}</p>
      </div>
      <form method="dialog">
        <button type="submit" class="dialog-close" :disabled="running" aria-label="Закрыть докачку">×</button>
      </form>
    </header>

    <div v-if="candidates.length" class="mt-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs muted">Выбрано {{ selected.length }} из {{ candidates.length }}</p>
        <div class="flex flex-wrap gap-3">
          <button type="button" class="text-action" :disabled="running" @click="selected = candidates.slice(0, 100)">{{ candidates.length > 100 ? 'Выбрать первые 100' : 'Выбрать всё' }}</button>
          <button type="button" class="text-action" :disabled="running" @click="selected = []">Снять выбор</button>
        </div>
      </div>
      <fieldset class="archive-file-list mt-2" :disabled="running" aria-label="Адреса для докачки">
        <label v-for="item in candidates" :key="key(item)" class="repair-row">
          <input v-model="selected" type="checkbox" :value="item" :disabled="selected.length >= 100 && !selected.includes(item)">
          <span class="min-w-0">
            <span class="block break-all font-semibold">{{ captureAddress(item.url) }}</span>
            <span class="block text-xs muted">{{ item.kind === 'page' ? 'Страница' : 'Ресурс' }}{{ item.description ? ' · ' + item.description : '' }}</span>
          </span>
        </label>
      </fieldset>
      <label class="capture-checkbox mt-3">
        <input v-model="login" type="checkbox" :disabled="running">
        Войти на сайте перед докачкой
      </label>
    </div>

    <div v-if="status" class="mt-4" role="status">
      <p class="break-all text-sm">{{ status }}</p>
      <progress v-if="progress" class="page-meter mt-2" :value="progress.completed" :max="progress.total" aria-label="Прогресс докачки" />
    </div>
    <p v-if="error" class="error mt-3" role="alert">{{ error }}</p>
    <p v-if="result" class="mt-3 text-sm">
      Успешно {{ result.done.length }} · Ошибок {{ result.failed.length }} · Файлов добавлено {{ result.files }}
    </p>
    <p v-if="result?.files" class="mt-2 text-xs muted">Чтобы использовать добавленные файлы, закрой и заново запусти просмотр с JavaScript.</p>

    <div class="mt-4 flex flex-wrap gap-2">
      <button v-if="waitingLogin" type="button" class="primary" @click="control('continue_repair')">Я вошёл, продолжить</button>
      <button v-else-if="candidates.length && !running" type="button" class="primary" :disabled="!selected.length" @click="start">Докачать выбранное</button>
      <button v-if="running" type="button" class="secondary" @click="control('stop_repair')">Отменить докачку</button>
    </div>
  </dialog>
</template>
