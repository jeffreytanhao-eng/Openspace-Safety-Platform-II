<script setup lang="ts">
/**
 * 精简版三维场景核心（替代原 BaseScene 的 3D 外壳部分）
 *
 * 分层：
 *   · Cesium canvas（zIndex 0）：影像 + 大气 + 晨昏光照，接收鼠标交互；
 *   · Three canvas（zIndex 1，透明、pointer-events:none）：星空 / 太阳 / 月亮 / 遮挡球 / 编目点云+选中轨道。
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
  setCameraOrbitFocusScene,
  syncCameraToThree,
  getCesiumScene
} from './cesiumEarth'
import { clearCatalogPoints } from './catalogPoints'
import {
  initCatalogCloudFromSnapshot,
  updateCatalogCloud,
  clearCatalogCloud,
  setCloudSelection,
  setCloudTypeFilter,
  ensureCloudSelected,
  setCloudOrbitCap,
  THREE_POINT_SOFT,
  CONS_ORBIT_CAP_HARD,
  toggleConsShow,
  toggleConsOrbit,
  isConsOrbitOn,
  consShowOf,
  setStationFocus,
  getStationFocus,
  getCloudSelectedNorad,
  isCloudSelectionVisible,
  getCatalogFocusPos,
  refreshCloudVisibility,
  upgradeConsRecsFromTles,
  prewarmCatalogModels,
  setEphemNorad,
} from './catalogCloudThree'
import {
  setEphemOrbit,
  setEphemManeuver,
  setEphemManSelected,
  getEphemManHighlights,
  getEphemManLocatePoint,
  updateEphemOrbitMarker,
  clearEphemOrbit,
  getEphemMarkerPosition,
  getEphemPositionAt,
  ephemDisplayLabel
} from './ephemOrbitThree'

const emit = defineEmits<{ (e: 'viewport-ready'): void }>()
import type { EphemSet, EphemState } from './ephem/types'
import { useCatalog, type CatalogTle } from '@/composables/useCatalog'
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
const reticleEl = ref<HTMLDivElement>()
const reticleNameEl = ref<HTMLSpanElement>()
/** 机动卡片定位标签（琥珀信息卡，随选中 MAN 块逐帧投影） */
const manLabelEl = ref<HTMLDivElement>()
const manLabelTextEl = ref<HTMLSpanElement>()

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
/** 上次推送到 simTimeMs 的值：用于识别「外部」改动（滑杆/重置/深链），避免把正常推进误判为需要回拉 */
let lastPushedSim = simTimeMs.value
let lastWall = 0
let lastSyncWall = 0
/** Monotonic paint generation — stale async clears must not wipe newer chip paints. */
let paintSeq = 0
let lastFilterTypes: string[] = []

