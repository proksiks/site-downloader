export type CaptureEntry = {
  id: number
  kind: 'system' | 'page' | 'resource' | 'error'
  label: string
  url?: string
  detail: string
  bytes?: number
  elapsedMs: number
}

export type CaptureActivity = {
  elapsedMs: number
  bytesPerSecond: number
  processedPages: number
  queuedPages: number
  activeCount: number
  activeUrls: string[]
  entries: CaptureEntry[]
  omitted: number
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

export function formatCaptureBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${number.format(bytes / 1024 ** 3)} ГБ`
  if (bytes >= 1024 ** 2) return `${number.format(bytes / 1024 ** 2)} МБ`
  if (bytes >= 1024) return `${number.format(bytes / 1024)} КБ`
  return `${number.format(bytes)} Б`
}

export function captureDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60)
  const padded = (value: number) => String(value).padStart(2, '0')
  const time = `${padded(minutes % 60)}:${padded(seconds % 60)}`
  return hours ? `${hours}:${time}` : time
}

export function captureAddress(address: string) {
  try {
    const url = new URL(address)
    return url.host + url.pathname
  } catch {
    return address
  }
}
