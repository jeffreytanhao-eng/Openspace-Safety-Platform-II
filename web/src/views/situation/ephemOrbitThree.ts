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
import { eciToScene, KM_TO_SCENE, uncLegend, uncScale, uncSigmaN, uncVisible } from './scene'
import { interpolateAt } from './ephem/interp'
import { twoBodyPropagate } from './ephem/screening'
import { resolveCatalogModelKey, loadSharedModelGeom } from './catalogCloudThree'
import type { EphemManSegment, EphemSet, EphemState, UncertaintySample, Vec3 } from './ephem/types'
import { accToEci, manChevronCount, manSignificantAxisAccs, manSpeedSense } from './ephem/maneuverDisplay'
import { samplesAlongTrack, tubeSliceProfile, TUBE_STATIONS, TUBE_STATIONS_LOW, UNC_COLOR } from './ephem/uncertainty'

export const EPH_ORBIT_COLOR = 0x81d4fa
export const EPH_MANEUVER_COLOR = 0xffb454
/** 星历目标标识色：更偏蓝（比轨道线的浅天蓝更深更蓝，明显区分） */
export const EPH_MARKER_COLOR = 0x3b82f6
/** 选中星历 3D 模型机身色：深蓝（贴图乘色，保留模型中间的结构框线） */
export const EPH_MARKER_BODY_COLOR = 0x12356e
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
/** Selected-maneuver thrust marks: small blue ">" chevrons along the burn (file NTW/RTN acc). */
let manThrustArrows: THREE.LineSegments | null = null
/** Saturated blue ">" chevrons along the selected burn (gold tube stays #ffd166). */
const EPH_THRUST_ARROW_COLOR = 0x3b9eff
/** Two-stroke chevron arm length / half-width in km. Compact ">" , tighter than the old 14/6 ticks. */
const CHEVRON_ARM_KM = 7
const CHEVRON_HALF_KM = 3.2
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

function clearManThrustArrow() {
  if (!manThrustArrows) return
  if (group) group.remove(manThrustArrows)
  manThrustArrows.geometry.dispose()
  ;(manThrustArrows.material as THREE.Material).dispose()
  manThrustArrows = null
}

function manStateAt(set: EphemSet, t: number): { r: Vec3; v: Vec3 } | null {
  const st = interpolateAt(set.states, t)
  if (st) return { r: st.r, v: st.v }
  if (!set.states.length) return null
  const s0 = set.states[0]
  const sN = set.states[set.states.length - 1]
  const base = t < s0.t ? s0 : sN
  const prop = twoBodyPropagate(base.r, base.v, (t - base.t) / 1000)
  if (!prop) return null
  return { r: prop.r, v: prop.v }
}

const _thrPerp = new THREE.Vector3()
const _thrTip = new THREE.Vector3()
const _thrLeft = new THREE.Vector3()
const _thrRight = new THREE.Vector3()
const _thrBase = new THREE.Vector3()

/** Two-stroke ">" chevron: tip in the thrust direction, arms only (no shaft). Sits just outside the tube. */
function appendChevron(
  positions: number[],
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  armLen: number,
  halfW: number
): void {
  _thrBase.copy(origin)
  const rLen = origin.length()
  if (rLen > 1e-9) _thrBase.addScaledVector(origin, (MAN_TUBE_RADIUS + 0.0008) / rLen)
  const along = Math.sqrt(Math.max(0, armLen * armLen - halfW * halfW))
  _thrTip.copy(_thrBase).addScaledVector(dir, along)
  _thrPerp.crossVectors(dir, origin)
  if (_thrPerp.lengthSq() < 1e-12) {
    if (Math.abs(dir.y) < 0.9) _thrPerp.set(0, 1, 0).cross(dir)
    else _thrPerp.set(1, 0, 0).cross(dir)
  }
  _thrPerp.normalize()
  _thrLeft.copy(_thrTip).addScaledVector(dir, -along).addScaledVector(_thrPerp, halfW)
  _thrRight.copy(_thrTip).addScaledVector(dir, -along).addScaledVector(_thrPerp, -halfW)
  positions.push(
    _thrLeft.x, _thrLeft.y, _thrLeft.z, _thrTip.x, _thrTip.y, _thrTip.z,
    _thrRight.x, _thrRight.y, _thrRight.z, _thrTip.x, _thrTip.y, _thrTip.z
  )
}

