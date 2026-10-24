<script setup lang="ts">
/**
 * 精简版三维场景核心（替代原 BaseScene 的 3D 外壳部分）
 *
 * 分层：
 *   · Cesium canvas（zIndex 0）：影像 + 大气 + 晨昏光照，接收鼠标交互；
 *   · Three canvas（zIndex 1，透明、pointer-events:none）：星空 / 太阳 / 月亮 / 遮挡球。
 *
 * 每帧时序：推进仿真时钟 → 更新天体位置 → renderCesium → syncCameraToThree → 渲染 Three。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { buildStarfield } from './starfield'
import {
  configureEarthBase,
  destroyCesium,
  initCesium,
  renderCesium,
  resizeCesium,
  setCameraFromScene,
  syncCameraToThree
} from './cesiumEarth'
import {
  EARTH_RADIUS_KM,
  HOME_CAM_DIST,
  error,
  homeDirection,
  loading,
  moonDirection,
  simPlaying,
  simSpeed,
  simTimeMs,
  skyLayers,
  sunDirection
} from './scene'

const containerEl = ref<HTMLDivElement>()

/** 太阳标记距离 / 半径（场景单位，地球半径 = 1） */
const SUN_MARKER_DIST = 200
const SUN_MARKER_R = 5
/** 月亮：真实地心距约 60.3 个地球半径，半径放大到 1.1 便于辨认 */
const MOON_MARKER_DIST = 60.3
const MOON_MARKER_R = 1.1

const WGS84_A_KM = 6378.137
const WGS84_B_KM = 6356.7523142

let renderer: THREE.WebGLRenderer | null = null
let camera: THREE.PerspectiveCamera | null = null
let threeScene: THREE.Scene | null = null
let starfield: THREE.Group | null = null
let sunGroup: THREE.Group | null = null
let moonMesh: THREE.Mesh | null = null
let sunLight: THREE.DirectionalLight | null = null
let rafId = 0
let disposed = false
let cesiumActive = false
let interacting = false
let resizeObserver: ResizeObserver | null = null

/** 内部仿真时刻（避免每帧写响应式 ref） */
let simMs = simTimeMs.value
let lastWall = 0
let lastSyncWall = 0

/* ---------------- 程序化贴图 ---------------- */

function radialSprite(inner: string, outer: string, size = 256): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  const gd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gd.addColorStop(0, inner)
  gd.addColorStop(0.35, outer)
  gd.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gd
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function moonSurfaceTexture(size = 256): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#c9c9c9'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 220; i++) {
    const u = (i * 0.6180339887) % 1
    const v = (i * 0.7548776662) % 1
    const r = 3 + ((i * 37) % 17)
    const dark = i % 3 === 0
    ctx.beginPath()
    ctx.arc(u * size, v * size, r, 0, Math.PI * 2)
    ctx.fillStyle = dark ? 'rgba(120,120,126,0.55)' : 'rgba(176,176,182,0.45)'
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/* ---------------- 初始化 ---------------- */

function initThree(el: HTMLElement) {
  threeScene = new THREE.Scene()
  threeScene.background = new THREE.Color(0x04060b)
  camera = new THREE.PerspectiveCamera(50, el.clientWidth / Math.max(el.clientHeight, 1), 0.01, 1000)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(el.clientWidth, el.clientHeight)
  el.appendChild(renderer.domElement)

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.28))
  sunLight = new THREE.DirectionalLight(0xffffff, 2.6)
  threeScene.add(sunLight)

  // 背景星空
  starfield = buildStarfield()
  threeScene.add(starfield)

  // 太阳：发光球 + 光晕
  sunGroup = new THREE.Group()
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_MARKER_R * 0.45, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4 })
  )
  sunGroup.add(core)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialSprite('rgba(255,246,214,1)', 'rgba(255,196,80,0.55)'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  }))
  glow.scale.setScalar(SUN_MARKER_R * 4.2)
  sunGroup.add(glow)
  threeScene.add(sunGroup)

  // 月亮：共用太阳平行光，月相天然正确
  moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_MARKER_R, 32, 32),
    new THREE.MeshPhongMaterial({ map: moonSurfaceTexture(), shininess: 2, specular: 0x111111 })
  )
  threeScene.add(moonMesh)

  applyHomeCamera()
}

/** 隐形遮挡球：只写深度的 WGS84 椭球，让星空/日月转到地球背面时被正确遮挡 */
function addOccluder() {
  if (!threeScene) return
  const occ = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 96),
    new THREE.MeshBasicMaterial({ colorWrite: false })
  )
  occ.scale.set(WGS84_A_KM / EARTH_RADIUS_KM, WGS84_B_KM / EARTH_RADIUS_KM, WGS84_A_KM / EARTH_RADIUS_KM)
  occ.raycast = () => {}
  occ.renderOrder = -1
  threeScene.add(occ)
}

