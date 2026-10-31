/**
 * 用户星历轨道图层（态势三维）：
 * - 主轨：浅蓝 #81d4fa — 全时段多圈折线（OCM ~7 天）
 * - MAN 段：琥珀 #ffb454 — [TIME_ABSOLUTE, +MAN_DURA] 线段（TRAJ 内直接采样；
 *   窗口外历史段用二体推进近似绘制）
 *   真实时长常仅 ~80–100 s → 不加时间垫宽；视觉上仅：
 *   · 管状加粗 + 高 renderOrder + 中点琥珀球
 *   · 用户点「跳转至机动段」才跳仿真时刻
 * - 交互脉冲机动（applyImpulse）仍可叠加琥珀后半段
 */
import * as THREE from 'three'
import { eciToScene } from './scene'
import { interpolateAt } from './ephem/interp'
import { twoBodyPropagate } from './ephem/screening'
import { resolveCatalogModelKey, loadSharedModelGeom } from './catalogCloudThree'
import type { EphemManSegment, EphemSet, EphemState, Vec3 } from './ephem/types'

export const EPH_ORBIT_COLOR = 0x81d4fa
export const EPH_MANEUVER_COLOR = 0xffb454
/** 星历目标标识色：更偏蓝（比轨道线的浅天蓝更深更蓝，明显区分） */
export const EPH_MARKER_COLOR = 0x3b82f6
export const EPH_BURN_COLOR = 0xffd166

/**
 * Background multi-rev polyline budget.
 * Old 2k was too coarse when zoomed (visible chords). Prefer near-native density for
 * week-long OCM (~10k @60s); cap higher for longer files, then chord-densify.
 */
const MAX_POLY_POINTS = 16000
/** Max scene-unit gap (~25 km) before inserting lerp verts so close-up arcs look continuous. */
const MAX_CHORD = 0.004
/** MAN dense sample step (ms); short burns stay true-duration — no time pad. */
const MAN_SAMPLE_MS = 500
/** Thick MAN tube (Earth R=1). Short segments only — cheap vs full-orbit tube. 0.0016 = 原 0.008 的 20% */
const MAN_TUBE_RADIUS = 0.0016
const MAN_TUBE_RADIAL = 6

export interface EphemManHighlight {
  id?: string
  /** 在 set.maneuvers 中的原始下标（面板卡片下标） */
  origIdx: number
  /** 真实 MAN 起止 */
  t0: number
  t1: number
  /** 绘制用（垫宽后、裁到 TRAJ） */
  draw0: number
  draw1: number
  midMs: number
}

let group: THREE.Group | null = null
let orbitLine: THREE.Line | null = null
let manObjects: THREE.Object3D[] = []
/** 与 manObjects 对齐的 set.maneuvers 原始下标（窗口外推进段同样进列表） */
let manOrigIdx: number[] = []
let impulseLine: THREE.Line | null = null
let marker: THREE.Mesh | null = null
let burnMarker: THREE.Mesh | null = null
/** t204u: 星历目标 3D 模型（共享几何；浅蓝球保留为位置真值载体 + 加载失败兜底） */
let markerModel: THREE.Mesh | null = null
let markerModelSeq = 0
/** 面板机动卡片当前选中的可画 MAN 下标（null = 无）；重绘后自动恢复高亮 */
let selectedManIdx: number | null = null
const _mkUp = new THREE.Vector3()
const _mkFwd = new THREE.Vector3()
const _mkRight = new THREE.Vector3()
const _mkM = new THREE.Matrix4()
let attachedScene: THREE.Scene | null = null
let currentSet: EphemSet | null = null
let currentImpulse: EphemState[] | null = null
let currentBurnMs: number | null = null
let manHighlights: EphemManHighlight[] = []

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (mat) {
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat.dispose()
    }
  })
}

function disposeLine(line: THREE.Line | null) {
  if (!line) return
  line.geometry.dispose()
  ;(line.material as THREE.Material).dispose()
}

function clearManObjects() {
  for (const obj of manObjects) {
    if (group) group.remove(obj)
    disposeObject(obj)
  }
  manObjects = []
  manOrigIdx = []
  manHighlights = []
}

function ensureGroup(scene: THREE.Scene): THREE.Group {
  if (group && attachedScene === scene) return group
  clearEphemOrbit()
  group = new THREE.Group()
  group.name = 'ospUserEphem'
  scene.add(group)
  attachedScene = scene
  return group
}