function clearManObjects() {
  clearManThrustArrow()
  for (const obj of manObjects) {
    if (group) group.remove(obj)
    disposeObject(obj)
  }
  manObjects = []
  manOrigIdx = []
  manHighlights = []
}

/** Scene-space unit direction of a 1 km ECI tip from r. */
function eciHatToSceneDir(r: Vec3, hat: Vec3, origin: THREE.Vector3, dir: THREE.Vector3): number {
  origin.copy(eciToScene(r[0], r[1], r[2]))
  dir.copy(eciToScene(r[0] + hat[0], r[1] + hat[1], r[2] + hat[2])).sub(origin)
  const km = dir.length()
  if (km < 1e-12) return 0
  dir.multiplyScalar(1 / km)
  return km
}

function eciUnit(vec: Vec3): Vec3 | null {
  const mag = Math.hypot(vec[0], vec[1], vec[2])
  if (!(mag > 0)) return null
  return [vec[0] / mag, vec[1] / mag, vec[2] / mag]
}

/**
 * Stream of small blue ">" chevrons along the selected MAN burn.
 * Each glyph is oriented along one significant file-frame Δv axis (with sign).
 * Multi-axis burns interleave orientations along the tube (T, W, T, W, …);
 * density still follows manChevronCount (加速 dense / 减速 sparse).
 * If acc is missing, chevrons fall back to +T (along-track); no N/W is invented.
 */
function updateManThrustArrow(): void {
  clearManThrustArrow()
  if (selectedManIdx == null || !currentSet?.states.length || !group) return
  const seg = currentSet.maneuvers?.[selectedManIdx]
  if (!seg) return
  const high = manHighlights.find((h) => h.origIdx === selectedManIdx)
  const tStart = high ? high.draw0 : seg.t0
  const tEnd = high ? high.draw1 : seg.t1
  const midSv = manStateAt(currentSet, (tStart + tEnd) / 2)
  const sense = midSv && seg.acc ? manSpeedSense(midSv.r, midSv.v, seg.acc, seg.refFrame) : null
  const axisAccs = seg.acc ? manSignificantAxisAccs(seg) : null
  const axisCount = axisAccs && axisAccs.length ? axisAccs.length : 1
  const n = Math.max(manChevronCount(tEnd - tStart, sense), axisCount)
  const positions: number[] = []
  const dir = new THREE.Vector3()
  const origin = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (tStart + tEnd) / 2 : tStart + ((i + 0.5) / n) * (tEnd - tStart)
    const sv = manStateAt(currentSet, t)
    if (!sv) continue
    let hat: Vec3 | null = null
    if (axisAccs && axisAccs.length) {
      const accEci = accToEci(sv.r, sv.v, axisAccs[i % axisAccs.length], seg.refFrame)
      hat = accEci ? eciUnit(accEci) : null
    } else {
      // Acc missing: along-track only (+T / velocity). Do not invent N/W components.
      hat = eciUnit(sv.v)
    }
    if (!hat) continue
    const km = eciHatToSceneDir(sv.r, hat, origin, dir)
    if (!km) continue
    appendChevron(positions, origin, dir, CHEVRON_ARM_KM * km, CHEVRON_HALF_KM * km)
  }
  if (positions.length < 6) return
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  manThrustArrows = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: EPH_THRUST_ARROW_COLOR,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false
    })
  )
  manThrustArrows.frustumCulled = false
  manThrustArrows.renderOrder = 4
  group.add(manThrustArrows)
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

