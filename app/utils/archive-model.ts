import { invoke } from '@tauri-apps/api/core'
import { captureAddress } from '~/utils/capture-display'

export type ModelFile = {
  path: string
  url: string | null
  contentType?: string
  aliases?: string[]
  variant: 'original' | 'snapshot' | 'export'
}

type ModelResource = { uri?: unknown; mimeType?: unknown } | null
type ModelDocument = {
  asset?: { version?: unknown }
  extensionsRequired?: unknown
  buffers?: ModelResource[]
  images?: ModelResource[]
  textures?: ({ extensions?: { KHR_texture_basisu?: { source?: unknown } } } | null)[]
}

const localArchive = 'https://archive.invalid/'
const fileLimit = 64 * 1024 * 1024
const modelBudget = 128 * 1024 * 1024

export function isArchiveModel(file: ModelFile) {
  return /\.(?:gltf|glb)$/i.test(file.path) || /^model\/gltf\+(?:json|binary)(?:;|$)/i.test(file.contentType ?? '')
}

function modelDependencies(data: ArrayBuffer) {
  let json = new Uint8Array(data)
  const header = new DataView(data)
  if (data.byteLength >= 4 && header.getUint32(0, true) === 0x46546c67) {
    if (data.byteLength < 20 || header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== data.byteLength || header.getUint32(16, true) !== 0x4e4f534a ||
      header.getUint32(12, true) > data.byteLength - 20) {
      throw new Error('Не удалось прочитать структуру GLB.')
    }
    json = new Uint8Array(data, 20, header.getUint32(12, true))
  }
  const document = JSON.parse(new TextDecoder().decode(json)) as ModelDocument | null
  if (typeof document?.asset?.version !== 'string' || !document.asset.version.startsWith('2.')) {
    throw new Error('Поддерживаются модели glTF версии 2.')
  }
  if (Array.isArray(document.extensionsRequired) && document.extensionsRequired.includes('KHR_texture_basisu')) {
    throw new Error('Модель требует текстуры KTX2/BasisU. Открой её во внешнем просмотрщике через «Показать файл».')
  }

  const dependencies = new Map<string, string>()
  const textures = Array.isArray(document.textures) ? document.textures : []
  const basisImages = new Set(textures.map(texture => texture?.extensions?.KHR_texture_basisu?.source))
  const images = Array.isArray(document.images) ? document.images.filter((_, index) => !basisImages.has(index)) : []
  for (const list of [document.buffers, images]) {
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item?.uri === 'string' && item.uri && !/^data:/i.test(item.uri)) {
        dependencies.set(item.uri, typeof item.mimeType === 'string' ? item.mimeType : '')
      }
    }
  }
  return dependencies
}

function httpAddress(uri: string, base?: string) {
  try {
    const url = new URL(uri, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function pathFrom(uri: string, path: string) {
  const base = localArchive + path.split('/').map(encodeURIComponent).join('/')
  const url = httpAddress(uri, base)
  if (!url || !url.href.startsWith(localArchive)) return ''
  try {
    return url.pathname.slice(1).split('/').map(decodeURIComponent).join('/')
  } catch {
    return ''
  }
}

function dependencyName(uri: string) {
  return httpAddress(uri) ? captureAddress(uri) : uri.split(/[?#]/)[0] ?? uri
}

export async function prepareArchiveModel(
  directory: string,
  model: ModelFile,
  files: readonly ModelFile[],
  signal: AbortSignal,
) {
  const objects = new Map<string, string>()
  const free = () => {
    for (const url of objects.values()) URL.revokeObjectURL(url)
    objects.clear()
  }
  try {
    async function read(path: string, limit: number) {
      signal.throwIfAborted()
      const data = await invoke<ArrayBuffer>('read_archive_model_file', { directory, path, limit })
      signal.throwIfAborted()
      return data
    }
    const data = await read(model.path, fileLimit)
    const dependencies = modelDependencies(data)
    if (dependencies.size > 256) throw new Error('У модели больше 256 внешних файлов.')

    const byPath = new Map(files.map(file => [file.path, file]))
    const originals = files.filter(file => file.variant === 'original')
    const byUrl = new Map<string, ModelFile>()
    for (const file of originals) {
      const key = file.url && httpAddress(file.url)?.href
      if (key) byUrl.set(key, file)
    }
    for (const file of originals) {
      for (const alias of file.aliases ?? []) {
        const key = httpAddress(alias)?.href
        if (key && !byUrl.has(key)) byUrl.set(key, file)
      }
    }

    let remaining = modelBudget - data.byteLength
    const resolved = new Map<string, string>()
    const missing = new Set<string>()
    for (const [uri, type] of dependencies) {
      const local = model.variant === 'export' || !model.url ? byPath.get(pathFrom(uri, model.path)) : undefined
      const remote = model.url ? httpAddress(uri, model.url)?.href : undefined
      const file = local ?? (remote ? byUrl.get(remote) : undefined)
      if (!file) {
        missing.add(dependencyName(uri))
        continue
      }
      let url = objects.get(file.path)
      if (!url) {
        try {
          const bytes = await read(file.path, Math.min(remaining, fileLimit))
          remaining -= bytes.byteLength
          url = URL.createObjectURL(new Blob([bytes], { type: type || file.contentType || 'application/octet-stream' }))
          objects.set(file.path, url)
        } catch (error) {
          signal.throwIfAborted()
          missing.add(dependencyName(uri) + ' (' + String(error) + ')')
          continue
        }
      }
      resolved.set(uri, url)
    }
    return { data, dependencies, resolved, missing: [...missing], free }
  } catch (error) {
    free()
    throw error
  }
}