/** 移除星历模型（geometry 归共享缓存不 dispose；材质为克隆实例需释放） */
function disposeMarkerModel(): void {
  if (!markerModel) return
  if (group) group.remove(markerModel)
  const m = markerModel.material as THREE.Material | undefined
  if (m) m.dispose()
  markerModel = null
}

/** 按星历名称/NORAD 解析型号并加载共享几何 → 模型 mesh 替换青色球（球保留兜底） */
function refreshMarkerModel(set: EphemSet): void {
  const seq = ++markerModelSeq
  const key = resolveCatalogModelKey(set.name || '', set.norad)
  void loadSharedModelGeom(key, 'med').then((gm) => {
    if (seq !== markerModelSeq || !gm || !group) return
    disposeMarkerModel()
    const mat = (gm.mat as THREE.MeshStandardMaterial).clone()
    mat.emissive = new THREE.Color(EPH_MARKER_COLOR) // 星历通道标识色：偏蓝自发光
    // 轨道线/MAN 管都是透明材质（后绘制）→ 不透明模型会被轨道线盖住。
    // 把模型也转入透明队列，renderOrder 3 > 管道 2 > 轨道线 0 → 模型绘制在轨道图层之上
    mat.transparent = true
    markerModel = new THREE.Mesh(gm.geom, mat)
    markerModel.frustumCulled = false
    markerModel.renderOrder = 3
    if (marker) markerModel.position.copy(marker.position)
    group.add(markerModel)
    if (marker) marker.visible = false
  }).catch(() => { /* 加载失败：青色球兜底继续显示 */ })
}

/** 模型位置 + 轨道基准姿态（up=径向天顶、fwd=速度方向，与目标云模型同款） */
function syncMarkerModelPose(st: { r: Vec3; v: Vec3 }, pos: THREE.Vector3): void {
  if (!markerModel) return
  markerModel.position.copy(pos)
  _mkUp.copy(pos)
  const l = _mkUp.length()
  if (l > 1e-9) _mkUp.multiplyScalar(1 / l)
  else _mkUp.set(0, 1, 0)
  // ECI 速度 → 场景方向：eciToScene 为线性映射 (x,y,z)→(x,z,-y)，纯方向无需缩放
  _mkFwd.set(st.v[0], st.v[2], -st.v[1])
  if (_mkFwd.lengthSq() < 1e-12) _mkFwd.set(0, 1, 0)
  _mkRight.crossVectors(_mkFwd, _mkUp)
  if (_mkRight.lengthSq() < 1e-12) {
    _mkFwd.set(0, 1, 0)
    if (Math.abs(_mkUp.y) > 0.9) _mkFwd.set(1, 0, 0)
    _mkRight.crossVectors(_mkFwd, _mkUp)
  }
  _mkRight.normalize()
  _mkFwd.crossVectors(_mkUp, _mkRight)
  _mkM.makeBasis(_mkRight, _mkFwd, _mkUp)
  markerModel.quaternion.setFromRotationMatrix(_mkM)
}

function buildPts(states: EphemState[]): THREE.Vector3[] {
  if (states.length < 2) return []
  const stride = Math.max(1, Math.ceil(states.length / MAX_POLY_POINTS))
  const raw: THREE.Vector3[] = []
  for (let i = 0; i < states.length; i += stride) {
    const s = states[i]
    raw.push(eciToScene(s.r[0], s.r[1], s.r[2]))
  }
  const last = states[states.length - 1]
  const lastPt = eciToScene(last.r[0], last.r[1], last.r[2])
  if (!raw.length || raw[raw.length - 1].distanceToSquared(lastPt) > 1e-12) raw.push(lastPt)
  // Densify long chords (stride or sparse ephem) so close track view is not polygonal
  const pts: THREE.Vector3[] = [raw[0].clone()]
  for (let i = 1; i < raw.length; i++) {
    const a = pts[pts.length - 1]
    const b = raw[i]
    const d = a.distanceTo(b)
    if (d > MAX_CHORD) {
      const n = Math.min(48, Math.ceil(d / MAX_CHORD))
      for (let k = 1; k < n; k++) pts.push(a.clone().lerp(b, k / n))
    }
    pts.push(b.clone())
  }
  return pts
}

function makeLine(pts: THREE.Vector3[], color: number, opacity: number): THREE.Line | null {
  if (pts.length < 2) return null
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false
    })
  )
  line.frustumCulled = false
  return line
}

