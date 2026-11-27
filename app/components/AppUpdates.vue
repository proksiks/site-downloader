<script setup lang="ts">
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { formatCaptureBytes } from '~/utils/capture-display'

defineProps<{ busy: boolean }>()
type UpdateInfo = { version: string; enabled: boolean }
type UpdateEvent = { type: 'downloading'; downloaded: number; total: number | null } | { type: 'installing' }

const desktop = ref(false)
const dialog = ref<HTMLDialogElement | null>(null)
const info = ref<UpdateInfo>()
const version = ref<string | null>(null)
const checking = ref(false)
const installing = ref(false)
const state = ref('')
const error = ref('')
const downloaded = ref(0)
const total = ref<number | null>(null)

async function check() {
  if (checking.value || installing.value) return
  checking.value = true
  error.value = ''
  state.value = ''
  try {
    info.value ??= await invoke<UpdateInfo>('update_info')
    if (!info.value.enabled) {
      state.value = 'Автообновление доступно в подписанной сборке с GitHub.'
      return
    }
    version.value = await invoke<string | null>('check_app_update')
    if (!version.value) state.value = 'Установлена актуальная версия.'
  } catch (cause) {
    error.value = String(cause)
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  desktop.value = isTauri()
  if (desktop.value) void check()
})

async function install() {
  if (!version.value || installing.value) return
  installing.value = true
  state.value = 'Загружаем обновление…'
  error.value = ''
  downloaded.value = 0
  total.value = null
  const events = new Channel<UpdateEvent>()
  events.onmessage = (event) => {
    if (event.type === 'installing') state.value = 'Устанавливаем обновление…'
    else {
      downloaded.value = event.downloaded
      total.value = event.total
    }
  }
  try {
    await invoke('install_app_update', { version: version.value, events })
    state.value = 'Перезапускаем приложение…'
  } catch (cause) {
    error.value = String(cause)
    state.value = ''
    installing.value = false
  }
}
</script>

<template>
  <button v-if="desktop" type="button" class="secondary inline-flex items-center gap-2" aria-haspopup="dialog"
          @click="dialog?.showModal()">
    Обновления<span v-if="version" class="status-dot" role="img" aria-label="Доступна новая версия" />
  </button>

  <dialog ref="dialog" class="appearance-dialog panel" aria-labelledby="updates-title" @cancel="installing && $event.preventDefault()">
    <header class="flex items-center justify-between gap-3">
      <h2 id="updates-title" class="text-lg font-semibold">Обновления</h2>
      <form method="dialog">
        <button type="submit" class="dialog-close" :disabled="installing" aria-label="Закрыть обновления">×</button>
      </form>
    </header>

    <p v-if="info" class="mt-2 text-xs muted">Установленная версия {{ info.version }}</p>
    <p v-if="version" class="mt-3 text-sm font-semibold">Доступна версия {{ version }}</p>
    <p v-if="checking || state" class="mt-3 text-sm" role="status">{{ checking ? 'Проверяем обновления…' : state }}</p>
    <template v-if="installing">
      <progress class="page-meter mt-2" :value="total ? Math.min(downloaded, total) : undefined" :max="total || 1"
                aria-label="Прогресс обновления" />
      <p v-if="downloaded" class="mt-1 text-xs muted">
        {{ formatCaptureBytes(downloaded) }}{{ total ? ' / ' + formatCaptureBytes(total) : '' }}
      </p>
    </template>
    <p v-if="error" class="error mt-3 break-words" role="alert">{{ error }}</p>
    <p v-if="busy && version" class="mt-3 text-xs muted">Перед установкой заверши захват или закрой просмотр.</p>

    <div class="mt-4 flex flex-wrap gap-2">
      <button v-if="version" type="button" class="primary" :disabled="busy || checking || installing" @click="install">
        Установить и перезапустить
      </button>
      <button v-if="info?.enabled !== false" type="button" class="secondary" :disabled="checking || installing" @click="check">
        Проверить обновления
      </button>
    </div>
  </dialog>
</template>
