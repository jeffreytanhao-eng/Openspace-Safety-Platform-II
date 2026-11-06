/**
 * 交会危险事件云（Epic E4）：黄/橙/红分级事件在 TCA 时刻交会几何中心的三维标记。
 *
 * - 渲染走独立 Three 叠加层（仿 ephemOrbitThree 模式），不触碰 SceneCore 主路径；
 * - 锚点 = 双方编目快照状态向量（useCatalog cloudList @ cloudSnapT）经两体推进到
 *   TCA 时刻的几何中心；一方缺失用另一方，双方都缺失则丢弃（如实降级）；
 * - 尺度随分级（红>橙>黄）与脱靶距离微调；透明度随 |simMs−TCA| 衰减（复核模式聚焦）；
 * - 拾取 raycaster 独立实现，命中后由 SceneCore 转发 Vue 层弹窗。
 */
import * as THREE from 'three'
import { twoline2satrec, propagate, gstime } from 'satellite.js'
import { eciToScene } from './scene'
import { twoBodyPropagate } from './ephem/screening'
import { useCatalog } from '@/composables/useCatalog'
import { loadSharedModelGeom, resolveCatalogModelKey } from './catalogCloudThree'

export interface EventCloudItem {
  key: string
  noradA: number
  noradB: number
  nameA: string
  nameB: string
  /** ISO 字符串（弹窗展示用） */
  tca: string
  tcaMs: number
  level: 'yellow' | 'orange' | 'red'
  pc: number | null
  missKm: number | null
  relSpeedKmS: number | null
  cdmCount: number
  /** R2-15：TCA 交会点大地坐标（由事件锚点 ECI 状态换算，纬度/经度 度、高度 km） */
  latDeg?: number
  lonDeg?: number
  altKm?: number
}

/** 分级视觉：基础半径（场景单位）+ 颜色（R2-10：黄/橙最小半径上调，远距离也看得见） */
const LEVEL_STYLE: Record<EventCloudItem['level'], { r: number; color: number }> = {
  red: { r: 0.016, color: 0xff4545 },
  orange: { r: 0.014, color: 0xff9430 },
  yellow: { r: 0.012, color: 0xffd23c }
}
/** 透明度：|dt| ≤ NEAR 全亮，线性衰减到 FAR 外的分级下限（R2-10：黄/橙不低于 0.55/0.45） */
const NEAR_MS = 3600_000
const FAR_MS = 86_400_000 * 3
const DIM_OPACITY = 0.3
const LEVEL_OPACITY_FLOOR: Record<EventCloudItem['level'], number> = {
  red: 0.35,
  orange: 0.45,
  yellow: 0.55
}
/** 选中环 */
const RING_SIZE = 0.05
/** 交会放大态白圈（近景尺度，避免铺满屏幕） */
const RING_FOCUS_SIZE = 0.014

let group: THREE.Group | null = null
let items: (EventCloudItem & { pos: THREE.Vector3 })[] = []
let sprites: THREE.Sprite[] = []
let ring: THREE.Sprite | null = null
/** 白圈基准尺寸（宽景 RING_SIZE / 近景 RING_FOCUS_SIZE） */
let ringBaseSize = RING_SIZE
/* R2-7 交会放大态：双方轨道 + 双方模型（选中时构建，取消选中即销毁） */
let focus: THREE.Group | null = null
let focusToken = 0
const CONJ_ORBIT_SAMPLES = 180
/** R2-10：交会放大态双方用高对比双色（A 冰蓝 / B 琥珀），避免同色难以分辨 */
const CONJ_MODEL_COLOR_A = 0x3b82f6
const CONJ_MODEL_COLOR_B = 0xffa63d
let lastOpacitySimMs = Number.NaN
let attachedScene: THREE.Scene | null = null

let puffTex: THREE.Texture | null = null
let ringTex: THREE.Texture | null = null