/** Ephem track / reticle — reuse old Openspace-Safety-Platform select UX (TRACK_CAM_DIST + breath ring). */
const TRACK_CAM_DIST = 0.15
/** Slower than old 2s pulse — CSS animation uses 3.2s. */
let trackEphem = false
/** Catalog selection track (station「位置展示」/ list pick) — same UX as ephem track (t201u). */
let trackCat = false
/** Fly-in pending until the selected entry has a position (async cloud rebuild). */
let catFlyPending = false
/** 机动卡片定位标签状态：锚定的场景坐标 + 是否显示 */
const manLabelPos = new THREE.Vector3()
let manLabelOn = false
const _trackPrev = new THREE.Vector3()
const _trackDelta = new THREE.Vector3()
const _trackPos = new THREE.Vector3()
const _proj = new THREE.Vector3()
const _camUp = new THREE.Vector3(0, 1, 0)
const _viewDir = new THREE.Vector3()
/** Look-at point while flying / tracking (scene space). */
const lookAtPt = new THREE.Vector3()
const camFly = {
  active: false,
  t0: 0,
  dur: 900,
  fromPos: new THREE.Vector3(),
  toPos: new THREE.Vector3(),
  fromLook: new THREE.Vector3(),
  toLook: new THREE.Vector3()
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * Push Three camera → Cesium.
 * @param aimLookAt when true (fly-in), force look at lookAtPt on geocentric ray;
 *   when false (track follow), keep current view dir so user orbit/zoom survives.
 */
function applySceneCamera(aimLookAt = true) {
  if (!camera || !cesiumActive) return
  if (aimLookAt) {
    _viewDir.subVectors(lookAtPt, camera.position).normalize()
    _camUp.set(0, 1, 0)
    if (Math.abs(_viewDir.dot(_camUp)) > 0.92) _camUp.set(0, 0, 1)
    camera.up.copy(_camUp)
    if (camera.position.distanceToSquared(lookAtPt) > 1e-8) camera.lookAt(lookAtPt)
    _viewDir.subVectors(lookAtPt, camera.position).normalize()
  } else {
    camera.getWorldDirection(_viewDir)
  }
  setCameraFromScene(camera.position, _viewDir, camera.up, simMs)
}

function beginCamFly(toPos: THREE.Vector3, toLook: THREE.Vector3) {
  if (!camera) return
  camFly.fromPos.copy(camera.position)
  camFly.fromLook.copy(lookAtPt)
  camFly.toPos.copy(toPos)
  camFly.toLook.copy(toLook)
  camFly.t0 = performance.now()
  camFly.active = true
}

function updateCameraFly(now: number): boolean {
  if (!camFly.active || !camera) {
    camFly.active = false
    return false
  }
  const k = Math.min((now - camFly.t0) / camFly.dur, 1)
  const e = easeInOutCubic(k)
  camera.position.lerpVectors(camFly.fromPos, camFly.toPos, e)
  lookAtPt.lerpVectors(camFly.fromLook, camFly.toLook, e)
  applySceneCamera(true)
  if (k >= 1) {
    camFly.active = false
    // Landed: enable orbit-around-target (old focusOrbitOnSel / controls.target = sat)
    if (trackEphem || trackCat) setCameraOrbitFocusScene(lookAtPt, simMs)
    return false
  }
  return true
}

function setReticleVisible(show: boolean) {
  const el = reticleEl.value
  if (!el) return
  el.style.display = show ? 'block' : 'none'
}

function updateReticle() {
  const el = reticleEl.value
  if (!el || !camera || !containerEl.value) {
    setReticleVisible(false)
    return
  }
  let ok = false
  if (trackEphem) ok = !!getEphemMarkerPosition(_trackPos)
  else if (trackCat) ok = getCatalogFocusPos(simMs, _trackPos)
  if (!ok) {
    setReticleVisible(false)
    return
  }
  _proj.copy(_trackPos).project(camera)
  let show = false
  let x = 0
  let y = 0
  if (_proj.z <= 1 && _proj.z >= -1) {
    const rect = containerEl.value.getBoundingClientRect()
    x = (_proj.x * 0.5 + 0.5) * rect.width
    y = (-_proj.y * 0.5 + 0.5) * rect.height
    const margin = 24
    show = x >= -margin && x <= rect.width + margin && y >= -margin && y <= rect.height + margin
  }
  if (show) el.style.transform = `translate(${x}px, ${y}px)`
  setReticleVisible(show)
}

function setManLabelVisible(show: boolean) {
  manLabelOn = show
  const el = manLabelEl.value
  if (el) el.style.display = show ? 'block' : 'none'
}

/** 机动标签逐帧跟随：把锚定的 MAN 中点投影到屏幕（离屏/被遮挡视角时隐藏） */
function updateManLabel() {
  if (!manLabelOn) return
  const el = manLabelEl.value
  if (!el || !camera || !containerEl.value) {
    setManLabelVisible(false)
    return
  }
  _proj.copy(manLabelPos).project(camera)
  let show = false
  let x = 0
  let y = 0
  if (_proj.z <= 1 && _proj.z >= -1) {
    const rect = containerEl.value.getBoundingClientRect()
    x = (_proj.x * 0.5 + 0.5) * rect.width
    y = (-_proj.y * 0.5 + 0.5) * rect.height
    const margin = 24
    show = x >= -margin && x <= rect.width + margin && y >= -margin && y <= rect.height + margin
  }
  if (show) el.style.transform = `translate(${x}px, ${y}px)`
  el.style.display = show ? 'block' : 'none'
}

function stopCatalogTrack() {
  if (!trackCat) return
  trackCat = false
  catFlyPending = false
  if (!trackEphem) {
    setCameraOrbitFocusScene(null, simMs)
    setReticleVisible(false)
  }
}

/** 选中编目目标：径向飞入 + delta 跟随 + 呼吸光环 + 名称（与星历选中一致，t201u）。 */
function startCatalogTrack(item: { object_name?: string | null; norad_id: number }, labelOverride?: string) {
  if (!camera || !item) return
  stopEphemTrack()
  trackCat = true
  catFlyPending = false
  const nameEl = reticleNameEl.value
  const label = labelOverride || item.object_name || `NORAD ${item.norad_id}`
  if (nameEl) nameEl.textContent = label
  if (getCatalogFocusPos(simMs, _trackPos)) {
    lookAtPt.copy(_trackPos)
    _trackPrev.copy(_trackPos)
    const radial = _trackPos.clone().normalize()
    const toPos = _trackPos.clone().addScaledVector(radial, TRACK_CAM_DIST)
    setReticleVisible(true)
    beginCamFly(toPos, _trackPos.clone())
  } else {
    // Cloud not painted yet (async) — reticle shows once the position stream starts
    catFlyPending = true
    setReticleVisible(false)
  }
}

function stopEphemTrack() {
  trackEphem = false
  camFly.active = false
  setCameraOrbitFocusScene(null, simMs)
  setReticleVisible(false)
}

function startEphemTrack(set: EphemSet) {
  if (!camera || !set) return
  stopEphemTrack()
  stopCatalogTrack()
  // Clamp sim into ephem span so marker is on-orbit
  if (set.states.length) {
    const t0 = set.states[0].t
    const t1 = set.states[set.states.length - 1].t
    if (simMs < t0 || simMs > t1) {
      simMs = t0
      simTimeMs.value = t0
    }
  }
  updateEphemOrbitMarker(simMs)
  if (!getEphemMarkerPosition(_trackPos) && !getEphemPositionAt(simMs, _trackPos)) return
  lookAtPt.copy(_trackPos)
  _trackPrev.copy(_trackPos)
  // Camera on Earth-center → target ray (radial outward), looking at target — no polar bend
  const radial = _trackPos.clone().normalize()
  const toPos = _trackPos.clone().addScaledVector(radial, TRACK_CAM_DIST)
  trackEphem = true
  const nameEl = reticleNameEl.value
  if (nameEl) nameEl.textContent = ephemDisplayLabel(set)
  setReticleVisible(true)
  beginCamFly(toPos, _trackPos.clone())
}

/** Place camera on geocentric ray through `pos`, distance TRACK_CAM_DIST beyond target. */
function framePointAtTrackDist(pos: THREE.Vector3) {
  if (!camera) return
  lookAtPt.copy(pos)
  const radial = pos.clone().normalize()
  const toPos = pos.clone().addScaledVector(radial, TRACK_CAM_DIST)
  beginCamFly(toPos, pos.clone())
}

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
    // Old: ignore Cesium moveStart while tracking — track delta + orbit-focus drag own the camera;
    // setting interacting here would freeze sim on every micro-move and felt like “controls dead”.
    onMoveStart: () => { if (trackEphem || trackCat || camFly.active) return; interacting = true },
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
  // Do NOT auto-load catalog: initial globe must be empty until user enables a type chip
  // (mirrors old satPanel.typeF all-false). Chips → paintFromSnapshot (lazy constellation).
  return true
}

