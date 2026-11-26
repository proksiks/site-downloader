<script setup lang="ts">
const palettes = [
  { id: 'green', label: 'Зелёная', color: '#177a50' },
  { id: 'blue', label: 'Синяя', color: '#2459bc' },
  { id: 'purple', label: 'Сиреневая', color: '#6852b5' },
  { id: 'rose', label: 'Розовая', color: '#b03968' },
  { id: 'amber', label: 'Янтарная', color: '#a75213' },
] as const

const modes = [
  { id: 'system', label: 'Как в системе' },
  { id: 'light', label: 'Светлая' },
  { id: 'dark', label: 'Тёмная' },
] as const

const fonts = [
  { id: 'system', label: 'Системный', family: 'system-ui, sans-serif' },
  { id: 'sans', label: 'Без засечек', family: 'Arial, sans-serif' },
  { id: 'serif', label: 'С засечками', family: 'Georgia, serif' },
  { id: 'mono', label: 'Моноширинный', family: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
] as const

const sizes = [90, 100, 110, 120] as const
const storageKey = 'site-downloader.appearance'
const defaultSettings = {
  palette: 'green' as typeof palettes[number]['id'] | 'custom',
  mode: 'system' as typeof modes[number]['id'],
  font: 'system' as typeof fonts[number]['id'],
  size: 100 as typeof sizes[number],
  customAccent: palettes[0].color as string,
  backgroundTint: null as string | null,
}

const settings = reactive({ ...defaultSettings })
const dialog = ref<HTMLDialogElement | null>(null)
const systemDark = ref(false)
const accent = computed(() => settings.palette === 'custom'
  ? settings.customAccent
  : palettes.find(palette => palette.id === settings.palette)!.color)

function validColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function contrastText(hex: string) {
  const linear = [1, 3, 5].map(index => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const [red, green, blue] = linear as [number, number, number]
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

function restoreSettings() {
  try {
    const value: Partial<typeof defaultSettings> | null = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (!value || typeof value !== 'object') return
    if (value.palette === 'custom' || palettes.some(option => option.id === value.palette)) {
      settings.palette = value.palette!
    }
    const mode = modes.find(option => option.id === value.mode)
    const font = fonts.find(option => option.id === value.font)
    const size = sizes.find(option => option === value.size)
    if (mode) settings.mode = mode.id
    if (font) settings.font = font.id
    if (size) settings.size = size
    if (validColor(value.customAccent)) settings.customAccent = value.customAccent
    if (validColor(value.backgroundTint)) settings.backgroundTint = value.backgroundTint
  } catch {
    // Defaults are available even when local storage is disabled.
  }
}

function updateAccent(event: Event) {
  settings.customAccent = (event.target as HTMLInputElement).value
  settings.palette = 'custom'
}

function updateBackground(event: Event) {
  settings.backgroundTint = (event.target as HTMLInputElement).value
}

const enableAppearance = ref(false)
onMounted(() => {
  restoreSettings()
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const updateSystemTheme = () => { systemDark.value = media.matches }
  updateSystemTheme()
  media.addEventListener('change', updateSystemTheme)
  cleanupSystemTheme = () => media.removeEventListener('change', updateSystemTheme)
  enableAppearance.value = true
})

let cleanupSystemTheme: (() => void) | undefined
onUnmounted(() => cleanupSystemTheme?.())

watchEffect(() => {
  if (!enableAppearance.value) return
  const root = document.documentElement
  const dark = settings.mode === 'dark' || (settings.mode === 'system' && systemDark.value)
  const foreground = contrastText(accent.value)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.setProperty('--ui-font', fonts.find(font => font.id === settings.font)!.family)
  root.style.setProperty('--ui-scale', `${settings.size}%`)
  root.style.setProperty('--ui-accent', accent.value)
  root.style.setProperty('--ui-on-accent', foreground)
  root.style.setProperty('--ui-accent-hover-mix', foreground === '#ffffff' ? '#000000' : '#ffffff')
  root.style.setProperty('--ui-background-tint', settings.backgroundTint ?? accent.value)
})

watch(settings, () => {
  if (!enableAppearance.value) return
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // The current window still uses the chosen appearance.
  }
})
</script>

<template>
  <button
    type="button"
    class="secondary inline-flex items-center gap-2"
    aria-haspopup="dialog"
    @click="dialog?.showModal()"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6" />
    </svg>
    Настройки
  </button>

  <dialog ref="dialog" class="appearance-dialog panel" aria-labelledby="appearance-title">
    <header class="flex items-center justify-between gap-3">
      <h2 id="appearance-title" class="text-lg font-semibold">Оформление</h2>
      <form method="dialog">
        <button type="submit" class="dialog-close" aria-label="Закрыть настройки">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </form>
    </header>

    <div class="mt-5 grid gap-5">
      <div>
        <label for="appearance-mode">Тема</label>
        <select id="appearance-mode" v-model="settings.mode" class="settings-select mt-2">
          <option v-for="mode in modes" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
        </select>
      </div>

      <fieldset>
        <legend class="settings-label">Цветовая схема</legend>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="palette in palettes"
            :key="palette.id"
            type="button"
            class="palette-option"
            :aria-pressed="settings.palette === palette.id"
            @click="settings.palette = palette.id"
          >
            <span class="palette-swatch" :style="{ backgroundColor: palette.color }" aria-hidden="true" />
            {{ palette.label }}
          </button>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <label class="color-control">
            <input type="color" :value="accent" @input="updateAccent">
            Цвет акцента
          </label>
          <label class="color-control">
            <input type="color" :value="settings.backgroundTint ?? accent" @input="updateBackground">
            Оттенок фона
          </label>
        </div>
        <button v-if="settings.backgroundTint" type="button" class="text-action mt-2" @click="settings.backgroundTint = null">
          Вернуть фон палитры
        </button>
      </fieldset>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="appearance-font">Шрифт</label>
          <select id="appearance-font" v-model="settings.font" class="settings-select mt-2">
            <option v-for="font in fonts" :key="font.id" :value="font.id">{{ font.label }}</option>
          </select>
        </div>
        <div>
          <label for="appearance-size">Масштаб</label>
          <select id="appearance-size" v-model="settings.size" class="settings-select mt-2">
            <option v-for="size in sizes" :key="size" :value="size">{{ size }}%</option>
          </select>
        </div>
      </div>
    </div>

    <footer class="mt-6 flex flex-wrap items-center justify-between gap-3">
      <button type="button" class="text-action" @click="Object.assign(settings, defaultSettings)">
        Сбросить настройки
      </button>
      <form method="dialog">
        <button type="submit" class="primary">Готово</button>
      </form>
    </footer>
  </dialog>
</template>