/** 径向渐变云团贴图（每分级一份着色即可，material.color 调色） */
function getPuffTexture(): THREE.Texture {
  if (puffTex) return puffTex
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')!
  const gd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gd.addColorStop(0, 'rgba(255,255,255,0.95)')
  gd.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  gd.addColorStop(0.7, 'rgba(255,255,255,0.12)')
  gd.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gd
  ctx.fillRect(0, 0, 128, 128)
  puffTex = new THREE.CanvasTexture(cv)
  puffTex.colorSpace = THREE.SRGBColorSpace
  return puffTex
}

function getRingTexture(): THREE.Texture {
  if (ringTex) return ringTex
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.arc(64, 64, 52, 0, Math.PI * 2)
  ctx.stroke()
  // 四个刻度缺口，与准星/选中环视觉语言一致
  ctx.lineWidth = 10
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    ctx.clearRect(64 + Math.cos(a) * 52 - 7, 64 + Math.sin(a) * 52 - 7, 14, 14)
  }
  ringTex = new THREE.CanvasTexture(cv)
  ringTex.colorSpace = THREE.SRGBColorSpace
  return ringTex
}

/** 编目快照状态向量 → 两体推进到 tcaMs 的 ECI km 位置 */
function propagateNorad(norad: number, tcaMs: number): [number, number, number] | null {
  const { cloudList, cloudSnapT } = useCatalog()
  const p = cloudList.value.find((c) => c.norad_id === norad)
  if (!p || !cloudSnapT.value) return null
  const dtSec = (tcaMs - cloudSnapT.value) / 1000
  if (!Number.isFinite(dtSec) || Math.abs(dtSec) > 86400 * 30) return null
  const prop = twoBodyPropagate(
    [p.x, p.y, p.z],
    [p.vx, p.vy, p.vz],
    dtSec
  )
  return prop ? [prop.r[0], prop.r[1], prop.r[2]] : null
}

/** TLE（tleLineMap）→ SGP4 在 tcaMs 的 ECI km 位置（编目快照外的目标兜底） */
function propagateByTle(norad: number, tcaMs: number): [number, number, number] | null {
  const line = useCatalog().tleLineMap.value.get(norad)
  if (!line) return null
  try {
    const satrec = twoline2satrec(line[0], line[1])
    const pv = propagate(satrec, new Date(tcaMs))
    const p = pv?.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    return [p.x, p.y, p.z]
  } catch {
    return null
  }
}

/** 目标在 TCA 的位置：优先新鲜 TLE/SGP4（编目快照两体推进受龄期与 J2 漂移影响，长 TCA 会显著偏移） */
function positionOf(norad: number, tcaMs: number): [number, number, number] | null {
  return propagateByTle(norad, tcaMs) ?? propagateNorad(norad, tcaMs)
}

/** 编目元信息（object_type 等）：型号解析与标签类型显示共用，取自左栏同一份编目快照 */
function catalogMetaOf(norad: number): { objectType: string; name: string } {
  const p = useCatalog().cloudList.value.find((c) => c.norad_id === norad)
  return { objectType: p?.object_type ?? '', name: p?.object_name ?? '' }
}

const OBJECT_TYPE_LABEL: Record<string, string> = {
  PAYLOAD: '卫星',
  'ROCKET BODY': '火箭残骸',
  DEBRIS: '碎片',
  UNKNOWN: '未知'
}

function objectTypeLabel(t: string): string {
  return OBJECT_TYPE_LABEL[t] || '未知'
}

const WGS84_A_KM = 6378.137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

/** ECI(km) → WGS84 大地坐标：Rz(−GMST) 转 ECEF 后迭代反算（R2-15 事件卡经纬高） */
function eciToGeodetic(
  r: [number, number, number],
  tcaMs: number
): { latDeg: number; lonDeg: number; altKm: number } {
  const g = gstime(new Date(tcaMs))
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const x = r[0] * cg + r[1] * sg
  const y = -r[0] * sg + r[1] * cg
  const z = r[2]
  const p = Math.hypot(x, y)
  const lon = Math.atan2(y, x)
  let lat = Math.atan2(z, p * (1 - WGS84_E2))
  let altKm = 0
  for (let i = 0; i < 6; i++) {
    const sinLat = Math.sin(lat)
    const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
    if (Math.abs(Math.cos(lat)) < 1e-9) break
    altKm = p / Math.cos(lat) - n
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + altKm)))
  }
  return { latDeg: (lat * 180) / Math.PI, lonDeg: (lon * 180) / Math.PI, altKm }
}