/** 移除星历模型（geometry 归共享缓存不 dispose；材质与结构边线为本地实例需释放） */
function disposeMarkerModel(): void {
  if (!markerModel) return
  if (group) group.remove(markerModel)
  for (const ch of markerModel.children) {
    const lm = ch as THREE.LineSegments
    lm.geometry?.dispose()
    const cms = lm.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(cms)) cms.forEach((x) => x.dispose())
    else cms?.dispose()
  }
  markerModel.clear()
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
    // 选中星历目标：深蓝机身。乘色（而非替换贴图）以保留模型纹理与结构框线；
    // 自发光压在较低强度，避免整体发白把内部线条糊掉。
    mat.color = new THREE.Color(EPH_MARKER_BODY_COLOR)
    mat.emissive = new THREE.Color(EPH_MARKER_COLOR)
    mat.emissiveIntensity = 0.3
    // 轨道线/MAN 管都是透明材质（后绘制）→ 不透明模型会被轨道线盖住。
    // 把模型也转入透明队列，renderOrder 3 > 机动管 2 > 不确定度管 1 > 轨道线 0 → 模型绘制在轨道图层之上。
    // depthWrite stays on so a stretch of 1σ under the model is occluded naturally.
    mat.transparent = true
    mat.depthTest = true
    mat.depthWrite = true
    markerModel = new THREE.Mesh(gm.geom, mat)
    markerModel.frustumCulled = false
    markerModel.renderOrder = 3
    // 深蓝机身容易糊成一块：叠一层浅蓝结构边线，让中间的框线/棱线清楚可见
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(gm.geom, 28),
      new THREE.LineBasicMaterial({ color: 0x8fc2ff, transparent: true, opacity: 0.9, depthWrite: false })
    )
    edges.renderOrder = 4
    markerModel.add(edges)
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

/** 把选中态刷到 MAN 管道材质：选中段亮金 #ffd166（整段含烧蚀区间），其余恢复常规琥珀 */
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
  updateManThrustArrow()
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
    disposeUncertainty()
    return
  }

  replaceOrbitLine(g, buildPts(set.states))
  paintManSegments(g, set)

  if (!marker) {
    marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 12, 12),
      new THREE.MeshBasicMaterial({ color: EPH_MARKER_COLOR, depthTest: true, depthWrite: true })
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
  // Marker first so click-to-track can resolve a position even if the tube throws.
  try {
    setupUncertainty(g, set)
  } catch (e) {
    console.warn('[situation] uncertainty tube', e)
  }
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

/** Prefer the live marker, then interpolated currentSet, then the provided set (for first-activation races). */
export function getEphemTrackPosition(simMs: number, out: THREE.Vector3, set?: EphemSet | null): boolean {
  if (getEphemMarkerPosition(out)) return true
  if (getEphemPositionAt(simMs, out)) return true
  const src = set ?? currentSet
  if (!src?.states.length) return false
  const st =
    interpolateAt(src.states, simMs) ||
    (simMs <= src.states[0].t ? src.states[0] : src.states[src.states.length - 1])
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
  const src =
    currentImpulse && currentBurnMs != null && simMs >= currentBurnMs
      ? currentImpulse
      : currentSet.states
  const st = interpolateAt(src, simMs) || interpolateAt(currentSet.states, simMs)
  if (!st) return
  const pos = eciToScene(st.r[0], st.r[1], st.r[2])
  if (marker) marker.position.copy(pos)
  if (markerModel) syncMarkerModelPose(st, pos)
  // Tube is a 20x-display-scale sweep of the whole ephemeris; not rebuilt every frame.
}

