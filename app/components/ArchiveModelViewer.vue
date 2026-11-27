<script setup lang="ts">
import {
  ACESFilmicToneMapping, Box3, BufferGeometry, Color, DirectionalLight, HemisphereLight, LoadingManager,
  Material, type Object3D, PerspectiveCamera, Scene, Skeleton, Sphere, Texture, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { prepareArchiveModel, type ModelFile } from '~/utils/archive-model'

const props = defineProps<{ directory: string; model: ModelFile; files: readonly ModelFile[] }>()
const host = ref<HTMLElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
const missing = ref<string[]>([])
const abort = new AbortController()
let disposeViewer: (() => void) | undefined
let resetView: (() => void) | undefined
let rotateView: ((key: string) => void) | undefined

function disposeScenes(scenes: Object3D[]) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  const skeletons = new Set<Skeleton>()
  const bitmaps = new Set<ImageBitmap>()
  for (const scene of scenes) {
    scene.traverse((node) => {
      if ('geometry' in node && node.geometry instanceof BufferGeometry) geometries.add(node.geometry)
      if ('skeleton' in node && node.skeleton instanceof Skeleton) skeletons.add(node.skeleton)
      if ('material' in node) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (!(material instanceof Material)) continue
          materials.add(material)
          for (const value of Object.values(material)) {
            if (value instanceof Texture) textures.add(value)
          }
        }
      }
    })
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.source.data instanceof ImageBitmap) bitmaps.add(texture.source.data)
    texture.dispose()
  }
  for (const bitmap of bitmaps) bitmap.close()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
}

function makeViewer(element: HTMLElement) {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ antialias: true })
  } catch {
    throw new Error('WebGL 2 недоступен. Открой модель через «Показать файл».')
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.setAttribute('aria-hidden', 'true')
  element.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color('#1c2528')
  scene.add(new HemisphereLight(0xffffff, 0x726755, 2))
  const keyLight = new DirectionalLight(0xffffff, 2.4)
  keyLight.position.set(3, 6, 4)
  scene.add(keyLight)

  const camera = new PerspectiveCamera(42, 1)
  camera.position.set(2, 1, 3)
  const controls = new OrbitControls(camera, renderer.domElement)
  const render = () => renderer.render(scene, camera)
  controls.addEventListener('change', render)

  const boundingSphere = new Sphere()
  function reset() {
    const { center, radius } = boundingSphere
    if (!radius || !camera.aspect) return
    const vertical = camera.fov * Math.PI / 360
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
    const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.08
    camera.near = Math.max(radius / 10000, 0.00001)
    camera.far = distance + radius * 100
    camera.position.copy(center).addScaledVector(new Vector3(1, .65, 1.25).normalize(), distance)
    controls.target.copy(center)
    controls.minDistance = radius * .025
    controls.maxDistance = distance + radius * 24
    camera.updateProjectionMatrix()
    controls.update()
    render()
  }

  function rotate(key: string) {
    const offset = camera.position.clone().sub(controls.target)
    if (key === '+' || key === '=' || key === '-') {
      offset.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * (key === '-' ? 1.18 : 1 / 1.18))))
    } else {
      const step = Math.PI / 18
      const left = key === 'ArrowLeft' || key === 'ArrowRight'
      const axis = left ? camera.up : new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
      offset.applyAxisAngle(axis, step * (key === 'ArrowLeft' || key === 'ArrowUp' ? 1 : -1))
    }
    camera.position.copy(controls.target).add(offset)
    controls.update()
    render()
  }

  function resize() {
    const width = Math.max(1, element.clientWidth)
    const height = Math.max(1, element.clientHeight)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    render()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(element)
  resize()

  return {
    reset, rotate,
    show(model: Object3D) {
      scene.add(model)
      const bounds = new Box3().setFromObject(model)
      if (bounds.isEmpty()) throw new Error('В модели нет геометрии для просмотра.')
      bounds.getBoundingSphere(boundingSphere)
      if (!Number.isFinite(boundingSphere.radius)) throw new Error('У модели некорректные размеры.')
      if (boundingSphere.radius === 0) boundingSphere.radius = 1
      reset()
    },
    dispose() {
      observer.disconnect()
      controls.removeEventListener('change', render)
      controls.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}

onMounted(async () => {
  const element = host.value
  if (!element) return
  try {
    const model = await prepareArchiveModel(props.directory, props.model, props.files, abort.signal)
    let draco: DRACOLoader | undefined
    try {
      missing.value = model.missing
      const viewer = makeViewer(element)
      disposeViewer = viewer.dispose
      const manager = new LoadingManager()
      manager.setURLModifier((url) => {
        const local = model.resolved.get(url)
        if (local) return local
        if (model.dependencies.has(url)) throw new Error('В архиве отсутствует файл модели.')
        if (/^(?:blob:|data:)/i.test(url)) return url
        throw new Error('В архиве отсутствует файл модели.')
      })
      draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG).setWorkerLimit(2)
      const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder)
      const gltf = await loader.parseAsync(model.data, '')
      const freeModel = () => disposeScenes(gltf.scenes)
      if (abort.signal.aborted) {
        freeModel()
        return
      }
      disposeViewer = () => {
        freeModel()
        viewer.dispose()
      }
      viewer.show(gltf.scene)
      resetView = viewer.reset
      rotateView = viewer.rotate
      status.value = 'ready'
    } finally {
      draco?.dispose()
      model.free()
    }
  } catch (cause) {
    if (abort.signal.aborted) return
    disposeViewer?.()
    disposeViewer = undefined
    error.value = cause instanceof SyntaxError ? 'Не удалось прочитать JSON модели.'
      : cause instanceof Error ? cause.message : String(cause)
    status.value = 'error'
  }
})

onBeforeUnmount(() => {
  abort.abort()
  disposeViewer?.()
})

function onKeydown(event: KeyboardEvent) {
  if (!rotateView || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return
  event.preventDefault()
  rotateView(event.key)
}
</script>

<template>
  <section class="mt-3" aria-label="Просмотр 3D-модели">
    <div v-show="status !== 'error'" class="model-stage">
      <div ref="host" class="model-viewport" :tabindex="status === 'ready' ? 0 : -1"
           aria-label="Область просмотра 3D-модели" aria-describedby="model-controls" @keydown="onKeydown" />
      <p v-if="status === 'loading'" class="model-loading" role="status">Загружаем модель…</p>
    </div>
    <p v-if="error" class="error mt-2" role="alert">{{ error }}</p>
    <div v-if="status === 'ready'" class="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" class="secondary" @click="resetView?.()">Сбросить вид</button>
      <p id="model-controls" class="text-xs muted">Вращай мышью или стрелками. Масштабируй колёсиком или клавишами + и −.</p>
    </div>
    <details v-if="missing.length && status !== 'loading'" class="capture-filters mt-2">
      <summary>Не удалось загрузить файлы ({{ missing.length }})</summary>
      <ul class="mt-2 max-h-32 space-y-1 overflow-auto break-all text-xs muted">
        <li v-for="file in missing" :key="file">{{ file }}</li>
      </ul>
    </details>
  </section>
</template>