/**
 * 组装带锚点的事件集：双方位置几何中心（缺一用另一方，全缺丢弃）。
 * 编目快照（约 450 目标）之外的事件用 sat_tle 全量 TLE 兜底锚点，
 * 保证深链/任意交会事件都能落进场景。
 */
export async function buildEventCloudItems(
  raw: EventCloudItem[]
): Promise<{ items: (EventCloudItem & { pos: THREE.Vector3 })[]; skipped: number }> {
  // R2-10：锚点与放大态模型统一按新鲜 TLE 计算，避免快照龄期导致锚点/模型错位
  const { tleLineMap, loadTleLines } = useCatalog()
  if (!tleLineMap.value.size) {
    try {
      await loadTleLines()
    } catch (e) {
      console.warn('[situation] tle_lines load failed, keep snapshot anchors only', e)
    }
  }

  const out: (EventCloudItem & { pos: THREE.Vector3 })[] = []
  let skipped = 0
  for (const ev of raw) {
    const a = positionOf(ev.noradA, ev.tcaMs)
    const b = ev.noradB !== ev.noradA ? positionOf(ev.noradB, ev.tcaMs) : null
    let r: [number, number, number] | null = null
    if (a && b) r = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    else r = a ?? b
    if (!r) {
      skipped++
      continue
    }
    // R2-15：交会点大地坐标（事件卡显示；换算与锚点同一组 TCA 状态）
    const geo = eciToGeodetic(r, ev.tcaMs)
    out.push({ ...ev, pos: eciToScene(r[0], r[1], r[2]), ...geo })
  }
  return { items: out, skipped }
}

/** 挂载/替换事件云（scene 就绪前调用则仅缓存，由 SceneCore flush 补挂） */
export function setEventCloud(scene: THREE.Scene, list: (EventCloudItem & { pos: THREE.Vector3 })[]): void {
  clearEventCloud(scene)
  attachedScene = scene
  group = new THREE.Group()
  group.name = 'ospEventCloud'
  items = list
  const tex = getPuffTexture()
  for (const it of items) {
    const style = LEVEL_STYLE[it.level]
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: style.color,
      transparent: true,
      opacity: DIM_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    const sp = new THREE.Sprite(mat)
    // 尺度微调：miss 越小云越收紧（1km→×1.3，20km+→×0.8）
    const missK = it.missKm != null ? Math.max(0.8, Math.min(1.3, 1.25 - Math.log10(Math.max(it.missKm, 0.1)) * 0.12)) : 1
    sp.scale.setScalar(style.r * 2 * missK)
    sp.position.copy(it.pos)
    sp.userData.key = it.key
    sp.userData.level = it.level
    group.add(sp)
    sprites.push(sp)
  }
  // 选中环（默认隐藏）
  ring = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getRingTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false
    })
  )
  ring.scale.setScalar(RING_SIZE)
  ring.visible = false
  group.add(ring)
  scene.add(group)
  lastOpacitySimMs = Number.NaN
}

/** 每帧：透明度随时间差衰减（限频：仿真钟推进 60s 才算一次） */
export function updateEventCloud(simMs: number): void {
  if (!group || !sprites.length) return
  if (Number.isFinite(lastOpacitySimMs) && Math.abs(simMs - lastOpacitySimMs) < 60_000) return
  lastOpacitySimMs = simMs
  for (let i = 0; i < items.length; i++) {
    const dt = Math.abs(simMs - items[i].tcaMs)
    const floor = LEVEL_OPACITY_FLOOR[items[i].level] ?? DIM_OPACITY
    const k = dt <= NEAR_MS ? 1 : Math.max(floor, 1 - ((dt - NEAR_MS) / (FAR_MS - NEAR_MS)) * 0.7)
    const mat = sprites[i].material as THREE.SpriteMaterial
    mat.opacity = k
  }
}

