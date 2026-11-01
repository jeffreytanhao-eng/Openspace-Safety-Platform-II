/**
 * Catalog satellite cloud on the Three overlay (Cesium+Three hybrid).
 *
 * First-paint path (mirrors old BaseScene.applyCloud):
 *   1) Snapshot x/y/z → Points (no client SGP4 / no tle_lines)
 *   2) Fill attribute buffers in rAF chunks so the UI stays interactive
 *   3) Orbits: selection/station sync; constellation「轨道展示」progressive batch
 *   4) Motion: per-frame two-body coast (continuous) + throttled SGP4 recal
 *
 * 显示口径（t201u/t202u）：
 *   - 类型芯片开启后，该类型全部目标常显——不做距离 LOD 抽稀隐藏；
 *   - 星座「轨道展示」为该星座全部展示成员画轨（Starlink 全量，不再要求 satrec——
 *     快照自带速度矢量，直接拟合开普勒椭圆即可）；
 *   - 全部轨道线为闭合椭圆（首点===尾点，t202u：天宫等轨道必须闭合）。
 *
 * See docs/cesium-three.md.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { twoline2satrec, propagate } from 'satellite.js'
import type { CatalogTle, CloudPoint } from '@/composables/useCatalog'
import {
  eciToScene,
  TYPE_COLOR,
  normalizeObjectType,
  KM_TO_SCENE
} from './scene'

export const THREE_POINT_SOFT = 40000
export const THREE_POINT_CONS = 5000
export const THREE_POINT_HARD = 44000
/** Points written per animation frame during progressive fill. */
export const FILL_CHUNK = 6000
/** First sync chunk so something appears before the first rAF yield. */
export const FILL_FIRST = 5000

/** Near-camera Starlink 3D model (old osp_flat / starlink-flat-wing.glb). Far sats stay Points. */
export const STARLINK_MODEL_URL = '/models/starlink-flat-wing.glb'
export const STARLINK_NEAR_MAX = 64
/** Scene units (Earth R=1). Show GLB when camera–sat distance below this. */
export const STARLINK_NEAR_DIST = 2.2
/** Max edge length after normalize (matches old MODEL_MAX_DIM ≈ 0.011). */
export const STARLINK_MODEL_MAX_DIM = 0.011

const ORBIT_SAMPLES = 180
const ORBIT_CAP_HARD = 16
/** 「轨道展示」all-member polylines — Starlink 全量（~7k）也可入批。 */
export const CONS_ORBIT_CAP_HARD = 9000
/** Adaptive per-orbit samples by fleet size (keeps vertex buffer sane at 7k orbits). */
const CONS_SAMPLES_SMALL = 180
const CONS_SAMPLES_MID = 90
const CONS_SAMPLES_LARGE = 48
const CONS_MID_FLEET = 150
const CONS_LARGE_FLEET = 1200
/** Per-frame ms budget for the progressive cons-orbit builder. */
const ORBIT_BUILD_MS_BUDGET = 9
/** Light blue for constellation orbit lines (user t195u). */
export const CONS_ORBIT_COLOR = 0x81d4fa
const UPDATE_MIN_MS_LIGHT = 100
const UPDATE_MIN_MS_HEAVY = 250
const HEAVY_N = 4000
/** Max SGP4 recal writes per throttle tick (coast owns per-frame motion). */
const UPDATE_PROP_BUDGET_LIGHT = 1200
const UPDATE_PROP_BUDGET_HEAVY = 1000
/** Hard wall-clock cap for one recal tick (SGP4 bursts must not jank the frame). */
const RECAL_MS_BUDGET = 6
/** Recompute Points bounding sphere at most this often (ms). */
const BOUND_SPHERE_MIN_MS = 1000
/** WGS84 two-body μ (km³/s²) — coast integrator. */
const MU_KM3_S2 = 398600.4418
/** Coast integrator max substep (s) and max substeps per call. */
const COAST_MAX_STEP_S = 12
const COAST_MAX_SUBSTEPS = 30
/** Beyond this coast span (s) without a satrec, freeze state (waiting recal/repaint). */
const COAST_FREEZE_S = 360

type SatRec = ReturnType<typeof twoline2satrec>

interface CloudEntry {
  norad: number
  type: string
  name: string
  isStarlink: boolean
  cons: string[]
  /** Precomputed constellation tokens + raw upper name (per-frame match hot path). */
  toks: string[]
  nameTok: string
  nameRaw: string
  item: CatalogTle | null
  rec: SatRec | null
  /** Current ECI state (km, km/s) at tMs — coasted forward each frame, SGP4-recal'd on tick. */
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Sim ms of the ECI state above. */
  tMs: number
  pi: number
  /** Last written scene xyz (kept when hidden so distance stays valid). */
  sx: number
  sy: number
  sz: number
}

let group: THREE.Group | null = null
let points: THREE.Points | null = null
let positions: Float32Array | null = null
let colors: Float32Array | null = null
let entries: CloudEntry[] = []
let focusEntry: CloudEntry | null = null
/** Cached resolution of selectedNorad → entry (rebuilt after each cloud rebuild). */
let focusRef: CloudEntry | null = null
let selectedNorad: number | null = null
let activeTypes: string[] = []
/** Per-constellation show override (old consShowMap). Missing key → follow PAYLOAD chip. */
const consShowMap: Record<string, boolean> = {}
let consOrbitOn = false
let consOrbitBound = ''
let stationFocus: number | null = null
let orbitCap = 8
let orbitGroup: THREE.Group | null = null
let cloudGen = 0
let fillGen = 0
let lastRecalMs = 0
let lastBoundMs = 0
let recalCursor = 0
let snapTMs = Date.now()
/** Buffer dirty flag — skip GPU upload when nothing moved (paused sim). */
let bufDirty = false
let attachedScene: THREE.Scene | null = null
let fillBusy = false
/** Lazy TLE source for cons members (set by upgradeConsRecsFromTles). */
let consTleMap: Map<number, [string, string]> | null = null
let starlinkMesh: THREE.InstancedMesh | null = null
let starlinkGeom: THREE.BufferGeometry | null = null
let starlinkMat: THREE.Material | null = null
let starlinkLoad: Promise<void> | null = null
let starlinkReady = false
const _starlinkDummy = new THREE.Object3D()
const _starlinkCam = new THREE.Vector3()
const _starlinkPos = new THREE.Vector3()
const _colTmp = new THREE.Color()

/* ---------------- 星座名匹配（token 预计算，热路径零正则） ---------------- */

/** Canonical token so card「Starlink」matches cloud cons「星链」,「北斗」↔「北斗导航星座」. */
function consToken(s: string | null | undefined): string {
  const raw = String(s || '').trim()
  if (!raw) return ''
  if (raw.includes('星链') || /STAR\s*LINK/i.test(raw)) return 'STARLINK'
  if (/ONE\s*WEB/i.test(raw)) return 'ONEWEB'
  if (raw.includes('北斗') || /BEI\s*DOU/i.test(raw)) return 'BEIDOU'
  if (raw.includes('千帆') || /QIAN\s*FAN/i.test(raw)) return 'QIANFAN'
  if (raw.includes('国网') || /GUO\s*WANG|GW\b/i.test(raw)) return 'GUOWANG'
  return raw.toUpperCase().replace(/\s+/g, '')
}

const keyTokCache = new Map<string, string>()
function keyToken(key: string): string {
  let t = keyTokCache.get(key)
  if (t === undefined) {
    t = consToken(key)
    keyTokCache.set(key, t)
  }
  return t
}

function tokensOf(cons: string[] | undefined, name: string | null | undefined): { toks: string[]; nameTok: string; nameRaw: string } {
  const toks: string[] = []
  for (const c of cons || []) {
    const t = consToken(c)
    if (t) toks.push(t)
  }
  return { toks, nameTok: consToken(name), nameRaw: String(name || '').toUpperCase() }
}

function matchTokens(
  x: { toks: string[]; nameTok: string; nameRaw: string },
  key: string
): boolean {
  const nk = keyToken(key)
  if (!nk) return false
  for (const ct of x.toks) {
    if (ct && (ct === nk || ct.includes(nk) || nk.includes(ct))) return true
  }
  const nt = x.nameTok
  if (nt && (nt === nk || nt.includes(nk) || nk.includes(nt))) return true
  // raw substring fallback (English object_name STARLINK-1234 vs key Starlink)
  const k = (key || '').toUpperCase()
  if (k && x.nameRaw && x.nameRaw.includes(k)) return true
  return false
}

function matchesConsKey(e: CloudEntry, key: string): boolean {
  return matchTokens(e, key)
}

function isStarlinkName(name: string | null | undefined): boolean {
  const n = (name || '').toUpperCase()
  return n.includes('STARLINK') || n.includes('星链')
}

function typesActive(): boolean {
  return activeTypes.length > 0
}

function consOverrideActive(): boolean {
  return Object.keys(consShowMap).length > 0
}

export function consShowOf(name: string): boolean {
  const v = consShowMap[name]
  return v !== undefined ? v : activeTypes.includes('PAYLOAD')
}

/** Old BaseScene mask: type chips + consShowMap + stationFocus + selection channels. */
function entryShown(e: CloudEntry): boolean {
  if (e.norad === selectedNorad) return true
  if (stationFocus != null && e.norad === stationFocus) return true
  const t = e.type
  if (t === 'PAYLOAD') {
    if (consOverrideActive()) {
      // Match against card keys (Starlink) via aliases — do NOT consShowOf(cons[i])
      // which fails when cloud cons is「星链」but map key is「Starlink」(t195u).
      let related = false
      let anyOn = false
      for (const [k, on] of Object.entries(consShowMap)) {
        if (!matchesConsKey(e, k)) continue
        related = true
        if (on) anyOn = true
      }
      if (related) return anyOn
      return activeTypes.includes('PAYLOAD')
    }
    return activeTypes.includes('PAYLOAD')
  }
  return activeTypes.includes(t)
}

function cloudGate(): boolean {
  return activeTypes.length > 0 || consOverrideActive() || stationFocus != null || selectedNorad != null
}

function colorVec(type: string, out: THREE.Color, selected: boolean): THREE.Color {
  const key = normalizeObjectType(type)
  const n = TYPE_COLOR[key] ?? 0x90a4ae
  out.setHex(n)
  if (selected) out.multiplyScalar(1.25)
  return out
}

function makeRec(item: CatalogTle): SatRec | null {
  try {
    const rec = twoline2satrec(item.tle_line1.trim(), item.tle_line2.trim())
    if ((rec as { error?: number }).error) return null
    return rec
  } catch {
    return null
  }
}