export function clearEphemOrbit(): void {
  // 先摘除星历模型（克隆材质自释放），避免 group 级 dispose 误伤共享模型几何（目标云仍在用）
  markerModelSeq++
  disposeMarkerModel()
  disposeUncertainty()
  if (group && attachedScene) attachedScene.remove(group)
  if (group) disposeObject(group)
  group = null
  orbitLine = null
  manObjects = []
  manOrigIdx = []
  manHighlights = []
  selectedManIdx = null
  manThrustArrows = null
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


/* ---------------- Position uncertainty ellipsoids (selected orbit) ---------------- */
/* Translucent violet tube only (no wire/dashes) along the WHOLE ephemeris track.
 * renderOrder 1 is under MAN tubes (2), the 3D sat model (3), and chevrons (4).
 * depthTest is on so Earth and the opaque model occlude; a stretch hidden by
 * the model is expected. Fill does not write depth, so translucent shells do not fight.
 * At close range (camera within a few tube radii of the track) the fill fades out,
 * otherwise the wall fills the screen and reads as a violet slab detached from the line. */

const UNC_FILL_OPACITY = 0.26
const UNC_FILL_OPACITY_LOW = 0.16
/** Fade band in units of the tube radius: full above OUT, gone below IN. */
const UNC_FADE_OUT_RADII = 10
const UNC_FADE_IN_RADII = 3
const UNC_FADE_MIN_OPACITY = 0.05
/** Under 3D models (3) and maneuver tubes (2); above the cyan orbit line (0). */
const UNC_RENDER_ORDER = 1
const UNC_RADIAL = 12
const UNC_RADIAL_LOW = 8

let uncGroup: THREE.Group | null = null
let uncFill: THREE.Mesh | null = null
let uncFillMat: THREE.MeshBasicMaterial | null = null
let lastUncVisible = true
let lastUncKey = ''
/** Tube axis points (scene) with the local section radius, for the close-range fade. */
let uncAxisPts: { p: THREE.Vector3; r: number }[] = []
let uncBaseOpacity = UNC_FILL_OPACITY

function isLowEnd(): boolean {
  if (typeof navigator === 'undefined') return false
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return mem != null && mem <= 4
}

function eciVecToScene(v: [number, number, number]): THREE.Vector3 {
  return eciToScene(v[0], v[1], v[2])
}

function disposeUncertainty(): void {
  if (uncGroup && uncGroup.parent) uncGroup.parent.remove(uncGroup)
  if (uncFill) {
    uncFill.geometry.dispose()
    uncFill = null
  }
  uncFillMat?.dispose()
  uncFillMat = null
  uncGroup = null
  lastUncKey = ''
  uncAxisPts = []
  uncLegend.value = { source: null, exaggerated: false, scale: uncScale.value, maxSigmaKm: 0 }
}

/**
 * Per-frame view hook: fades the fill out when the camera gets within a few tube
 * radii of the track. Tube world size still does not depend on zoom or view height.
 */
export function setUncertaintyView(cam?: THREE.Camera | null, _viewHeightPx?: number): void {
  if (!cam || !uncFillMat || !uncFill || !uncFill.visible) return
  if (!uncAxisPts.length) {
    uncFillMat.opacity = uncBaseOpacity
    return
  }
  const p = cam.position
  let minD2 = Infinity
  let localR = 0
  for (const a of uncAxisPts) {
    const d = p.distanceToSquared(a.p)
    if (d < minD2) {
      minD2 = d
      localR = a.r
    }
  }
  if (!(localR > 0)) {
    uncFillMat.opacity = uncBaseOpacity
    return
  }
  const lo = UNC_FADE_IN_RADII * localR
  const hi = UNC_FADE_OUT_RADII * localR
  const t = hi > lo ? Math.min(1, Math.max(0, (Math.sqrt(minD2) - lo) / (hi - lo))) : 1
  const fade = UNC_FADE_MIN_OPACITY + (1 - UNC_FADE_MIN_OPACITY) * t * t * (3 - 2 * t)
  uncFillMat.opacity = uncBaseOpacity * fade
}

/** 单位倍率（n = 1）下的一个截面：环心、长短轴方向与半轴（scene 单位）。 */
interface TubeStation {
  p: THREE.Vector3
  major: THREE.Vector3
  minor: THREE.Vector3
  /** 长半轴（scene）——1σ、1× 下的真实值 */
  a: number
  /** 短半轴（scene） */
  b: number
}

let tubeCacheSet: EphemSet | null = null
let tubeCacheKey = ''
let tubeCacheStations: TubeStation[] = []
let tubeCacheMaxSigmaKm = 0

/**
 * 逐站截面只取决于星历文件（位置 + 逐历元 6×6 协方差）与轨道几何，
 * 与 1σ/3σ、放大倍率无关（倍率只把长短轴线性放大），因此缓存下来：
 * 切换倍率时只需重写顶点数组，不必重算协方差特征分解与平行传输。
 */
function buildTubeStations(set: EphemSet, low: boolean): TubeStation[] {
  const stations = samplesAlongTrack(set, low ? TUBE_STATIONS_LOW : TUBE_STATIONS)
  const key = `${set.id}|${set.states.length}|${stations.length}|${low ? 1 : 0}`
  if (tubeCacheSet === set && tubeCacheKey === key) return tubeCacheStations
  const out: TubeStation[] = []
  let prevN: Vec3 | null = null
  let prevMajor: THREE.Vector3 | null = null
  let maxSigmaKm = 0
  for (const st of stations) {
    maxSigmaKm = Math.max(maxSigmaKm, st.sample.sigmaKm[0], st.sample.sigmaKm[1], st.sample.sigmaKm[2])
    // (N, B) 平行传输，截面基底不会逐站翻转；此处先按 n = 1 求单位截面。
    const slice = tubeSliceProfile(st.sample.sigmaKm, st.sample.axesEci, st.tangentEci, 1, prevN, 1)
    prevN = slice.normal
    const { m00, m01, m11 } = slice
    const half = (m00 + m11) / 2
    const disc = Math.sqrt(Math.max(0, ((m00 - m11) / 2) ** 2 + m01 * m01))
    // 半轴 = 1/√λ：长半轴对应较小特征值。km → scene。
    const a = (1 / Math.sqrt(Math.max(1e-24, half - disc))) * KM_TO_SCENE
    const b = (1 / Math.sqrt(Math.max(1e-24, half + disc))) * KM_TO_SCENE
    // 长轴方向（(N,B) 坐标下）。截面常是 15:1 量级的扁椭圆，等角度极径采样
    // 会整段漏掉长轴尖端（实测环半径只剩应有值的 ~1/5）；按主轴生成椭圆，
    // 长短轴端点必然落在顶点上。
    let vn: number
    let vb: number
    if (Math.abs(m01) > 1e-18) {
      const nn = Math.hypot(m01, half - disc - m00) || 1
      vn = m01 / nn
      vb = (half - disc - m00) / nn
    } else if (m00 <= m11) {
      vn = 1
      vb = 0
    } else {
      vn = 0
      vb = 1
    }
    const Ns = eciVecToScene(slice.normal)
    Ns.normalize()
    const Bs = eciVecToScene(slice.binormal)
    Bs.normalize()
    const major = new THREE.Vector3().addScaledVector(Ns, vn).addScaledVector(Bs, vb).normalize()
    const minor = new THREE.Vector3().addScaledVector(Ns, -vb).addScaledVector(Bs, vn).normalize()
    // 主轴方向有 ± 二义性：与上一站同向，否则相邻环之间会扭 180°。
    if (prevMajor && major.dot(prevMajor) < 0) {
      major.negate()
      minor.negate()
    }
    prevMajor = major
    out.push({ p: eciVecToScene(st.sample.r), major, minor, a, b })
  }
  tubeCacheSet = set
  tubeCacheKey = key
  tubeCacheStations = out
  tubeCacheMaxSigmaKm = maxSigmaKm
  return out
}

function buildTubeGeometry(
  set: EphemSet,
  nSigma: 1 | 3,
  scale: number
): { fill: THREE.BufferGeometry; maxSigmaKm: number; axisPts: { p: THREE.Vector3; r: number }[] } | null {
  const low = isLowEnd()
  const stations = buildTubeStations(set, low)
  if (stations.length < 2) return null
  const radial = low ? UNC_RADIAL_LOW : UNC_RADIAL
  // 1σ/3σ 与显示倍率都只把长短轴按倍数放大，截面形状与轨道位置不变。
  const n = Math.max(1e-6, nSigma * scale)
  const nStations = stations.length
  const pos: number[] = []
  const indices: number[] = []
  for (let i = 0; i < nStations; i++) {
    const st = stations[i]
    const c = st.p
    const A = st.a * n
    const B = st.b * n
    for (let k = 0; k < radial; k++) {
      const th = (k / radial) * Math.PI * 2
      // 椭圆参数角：t = 0 落在长轴端点，t = π/2 落在短轴端点。
      const ca = Math.cos(th) * A
      const sb = Math.sin(th) * B
      pos.push(
        c.x + st.major.x * ca + st.minor.x * sb,
        c.y + st.major.y * ca + st.minor.y * sb,
        c.z + st.major.z * ca + st.minor.z * sb
      )
    }
  }
  for (let i = 0; i < nStations - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial
      const i0 = i * radial + k
      const i1 = i * radial + k2
      const j0 = (i + 1) * radial + k
      const j1 = (i + 1) * radial + k2
      indices.push(i0, j0, i1, i1, j0, j1)
    }
  }
  const fill = new THREE.BufferGeometry()
  fill.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  fill.setIndex(indices)
  // Every station so the close-range fade triggers anywhere on the track.
  const axisPts: { p: THREE.Vector3; r: number }[] = []
  for (let i = 0; i < nStations; i++) axisPts.push({ p: stations[i].p, r: stations[i].a * n })
  return {
    fill,
    maxSigmaKm: Math.max(tubeCacheMaxSigmaKm, set.uncertainty?.maxSigmaKm ?? 0),
    axisPts
  }
}