/** 选中高亮：白环锚在事件云位置；key=null 取消（同时销毁交会放大态） */
export function setEventCloudSelected(key: string | null): void {
  disposeFocus()
  ringBaseSize = RING_SIZE
  if (!ring) return
  const it = key ? items.find((x) => x.key === key) : null
  if (!it) {
    ring.visible = false
    return
  }
  ring.position.copy(it.pos)
  ring.visible = true
  // 近景：白圈收小到与模型同量级，避免铺满屏幕
  ringBaseSize = RING_FOCUS_SIZE
  ring.scale.setScalar(RING_FOCUS_SIZE)
  focusToken++
  void buildFocus(focusToken, it)
}

/**
 * 每帧白圈动效（R2-7）：缓慢自转 + 呼吸缩放。
 * wallSec = 墙钟秒（performance.now()/1000），与仿真倍速解耦。
 */
export function updateEventCloudFocus(wallSec: number): void {
  if (!ring || !ring.visible) return
  const mat = ring.material as THREE.SpriteMaterial
  mat.rotation = wallSec * 0.35
  ring.scale.setScalar(ringBaseSize * (1 + 0.14 * Math.sin(wallSec * 1.7)))
}

/* ---------- 交会放大态：双方轨道 + 双方 3D 模型 ---------- */

/** TLE → 以 TCA 为中心的一个完整轨道周期采样（连续椭圆，首尾闭合） */
function orbitByTle(norad: number, tcaMs: number): THREE.Vector3[] | null {
  const line = useCatalog().tleLineMap.value.get(norad)
  if (!line) return null
  let satrec: ReturnType<typeof twoline2satrec>
  try {
    satrec = twoline2satrec(line[0], line[1])
  } catch {
    return null
  }
  const no = satrec.no
  if (!no || !Number.isFinite(no)) return null
  // no: rad/min → 轨道周期 ms
  const periodMs = ((2 * Math.PI) / no) * 60000
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= CONJ_ORBIT_SAMPLES; i++) {
    const tMs = tcaMs - periodMs / 2 + (periodMs * i) / CONJ_ORBIT_SAMPLES
    const pv = propagate(satrec, new Date(tMs))
    const p = pv?.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    pts.push(eciToScene(p.x, p.y, p.z))
  }
  return pts
}

/** 无 TLE 时由编目快照状态向量做二体椭圆采样（连续轨道兜底） */
function orbitByState(norad: number, tcaMs: number): THREE.Vector3[] | null {
  const { cloudList, cloudSnapT } = useCatalog()
  const p = cloudList.value.find((c) => c.norad_id === norad)
  if (!p || !cloudSnapT.value) return null
  const dtSec = (tcaMs - cloudSnapT.value) / 1000
  if (!Number.isFinite(dtSec) || Math.abs(dtSec) > 86400 * 30) return null
  const s0 = twoBodyPropagate([p.x, p.y, p.z], [p.vx, p.vy, p.vz], dtSec)
  if (!s0) return null
  const [r0, v0] = [s0.r, s0.v]
  const rmag = Math.hypot(r0[0], r0[1], r0[2])
  const vmag = Math.hypot(v0[0], v0[1], v0[2])
  const mu = 398600.4418
  const a = 1 / (2 / rmag - (vmag * vmag) / mu)
  if (!Number.isFinite(a) || a <= 0) return null
  const periodSec = 2 * Math.PI * Math.sqrt((a * a * a) / mu)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= CONJ_ORBIT_SAMPLES; i++) {
    const dt = -periodSec / 2 + (periodSec * i) / CONJ_ORBIT_SAMPLES
    const s = twoBodyPropagate(r0, v0, dt)
    if (!s) return null
    pts.push(eciToScene(s.r[0], s.r[1], s.r[2]))
  }
  return pts
}

/**
 * 交会双方在 TCA 的真实场景位置。
 * 真实脱靶距离在 1 单位 = 6371 km 尺度下极小（常常只有 0.1–1 km），双方模型会完全重叠；
 * 这里仅对「显示位置」做最小间距分离，真实 miss 仍以事件卡/详情数值为准。
 */