/** 真实 MAN ∩ TRAJ（不加时间垫宽） */
function visibleManWindow(
  seg: EphemManSegment,
  span0: number,
  span1: number
): { draw0: number; draw1: number; midMs: number } | null {
  const draw0 = Math.max(seg.t0, span0)
  const draw1 = Math.min(seg.t1, span1)
  if (!(draw1 > draw0)) return null
  const mid = (draw0 + draw1) / 2
  return { draw0, draw1, midMs: mid }
}

/**
 * TRAJ 窗口外 MAN 段采样：从最近端点状态做二体开普勒推进（dt 可为负，往回推）。
 * 星历文件常从「当前时刻附近」才开始，历史机动（如已完成首段）整体落在窗口前，
 * 插值取不到状态 → 用推进近似画弧，保证大屏能看到琥珀色块。
 */
function samplePropagatedPts(states: EphemState[], t0: number, t1: number): THREE.Vector3[] {
  if (states.length < 2 || !(t1 > t0)) return []
  const base = t1 < states[0].t ? states[0] : states[states.length - 1]
  const pts: THREE.Vector3[] = []
  for (let t = t0; t <= t1; t += MAN_SAMPLE_MS) {
    const prop = twoBodyPropagate(base.r, base.v, (t - base.t) / 1000)
    if (prop) pts.push(eciToScene(prop.r[0], prop.r[1], prop.r[2]))
  }
  const end = twoBodyPropagate(base.r, base.v, (t1 - base.t) / 1000)
  if (end) {
    const p = eciToScene(end.r[0], end.r[1], end.r[2])
    if (!pts.length || pts[pts.length - 1].distanceToSquared(p) > 1e-12) pts.push(p)
  }
  return pts
}

function sampleIntervalPts(states: EphemState[], t0: number, t1: number): THREE.Vector3[] {
  if (!states.length || !(t1 > t0)) return []
  const pts: THREE.Vector3[] = []
  for (let t = t0; t <= t1; t += MAN_SAMPLE_MS) {
    const st = interpolateAt(states, t)
    if (st) pts.push(eciToScene(st.r[0], st.r[1], st.r[2]))
  }
  const end = interpolateAt(states, t1)
  if (end) {
    const p = eciToScene(end.r[0], end.r[1], end.r[2])
    if (!pts.length || pts[pts.length - 1].distanceToSquared(p) > 1e-12) pts.push(p)
  }
  return pts
}