async function applyCesiumBase(el: HTMLElement): Promise<boolean> {
  loading.value = true
  error.value = ''
  configureEarthBase({})
  const ok = await initCesium(el, {
    onMoveStart: () => { interacting = true },
    onMoveEnd: () => { interacting = false }
  }).catch(() => false)
  if (!ok || disposed || !threeScene || !renderer) {
    error.value = '三维地球底座初始化失败，请检查网络与 WebGL 环境'
    loading.value = false
    return false
  }
  cesiumActive = true
  // Three 背景转透明，露出下层 Cesium 地球
  threeScene.background = null
  const canvas = renderer.domElement
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.zIndex = '1'
  canvas.style.pointerEvents = 'none'
  addOccluder()
  resizeCesium()
  renderCesium(simMs)
  loading.value = false
  applyHomeCamera()
  syncCameraToThree(camera!, simMs)
  return true
}

/* ---------------- 机位 ---------------- */

/** 把镜头放到正对武汉的初始位置与初始地球大小 */
function applyHomeCamera() {
  if (!camera) return
  const dir = homeDirection(simMs)
  camera.position.copy(dir).multiplyScalar(HOME_CAM_DIST)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  if (cesiumActive) {
    setCameraFromScene(camera.position, dir.clone().negate(), camera.up, simMs)
  }
}

/** 仅复位镜头：回到武汉初始视角，不改选中/过滤状态 */
function resetCameraHome() {
  applyHomeCamera()
}

/** 外部（播放条拖动 / 重置）写入仿真时刻 */
function setSimTime(ms: number) {
  simMs = ms
  simTimeMs.value = ms
}

/* ---------------- 每帧 ---------------- */

function updateSky(ms: number) {
  const date = new Date(ms)
  const sunDir = sunDirection(date)
  if (sunGroup) {
    sunGroup.visible = skyLayers.sun
    sunGroup.position.copy(sunDir).multiplyScalar(SUN_MARKER_DIST)
  }
  if (sunLight) sunLight.position.copy(sunDir).multiplyScalar(SUN_MARKER_DIST)
  if (moonMesh) {
    moonMesh.visible = skyLayers.moon
    const m = moonDirection(date)
    moonMesh.position.copy(m.dir).multiplyScalar(MOON_MARKER_DIST)
  }
  if (starfield) starfield.visible = skyLayers.stars
}

function loop(now: number) {
  if (disposed) return
  const dt = lastWall ? Math.min(0.1, (now - lastWall) / 1000) : 0
  lastWall = now

  // 外部改写（拖动/重置）检测
  if (Math.abs(simTimeMs.value - simMs) > 500) simMs = simTimeMs.value

  if (simPlaying.value && !interacting) simMs += dt * 1000 * simSpeed.value
  updateSky(simMs)

  renderCesium(simMs)
  if (camera) syncCameraToThree(camera, simMs)
  if (renderer && threeScene && camera) renderer.render(threeScene, camera)

  // 播放头/时刻显示节流回写（约 5Hz）
  if (now - lastSyncWall > 200) {
    lastSyncWall = now
    simTimeMs.value = simMs
  }
  rafId = requestAnimationFrame(loop)
}

function onResize() {
  const el = containerEl.value
  if (!el || !renderer || !camera) return
  const w = el.clientWidth
  const h = Math.max(el.clientHeight, 1)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  resizeCesium()
}

onMounted(async () => {
  const el = containerEl.value
  if (!el) return
  initThree(el)
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(el)
  window.addEventListener('resize', onResize)

  const ok = await applyCesiumBase(el)
  if (ok) {
    lastWall = 0
    lastSyncWall = 0
    rafId = requestAnimationFrame(loop)
  }
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', onResize)
  destroyCesium()
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
    renderer = null
  }
  threeScene?.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else mat?.dispose()
  })
  threeScene = null
  camera = null
})

defineExpose({ resetCameraHome, setSimTime })
</script>

<template>
  <div ref="containerEl" class="scene-core">
    <div v-if="loading" class="scene-mask">
      <div class="loading-box">
        <span class="spin"></span>
        <span class="loading-txt">正在启动三维地球…</span>
      </div>
    </div>
    <div v-else-if="error" class="scene-mask">
      <span class="err">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.scene-core {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #04060b;

  :deep(canvas) {
    display: block;
  }
}

.scene-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 18px;
  background: rgba(4, 6, 11, 0.6);
  color: #dfe7f2;
  font-size: 14px;
  pointer-events: none;

  .err {
    color: #ff8a80;
  }
}

.loading-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;

  .spin {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 3px solid rgba(79, 195, 247, 0.18);
    border-top-color: #4fc3f7;
    animation: cspin 0.9s linear infinite;
  }

  .loading-txt {
    font-size: 13px;
    letter-spacing: 1px;
    color: #bcd6f7;
  }
}

@keyframes cspin {
  to {
    transform: rotate(360deg);
  }
}
</style>