function conjPairPositions(
  ev: EventCloudItem & { pos: THREE.Vector3 },
  outA: THREE.Vector3,
  outB: THREE.Vector3
): { a: boolean; b: boolean } {
  const pa = positionOf(ev.noradA, ev.tcaMs)
  const pb = ev.noradB !== ev.noradA ? positionOf(ev.noradB, ev.tcaMs) : null
  const va = pa ? eciToScene(pa[0], pa[1], pa[2]) : null
  const vb = pb ? eciToScene(pb[0], pb[1], pb[2]) : null
  if (!va && !vb) return { a: false, b: false }
  if (va && vb && va.distanceTo(vb) > 0.05) {
    // 交会事件双方不可能相距 300+ km：数据不一致时退回事件锚点，避免模型/标签被甩出视口
    outA.copy(ev.pos)
    outB.copy(ev.pos)
    return { a: true, b: true }
  }
  outA.copy(va ?? ev.pos)
  outB.copy(vb ?? ev.pos)
  if (va && vb) {
    // 最小显示间距：0.008 ≈ 51 km（仅视觉分离，不参与任何计算）
    const sep = Math.max(va.distanceTo(vb), 0.008) / 2
    const mid = outA.clone().add(outB).multiplyScalar(0.5)
    const dir = outB.clone().sub(outA)
    if (dir.lengthSq() < 1e-12) {
      dir.crossVectors(mid, new THREE.Vector3(0, 1, 0))
      if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0)
    }
    dir.normalize()
    outA.copy(mid).addScaledVector(dir, -sep)
    outB.copy(mid).addScaledVector(dir, sep)
  }
  return { a: !!va, b: !!vb }
}

/** R2-10/R2-15：交会放大态目标标签锚点（每帧由 SceneCore 投影成 DOM 标签） */
export interface ConjFocusLabel {
  /** 三行显示文本：名称 \n NORAD ID \n 类型 */
  label: string
  pos: THREE.Vector3
  color: number
}
let focusLabels: ConjFocusLabel[] = []

export function getEventCloudFocusLabels(): ConjFocusLabel[] {
  return focusLabels
}