/** Amber thick segment along path; depthTest on so Earth occluder hides far-side MAN. */
function makeManThickSegment(pts: THREE.Vector3[]): THREE.Mesh | null {
  if (pts.length < 2) return null
  const curve = new THREE.CatmullRomCurve3(pts)
  const tubular = Math.max(8, Math.min(64, (pts.length - 1) * 2))
  const geo = new THREE.TubeGeometry(curve, tubular, MAN_TUBE_RADIUS, MAN_TUBE_RADIAL, false)
  const mat = new THREE.MeshBasicMaterial({
    color: EPH_MANEUVER_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
    depthWrite: false
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  return mesh
}

/** MAN = thick amber path segment only (no start/mid/end spheres). */
function paintManSegments(g: THREE.Group, set: EphemSet) {
  clearManObjects()
  const segs = set.maneuvers || []
  if (!segs.length || set.states.length < 2) return
  const span0 = set.states[0].t
  const span1 = set.states[set.states.length - 1].t

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    const win = visibleManWindow(seg, span0, span1)
    let pts: THREE.Vector3[]
    let draw0: number, draw1: number, midMs: number
    if (win) {
      pts = sampleIntervalPts(set.states, win.draw0, win.draw1)
      draw0 = win.draw0
      draw1 = win.draw1
      midMs = win.midMs
    } else {
      // 窗口外段（星历生成前的历史机动等）：二体推进近似绘制，保证大屏可见琥珀斑块
      pts = samplePropagatedPts(set.states, seg.t0, seg.t1)
      draw0 = seg.t0
      draw1 = seg.t1
      midMs = (seg.t0 + seg.t1) / 2
    }
    if (pts.length < 2) continue

    const tube = makeManThickSegment(pts)
    if (tube) {
      manObjects.push(tube)
      manOrigIdx.push(si)
      g.add(tube)
    }

    manHighlights.push({
      origIdx: si,
      id: seg.id,
      t0: seg.t0,
      t1: seg.t1,
      draw0,
      draw1,
      midMs
    })
  }
  applyManSelection()
}

/** 把选中态刷到 MAN 管道材质：选中段亮琥珀、其余恢复常规琥珀（按 maneuver 原始下标匹配） */
function applyManSelection(): void {
  for (let i = 0; i < manObjects.length; i++) {
    const mesh = manObjects[i] as THREE.Mesh
    const mat = mesh.material as THREE.MeshBasicMaterial
    if (!mat) continue
    if (manOrigIdx[i] === selectedManIdx) {
      mat.color.setHex(EPH_BURN_COLOR)
      mat.opacity = 1
    } else {
      mat.color.setHex(EPH_MANEUVER_COLOR)
      mat.opacity = 0.95
    }
  }
}

/** 面板机动卡片选中/取消 → 高亮对应琥珀段（idx 为 set.maneuvers 原始下标，null 取消） */
export function setEphemManSelected(idx: number | null): void {
  selectedManIdx = idx
  applyManSelection()
}

/**
 * 机动卡片定位点（场景坐标）：TRAJ 内段取绘制窗口中点；
 * 窗口外段插值越界 → 用最近端点状态做二体推进近似（与绘制同口径），仅供相机对准。
 */
export function getEphemManLocatePoint(idx: number, out: THREE.Vector3): boolean {
  if (!currentSet?.states.length) return false
  const seg = currentSet.maneuvers?.[idx]
  if (!seg) return false
  const high = manHighlights.find((h) => h.origIdx === idx)
  const mid = high ? high.midMs : (seg.t0 + seg.t1) / 2
  const st = interpolateAt(currentSet.states, mid)
  if (st) {
    out.copy(eciToScene(st.r[0], st.r[1], st.r[2]))
    return true
  }
  const s0 = currentSet.states[0]
  const sN = currentSet.states[currentSet.states.length - 1]
  const base = mid < s0.t ? s0 : sN
  const prop = twoBodyPropagate(base.r, base.v, (mid - base.t) / 1000)
  if (!prop) return false
  out.copy(eciToScene(prop.r[0], prop.r[1], prop.r[2]))
  return true
}

function replaceOrbitLine(g: THREE.Group, pts: THREE.Vector3[]) {
  if (orbitLine) {
    g.remove(orbitLine)
    disposeLine(orbitLine)
    orbitLine = null
  }
  orbitLine = makeLine(pts, EPH_ORBIT_COLOR, 0.68)
  if (orbitLine) g.add(orbitLine)
}

/** 当前已绘制的 MAN 高亮（含窗口外二体推进段）；供面板卡片定位与选中恢复 */
export function getEphemManHighlights(): EphemManHighlight[] {
  return manHighlights.slice()
}


export function setEphemOrbit(scene: THREE.Scene | null, set: EphemSet | null): void {
  if (!scene) {
    clearEphemOrbit()
    return
  }
  // 换星历（或清空）时取消卡片选中态；同一份星历重绘（机动脉冲叠加等）则保留
  if (currentSet !== set) selectedManIdx = null
  const g = ensureGroup(scene)
  if (orbitLine) {
    g.remove(orbitLine)
    disposeLine(orbitLine)
    orbitLine = null
  }
  clearManObjects()
  if (impulseLine) {
    g.remove(impulseLine)
    disposeLine(impulseLine)
    impulseLine = null
  }
  if (burnMarker) {
    g.remove(burnMarker)
    burnMarker.geometry.dispose()
    ;(burnMarker.material as THREE.Material).dispose()
    burnMarker = null
  }
  currentSet = set
  currentImpulse = null
  currentBurnMs = null

  if (!set || !set.states.length) {
    markerModelSeq++
    disposeMarkerModel()
    if (marker) marker.visible = false
    return
  }

  replaceOrbitLine(g, buildPts(set.states))
  paintManSegments(g, set)

  if (!marker) {
    marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 12, 12),
      new THREE.MeshBasicMaterial({ color: EPH_MARKER_COLOR, depthTest: true, depthWrite: false })
    )
    g.add(marker)
  }
  marker.visible = true
  // 有可画 MAN 时，本星标落在首个机动中点，方便找到琥珀段
  const focusMs = manHighlights[0]?.midMs ?? set.states[0].t
  const st = interpolateAt(set.states, focusMs) || set.states[0]
  marker.position.copy(eciToScene(st.r[0], st.r[1], st.r[2]))
  // t204u: 星历目标 3D 模型化——按名称/NORAD 加载共享模型；就绪前浅蓝球兜底显示
  disposeMarkerModel()
  refreshMarkerModel(set)
}

