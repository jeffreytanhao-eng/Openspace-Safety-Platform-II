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
import { eciToScene } from './scene'
import { twoBodyPropagate } from './ephem/screening'
import { useCatalog } from '@/composables/useCatalog'

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
}

/** 分级视觉：基础半径（场景单位）+ 颜色 */
const LEVEL_STYLE: Record<EventCloudItem['level'], { r: number; color: number }> = {
  red: { r: 0.016, color: 0xff4545 },
  orange: { r: 0.012, color: 0xff9430 },
  yellow: { r: 0.009, color: 0xffd23c }
}
/** 透明度：|dt| ≤ NEAR 全亮，线性衰减到 FAR 外的 DIM */
const NEAR_MS = 3600_000
const FAR_MS = 86_400_000 * 3
const DIM_OPACITY = 0.3
/** 选中环 */
const RING_SIZE = 0.05

let group: THREE.Group | null = null
let items: (EventCloudItem & { pos: THREE.Vector3 })[] = []
let sprites: THREE.Sprite[] = []
let ring: THREE.Sprite | null = null
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

/**
 * 组装带锚点的事件集：双方编目位置几何中心（缺一用另一方，全缺丢弃）。
 * 返回附带 pos 的条目数组与被丢弃数量。
 */
export function buildEventCloudItems(
  raw: EventCloudItem[]
): { items: (EventCloudItem & { pos: THREE.Vector3 })[]; skipped: number } {
  const out: (EventCloudItem & { pos: THREE.Vector3 })[] = []
  let skipped = 0
  for (const ev of raw) {
    const a = propagateNorad(ev.noradA, ev.tcaMs)
    const b = ev.noradB !== ev.noradA ? propagateNorad(ev.noradB, ev.tcaMs) : null
    let r: [number, number, number] | null = null
    if (a && b) r = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    else r = a ?? b
    if (!r) {
      skipped++
      continue
    }
    out.push({ ...ev, pos: eciToScene(r[0], r[1], r[2]) })
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
    const k = dt <= NEAR_MS ? 1 : Math.max(DIM_OPACITY, 1 - ((dt - NEAR_MS) / (FAR_MS - NEAR_MS)) * 0.7)
    const mat = sprites[i].material as THREE.SpriteMaterial
    mat.opacity = k
  }
}

/** 选中高亮：白环锚在事件云位置；key=null 取消 */
export function setEventCloudSelected(key: string | null): void {
  if (!ring) return
  const it = key ? items.find((x) => x.key === key) : null
  if (!it) {
    ring.visible = false
    return
  }
  ring.position.copy(it.pos)
  ring.visible = true
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