/** Lazily attach a satrec from the shared tle_lines map (constellation orbit context). */
function attachRecLazy(e: CloudEntry): void {
  if (e.rec || !consTleMap) return
  const tl = consTleMap.get(e.norad)
  if (!tl) return
  const item = {
    norad_id: e.norad,
    object_name: e.name,
    object_type: e.type,
    regime: '',
    epoch: null,
    incl: null,
    apogee: null,
    perigee: null,
    tle_line1: tl[0],
    tle_line2: tl[1],
    is_active: 1,
    source: 'tle_lines',
    updated_at: null
  }
  const rec = makeRec(item as unknown as CatalogTle)
  if (rec) {
    e.rec = rec
    e.item = e.item || (item as unknown as CatalogTle)
  }
}

/* ---------------- 运动模型：每帧 coast + 节流 SGP4 recal（t201u 连续运动） ---------------- */

/**
 * Two-body coast (semi-implicit Euler with gravity) from e.tMs to whenMs.
 * Keeps positions continuous every frame; SGP4 recal removes drift on tick.
 */
function coastEntry(e: CloudEntry, whenMs: number): void {
  const dt = (whenMs - e.tMs) / 1000
  if (!Number.isFinite(dt) || dt === 0) return
  e.tMs = whenMs
  if (Math.abs(dt) > COAST_FREEZE_S) return // seek jump without satrec — wait for recal/repaint
  let n = Math.ceil(Math.abs(dt) / COAST_MAX_STEP_S)
  if (n > COAST_MAX_SUBSTEPS) n = COAST_MAX_SUBSTEPS
  const h = dt / n
  for (let k = 0; k < n; k++) {
    const r2 = e.x * e.x + e.y * e.y + e.z * e.z
    if (!(r2 > 1)) return
    const kk = -MU_KM3_S2 / (r2 * Math.sqrt(r2))
    e.vx += kk * e.x * h
    e.vy += kk * e.y * h
    e.vz += kk * e.z * h
    e.x += e.vx * h
    e.y += e.vy * h
    e.z += e.vz * h
  }
}

/** Exact SGP4 re-anchor at whenMs (removes coast drift). Falls back silently to coast state. */
function propEntry(e: CloudEntry, whenMs: number): void {
  e.tMs = whenMs
  if (!e.rec) return
  const pv = propagate(e.rec, new Date(whenMs))
  const p = pv?.position
  if (p && Number.isFinite(p.x)) {
    e.x = p.x
    e.y = p.y
    e.z = p.z
    const v = pv?.velocity
    if (v && Number.isFinite(v.x)) {
      e.vx = v.x
      e.vy = v.y
      e.vz = v.z
    }
  }
}

function hideOne(e: CloudEntry): void {
  if (!positions || e.pi < 0) return
  const i3 = e.pi * 3
  if (positions[i3] === 0 && positions[i3 + 1] === 0 && positions[i3 + 2] === 0) return
  positions[i3] = positions[i3 + 1] = positions[i3 + 2] = 0
  bufDirty = true
}

function writeBufPos(e: CloudEntry): void {
  if (!positions || e.pi < 0) return
  const i3 = e.pi * 3
  const sx = e.x * KM_TO_SCENE
  const sy = e.z * KM_TO_SCENE
  const sz = -e.y * KM_TO_SCENE
  positions[i3] = sx
  positions[i3 + 1] = sy
  positions[i3 + 2] = sz
  e.sx = sx
  e.sy = sy
  e.sz = sz
  bufDirty = true
}

function writeOne(e: CloudEntry, whenMs: number, tmp: THREE.Color, forceProp = false): void {
  if (!positions || !colors || e.pi < 0) return
  if (!entryShown(e)) {
    hideOne(e)
    return
  }
  const isPri = e.norad === selectedNorad || (stationFocus != null && e.norad === stationFocus)
  if (isPri || forceProp) propEntry(e, whenMs)
  else coastEntry(e, whenMs)
  writeBufPos(e)
  colorVec(e.type, tmp, e.norad === selectedNorad)
  const i3 = e.pi * 3
  colors[i3] = tmp.r
  colors[i3 + 1] = tmp.g
  colors[i3 + 2] = tmp.b
}

/* ---------------- Starlink near GLB ---------------- */

function disposeStarlinkMesh(): void {
  if (starlinkMesh && group) {
    group.remove(starlinkMesh)
    // geometry/material owned by shared cache — do not dispose here if reused
    starlinkMesh = null
  }
}

function ensureStarlinkMesh(): void {
  if (!group || !starlinkReady || !starlinkGeom || !starlinkMat) return
  if (starlinkMesh) return
  const mesh = new THREE.InstancedMesh(starlinkGeom, starlinkMat, STARLINK_NEAR_MAX)
  mesh.count = 0
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.name = 'ospStarlinkNear'
  group.add(mesh)
  starlinkMesh = mesh
}

function ensureStarlinkModel(): void {
  if (starlinkReady || starlinkLoad) return
  starlinkLoad = new Promise<void>((resolve) => {
    const loader = new GLTFLoader()
    loader.setDRACOLoader(getDracoLoader())
    const t0 = performance.now()
    loader.load(
      STARLINK_MODEL_URL,
      (gltf) => {
        try {
          const root = gltf.scene || gltf.scenes[0]
          // Merge first mesh geometry (flat-wing is a simple glb)
          let foundGeom: THREE.BufferGeometry | null = null
          let foundMat: THREE.Material | null = null
          root.updateMatrixWorld(true)
          root.traverse((obj) => {
            const mesh = obj as THREE.Mesh
            if (!foundGeom && mesh.isMesh && mesh.geometry) {
              const g = mesh.geometry.clone()
              g.applyMatrix4(mesh.matrixWorld)
              foundGeom = g
              const m = mesh.material
              foundMat = Array.isArray(m) ? m[0].clone() : (m as THREE.Material).clone()
            }
          })
          if (!foundGeom) {
            console.warn('[situation] starlink glb has no mesh')
            resolve()
            return
          }
          // Cast: traverse callback assigns are invisible to CFA
          const src: THREE.BufferGeometry = foundGeom as THREE.BufferGeometry
          const mat: THREE.Material | null = foundMat
          // Match old BaseScene: flip Y then rotateX(π/2) so +Y-up glTF → scene +Z zenith
          src.rotateY(Math.PI)
          src.rotateX(Math.PI / 2)
          src.computeBoundingBox()
          const box = src.boundingBox!
          const size = new THREE.Vector3()
          box.getSize(size)
          const maxDim = Math.max(size.x, size.y, size.z) || 1
          const s = STARLINK_MODEL_MAX_DIM / maxDim
          src.scale(s, s, s)
          src.center()
          if (mat && 'side' in mat) (mat as THREE.Material).side = THREE.DoubleSide
          if (mat && 'depthWrite' in mat) (mat as THREE.MeshBasicMaterial).depthWrite = true
          starlinkGeom = src
          starlinkMat = mat || new THREE.MeshStandardMaterial({ color: 0xb0bec5, metalness: 0.35, roughness: 0.45 })
          starlinkReady = true
          ensureStarlinkMesh()
          console.info(
            '[situation] starlink model ready',
            STARLINK_MODEL_URL,
            `${Math.round(performance.now() - t0)}ms`,
            `maxDim→${STARLINK_MODEL_MAX_DIM}`
          )
        } catch (e) {
          console.warn('[situation] starlink model prepare failed', e)
        }
        resolve()
      },
      undefined,
      (err) => {
        console.warn('[situation] starlink model load failed', err)
        resolve()
      }
    )
  })
}

/** Pick nearest Starlink using already-written point positions; set InstancedMesh; return set. */
function updateStarlinkNear(camera: THREE.Camera | null): void {
  // t203u: 全量模型激活后停用 Starlink 近景特例（模型已覆盖全部目标，避免同位双渲染）
  if (modelsActive) {
    if (starlinkMesh) starlinkMesh.count = 0
    return
  }
  if (!camera || !cloudGate() || !positions) {
    if (starlinkMesh) starlinkMesh.count = 0
    return
  }
  ensureStarlinkModel()
  ensureStarlinkMesh()
  if (!starlinkMesh || !starlinkReady) return

  camera.getWorldPosition(_starlinkCam)
  const lim = STARLINK_NEAR_DIST * STARLINK_NEAR_DIST
  const scored: { i: number; d2: number }[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e.isStarlink || e.pi < 0) continue
    if (!entryShown(e)) continue
    const i3 = e.pi * 3
    const sx = positions[i3]
    const sy = positions[i3 + 1]
    const sz = positions[i3 + 2]
    if (!Number.isFinite(sx)) continue
    const dx = sx - _starlinkCam.x
    const dy = sy - _starlinkCam.y
    const dz = sz - _starlinkCam.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 <= lim) scored.push({ i, d2 })
  }
  scored.sort((a, b) => a.d2 - b.d2)
  const n = Math.min(STARLINK_NEAR_MAX, scored.length)
  for (let k = 0; k < n; k++) {
    const e = entries[scored[k].i]
    const i3 = e.pi * 3
    _starlinkPos.set(positions[i3], positions[i3 + 1], positions[i3 + 2])
    _starlinkDummy.position.copy(_starlinkPos)
    _starlinkDummy.scale.set(1, 1, 1)
    _starlinkDummy.lookAt(0, 0, 0)
    _starlinkDummy.rotateY(Math.PI)
    _starlinkDummy.updateMatrix()
    starlinkMesh.setMatrixAt(k, _starlinkDummy.matrix)
  }
  starlinkMesh.count = n
  starlinkMesh.instanceMatrix.needsUpdate = true
}

/* ---------------- 全量 3D 模型渲染（老项目 InstancedMesh 架构，t203u） ----------------
 * 口径与老 openspace-safety-platform 一致：
 *  - resolveModelKey：星座名 / object_name 关键词 → 30 种型号，粗类型兜底（碎片 4 变体散列）；
 *  - 每型号 1 个 InstancedMesh（geometry/material 共享缓存），instanceColor 逐实例着色；
 *  - 全局 LOD：可见数 >15000→low，>4000→med，数量少且相机贴地→high（先粗后精）；
 *  - 每帧：位置已由 coast 推进，累计漂移 < MATRIX_SKIP_SCENE 时整批跳过矩阵重写；
 *  - 载荷/未知走免四元数直写快路径，碎片/箭体叠加本地三轴翻滚；
 *  - 模型就绪前 Points 兜底显示，构建成功后隐藏 Points。 */