async function paintFromSnapshot(types: string[]) {
  if (!threeScene || !cesiumActive) return
  const seq = ++paintSeq
  const want = (types || []).slice()
  const { cloudList, cloudSnapT, loadConstellation } = useCatalog()
  try {
    clearCatalogPoints(getCesiumScene())
    // Empty chips OK when constellation/station/selection channel is active (old mask)
    const needCloud = want.length > 0 || !!getStationFocus() || getCloudSelectedNorad() != null
    // consShowMap checked inside init via cloudGate — still need snapshot loaded if override
    if (!needCloud) {
      // Probe: if any cons override still on, still paint
      // (toggleConsShow may have set map before this call)
    }
    if (!cloudList.value.length) await loadConstellation()
    if (disposed || !threeScene || seq !== paintSeq) return
    const r = initCatalogCloudFromSnapshot(
      threeScene,
      cloudList.value,
      want,
      THREE_POINT_SOFT,
      cloudSnapT.value || Date.now(),
      getStationFocus()
    )
    if (seq !== paintSeq) return
    if (!r.plotted && !want.length && !getStationFocus()) {
      // Truly empty — clear filters
      setCloudTypeFilter([], simMs)
    }
    console.info('[situation] snapshot cloud', { plotted: r.plotted, want, cap: r.capped, cloudN: cloudList.value.length })
  } catch (e) {
    if (seq === paintSeq) console.warn('[situation] snapshot cloud skipped', e)
  }
}