export function setEphemManeuver(
  scene: THREE.Scene | null,
  states: EphemState[] | null,
  burnMs: number | null
): void {
  if (!scene || !group) {
    currentImpulse = states
    currentBurnMs = burnMs
    return
  }
  if (impulseLine) {
    group.remove(impulseLine)
    disposeLine(impulseLine)
    impulseLine = null
  }
  if (burnMarker) {
    group.remove(burnMarker)
    burnMarker.geometry.dispose()
    ;(burnMarker.material as THREE.Material).dispose()
    burnMarker = null
  }
  currentImpulse = states
  currentBurnMs = burnMs
  if (!states?.length || burnMs == null) return

  let lo = 0
  let hi = states.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (states[mid].t < burnMs) lo = mid + 1
    else hi = mid
  }
  const tail = states.slice(Math.max(0, lo - 1))
  const pts = buildPts(tail)
  impulseLine = makeLine(pts, EPH_MANEUVER_COLOR, 0.92)
  if (impulseLine) group.add(impulseLine)

  const burn = interpolateAt(states, burnMs)
  if (burn) {
    burnMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.01, 12, 12),
      new THREE.MeshBasicMaterial({ color: EPH_BURN_COLOR })
    )
    burnMarker.position.copy(eciToScene(burn.r[0], burn.r[1], burn.r[2]))
    group.add(burnMarker)
  }
}

/** Copy current cyan marker world pos; false if no visible marker. */
export function getEphemMarkerPosition(out: THREE.Vector3): boolean {
  if (!marker) return false
  // 模型替代球显示时（visible=false）位置仍随帧更新，跟踪照常
  if (!marker.visible && !markerModel) return false
  out.copy(marker.position)
  return true
}

/** Scene-space position of the ephem at simMs (interpolated); does not require marker. */
export function getEphemPositionAt(simMs: number, out: THREE.Vector3): boolean {
  if (!currentSet?.states.length) return false
  const src =
    currentImpulse && currentBurnMs != null && simMs >= currentBurnMs
      ? currentImpulse
      : currentSet.states
  const st = interpolateAt(src, simMs) || interpolateAt(currentSet.states, simMs)
  if (!st) return false
  out.copy(eciToScene(st.r[0], st.r[1], st.r[2]))
  return true
}

/**
 * Overlay label for track reticle.
 * Prefer object name; never rewrite a name whose numeric suffix != norad into "NORAD xxx".
 */
export function ephemDisplayLabel(set: EphemSet | null | undefined): string {
  if (!set) return ""
  const name = (set.name || "").trim()
  const norad = set.norad
  if (!name) return norad ? String(norad) : "Ephemeris"
  // Name suffix like FOO-12345 where 12345 != norad: keep the name (do not substitute NORAD)
  const m = /-(\d{3,})$/.exec(name)
  if (m && norad && Number(m[1]) !== norad) return name
  return name
}

export function updateEphemOrbitMarker(simMs: number): void {
  if (!currentSet?.states.length) return
  if (!marker && !markerModel) return
  const src =
    currentImpulse && currentBurnMs != null && simMs >= currentBurnMs
      ? currentImpulse
      : currentSet.states
  const st = interpolateAt(src, simMs) || interpolateAt(currentSet.states, simMs)
  if (!st) return
  const pos = eciToScene(st.r[0], st.r[1], st.r[2])
  if (marker) marker.position.copy(pos)
  if (markerModel) syncMarkerModelPose(st, pos)
}

export function clearEphemOrbit(): void {
  // 先摘除星历模型（克隆材质自释放），避免 group 级 dispose 误伤共享模型几何（目标云仍在用）
  markerModelSeq++
  disposeMarkerModel()
  if (group && attachedScene) attachedScene.remove(group)
  if (group) disposeObject(group)
  group = null
  orbitLine = null
  manObjects = []
  manOrigIdx = []
  manHighlights = []
  selectedManIdx = null
  impulseLine = null
  marker = null
  markerModelSeq++
  markerModel = null
  burnMarker = null
  attachedScene = null
  currentSet = null
  currentImpulse = null
  currentBurnMs = null
}

export function hasEphemOrbit(): boolean {
  return !!currentSet
}

export function ephemOrbitDiag(): {
  points: number
  mans: number
  drawableMans: number
  spanDays: number
  highlights: EphemManHighlight[]
} | null {
  if (!currentSet?.states.length) return null
  const n = currentSet.states.length
  const span = (currentSet.states[n - 1].t - currentSet.states[0].t) / 86400000
  return {
    points: n,
    mans: (currentSet.maneuvers || []).length,
    drawableMans: manHighlights.length,
    spanDays: span,
    highlights: manHighlights.slice()
  }
}