type ModelLod = 'low' | 'med' | 'high'

/** 模型归一化最大边（场景单位，老项目 MODEL_MAX_DIM 同款） */
const MODEL_MAX_DIM = 0.011
/** 空间站精细模型单独放大倍率（老项目同款） */
const MODEL_STATION_SCALE = 3
/** 碎片 / 箭体额外缩小（老项目同款） */
const MODEL_TINY_SCALE = 1 / 3
/** 未知目标十二面体标识模型单独缩小（当前尺寸的 20%） */
const MODEL_DODECA_SCALE = 0.2
/** LOD 检查间隔 / 首屏预热（老项目同款） */
const LOD_CHECK_MS = 1000
const LOD_WARMUP_MS = 4000
/** 累计漂移低于该值（≈0.64km，不足一像素）不重写实例矩阵（老项目 MATRIX_SKIP_SCENE） */
const MATRIX_SKIP_SCENE = 1e-4
/** 在轨最大速度（km/s）折算场景单位：本帧最大可能位移的保守上界 */
const MAX_ORBITAL_SPEED_SCENE = 7.9 / 6371

const MODEL_COARSE: Record<string, string> = {
  osp_flat: 'PAYLOAD', osp_boxwing: 'PAYLOAD', osp_tri: 'PAYLOAD', osp_tri2: 'PAYLOAD',
  osp_comm_a: 'PAYLOAD', osp_comm_b: 'PAYLOAD', osp_cube_d: 'PAYLOAD', osp_lem_a: 'PAYLOAD',
  osp_lem_b: 'PAYLOAD', osp_pico: 'PAYLOAD', osp_opt_a: 'PAYLOAD', osp_opt_b: 'PAYLOAD',
  osp_sat: 'PAYLOAD', osp_css: 'PAYLOAD', osp_iss: 'PAYLOAD',
  osp_fy: 'PAYLOAD', osp_kp: 'PAYLOAD', osp_met: 'PAYLOAD', osp_qf: 'PAYLOAD',
  osp_yg: 'PAYLOAD', osp_gw: 'PAYLOAD', osp_is: 'PAYLOAD', osp_glo: 'PAYLOAD',
  osp_gs: 'PAYLOAD', osp_gps: 'PAYLOAD', osp_bds: 'PAYLOAD', osp_jl: 'PAYLOAD',
  osp_debris: 'DEBRIS', osp_debris_b: 'DEBRIS', osp_debris_c: 'DEBRIS', osp_debris_d: 'DEBRIS',
  osp_rbody: 'ROCKET BODY',
  osp_dodeca: 'UNKNOWN'
}
/** 粗类型 → 兜底型号。未知目标统一十二面体标识（osp_dodeca）。 */
const COARSE_MODEL: Record<string, string> = {
  PAYLOAD: 'osp_sat', DEBRIS: 'osp_debris', 'ROCKET BODY': 'osp_rbody', UNKNOWN: 'osp_dodeca'
}
/** 固定单文件模型（不走 LOD 分档，老项目同款） */
const MODEL_FILE_OVERRIDE: Record<string, string> = {
  osp_flat: '/models/starlink-flat-wing.glb',
  osp_css: '/models/tiangong.glb',
  osp_iss: '/models/iss-detailed.glb'
}
/** 无固定机头（自带翻滚），不做头尾翻转（老项目 MODEL_NO_FLIP_Y，unknow 本地无素材不收录） */
const MODEL_NO_FLIP_Y = new Set(['osp_debris', 'osp_debris_b', 'osp_debris_c', 'osp_debris_d', 'osp_rbody', 'osp_dodeca'])
/** 碎片变体池：按目标名 FNV 散列挑选，同空域碎片形状不重样 */
const DEBRIS_MODELS = ['osp_debris', 'osp_debris_b', 'osp_debris_c', 'osp_debris_d']

function modelUrlOf(model: string, lod: ModelLod): string {
  const ov = MODEL_FILE_OVERRIDE[model]
  if (ov) return ov
  return `/models/${model}_${lod}.gltf`
}

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

function debrisVariantOf(name: string): string {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return DEBRIS_MODELS[(h >>> 0) % DEBRIS_MODELS.length]
}

/** Iridium 一/二代：NEXT 编号 ≥100 为二代（老项目同款） */
function iridiumGen(name: string): string {
  const m = /IRIDIUM[ -]?(\d+)/.exec(name)
  return m && Number(m[1]) >= 100 ? 'osp_tri2' : 'osp_tri'
}

/** Orbcomm 一/二代：OG2 / FM101+ 为二代（老项目同款） */
function orbcommGen(name: string): string {
  if (name.includes('OG2')) return 'osp_comm_b'
  const m = /ORBCOMM[ -]*(?:FM[ -]*)?(\d+)/.exec(name)
  return m && Number(m[1]) >= 100 ? 'osp_comm_b' : 'osp_comm_a'
}

/** 目标 → 型号键（老项目 resolveModelKey 全量移植）。 */
function resolveModelKey(p: { object_type: string; object_name: string; cons?: string[]; norad_id?: number }): string {
  const ot = p.object_type || ''
  const coarse = ot === 'PAYLOAD' || ot === 'DEBRIS' || ot === 'ROCKET BODY' ? ot : 'UNKNOWN'
  const norad = Number(p.norad_id)
  const nameEarly = (p.object_name || '').toUpperCase()
  // 空间站核心舱：NORAD 优先，名称兜底（精细 glb）
  if (norad === 25544 || nameEarly.includes('ISS (ZARYA)')) return 'osp_iss'
  if (norad === 48274 || nameEarly.includes('TIANHE')) return 'osp_css'
  if (coarse === 'DEBRIS') return debrisVariantOf(p.object_name || '')
  // 编目未知目标（object_type=UNKNOWN）统一十二面体标识；星历等无类型来源（''）不在此列，
  // 继续走名称关键词，保证星历选中仍显示对应型号模型
  if (ot === 'UNKNOWN') return COARSE_MODEL.UNKNOWN
  // ROCKET BODY 无型号细分
  if (coarse === 'ROCKET BODY') return COARSE_MODEL[coarse]
  const name = nameEarly
  const cons = p.cons || []
  const has = (s: string) => cons.includes(s)
  if (has('星链')) return 'osp_flat'
  if (has('OneWeb')) return 'osp_boxwing'
  if (has('Iridium')) return iridiumGen(name)
  if (has('Orbcomm')) return orbcommGen(name)
  if (has('Flock')) return 'osp_cube_d'
  if (has('风云星座')) return 'osp_fy'
  if (has('Kuiper')) return 'osp_kp'
  if (has('METEOR')) return 'osp_met'
  if (has('千帆星座')) return 'osp_qf'
  if (has('遥感星座')) return 'osp_yg'
  if (has('国网星座')) return 'osp_gw'
  if (has('Intelsat')) return 'osp_is'
  if (has('Glonass')) return 'osp_glo'
  if (has('Globalstar')) return 'osp_gs'
  if (has('GPS')) return 'osp_gps'
  if (has('北斗导航星座')) return 'osp_bds'
  if (has('吉利未来星座')) return 'osp_jl'
  if (name.includes('STARLINK')) return 'osp_flat'
  if (name.includes('ONEWEB') || name.includes('ONE WEB')) return 'osp_boxwing'
  if (name.includes('IRIDIUM')) return iridiumGen(name)
  if (name.includes('ORBCOMM')) return orbcommGen(name)
  if (name.includes('FLOCK')) return 'osp_cube_d'
  if (name.includes('SPACEBEE') || name.includes('SPACE BEE')) return 'osp_pico'
  if (name.includes('WORLDVIEW')) return /WORLDVIEW[ -]?[23]/.test(name) ? 'osp_opt_b' : 'osp_opt_a'
  if (name.includes('LEMUR')) return /LEMUR[ -]?2/.test(name) ? 'osp_lem_b' : 'osp_lem_a'
  if (name.includes('FENGYUN') || /^FY[ -]?\d/.test(name)) return 'osp_fy'
  if (name.includes('KUIPER')) return 'osp_kp'
  if (name.includes('METEOR')) return 'osp_met'
  if (name.includes('QIANFAN')) return 'osp_qf'
  if (name.includes('YAOGAN')) return 'osp_yg'
  if (name.includes('GUOWANG')) return 'osp_gw'
  if (name.includes('INTELSAT')) return 'osp_is'
  if (name.includes('GLONASS')) return 'osp_glo'
  if (name.includes('GLOBALSTAR')) return 'osp_gs'
  if (name.includes('NAVSTAR')) return 'osp_gps'
  if (name.includes('BEIDOU') || name.includes('COMPASS')) return 'osp_bds'
  if (name.includes('GEESAT')) return 'osp_jl'
  return 'osp_sat'
}

/* ---------- 模型加载（geometry 共享缓存 + 归一化，老项目 loadModelGeom 同款） ---------- */

interface GeomMat { geom: THREE.BufferGeometry; mat: THREE.Material }
const modelGeomCache = new Map<string, GeomMat>()

/** Draco 解码器（iss-detailed.glb 等精细模型带 KHR_draco 压缩），解码器文件在 public/draco/ */
let dracoLoader: DRACOLoader | null = null
function getDracoLoader(): DRACOLoader {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('/draco/')
    // 预热：首个 glb parse 前提前拉起 wasm 解码器，避免初始化与并发 parse 竞态中止请求
    dracoLoader.preload()
  }
  return dracoLoader
}