/** 空间站 NORAD → 卡片中文名（准星标签与列表卡片一致） */
const STATION_NAMES: Record<number, string> = {
  48274: '天宫空间站',
  25544: '国际空间站'
}

/** 空间站「位置展示」：独立通道，不影响类型芯片 / 星座展示。再点同一站收起。 */
async function showStation(norad: number) {
  const cur = getStationFocus()
  if (cur === norad) {
    setStationFocus(null)
    stopCatalogTrack()
    setCloudSelection(null, simMs)
    refreshCloudVisibility(simMs)
    return { on: false }
  }
  setStationFocus(norad)
  const { fetchTleByNorad, cloudList, loadConstellation } = useCatalog()
  if (!cloudList.value.length) await loadConstellation()
  // Ensure station is in the point cloud even when PAYLOAD chip is off
  void paintFromSnapshot(lastFilterTypes)
  let hit = null as Awaited<ReturnType<typeof fetchTleByNorad>>
  try { hit = await fetchTleByNorad(norad) } catch { hit = null }
  if (hit) {
    ensureCloudSelected(hit, simMs)
    // 拉近 + 跟踪 + 呼吸光环 + 名称（与星历选中一致，t201u）；标签与卡片名一致
    startCatalogTrack(hit, STATION_NAMES[norad])
  } else {
    refreshCloudVisibility(simMs)
  }
  return { on: true }
}

/**
 * 芯片/星座开关后：选中目标若失去全部可见通道（类型芯片、星座 override；空间站通道除外），
 * 同步清除选中态与准星——否则选中目标凭 selection 特判永驻，rebuildOrbits 会持续重画其轨道，
 * 造成「所有开关都关闭却残留一条轨道」的现象。
 */
function clearHiddenSelection() {
  const sel = getCloudSelectedNorad()
  if (sel == null || sel === getStationFocus()) return
  // 芯片场景必须传新列表：模块内 activeTypes 要到 paint/init 时才同步，直接读是旧值
  if (isCloudSelectionVisible(lastFilterTypes)) return
  setCloudSelection(null, simMs)
  stopCatalogTrack()
}

/** 星座「星座展示」：独立通道，不改类型芯片、不写搜索框。 */
async function showConstellation(name: string) {
  const on = toggleConsShow(name)
  clearHiddenSelection()
  await paintFromSnapshot(lastFilterTypes)
  if (!on) {
    // turned off this card
    refreshCloudVisibility(simMs)
  }
  return { on, orbit: isConsOrbitOn(name) }
}

/** 星座「轨道展示」：需先星座展示；点亮后提高 orbitCap 并尝试为成员补 TLE 画轨。 */
async function showConsOrbit(name: string) {
  const on = toggleConsOrbit(name)
  if (on) {
    // Full fleet: OneWeb ~650 / Starlink ~7k — progressive batch inside cloud (t201u)
    setCloudOrbitCap(CONS_ORBIT_CAP_HARD, simMs)
    const { loadTleLines, cloudList, loadConstellation, tleLineMap } = useCatalog()
    if (!cloudList.value.length) await loadConstellation()
    try {
      await loadTleLines()
    } catch (e) {
      console.warn('[situation] tle_lines for cons orbits', e)
    }
    // Attach satrec onto ALL shown cons members, then draw every orbit (light blue)
    const upgraded = upgradeConsRecsFromTles(name, tleLineMap.value, simMs)
    console.info('[situation] cons orbits', name, 'upgraded', upgraded)
    refreshCloudVisibility(simMs)
  } else {
    setCloudOrbitCap(8, simMs)
    refreshCloudVisibility(simMs)
  }
  return { on }
}