/** 构建交会放大态（异步：轨道同步入组，模型解析完成后按 token 校验补挂） */
async function buildFocus(token: number, ev: EventCloudItem & { pos: THREE.Vector3 }): Promise<void> {
  const scene = attachedScene
  if (!scene || token !== focusToken) return
  const g = new THREE.Group()
  g.name = 'ospConjFocus'

  const { tleLineMap, loadTleLines } = useCatalog()
  if (!tleLineMap.value.size) {
    try {
      await loadTleLines()
    } catch {
      /* 无 TLE 时轨道走二体兜底 */
    }
  }
  if (token !== focusToken) return

  const addOrbit = (norad: number, color: number) => {
    const pts = orbitByTle(norad, ev.tcaMs) ?? orbitByState(norad, ev.tcaMs)
    if (!pts || pts.length < 2) return
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })
    )
    line.name = `ospConjOrbit_${norad}`
    g.add(line)
  }
  addOrbit(ev.noradA, 0x62d0ff)
  if (ev.noradB !== ev.noradA) addOrbit(ev.noradB, 0xffb066)

  const posA = new THREE.Vector3()
  const posB = new THREE.Vector3()
  const pair = conjPairPositions(ev, posA, posB)
  // R2-10/R2-15：目标标签锚点（SceneCore 每帧投影；模型加载失败也保留标签）。
  // 三行文本：名称 / NORAD ID / 类型，便于操作员核对左侧编目是否同一目标。
  const labelOf = (norad: number, name: string): string => {
    const meta = catalogMetaOf(norad)
    const nm = name || meta.name || `NORAD ${norad}`
    return `${nm}\nNORAD ${norad}\n${objectTypeLabel(meta.objectType)}`
  }
  focusLabels = []
  if (pair.a) focusLabels.push({ label: labelOf(ev.noradA, ev.nameA), pos: posA.clone(), color: CONJ_MODEL_COLOR_A })
  if (pair.b && ev.noradB !== ev.noradA)
    focusLabels.push({ label: labelOf(ev.noradB, ev.nameB), pos: posB.clone(), color: CONJ_MODEL_COLOR_B })

  const addModel = async (norad: number, name: string, pos: THREE.Vector3, color: number) => {
    // R2-13：传入编目真实 object_type，保证交会双方外形与左栏一致（卫星/残骸/碎片/未知）
    const modelKey = resolveCatalogModelKey(name, norad, catalogMetaOf(norad).objectType)
    const gm = await loadSharedModelGeom(modelKey, 'med')
    if (!gm || token !== focusToken || focus !== g) return
    const mat = (gm.mat as THREE.MeshStandardMaterial).clone()
    mat.userData.cloned = true
    // R2-10：双方各用独立高对比色（A 冰蓝 / B 琥珀），便于区分两个目标
    mat.color = new THREE.Color(color)
    mat.emissive = new THREE.Color(color)
    mat.emissiveIntensity = 0.5
    const mesh = new THREE.Mesh(gm.geom, mat)
    mesh.name = `ospConjModel_${norad}`
    mesh.position.copy(pos)
    // 机头/天顶沿径向（与云模型同一姿态口径）
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize())
    g.add(mesh)

    // 白色发光描边：同几何外扩 + 背面渲染（仅轮廓一圈可见），便于区分两个目标的边界
    const addOutline = (scale: number, opacity: number) => {
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.BackSide,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      shellMat.userData.cloned = true
      const shell = new THREE.Mesh(gm.geom, shellMat)
      shell.name = `ospConjOutline_${norad}`
      shell.position.copy(pos)
      shell.quaternion.copy(mesh.quaternion)
      shell.scale.setScalar(scale)
      shell.renderOrder = 4
      g.add(shell)
    }
    addOutline(1.06, 0.95)
    addOutline(1.13, 0.4)
  }
  if (pair.a) void addModel(ev.noradA, ev.nameA, posA, CONJ_MODEL_COLOR_A)
  if (pair.b && ev.noradB !== ev.noradA) void addModel(ev.noradB, ev.nameB, posB, CONJ_MODEL_COLOR_B)

  scene.add(g)
  focus = g
}

/** 销毁交会放大态（几何为共享缓存不 dispose，克隆材质/线资源需释放） */
function disposeFocus(): void {
  focusLabels = []
  if (!focus) return
  focus.traverse((o) => {
    const mesh = o as THREE.Mesh
    if ((o as unknown as { isLine?: boolean }).isLine || (o as unknown as { isMesh?: boolean }).isMesh) {
      const mat = mesh.material as THREE.Material
      if (mat?.userData?.cloned) mat.dispose()
      if ((o as unknown as { isLine?: boolean }).isLine) mesh.geometry?.dispose()
    }
  })
  focus.removeFromParent()
  focus = null
}

/** 点击拾取：NDC 坐标 → 最近事件 key（未命中返回 null） */
export function pickEventCloud(ndc: THREE.Vector2, camera: THREE.Camera): string | null {
  if (!group || !sprites.length) return null
  const ray = new THREE.Raycaster()
  ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(sprites, false)
  return hits.length ? (hits[0].object.userData.key as string) : null
}

/** 事件云锚点（供相机定位），未找到返回 false */
export function getEventCloudAnchor(key: string, out: THREE.Vector3): boolean {
  const it = items.find((x) => x.key === key)
  if (!it) return false
  out.copy(it.pos)
  return true
}

export function hasEventCloud(): boolean {
  return !!group && sprites.length > 0
}

export function clearEventCloud(scene?: THREE.Scene | null): void {
  disposeFocus()
  const sc = scene ?? attachedScene
  if (group && sc) sc.remove(group)
  for (const sp of sprites) {
    sp.material.dispose()
  }
  if (ring) ring.material.dispose()
  sprites = []
  ring = null
  group = null
  items = []
  attachedScene = null
  lastOpacitySimMs = Number.NaN
}