async function loadModelGeom(url: string, model: string): Promise<GeomMat | null> {
  try {
    const loader = new GLTFLoader()
    loader.setDRACOLoader(getDracoLoader())
    const gltf = await loader.loadAsync(url)
    const root = gltf.scene || gltf.scenes[0]
    const geoms: THREE.BufferGeometry[] = []
    root.updateWorldMatrix(true, true)
    root.traverse((obj) => {
      const m = obj as THREE.Mesh
      if (!m.isMesh || !m.geometry) return
      geoms.push(m.geometry.clone().applyMatrix4(m.matrixWorld))
    })
    if (!geoms.length) return null
    if (geoms.length > 1) {
      // mergeGeometries 要求属性集合一致：先取交集再删多余属性（老项目同款）
      let common = Object.keys(geoms[0].attributes)
      for (const g of geoms) common = common.filter((k) => g.attributes && k in g.attributes)
      for (const g of geoms) {
        for (const k of Object.keys(g.attributes)) {
          if (!common.includes(k)) g.deleteAttribute(k)
        }
      }
    }
    let geom: THREE.BufferGeometry | null = null
    try { geom = mergeGeometries(geoms, false) } catch { geom = null }
    if (!geom) geom = geoms[0]
    // 逐实例着色：丢弃自带顶点色，补白色 color 属性，最终颜色完全由 setColorAt 决定
    if (geom.attributes.color) geom.deleteAttribute('color')
    const vcount = geom.attributes.position ? geom.attributes.position.count : 0
    if (vcount) geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vcount * 3).fill(1), 3))
    if (!geom.attributes.normal) geom.computeVertexNormals()
    // 头尾对调：卫星素材机头朝本地 -Z，统一绕 Y 翻转 180°（碎片/箭体无固定机头不翻）
    if (!MODEL_NO_FLIP_Y.has(model)) geom.rotateY(Math.PI)
    // glTF Y-up → 场景 +Z 天顶（底盘与地表平行、结构竖直指向太空）
    if (model === 'osp_flat' || model === 'osp_css' || model === 'osp_iss') geom.rotateX(Math.PI / 2)
    // 天宫桁架长轴沿速度方向，再绕天顶水平转 90°（老项目同款）
    if (model === 'osp_css') geom.rotateZ(Math.PI / 2)
    geom.computeBoundingBox()
    const size = new THREE.Vector3()
    geom.boundingBox!.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z)
    let s = maxDim > 0 ? MODEL_MAX_DIM / maxDim : 1
    if (model === 'osp_css' || model === 'osp_iss') s *= MODEL_STATION_SCALE
    const coarse = MODEL_COARSE[model] || 'UNKNOWN'
    if (coarse === 'DEBRIS' || coarse === 'ROCKET BODY') s *= MODEL_TINY_SCALE
    if (model === 'osp_dodeca') s *= MODEL_DODECA_SCALE
    geom.scale(s, s, s)
    geom.computeBoundingBox()
    const center = geom.boundingBox!.getCenter(new THREE.Vector3())
    geom.translate(-center.x, -center.y, -center.z)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      metalness: 0.45,
      roughness: 0.32,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      transparent: false,
      opacity: 1,
      depthWrite: true
    })
    // 自发光按实例着色：emissive * vColor（老项目 onBeforeCompile 同款）
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive * vColor.rgb;'
      )
    }
    return { geom, mat }
  } catch (e) {
    console.warn('[situation] model load failed', url, e)
    return null
  }
}

function loadModelGeomCached(model: string, lod: ModelLod): Promise<GeomMat | null> {
  const url = modelUrlOf(model, lod)
  const key = `${url}::${model}`
  const hit = modelGeomCache.get(key)
  if (hit) return Promise.resolve(hit)
  return loadModelGeom(url, model).then((gm) => {
    // 只缓存成功结果：网络抖动导致的失败不缓存，允许重试（老项目同款）
    if (gm) modelGeomCache.set(key, gm)
    return gm
  })
}

/**
 * 空闲预热：静默预载全部型号 low LOD 几何（全部 low 模型共约 320KB）。
 * 用户点亮类型芯片时几何全部命中缓存 → 批次构建在微任务内完成，不出现点云过渡。
 */
export function prewarmCatalogModels(): void {
  for (const model of Object.keys(MODEL_COARSE)) {
    void loadModelGeomCached(model, 'low').catch(() => { /* 预热失败静默，点亮时按失败重试 */ })
  }
}

/** 星历等外部通道解析型号键（无类型来源，名称/NORAD 关键词匹配，兜底 osp_sat） */
export function resolveCatalogModelKey(objectName: string, norad?: number | null): string {
  return resolveModelKey({ object_type: '', object_name: objectName, cons: [], norad_id: norad ?? undefined })
}

/** 取共享模型几何/材质（归一化 + 统一材质；调用方不得 dispose 返回值） */
export function loadSharedModelGeom(
  key: string,
  lod: 'low' | 'med' | 'high' = 'med'
): Promise<{ geom: THREE.BufferGeometry; mat: THREE.Material } | null> {
  return loadModelGeomCached(key, lod)
}

/* ---------- 实例批次状态 ---------- */

let modelRoot: THREE.Group | null = null
let modelMeshes: Record<string, THREE.InstancedMesh> = {}
let modelIndices: Record<string, number[]> = {}
let modelLod: ModelLod = 'low'
/** 至少一批成功构建（Points 已切换为隐藏兜底） */
let modelsActive = false
let modelsBuilding = false
let modelRetryLeft = 3
let modelRetryTimer: ReturnType<typeof setTimeout> | undefined
/** 构建进行中又收到新构建请求（云重建/LOD 切换）时排队，finally 中补跑（否则请求被丢弃后无人再触发，永久点云） */
let modelBuildQueued = false
let modelBuildQueuedLod: ModelLod | null = null
let matrixDrift = 0
/** 翻滚相位（墙钟秒，冻结与否则随世界口径） */
let tumbleClock = 0
let lastTumbleWall = 0
let lodCheckAt = 0
let lodWarmupUntil = 0
/** 上一帧仿真时刻（实例矩阵漂移估算用） */
let lastModelSimMs = 0

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0)
const _m4 = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _tumbleEuler = new THREE.Euler()
const _tumbleQ = new THREE.Quaternion()
const _poseRight = new THREE.Vector3()
const _poseFwd = new THREE.Vector3()
const _poseUp = new THREE.Vector3()
const _poseM = new THREE.Matrix4()
const _posePos = new THREE.Vector3()
const _oneScale = new THREE.Vector3(1, 1, 1)

/** 基准姿态正交基：up=径向天顶、fwd=速度方向（速度缺失时参考轴兜底，老项目 orbitBasis 同款） */
function orbitBasisOf(e: CloudEntry): void {
  _poseUp.set(e.sx, e.sy, e.sz)
  const l = _poseUp.length()
  if (l > 1e-9) _poseUp.multiplyScalar(1 / l)
  else _poseUp.set(0, 1, 0)
  // 场景速度方向 = eciToScene 的线性变换（纯方向，无需乘 KM_TO_SCENE）
  _poseFwd.set(e.vx, e.vz, -e.vy)
  if (_poseFwd.lengthSq() < 1e-12) _poseFwd.set(0, 1, 0)
  _poseRight.crossVectors(_poseFwd, _poseUp)
  if (_poseRight.lengthSq() < 1e-12) {
    _poseFwd.set(0, 1, 0)
    if (Math.abs(_poseUp.y) > 0.9) _poseFwd.set(1, 0, 0)
    _poseRight.crossVectors(_poseFwd, _poseUp)
  }
  _poseRight.normalize()
  _poseFwd.crossVectors(_poseUp, _poseRight)
}

/** 位置尚未写入（fill 未覆盖 / 快照缺坐标）时写零矩阵，避免实例堆在地心 */
function poseReady(e: CloudEntry): boolean {
  return e.sx !== 0 || e.sy !== 0 || e.sz !== 0
}

/** 碎片/箭体完整矩阵：基准姿态 + 本地三轴翻滚（老项目 writeInstance 同款） */
function writeModelInstance(imesh: THREE.InstancedMesh, local: number, e: CloudEntry, spin: Float32Array | null): void {
  if (!entryShown(e) || !poseReady(e)) {
    imesh.setMatrixAt(local, ZERO_M)
    return
  }
  orbitBasisOf(e)
  _poseM.makeBasis(_poseRight, _poseFwd, _poseUp)
  _quat.setFromRotationMatrix(_poseM)
  if (spin) {
    const o = local * 6
    _tumbleEuler.set(
      tumbleClock * spin[o] + spin[o + 3],
      tumbleClock * spin[o + 1] + spin[o + 4],
      tumbleClock * spin[o + 2] + spin[o + 5]
    )
    _quat.multiply(_tumbleQ.setFromEuler(_tumbleEuler))
  }
  _posePos.set(e.sx, e.sy, e.sz)
  _m4.compose(_posePos, _quat, _oneScale)
  imesh.setMatrixAt(local, _m4)
}

/** 载荷/未知免四元数快路径：矩阵列直写（老项目 writeInstanceUpright 同款） */
function writeModelInstanceUpright(imesh: THREE.InstancedMesh, local: number, e: CloudEntry): void {
  if (!entryShown(e) || !poseReady(e)) {
    imesh.setMatrixAt(local, ZERO_M)
    return
  }
  orbitBasisOf(e)
  const arr = imesh.instanceMatrix.array as Float32Array
  const o = local * 16
  arr[o] = _poseRight.x; arr[o + 1] = _poseRight.y; arr[o + 2] = _poseRight.z; arr[o + 3] = 0
  arr[o + 4] = _poseFwd.x; arr[o + 5] = _poseFwd.y; arr[o + 6] = _poseFwd.z; arr[o + 7] = 0
  arr[o + 8] = _poseUp.x; arr[o + 9] = _poseUp.y; arr[o + 10] = _poseUp.z; arr[o + 11] = 0
  arr[o + 12] = e.sx; arr[o + 13] = e.sy; arr[o + 14] = e.sz; arr[o + 15] = 1
}

/** 按当前显隐口径重写全部实例矩阵（显隐事件后调用，隐藏实例写零矩阵） */
function rewriteModelMatrices(): void {
  if (!modelsActive) return
  for (const model of Object.keys(modelMeshes)) {
    const imesh = modelMeshes[model]
    const idxs = modelIndices[model]
    if (!idxs || !idxs.length) continue
    const spin = imesh.userData.spin as Float32Array | null
    for (let local = 0; local < idxs.length; local++) {
      const e = entries[idxs[local]]
      if (spin) writeModelInstance(imesh, local, e, spin)
      else writeModelInstanceUpright(imesh, local, e)
    }
    imesh.instanceMatrix.needsUpdate = true
  }
}

/** 空间站模型统一蓝色标识（天宫 osp_css / 国际空间站 osp_iss） */
const STATION_MODEL_COLOR = 0x3b82f6

/** 逐实例着色：类型色 / 选中提亮（与 Points colorVec 同一口径）；空间站模型固定蓝色 */
function paintModelColors(): void {
  if (!modelsActive) return
  const tmp = _colTmp
  for (const model of Object.keys(modelMeshes)) {
    const imesh = modelMeshes[model]
    const idxs = modelIndices[model]
    if (!idxs || !idxs.length) continue
    const station = model === 'osp_iss' || model === 'osp_css'
    for (let local = 0; local < idxs.length; local++) {
      const e = entries[idxs[local]]
      if (station) tmp.setHex(STATION_MODEL_COLOR)
      else colorVec(e.type, tmp, e.norad === selectedNorad)
      if (e.norad === selectedNorad) tmp.multiplyScalar(1.25)
      imesh.setColorAt(local, tmp)
    }
    if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true
  }
}