function selectCatalogItem(item: CatalogTle | null) {
  if (!item) {
    stopCatalogTrack()
    setCloudSelection(null, simMs)
    return
  }
  ensureCloudSelected(item, simMs)
  // 拉近 + 跟踪 + 呼吸光环 + 名称（与星历选中一致，t201u）
  // 空间站沿用卡片中文名（pickStation 会同时 emit select，避免标签被 TLE 英文名回写）
  startCatalogTrack(item, STATION_NAMES[item.norad_id])
}

function filterCatalogTypes(types: string[]) {
  lastFilterTypes = (types || []).slice()
  clearHiddenSelection()
  void paintFromSnapshot(lastFilterTypes)
}

function setCatalogOrbitCap(n: number) {
  setCloudOrbitCap(n, simMs)
}

function refreshCatalogItems(_items: CatalogTle[]) {
  /* list materialize no longer drives the globe */
}

function applyHomeCamera() {
  if (!camera) return
  stopEphemTrack()
  stopCatalogTrack()
  const dir = homeDirection(simMs)
  camera.position.copy(dir).multiplyScalar(HOME_CAM_DIST)
  lookAtPt.set(0, 0, 0)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  if (cesiumActive) {
    setCameraFromScene(camera.position, dir.clone().negate(), camera.up, simMs)
  }
}

function resetCameraHome() {
  applyHomeCamera()
}