function setupUncertainty(parent: THREE.Group, set: EphemSet): void {
  disposeUncertainty()
  uncGroup = new THREE.Group()
  uncGroup.name = 'ephem-uncertainty'
  parent.add(uncGroup)
  updateUncertaintyTube()
}

function updateUncertaintyTube(): void {
  if (!currentSet?.states.length || !uncGroup) return
  const visible = uncVisible.value
  const nSigma = uncSigmaN.value
  const scale = uncScale.value
  const source = currentSet.uncertainty?.source ?? (currentSet.hasCov ? 'file' : 'age')
  if (!visible) {
    if (uncGroup) uncGroup.visible = false
    if (lastUncVisible) {
      lastUncVisible = false
      uncLegend.value = {
        source,
        exaggerated: false,
        scale,
        maxSigmaKm: currentSet.uncertainty?.maxSigmaKm ?? 0
      }
    }
    return
  }
  lastUncVisible = true
  const key = `${currentSet.id}|${nSigma}|${scale}|${source}|${currentSet.uncertainty?.samples.length ?? 0}`
  if (key !== lastUncKey || !uncFill) {
    lastUncKey = key
    if (uncFill) {
      uncGroup.remove(uncFill)
      uncFill.geometry.dispose()
      uncFill = null
    }
    const built = buildTubeGeometry(currentSet, nSigma, scale)
    if (!built) {
      uncLegend.value = { source, exaggerated: false, scale, maxSigmaKm: currentSet.uncertainty?.maxSigmaKm ?? 0 }
      return
    }
    uncAxisPts = built.axisPts
    uncBaseOpacity = isLowEnd() ? UNC_FILL_OPACITY_LOW : UNC_FILL_OPACITY
    if (!uncFillMat) {
      uncFillMat = new THREE.MeshBasicMaterial({
        color: UNC_COLOR,
        transparent: true,
        opacity: uncBaseOpacity,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide
      })
    } else {
      uncFillMat.color.setHex(UNC_COLOR)
      uncFillMat.opacity = uncBaseOpacity
    }
    uncFill = new THREE.Mesh(built.fill, uncFillMat)
    uncFill.renderOrder = UNC_RENDER_ORDER
    uncFill.frustumCulled = false
    uncGroup.add(uncFill)
    uncLegend.value = {
      source,
      exaggerated: scale > 1,
      scale,
      maxSigmaKm: built.maxSigmaKm
    }
  }
  uncGroup.visible = true
}

/** Rebuild the tube (settings changed). Kept `simMs`-tolerant for existing call sites. */
export function refreshUncertaintyNow(_simMs?: number): void {
  if (!currentSet) return
  updateUncertaintyTube()
}

/** Single write path used by the ephemeris panel: set scene refs and rebuild/show the tube. */
export function applyUncertaintyDisplay(visible: boolean, nSigma?: 1 | 3): void {
  uncVisible.value = !!visible
  if (nSigma === 1 || nSigma === 3) uncSigmaN.value = nSigma
  refreshUncertaintyNow()
}

/** Change the 1σ cross-section magnification (1× / 5× / 20×) and rebuild the tube in place. */
export function applyUncertaintyScale(scale: 1 | 5 | 20): void {
  if (uncScale.value === scale) return
  uncScale.value = scale
  refreshUncertaintyNow()
}