/** 每实例翻滚参数：三轴角速度 + 初相（seed 用 norad，重建批次时姿态连续） */
function makeTumble(idxs: number[]): Float32Array {
  const out = new Float32Array(idxs.length * 6)
  for (let i = 0; i < idxs.length; i++) {
    const e = entries[idxs[i]]
    const seed = e ? e.norad : i
    for (let a = 0; a < 3; a++) {
      out[i * 6 + a] = 0.25 + (0.85 - 0.25) * hash01(seed + a * 13)
      out[i * 6 + 3 + a] = hash01(seed + 71 + a * 29) * Math.PI * 2
    }
  }
  return out
}

/** 目标 → 型号分桶 + 局部下标（云重建后调用） */
function assignModelKeys(): void {
  modelIndices = {}
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const key = resolveModelKey({ object_type: e.type, object_name: e.name, cons: e.cons, norad_id: e.norad })
    const bucket = modelIndices[key]
    if (bucket) bucket.push(i)
    else modelIndices[key] = [i]
  }
}

/** 丢弃当前实例批次（geometry/material 归共享缓存，不 dispose），Points 恢复兜底显示 */
function resetModelBatches(): void {
  for (const old of Object.values(modelMeshes)) {
    if (modelRoot) modelRoot.remove(old)
    old.dispose()
  }
  modelMeshes = {}
  modelIndices = {}
  modelsActive = false
  modelBuildQueued = false
  modelBuildQueuedLod = null
  matrixDrift = MATRIX_SKIP_SCENE
  if (points) points.visible = true
}

function clearModelRetry(): void {
  if (modelRetryTimer) {
    clearTimeout(modelRetryTimer)
    modelRetryTimer = undefined
  }
  modelRetryLeft = 3
}

/** 为当前 entries 构建全部型号批次：并行下载解析 → 原子换批 → 颜色/矩阵落位 */
async function buildModelInstances(lod: ModelLod = modelLod): Promise<void> {
  if (modelsBuilding) {
    modelBuildQueued = true
    modelBuildQueuedLod = lod
    return
  }
  if (!group || !entries.length) return
  const gen = cloudGen
  modelsBuilding = true
  try {
    const keys = Object.keys(modelIndices).filter((k) => modelIndices[k].length)
    const parts = await Promise.all(
      keys.map(async (model) => ({ model, gm: await loadModelGeomCached(model, lod) }))
    )
    if (gen !== cloudGen || !group || !entries.length) return
    const built: Record<string, THREE.InstancedMesh> = {}
    const failed: string[] = []
    for (const { model, gm } of parts) {
      const idxs = modelIndices[model]
      if (!gm) { failed.push(model); continue }
      if (!idxs || !idxs.length) continue
      const imesh = new THREE.InstancedMesh(gm.geom, gm.mat, idxs.length)
      imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // 实例矩阵每帧改写，包围球停在地心附近：关闭视锥剔除防拉近时整批误剔除（老项目同款）
      imesh.frustumCulled = false
      imesh.name = `ospModel_${model}`
      const coarse = MODEL_COARSE[model] || 'UNKNOWN'
      imesh.userData.spin = coarse === 'DEBRIS' || coarse === 'ROCKET BODY' ? makeTumble(idxs) : null
      built[model] = imesh
    }
    for (const old of Object.values(modelMeshes)) {
      if (modelRoot) modelRoot.remove(old)
      old.dispose()
    }
    modelMeshes = {}
    for (const [model, imesh] of Object.entries(built)) {
      modelRoot?.add(imesh)
      modelMeshes[model] = imesh
    }
    modelLod = lod
    const okAny = Object.keys(modelMeshes).length > 0
    if (okAny) {
      modelsActive = true
      if (points) points.visible = false
      paintModelColors()
      rewriteModelMatrices()
    }
    lodWarmupUntil = performance.now() + LOD_WARMUP_MS
    console.info('[situation] model instances', { lod, batches: Object.keys(modelMeshes).length, failed })
    if (failed.length && modelRetryLeft > 0) {
      modelRetryLeft--
      clearModelRetryKeepCount()
      modelRetryTimer = setTimeout(() => { void buildModelInstances() }, 4000)
    } else if (!failed.length) {
      modelRetryLeft = 3
    }
  } finally {
    modelsBuilding = false
    if (modelBuildQueued) {
      modelBuildQueued = false
      const nextLod = modelBuildQueuedLod
      modelBuildQueuedLod = null
      if (nextLod) void buildModelInstances(nextLod)
      else void buildModelInstances()
    }
  }
}

function clearModelRetryKeepCount(): void {
  if (modelRetryTimer) {
    clearTimeout(modelRetryTimer)
    modelRetryTimer = undefined
  }
}

/** 当前应使用的 LOD 档（老项目 pickModelLod 同款；本项目画质恒为 high 上限） */
function pickModelLod(camera?: THREE.Camera | null): ModelLod {
  let vis = 0
  for (const e of entries) if (entryShown(e)) vis++
  if (vis > 15000) return 'low'
  if (vis > 4000) return 'med'
  const dist = camera ? camera.position.length() : 0
  const near = dist > 0 && dist - 1 <= 1.2
  return near ? 'high' : 'med'
}

/** 限频检查换档：目标档位与当前不同时异步重建（geometry 缓存复用，不重复下载） */
function maybeSwitchModelLod(nowWall: number, camera?: THREE.Camera | null): void {
  if (modelsBuilding || !modelsActive || !entries.length) return
  if (nowWall < lodWarmupUntil || nowWall - lodCheckAt < LOD_CHECK_MS) return
  lodCheckAt = nowWall
  const target = pickModelLod(camera)
  if (target === modelLod) return
  void buildModelInstances(target)
}

/** 每帧模型矩阵更新：漂移跳过 + 翻滚时钟 + LOD 检查（在 updateCatalogCloud 尾部调用） */
function updateModelFrames(whenMs: number, camera?: THREE.Camera | null): void {
  if (!modelsActive || !modelRoot || modelsBuilding) {
    if (modelsActive) lastModelSimMs = whenMs
    return
  }
  const dtSim = Math.max(0, (whenMs - lastModelSimMs) / 1000)
  lastModelSimMs = whenMs
  const nowWall = performance.now()
  if (lastTumbleWall) tumbleClock += Math.min(0.1, (nowWall - lastTumbleWall) / 1000)
  lastTumbleWall = nowWall
  matrixDrift += MAX_ORBITAL_SPEED_SCENE * dtSim
  const writeMatrix = matrixDrift >= MATRIX_SKIP_SCENE
  if (writeMatrix) matrixDrift = 0
  for (const model of Object.keys(modelMeshes)) {
    const imesh = modelMeshes[model]
    const idxs = modelIndices[model]
    if (!idxs || !idxs.length) continue
    const spin = imesh.userData.spin as Float32Array | null
    // 翻滚姿态逐帧变化必须重写；三轴稳定目标按漂移跳过整批重写
    if (!spin && !writeMatrix) continue
    for (let local = 0; local < idxs.length; local++) {
      const e = entries[idxs[local]]
      if (!entryShown(e)) continue // 隐藏实例的零矩阵由 rewriteModelMatrices 在显隐事件时落位
      if (spin) writeModelInstance(imesh, local, e, spin)
      else writeModelInstanceUpright(imesh, local, e)
    }
    imesh.instanceMatrix.needsUpdate = true
  }
  maybeSwitchModelLod(nowWall, camera)
}

/* ---------------- 采样 / 构建 ---------------- */

function sampleCloud(items: CloudPoint[], cap: number, keepNorad?: number | null): CloudPoint[] {
  const hard = Math.min(cap, THREE_POINT_HARD)
  if (items.length <= hard) return items.slice()
  const keep = keepNorad != null ? items.find((it) => it.norad_id === keepNorad) : undefined
  const rest = keep ? items.filter((it) => it !== keep) : items
  const buckets = new Map<string, CloudPoint[]>()
  for (const it of rest) {
    const k = normalizeObjectType(it.object_type)
    const arr = buckets.get(k) ?? []
    arr.push(it)
    buckets.set(k, arr)
  }
  const lists = [...buckets.values()]
  const out: CloudPoint[] = keep ? [keep] : []
  let i = 0
  while (out.length < hard && lists.some((b) => b.length)) {
    const b = lists[i % lists.length]
    i++
    if (!b.length) continue
    const stride = Math.max(
      1,
      Math.floor(b.length / Math.max(1, Math.ceil((hard - out.length) / Math.max(1, lists.length))))
    )
    out.push(b.shift()!)
    for (let s = 1; s < stride && b.length; s++) b.shift()
  }
  return out
}

function sampleTles(items: CatalogTle[], cap: number, keepNorad?: number | null): CatalogTle[] {
  const hard = Math.min(cap, THREE_POINT_HARD)
  if (items.length <= hard) return items.slice()
  const asCloud: CloudPoint[] = items.map((it) => ({
    norad_id: Number(it.norad_id),
    object_name: it.object_name,
    object_type: it.object_type,
    regime: it.regime || 'OTHER',
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    alt: null, cons: [], owner_code: it.owner_code || '--',
    perigee: it.perigee, period: null, incl: it.incl
  }))
  const picked = new Set(sampleCloud(asCloud, hard, keepNorad).map((p) => p.norad_id))
  return items.filter((it) => picked.has(Number(it.norad_id))).slice(0, hard)
}

function ensureGroup(scene: THREE.Scene): THREE.Group {
  if (group && attachedScene === scene) return group
  // Tear down prior group WITHOUT bumping cloudGen (clearCatalogCloud would invalidate
  // the in-flight init gen and abort first chip-on with plotted=0 — t187u).
  if (group) {
    if (points) {
      group.remove(points)
      points.geometry.dispose()
      ;(points.material as THREE.Material).dispose()
      points = null
    }
    clearOrbitLines()
    disposeStarlinkMesh()
    for (const old of Object.values(modelMeshes)) old.dispose()
    modelMeshes = {}
    modelIndices = {}
    modelsActive = false
    if (attachedScene) attachedScene.remove(group)
  }
  positions = colors = null
  entries = []
  focusEntry = null
  focusRef = null
  attachedScene = scene
  group = new THREE.Group()
  group.name = 'ospCatalogCloud'
  orbitGroup = new THREE.Group()
  orbitGroup.name = 'ospCatalogOrbits'
  group.add(orbitGroup)
  modelRoot = new THREE.Group()
  modelRoot.name = 'ospCatalogModels'
  group.add(modelRoot)
  scene.add(group)
  ensureStarlinkModel()
  return group
}