function setSimTime(ms: number) {
  simMs = ms
  simTimeMs.value = ms
}

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

  // 仅当 simTimeMs 被外部真正改动（≠ 我们上次推送的值）才跟随回拉；
  // lastPushedSim 只能随推送/回拉本身更新：若每帧赋值成当前 simMs，
  // 下一帧「陈旧推送值 ≠ 新鲜 simMs」恒成立 → 高倍速下每隔一帧回拉一次（轨迹不连续、净速率骤降）
  if (simTimeMs.value !== lastPushedSim) {
    simMs = simTimeMs.value
    lastPushedSim = simMs
  }

  // Freeze sim during user drag or camera fly; keep playing while tracking (camera follows)
  const freezeSim = interacting || camFly.active
  if (simPlaying.value && !freezeSim) simMs += dt * 1000 * simSpeed.value
  updateSky(simMs)

  updateCatalogCloud(simMs, camera)
  updateEphemOrbitMarker(simMs)

  const flying = updateCameraFly(now)

  // Old BaseScene Cesium track pattern:
  //  1) absorb user drag/zoom from Cesium → Three (when not flying)
  //  2) delta-translate cam + lookAt with sat (keep relative pose; do NOT radial-lock)
  //  3) push Three → Cesium when flying/tracking so follow is not wiped by sync
  //  4) renderCesium; sync again when !flying
  if (!flying && camera) syncCameraToThree(camera, simMs)

  // Pending catalog fly-in: position became available after async cloud rebuild
  if (!flying && trackCat && catFlyPending && getCatalogFocusPos(simMs, _trackPos)) {
    catFlyPending = false
    lookAtPt.copy(_trackPos)
    _trackPrev.copy(_trackPos)
    const radial = _trackPos.clone().normalize()
    const toPos = _trackPos.clone().addScaledVector(radial, TRACK_CAM_DIST)
    setReticleVisible(true)
    beginCamFly(toPos, _trackPos.clone())
  }

  // Old BaseScene Cesium track pattern:
  //  1) absorb user drag/zoom from Cesium → Three (when not flying)
  //  2) delta-translate cam + lookAt with sat (keep relative pose; do NOT radial-lock)
  //  3) push Three → Cesium when flying/tracking so follow is not wiped by sync
  //  4) renderCesium; sync again when !flying
  const tracking = trackEphem || trackCat
  if (!flying && tracking && camera) {
    let ok = false
    if (trackEphem) ok = !!getEphemMarkerPosition(_trackPos)
    else ok = getCatalogFocusPos(simMs, _trackPos)
    if (ok) {
      _trackDelta.subVectors(_trackPos, _trackPrev)
      camera.position.add(_trackDelta)
      lookAtPt.add(_trackDelta)
      _trackPrev.copy(_trackPos)
      setCameraOrbitFocusScene(lookAtPt, simMs)
    }
  }

  if (flying || tracking) {
    // Fly aims at target; track keeps current view dir (orbit/zoom around lookAt)
    applySceneCamera(flying)
  }

  renderCesium(simMs)
  if (camera && !flying) syncCameraToThree(camera, simMs)
  if (renderer && threeScene && camera) renderer.render(threeScene, camera)
  updateReticle()
  updateManLabel()

  if (now - lastSyncWall > 200) {
    lastSyncWall = now
    simTimeMs.value = simMs
    lastPushedSim = simMs
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

function stopViewport() {
  disposed = true
  stopEphemTrack()
  stopCatalogTrack()
  cancelAnimationFrame(rafId)
  rafId = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', onResize)
  clearCatalogCloud(threeScene)
  clearEphemOrbit()
  clearCatalogPoints(getCesiumScene())
  destroyCesium()
  cesiumActive = false
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
  sunGroup = null
  sunLight = null
  moonMesh = null
  starfield = null
}

async function startViewport() {
  const el = containerEl.value
  if (!el) return
  disposed = false
  interacting = false
  initThree(el)
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(el)
  window.addEventListener('resize', onResize)

  const ok = await applyCesiumBase(el)
  if (ok && !disposed) {
    lastWall = 0
    lastSyncWall = 0
    rafId = requestAnimationFrame(loop)
    onResize()
    // Restore chip filter after viewport rebuild (初始化窗口)
    if (lastFilterTypes.length) void paintFromSnapshot(lastFilterTypes)
    // Re-draw user ephemeris that was requested before Three/Cesium finished
    flushUserEphem()
    emit('viewport-ready')
  }
}

/** Re-init 3D viewport only — does not remount AppShell or reload the page (t192u). */
async function reinitViewport() {
  const keepTypes = lastFilterTypes.slice()
  stopViewport()
  lastFilterTypes = keepTypes
  await startViewport()
  applyHomeCamera()
}

onMounted(() => {
  void startViewport()
  // t203u: 空闲预热全部型号 low LOD 几何（约 320KB）——点亮类型芯片时零等待换批，无点云过渡
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
  if (typeof ric === 'function') ric(prewarmCatalogModels, { timeout: 8000 })
  else window.setTimeout(prewarmCatalogModels, 3000)
})

onBeforeUnmount(() => {
  stopViewport()
})


/** Last requested user-ephemeris draw — flushed when Three scene becomes ready. */
let lastEphemSet: EphemSet | null = null
let lastManeuverStates: EphemState[] | null = null
let lastManeuverBurnMs: number | null = null

function flushUserEphem() {
  const scene = threeScene
  if (!scene) return
  if (lastEphemSet) {
    setEphemOrbit(scene, lastEphemSet)
    if (lastManeuverStates && lastManeuverBurnMs != null) {
      setEphemManeuver(scene, lastManeuverStates, lastManeuverBurnMs)
    }
  } else {
    clearEphemOrbit()
  }
}

function showEphemOrbit(set: EphemSet | null, opts?: { track?: boolean }) {
  const setChanged = lastEphemSet !== set
  lastEphemSet = set
  // 同步给编目云：星历激活目标由 ephem 通道渲染，编目芯片/模型实例排除该 NORAD 防重复
  setEphemNorad(set ? Number(set.norad) || null : null)
  const scene = threeScene
  if (!scene) {
    if (!set) stopEphemTrack()
    return
  }
  setEphemOrbit(scene, set)
  // setEphemOrbit clears maneuver visuals — re-apply if still requested
  if (set && lastManeuverStates && lastManeuverBurnMs != null) {
    setEphemManeuver(scene, lastManeuverStates, lastManeuverBurnMs)
  }
  if (!set) {
    stopEphemTrack()
    setManLabelVisible(false)
    return
  }
  // 换星历：旧机动标签随之失效（选中态由 setEphemOrbit 内按 set 身份重置）
  if (setChanged) setManLabelVisible(false)
  if (opts?.track) startEphemTrack(set)
}

/**
 * 「机动卡片」定位：停卫星跟随（与当前位置解耦），相机对准琥珀 MAN 块中点；
 * 不改仿真时刻——保持真实时间，卫星无需位于斑块中。idx=null 取消高亮与标签。
 * TRAJ 窗口外的段（如已完成）无琥珀块 → 用二体推进近似位置定位，仅相机+标签。
 */
function focusEphemManIndex(idx: number | null, labelText?: string): boolean {
  if (idx == null) {
    setEphemManSelected(null)
    setManLabelVisible(false)
    return true
  }
  // IDB 旧数据可能丢 maneuvers → 图层无高亮；用当前 set 现场重绘后再取
  if (!getEphemManHighlights().length && lastEphemSet?.maneuvers?.length) {
    const scene = threeScene
    if (scene) {
      setEphemOrbit(scene, lastEphemSet)
      if (lastManeuverStates && lastManeuverBurnMs != null) {
        setEphemManeuver(scene, lastManeuverStates, lastManeuverBurnMs)
      }
    }
  }
  if (!getEphemManLocatePoint(idx, _trackPos)) return false
  stopEphemTrack()
  setEphemManSelected(idx)
  manLabelPos.copy(_trackPos)
  const txtEl = manLabelTextEl.value
  if (txtEl && labelText) txtEl.textContent = labelText
  setManLabelVisible(true)
  framePointAtTrackDist(_trackPos)
  return true
}


function showEphemManeuver(states: EphemState[] | null, burnMs: number | null) {
  lastManeuverStates = states
  lastManeuverBurnMs = burnMs
  const scene = threeScene
  if (!scene) return
  setEphemManeuver(scene, states, burnMs)
}

function clearUserEphemOrbit() {
  lastEphemSet = null
  lastManeuverStates = null
  lastManeuverBurnMs = null
  stopEphemTrack()
  setManLabelVisible(false)
  clearEphemOrbit()
}
defineExpose({
  resetCameraHome,
  setSimTime,
  selectCatalogItem,
  filterCatalogTypes,
  setCatalogOrbitCap,
  refreshCatalogItems,
  reinitViewport,
  showStation,
  showConstellation,
  showConsOrbit,
  consShowOf,
  isConsOrbitOn,
  getStationFocus,
  showEphemOrbit,
  showEphemManeuver,
  focusEphemManIndex,
  clearUserEphemOrbit
})
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
    <!-- Ephem / select reticle: breath ring + name (slower than old 2s) -->
    <div ref="reticleEl" class="sat-reticle" style="display: none">
      <span class="sat-reticle-ring"></span>
      <span ref="reticleNameEl" class="sat-reticle-name"></span>
    </div>
    <!-- 机动卡片定位标签：锚定选中 MAN 块中点的琥珀信息卡 -->
    <div ref="manLabelEl" class="man-label" style="display: none">
      <span ref="manLabelTextEl" class="man-label-box"></span>
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

.sat-reticle {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 3;
  width: 0;
  height: 0;
}

.sat-reticle-ring {
  position: absolute;
  width: 44px;
  height: 44px;
  margin-left: -22px;
  margin-top: -22px;
  border-radius: 50%;
  border: 1.6px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.55), inset 0 0 6px rgba(255, 255, 255, 0.25);
  animation: sat-reticle-pulse 3.2s ease-in-out infinite;
}

@keyframes sat-reticle-pulse {
  0%,
  100% {
    opacity: 0.95;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.05);
  }
}

.sat-reticle-name {
  position: absolute;
  left: 26px;
  top: -22px;
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  white-space: nowrap;
  text-shadow:
    0 0 2px rgba(4, 8, 16, 0.95),
    0 0 4px rgba(4, 8, 16, 0.85),
    0 0 1px rgba(4, 8, 16, 1);
}

/* 机动卡片定位标签：零尺寸锚点 + 右上偏移的琥珀信息卡（时间/时长 + 经纬度两行） */
.man-label {
  position: absolute;
  pointer-events: none;
  z-index: 3;
  width: 0;
  height: 0;
}

.man-label-box {
  position: absolute;
  left: 10px;
  bottom: 10px;
  padding: 4px 8px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #ffd9a0;
  /* pre：保留 \n 分行且不收缩换行（零宽容器内 pre-line 会被压成竖条） */
  white-space: pre;
  background: rgba(18, 24, 38, 0.88);
  border: 1px solid rgba(255, 180, 84, 0.6);
  border-radius: 5px;
  box-shadow: 0 0 6px rgba(255, 180, 84, 0.25);
}
</style>