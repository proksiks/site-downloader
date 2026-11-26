import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2025-07-15',
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  telemetry: false,
  ignore: ['**/src-tauri/**'],
  nitro: {
    output: { publicDir: 'dist' },
  },
  vite: {
    plugins: [tailwindcss()],
    server: { strictPort: true },
  },
})