function cancelOrbitBuild(): void {
  orbitBuild = null
}

function clearOrbitLines(): void {
  cancelOrbitBuild()
  if (!orbitGroup) return
  while (orbitGroup.children.length) {
    const ch = orbitGroup.children.pop()!
    const line = ch as THREE.Line
    line.geometry?.dispose()
    const mat = line.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else mat?.dispose()
  }
}

/* ---------------- 渐进星座轨道批量构建（t201u 全量成员画轨） ---------------- */

interface OrbitBuild {
  gen: number
  items: CloudEntry[]
  idx: number
  samples: number
  arr: Float32Array
  geo: THREE.BufferGeometry
  segs: THREE.LineSegments
  done: number
}

let orbitBuild: OrbitBuild | null = null

function consSamplesFor(n: number): number {
  if (n > CONS_LARGE_FLEET) return CONS_SAMPLES_LARGE
  if (n > CONS_MID_FLEET) return CONS_SAMPLES_MID
  return CONS_SAMPLES_SMALL
}

/** Write a degenerate (invisible) slot for an orbit that cannot be sampled. */
function fillDegenerateSlot(b: OrbitBuild, slot: number): void {
  const e = b.items[slot]
  const base = slot * b.samples * 6
  let sx = 0
  let sy = 0
  let sz = 0
  if (e && e.pi >= 0 && positions) {
    const i3 = e.pi * 3
    sx = positions[i3]
    sy = positions[i3 + 1]
    sz = positions[i3 + 2]
  }
  for (let i = 0; i < b.samples * 2; i++) {
    b.arr[base + i * 3] = sx
    b.arr[base + i * 3 + 1] = sy
    b.arr[base + i * 3 + 2] = sz
  }
}

function sampleOrbitPoints(e: CloudEntry, whenMs: number, samples: number): THREE.Vector3[] {
  const rec = e.rec
  if (!rec) return []
  const periodMin = (2 * Math.PI) / rec.no
  if (!Number.isFinite(periodMin) || periodMin < 5 || periodMin > 3000) return []
  const periodMs = periodMin * 60 * 1000
  // Fixed-slot buffer: invalid samples are forward/backward-filled from valid neighbours
  // so a stray SGP4 failure never draws a segment to Earth center.
  const pts: (THREE.Vector3 | null)[] = new Array(samples + 1).fill(null)
  for (let i = 0; i <= samples; i++) {
    const t = new Date(whenMs + (i / samples) * periodMs)
    const pv = propagate(rec, t)
    const p = pv?.position
    if (p && Number.isFinite(p.x)) {
      const v = eciToScene(p.x, p.y, p.z)
      if (v.length() >= 0.9) pts[i] = v
    }
  }
  const firstIdx = pts.findIndex((p) => p)
  if (firstIdx < 0) return []
  for (let i = 0; i < firstIdx; i++) pts[i] = pts[firstIdx]
  let last = pts[firstIdx] as THREE.Vector3
  for (let i = firstIdx; i <= samples; i++) {
    if (pts[i]) last = pts[i] as THREE.Vector3
    else pts[i] = last
  }
  return pts as THREE.Vector3[]
}

/* ---------------- 闭合轨道拟合（开普勒椭圆，t202u） ---------------- */

/**
 * Osculating two-body ellipse from an ECI state vector (km, km/s).
 * Closed by construction — last point === first point (t202u: 天宫等目标轨道必须闭合).
 * Returns null when the state cannot form a sane closed ellipse (caller falls back to SGP4).
 */
function sampleEllipseFromState(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  samples: number
): THREE.Vector3[] | null {
  const r = Math.sqrt(x * x + y * y + z * z)
  if (!(r > 100) || r > 500000) return null
  const v2 = vx * vx + vy * vy + vz * vz
  if (!(v2 > 1e-6)) return null
  const mu = MU_KM3_S2
  // Specific angular momentum h = r × v
  const hx = y * vz - z * vy
  const hy = z * vx - x * vz
  const hz = x * vy - y * vx
  const h2 = hx * hx + hy * hy + hz * hz
  if (!(h2 > 1e-6)) return null
  // Eccentricity vector e = (v × h)/μ − r̂
  const ex = (vy * hz - vz * hy) / mu - x / r
  const ey = (vz * hx - vx * hz) / mu - y / r
  const ez = (vx * hy - vy * hx) / mu - z / r
  const ecc2 = ex * ex + ey * ey + ez * ez
  const ecc = Math.sqrt(ecc2)
  const aInv = 2 / r - v2 / mu
  if (!(aInv > 1e-12)) return null // hyperbolic/parabolic — no closed orbit
  const a = 1 / aInv
  if (!(a > 6371 && a < 600000)) return null // sane orbit size (km)
  if (ecc >= 0.99) return null // near-degenerate ellipse
  // Perifocal frame: p̂ along eccentricity (or radius when circular), ŵ along h, q̂ = ŵ × p̂
  let px: number, py: number, pz: number
  if (ecc < 1e-9) {
    px = x / r; py = y / r; pz = z / r
  } else {
    const el = Math.sqrt(ecc2)
    px = ex / el; py = ey / el; pz = ez / el
  }
  const wl = Math.sqrt(h2)
  const wx = hx / wl, wy = hy / wl, wz = hz / wl
  const qx = wy * pz - wz * py
  const qy = wz * px - wx * pz
  const qz = wx * py - wy * px
  const p = a * (1 - ecc * ecc) // semi-latus rectum
  const out: THREE.Vector3[] = new Array(samples + 1)
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * Math.PI * 2
    const rr = p / (1 + ecc * Math.cos(th))
    const ct = Math.cos(th)
    const sth = Math.sin(th)
    out[i] = eciToScene(
      rr * (px * ct + qx * sth),
      rr * (py * ct + qy * sth),
      rr * (pz * ct + qz * sth)
    )
  }
  out[samples] = out[0] // exact closure
  return out
}

/** Closed orbit points for an entry: fitted ellipse from current state, SGP4 fallback. */
function orbitLinePoints(e: CloudEntry, whenMs: number, samples: number): THREE.Vector3[] {
  const ell = sampleEllipseFromState(e.x, e.y, e.z, e.vx, e.vy, e.vz, samples)
  if (ell) return ell
  if (!e.rec) attachRecLazy(e)
  return sampleOrbitPoints(e, whenMs, samples)
}

function stepOrbitBuild(): void {
  const b = orbitBuild
  if (!b) return
  if (b.gen !== cloudGen || !b.segs.parent) {
    orbitBuild = null
    return
  }
  const whenMs = simNowMs
  const t0 = performance.now()
  while (b.idx < b.items.length && performance.now() - t0 < ORBIT_BUILD_MS_BUDGET) {
    const slot = b.idx
    const e = b.items[b.idx]
    b.idx++
    const pts = orbitLinePoints(e, whenMs, b.samples)
    if (!pts.length) {
      fillDegenerateSlot(b, slot)
      continue
    }
    const base = slot * b.samples * 6
    for (let i = 0; i < b.samples; i++) {
      const a = pts[i]
      const c = pts[i + 1]
      const o = base + i * 6
      b.arr[o] = a.x
      b.arr[o + 1] = a.y
      b.arr[o + 2] = a.z
      b.arr[o + 3] = c.x
      b.arr[o + 4] = c.y
      b.arr[o + 5] = c.z
    }
    b.done++
    b.geo.setDrawRange(0, b.done * b.samples * 2)
    ;(b.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }
  if (b.idx >= b.items.length) {
    orbitBuild = null
    return
  }
  requestAnimationFrame(stepOrbitBuild)
}

/** Lazy orbits: selection + focus sync; constellation batch progressive. */
function rebuildOrbits(whenMs: number): void {
  if (!orbitGroup) return
  clearOrbitLines()
  if (!cloudGate()) return
  simNowMs = whenMs
  // Cons「轨道展示」uses a high cap so Starlink-scale fleets get all lines
  if (consOrbitOn) orbitCap = Math.max(orbitCap, CONS_ORBIT_CAP_HARD)

  const hard = consOrbitOn ? CONS_ORBIT_CAP_HARD : ORBIT_CAP_HARD
  const seen = new Set<number>()
  const indiv: CloudEntry[] = []
  const consItems: CloudEntry[] = []

  const pushIndiv = (e: CloudEntry | null | undefined) => {
    if (!e || !entryShown(e)) return
    if (seen.has(e.norad)) return
    seen.add(e.norad)
    indiv.push(e)
  }
  if (selectedNorad != null) {
    pushIndiv(entries.find((e) => e.norad === selectedNorad) ?? focusRef)
  }
  if (stationFocus != null) {
    pushIndiv(entries.find((e) => e.norad === stationFocus) || focusRef)
  }
  pushIndiv(focusRef)

  if (consOrbitOn && consOrbitBound) {
    const capN = Math.min(orbitCap, hard)
    for (const e of entries) {
      if (consItems.length >= capN) break
      if (!entryShown(e)) continue
      if (e.norad === selectedNorad) continue // selected draws as its own line
      // t202u: no satrec requirement — snapshot state vector fits a closed ellipse
      if (seen.has(e.norad)) continue
      if (!matchesConsKey(e, consOrbitBound)) continue
      seen.add(e.norad)
      consItems.push(e)
    }
  }

  // Individual lines (selection / station focus) — few, build sync. Closed ellipse (t202u).
  for (const e of indiv) {
    const pts = orbitLinePoints(e, whenMs, ORBIT_SAMPLES)
    if (pts.length < 8) continue
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const tmp = new THREE.Color()
    colorVec(e.type, tmp, e.norad === selectedNorad)
    const mat = new THREE.LineBasicMaterial({
      color: tmp.getHex(),
      transparent: true,
      opacity: e.norad === selectedNorad ? 0.85 : 0.28,
      depthWrite: false
    })
    const line = new THREE.Line(geo, mat)
    line.frustumCulled = false
    line.userData.norad = e.norad
    orbitGroup.add(line)
  }

  // Cons mode: one LineSegments batch (1 draw call), built progressively per frame.
  if (consItems.length) {
    const samples = consSamplesFor(consItems.length)
    const arr = new Float32Array(consItems.length * samples * 2 * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    geo.setDrawRange(0, 0)
    const mat = new THREE.LineBasicMaterial({
      color: CONS_ORBIT_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    })
    const segs = new THREE.LineSegments(geo, mat)
    segs.frustumCulled = false
    segs.userData.consBatch = consOrbitBound
    orbitGroup.add(segs)
    orbitBuild = { gen: cloudGen, items: consItems, idx: 0, samples, arr, geo, segs, done: 0 }
    requestAnimationFrame(stepOrbitBuild)
  }
  lastOrbitMs = whenMs
}

function touchGeometry(forceBound = false): void {
  if (!points) return
  // t203u: Points 被全量模型替代隐藏后跳过 GPU 上传（恢复显示时由下次 touch 补传）
  if (bufDirty && points.visible) {
    const geo = points.geometry as THREE.BufferGeometry
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate = true
    bufDirty = false
  }
  const now = performance.now()
  if (forceBound || now - lastBoundMs >= BOUND_SPHERE_MIN_MS) {
    lastBoundMs = now
    const geo = points.geometry as THREE.BufferGeometry
    geo.computeBoundingSphere()
    if (geo.boundingSphere) geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius, 8)
  }
}

function cancelFill(): void {
  fillGen++
  fillBusy = false
}

/** Progressive rAF fill — first FILL_FIRST sync, then FILL_CHUNK per frame. */
function scheduleFill(whenMs: number, gen: number): void {
  cancelFill()
  const my = ++fillGen
  if (!entries.length || !positions) return
  const tmp = new THREE.Color()
  const n = entries.length
  const first = Math.min(FILL_FIRST, n)
  for (let i = 0; i < first; i++) writeOne(entries[i], whenMs, tmp)
  touchGeometry(true)
  if (first >= n) {
    fillBusy = false
    return
  }
  fillBusy = true
  let cursor = first
  const step = () => {
    if (my !== fillGen || gen !== cloudGen) {
      fillBusy = false
      return
    }
    const end = Math.min(cursor + FILL_CHUNK, n)
    for (let i = cursor; i < end; i++) writeOne(entries[i], whenMs, tmp)
    cursor = end
    if (cursor < n) {
      touchGeometry(false)
      requestAnimationFrame(step)
    } else {
      touchGeometry(true)
      fillBusy = false
    }
  }
  requestAnimationFrame(step)
}

function allocatePoints(n: number): void {
  if (!group) return
  if (points) {
    group.remove(points)
    points.geometry.dispose()
    ;(points.material as THREE.Material).dispose()
    points = null
  }
  positions = new Float32Array(n * 3)
  colors = new Float32Array(n * 3)
  bufDirty = false
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage))
  const mat = new THREE.PointsMaterial({
    size: 3.2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 2
  group.add(points)
}

/** Scene-clock mirror for the progressive orbit builder (set by updateCatalogCloud). */
let simNowMs = Date.now()
let lastOrbitMs = 0
/** Wall-clock throttle for the near-camera Starlink GLB refresh. */
let lastNearWallMs = 0

/**
 * Preferred first-paint: constellation snapshot coords (server already SGP4'd).
 * No tle_lines, no client satrec batch.
 */
export function initCatalogCloudFromSnapshot(
  scene: THREE.Scene,
  cloud: CloudPoint[],
  types: string[],
  cap = THREE_POINT_SOFT,
  snapT = Date.now(),
  keepNorad?: number | null
): { plotted: number; orbits: number; capped: number } {
  cancelFill()
  ensureGroup(scene)
  // gen AFTER ensureGroup — ensure must never bump cloudGen (t187u first-chip abort)
  const gen = ++cloudGen
  const prevPayload = activeTypes.includes('PAYLOAD')
  activeTypes = (types || []).map(normalizeObjectType)
  if (prevPayload !== activeTypes.includes('PAYLOAD')) {
    for (const k of Object.keys(consShowMap)) delete consShowMap[k]
    consOrbitOn = false
    consOrbitBound = ''
  }
  snapTMs = snapT || Date.now()
  simNowMs = snapTMs
  entries = []
  focusEntry = null
  focusRef = null

  if (!cloudGate() || !cloud.length) {
    resetModelBatches()
    if (points && group) {
      group.remove(points)
      points.geometry.dispose()
      ;(points.material as THREE.Material).dispose()
      points = null
    }
    positions = colors = null
    clearOrbitLines()
    console.info('[situation] three cloud snapshot skip', {
      types: activeTypes.slice(),
      cloud: cloud.length
    })
    return { plotted: 0, orbits: 0, capped: 0 }
  }

  // Include type-chip hits OR cons-show / station-focus / selection channels (old mask)
  const filtered = cloud.filter((p) => {
    const norad = Number(p.norad_id)
    if (stationFocus != null && norad === stationFocus) return true
    if (selectedNorad != null && norad === selectedNorad) return true
    const t = normalizeObjectType(p.object_type)
    if (t === 'PAYLOAD') {
      if (consOverrideActive()) {
        const pt = tokensOf(p.cons, p.object_name)
        let related = false
        let anyOn = false
        for (const [k, on] of Object.entries(consShowMap)) {
          if (!matchTokens(pt, k)) continue
          related = true
          if (on) anyOn = true
        }
        if (related) return anyOn
        return activeTypes.includes('PAYLOAD')
      }
      return activeTypes.includes('PAYLOAD')
    }
    return activeTypes.includes(t)
  })
  const sampled = sampleCloud(filtered, Math.min(cap, THREE_POINT_HARD), keepNorad ?? selectedNorad)
  if (gen !== cloudGen) {
    console.warn('[situation] three cloud aborted gen mismatch', gen, cloudGen)
    return { plotted: 0, orbits: 0, capped: 0 }
  }

  const built: CloudEntry[] = sampled.map((p, i) => {
    const tk = tokensOf(p.cons, p.object_name)
    return {
      norad: p.norad_id,
      type: normalizeObjectType(p.object_type),
      name: p.object_name || '',
      isStarlink: isStarlinkName(p.object_name),
      cons: p.cons || [],
      toks: tk.toks,
      nameTok: tk.nameTok,
      nameRaw: tk.nameRaw,
      item: null,
      rec: null,
      x: p.x, y: p.y, z: p.z,
      vx: p.vx, vy: p.vy, vz: p.vz,
      tMs: snapTMs,
      pi: i,
      sx: 0, sy: 0, sz: 0
    }
  })
  entries = built
  focusRef = selectedNorad != null ? built.find((e) => e.norad === selectedNorad) ?? null : null
  allocatePoints(built.length)
  // t203u: 型号分桶 + 异步构建实例批次；模型就绪前 Points 兜底显示
  resetModelBatches()
  assignModelKeys()
  void buildModelInstances()
  scheduleFill(snapTMs, gen)
  clearOrbitLines()
  console.info(
    '[situation] three cloud snapshot',
    {
      plotted: built.length,
      filtered: filtered.length,
      cloud: cloud.length,
      types: activeTypes.slice(),
      cap: Math.min(cap, THREE_POINT_HARD),
      sample0: built[0] ? { norad: built[0].norad, type: built[0].type, x: built[0].x } : null
    }
  )
  return { plotted: built.length, orbits: 0, capped: Math.min(cap, THREE_POINT_HARD) }
}

/**
 * TLE-backed rebuild (heavier). Prefer snapshot path; use for search hits / upgrades.
 * Still chunked — never sync-SGP4 the whole cap on one frame.
 */
export function initCatalogCloud(
  scene: THREE.Scene,
  items: CatalogTle[],
  cap = THREE_POINT_SOFT,
  keepNorad?: number | null
): { plotted: number; orbits: number; capped: number } {
  cancelFill()
  ensureGroup(scene)
  const gen = ++cloudGen
  entries = []
  focusEntry = null
  focusRef = null

  if (!cloudGate() || !items.length) {
    resetModelBatches()
    if (points && group) {
      group.remove(points)
      points.geometry.dispose()
      ;(points.material as THREE.Material).dispose()
      points = null
    }
    positions = colors = null
    clearOrbitLines()
    return { plotted: 0, orbits: 0, capped: 0 }
  }

  const sampled = sampleTles(items, Math.min(cap, THREE_POINT_HARD), keepNorad ?? selectedNorad)
  if (gen !== cloudGen) return { plotted: 0, orbits: 0, capped: 0 }

  // Defer satrec parse into the fill loop (chunked) — store items first
  const now = Date.now()
  snapTMs = now
  simNowMs = now
  const built: CloudEntry[] = []
  for (let i = 0; i < sampled.length; i++) {
    const it = sampled[i]
    const tk = tokensOf([], it.object_name)
    built.push({
      norad: Number(it.norad_id),
      type: normalizeObjectType(it.object_type),
      name: it.object_name || '',
      isStarlink: isStarlinkName(it.object_name),
      cons: [],
      toks: tk.toks,
      nameTok: tk.nameTok,
      nameRaw: tk.nameRaw,
      item: it,
      rec: null, // filled in first update chunk
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      tMs: now,
      pi: i,
      sx: 0, sy: 0, sz: 0
    })
  }
  entries = built
  focusRef = selectedNorad != null ? built.find((e) => e.norad === selectedNorad) ?? null : null
  allocatePoints(built.length)
  // t203u: 与快照路径同款 — 型号分桶 + 异步构建实例批次；模型就绪前 Points 兜底
  resetModelBatches()
  assignModelKeys()
  void buildModelInstances()

  // Chunk: parse satrec + seed position
  const my = ++fillGen
  fillBusy = true
  const tmp = new THREE.Color()
  let cursor = 0
  const step = () => {
    if (my !== fillGen || gen !== cloudGen) {
      fillBusy = false
      return
    }
    const end = Math.min(cursor + (cursor === 0 ? FILL_FIRST : FILL_CHUNK), built.length)
    for (let i = cursor; i < end; i++) {
      const e = built[i]
      if (e.item && !e.rec) e.rec = makeRec(e.item)
      if (e.rec) {
        propEntry(e, now)
      }
      writeOne(e, now, tmp, true)
    }
    touchGeometry()
    cursor = end
    if (cursor < built.length) requestAnimationFrame(step)
    else {
      fillBusy = false
      // Orbit only if selection already set
      if (selectedNorad != null) rebuildOrbits(now)
    }
  }
  step()
  console.info('[situation] three cloud tle-chunked', built.length, '/', items.length)
  return { plotted: built.length, orbits: 0, capped: Math.min(cap, THREE_POINT_HARD) }
}

/**
 * Per-frame cloud update:
 *   1) coast + write ALL visible entries (continuous motion, no LOD hiding — t201u)
 *   2) throttled SGP4 recal round-robin (drift correction only)
 *   3) model instance matrices (drift-skip + tumble) + LOD check (t203u)
 *   4) throttled near-camera Starlink GLB refresh
 */
export function updateCatalogCloud(whenMs: number, camera?: THREE.Camera | null): void {
  simNowMs = whenMs
  if (!points || !entries.length || fillBusy) return
  if (!cloudGate()) return

  const tmp = _colTmp
  for (let i = 0; i < entries.length; i++) {
    writeOne(entries[i], whenMs, tmp)
  }

  const heavy = entries.length >= HEAVY_N
  const minMs = heavy ? UPDATE_MIN_MS_HEAVY : UPDATE_MIN_MS_LIGHT
  if (whenMs - lastRecalMs >= minMs) {
    lastRecalMs = whenMs
    // SGP4 recal round-robin over satrec'd entries (coast drift correction)
    const budget = heavy ? UPDATE_PROP_BUDGET_HEAVY : UPDATE_PROP_BUDGET_LIGHT
    const n = entries.length
    const t0 = performance.now()
    let scanned = 0
    let spent = 0
    while (spent < budget && scanned < n && performance.now() - t0 < RECAL_MS_BUDGET) {
      const e = entries[(recalCursor + scanned) % n]
      scanned++
      if (e.pi < 0 || !e.rec) continue
      if (!entryShown(e)) continue
      if (e.norad === selectedNorad || (stationFocus != null && e.norad === stationFocus)) continue
      writeOne(e, whenMs, tmp, true)
      spent++
    }
    recalCursor = (recalCursor + scanned) % Math.max(1, n)
  }
  // Near Starlink GLB refresh on WALL clock — must track camera even while sim is paused
  const nowWall = performance.now()
  if (nowWall - lastNearWallMs >= 200) {
    lastNearWallMs = nowWall
    updateStarlinkNear(camera ?? null)
  }
  updateModelFrames(whenMs, camera)
  touchGeometry(false)
}

export function setCloudSelection(item: CatalogTle | null, whenMs = Date.now()): void {
  selectedNorad = item ? Number(item.norad_id) : null
  if (item) {
    const rec = makeRec(item)
    const existing = entries.find((e) => e.norad === selectedNorad)
    if (existing) {
      existing.item = item
      if (rec) existing.rec = rec
      focusEntry = existing
    } else if (rec) {
      const tk = tokensOf([], item.object_name)
      const fe: CloudEntry = {
        norad: Number(item.norad_id),
        type: normalizeObjectType(item.object_type),
        name: item.object_name || '',
        isStarlink: isStarlinkName(item.object_name),
        cons: [],
        toks: tk.toks,
        nameTok: tk.nameTok,
        nameRaw: tk.nameRaw,
        item,
        rec,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        tMs: whenMs,
        pi: -1,
        sx: 0, sy: 0, sz: 0
      }
      propEntry(fe, whenMs)
      focusEntry = fe
    }
  } else {
    focusEntry = null
  }
  focusRef = selectedNorad != null
    ? entries.find((e) => e.norad === selectedNorad) ?? focusEntry
    : null
  const tmp = new THREE.Color()
  for (const e of entries) writeOne(e, whenMs, tmp)
  touchGeometry()
  rebuildOrbits(whenMs) // lazy: only selection
  // t203u: 选中提亮 / 焦点显隐同步到模型实例
  paintModelColors()
  rewriteModelMatrices()
}

export function ensureCloudSelected(item: CatalogTle, whenMs = Date.now()): void {
  setCloudSelection(item, whenMs)
}

export function setCloudTypeFilter(types: string[], whenMs = Date.now()): void {
  const prevPayload = activeTypes.includes('PAYLOAD')
  activeTypes = (types || []).map(normalizeObjectType)
  const nowPayload = activeTypes.includes('PAYLOAD')
  // Old scene.ts: PAYLOAD master switch resets constellation card overrides
  if (prevPayload !== nowPayload) {
    for (const k of Object.keys(consShowMap)) delete consShowMap[k]
    consOrbitOn = false
    consOrbitBound = ''
  }
  if (!cloudGate()) {
    cancelFill()
    if (positions) positions.fill(0)
    bufDirty = true
    touchGeometry()
    rewriteModelMatrices()
    clearOrbitLines()
    return
  }
  const tmp = new THREE.Color()
  for (const e of entries) writeOne(e, whenMs, tmp)
  touchGeometry()
  rewriteModelMatrices()
  if (selectedNorad != null || consOrbitOn || stationFocus != null) rebuildOrbits(whenMs)
  else clearOrbitLines()
}

/** Toggle constellation card「星座展示」(independent of type chips). Returns new on-state. */
export function toggleConsShow(name: string): boolean {
  const on = consShowOf(name)
  consShowMap[name] = !on
  if (!on) {
    consOrbitBound = name
  } else if (consOrbitBound === name) {
    consOrbitBound = ''
    consOrbitOn = false
  }
  return !on
}

export function getConsShowMap(): Record<string, boolean> {
  return { ...consShowMap }
}

export function clearConsShow(): void {
  for (const k of Object.keys(consShowMap)) delete consShowMap[k]
  consOrbitOn = false
  consOrbitBound = ''
}

/** 「轨道展示」— only meaningful when that constellation is shown. */
export function toggleConsOrbit(name: string): boolean {
  if (!consShowOf(name)) {
    consOrbitOn = false
    return false
  }
  if (consOrbitBound !== name) {
    consOrbitBound = name
    consOrbitOn = true
  } else {
    consOrbitOn = !consOrbitOn
  }
  return consOrbitOn
}

export function isConsOrbitOn(name: string): boolean {
  return consOrbitOn && consOrbitBound === name
}

export function setStationFocus(norad: number | null): void {
  stationFocus = norad
}

export function getStationFocus(): number | null {
  return stationFocus
}

export function getCloudSelectedNorad(): number | null {
  return selectedNorad
}

/**
 * 选中目标在当前可见通道（类型芯片 / 星座 override / 空间站）下是否仍可见。
 * 不含 selection 特判（entryShown 对选中目标恒 true，不能用于判断芯片/星座开关后是否失去可见性）。
 * @param chips 芯片开关场景传入新芯片列表——模块内 activeTypes 要到 paint/init 时才同步，直接读会拿到旧值误判可见
 */
export function isCloudSelectionVisible(chips?: string[]): boolean {
  if (selectedNorad == null) return false
  if (selectedNorad === stationFocus) return true
  const sel = entries.find((e) => e.norad === selectedNorad) ?? focusRef
  if (!sel) return false
  const chipsOn = chips ? chips.map(normalizeObjectType) : activeTypes
  if (sel.type === 'PAYLOAD') {
    if (consOverrideActive()) {
      let related = false
      let anyOn = false
      for (const [k, on] of Object.entries(consShowMap)) {
        if (!matchesConsKey(sel, k)) continue
        related = true
        if (on) anyOn = true
      }
      if (related) return anyOn
      return chipsOn.includes('PAYLOAD')
    }
    return chipsOn.includes('PAYLOAD')
  }
  return chipsOn.includes(sel.type)
}

/**
 * Current scene-space position of the selected catalog target (tracking / reticle).
 * Advances the entry state to `whenMs` (cheap when already advanced this frame).
 */
export function getCatalogFocusPos(whenMs: number, out: THREE.Vector3): boolean {
  const e = focusRef
  if (!e || selectedNorad == null || e.norad !== selectedNorad) return false
  if (e.rec) propEntry(e, whenMs)
  else coastEntry(e, whenMs)
  const sx = e.x * KM_TO_SCENE
  const sy = e.z * KM_TO_SCENE
  const sz = -e.y * KM_TO_SCENE
  if (!Number.isFinite(sx) || (sx === 0 && sy === 0 && sz === 0)) return false
  out.set(sx, sy, sz)
  return true
}

/** Re-apply visibility without full rebuild (after cons/station toggle when entries exist). */
export function refreshCloudVisibility(whenMs = Date.now()): void {
  if (!points || !entries.length) return
  if (!cloudGate()) {
    if (positions) positions.fill(0)
    bufDirty = true
    touchGeometry()
    rewriteModelMatrices()
    clearOrbitLines()
    return
  }
  const tmp = new THREE.Color()
  for (const e of entries) writeOne(e, whenMs, tmp)
  touchGeometry()
  rewriteModelMatrices()
  if (selectedNorad != null || consOrbitOn || stationFocus != null) rebuildOrbits(whenMs)
  else clearOrbitLines()
}

export function setCloudOrbitCap(n: number, whenMs = Date.now()): void {
  const hard = consOrbitOn ? CONS_ORBIT_CAP_HARD : ORBIT_CAP_HARD
  orbitCap = Math.max(1, Math.min(n, hard))
  if (selectedNorad != null || consOrbitOn || stationFocus != null) rebuildOrbits(whenMs)
}

/**
 * Register tle_lines as the lazy satrec source for constellation members (for「轨道展示」).
 * Parsing happens progressively in the orbit builder / recal pass — never a sync 7k parse.
 * Returns how many shown members can draw an orbit for `name`.
 */
export function upgradeConsRecsFromTles(
  name: string,
  tleMap: Map<number, [string, string]>,
  whenMs = Date.now()
): number {
  consTleMap = tleMap
  let n = 0
  for (const e of entries) {
    if (!matchesConsKey(e, name)) continue
    if (!entryShown(e)) continue
    if (e.rec || (tleMap && tleMap.has(e.norad))) n++
  }
  // Prefer drawing cons orbits: bump cap then rebuild (progressive batch)
  orbitCap = Math.min(CONS_ORBIT_CAP_HARD, Math.max(orbitCap, n || orbitCap))
  rebuildOrbits(whenMs)
  return n
}

export function clearCatalogCloud(scene?: THREE.Scene | null): void {
  cloudGen++
  cancelFill()
  if (points && group) {
    group.remove(points)
    points.geometry.dispose()
    ;(points.material as THREE.Material).dispose()
  }
  points = null
  positions = colors = null
  entries = []
  focusEntry = null
  focusRef = null
  consTleMap = null
  orbitBuild = null
  clearOrbitLines()
  disposeStarlinkMesh()
  clearModelRetry()
  resetModelBatches()
  modelRoot = null
  if (group && (scene || attachedScene)) {
    ;(scene || attachedScene)!.remove(group)
  }
  group = null
  orbitGroup = null
  attachedScene = null
}

export function getCloudPlotted(): number {
  return entries.filter((e) => e.pi >= 0).length
}

export function isCloudFillBusy(): boolean {
  return fillBusy
}

export function getLastOrbitMs(): number {
  return lastOrbitMs
}
