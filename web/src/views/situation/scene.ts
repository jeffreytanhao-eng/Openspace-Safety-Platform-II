/**
 * 态势主场景共享常量与状态
 *
 * 包含 3D 地球外壳所需的坐标换算、颜色常量、仿真时钟状态，
 * 以及右侧「星历分析」面板共用的开关、抽屉高度与拖拽逻辑。
 */
import { reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import { gstime } from 'satellite.js'

/* ---------------- 坐标 / 尺度 ---------------- */

export const EARTH_RADIUS_KM = 6371
export const EARTH_R = 1
export const KM_TO_SCENE = EARTH_R / EARTH_RADIUS_KM
export const BASE = import.meta.env.BASE_URL || '/'

const WGS84_A_KM = 6378.137
const WGS84_B_KM = 6356.7523142

/** 当地 WGS84 地心半径（km），用于把经纬度落在地球椭球表面 */
export function wgs84RadiusKm(latRad: number): number {
  const a2 = WGS84_A_KM * WGS84_A_KM
  const b2 = WGS84_B_KM * WGS84_B_KM
  const c = Math.cos(latRad)
  const s = Math.sin(latRad)
  return Math.sqrt((a2 * a2 * c * c + b2 * b2 * s * s) / (a2 * c * c + b2 * s * s))
}

/** 经纬度（度）→ 场景坐标（ECEF 轴映射口径：scene = (x, z, -y)） */
export function lonLatToScene(lon: number, lat: number, r: number): THREE.Vector3 {
  const lonRad = (lon * Math.PI) / 180
  const latRad = (lat * Math.PI) / 180
  const cosLat = Math.cos(latRad)
  const k = (r * wgs84RadiusKm(latRad)) / EARTH_RADIUS_KM
  return new THREE.Vector3(k * cosLat * Math.cos(lonRad), k * Math.sin(latRad), -k * cosLat * Math.sin(lonRad))
}

/** ECI（km）→ 场景坐标（1 场景单位 = 6371 km） */
export function eciToScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x * KM_TO_SCENE, z * KM_TO_SCENE, -y * KM_TO_SCENE)
}

/* ---------------- 初始机位（武汉） ---------------- */

export const HOME_LON = 114.3
export const HOME_LAT = 30.6
/** 初始/复位机位距地心距离（地球半径 = 1） */
export const HOME_CAM_DIST = 4.5

/** 当前时刻该地表点在场景世界坐标中的方向（含地球自转相位） */
export function homeDirection(simTimeMs: number): THREE.Vector3 {
  const local = lonLatToScene(HOME_LON, HOME_LAT, 1)
  const rotY = gstime(new Date(simTimeMs))
  const c = Math.cos(rotY)
  const s = Math.sin(rotY)
  return new THREE.Vector3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c)
}

/* ---------------- 太阳 / 月亮方向 ---------------- */

/** 太阳在 ECI 的单位方向向量（低精度公式，与全球晨昏线口径一致） */
export function sunDirection(date: Date): THREE.Vector3 {
  const jd = date.getTime() / 86400000 - 10957.5
  const L = (((280.46 + 0.9856474 * jd) % 360) * Math.PI) / 180
  const g = (((357.528 + 0.9856003 * jd) % 360) * Math.PI) / 180
  const lambda = L + ((1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI) / 180
  const eps = ((23.439 - 0.0000004 * jd) * Math.PI) / 180
  return new THREE.Vector3(
    Math.cos(lambda),
    Math.cos(eps) * Math.sin(lambda),
    Math.sin(eps) * Math.sin(lambda)
  ).normalize()
}

/** 月亮在 ECI 的单位方向向量与地心距（仅供三维标记显示） */
export function moonDirection(date: Date): { dir: THREE.Vector3; distKm: number } {
  const jd = date.getTime() / 86400000 - 10957.5
  const T = jd / 36525
  const rad = Math.PI / 180
  const Lp = 218.316 + 481267.881 * T
  const D = 297.85 + 445267.112 * T
  const M = 357.529 + 35999.05 * T
  const Mp = 134.963 + 477198.867 * T
  const F = 93.272 + 483202.018 * T
  const sin = (deg: number) => Math.sin(deg * rad)
  const cos = (deg: number) => Math.cos(deg * rad)
  const lon = Lp + 6.289 * sin(Mp) - 1.274 * sin(Mp - 2 * D) + 0.658 * sin(2 * D)
    + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F)
  const lat = 5.128 * sin(F) + 0.281 * sin(Mp + F) - 0.278 * sin(F - Mp)
    - 0.173 * sin(F - 2 * D)
  const par = 0.9508 + 0.0518 * cos(Mp) + 0.0095 * cos(Mp - 2 * D)
    + 0.0078 * cos(2 * D) + 0.0028 * cos(2 * Mp)
  const distKm = 6378.14 / Math.sin(par * rad)
  const lr = lon * rad
  const br = lat * rad
  const eps = (23.439 - 0.0000004 * jd) * rad
  return {
    dir: new THREE.Vector3(
      Math.cos(br) * Math.cos(lr),
      Math.cos(eps) * Math.cos(br) * Math.sin(lr) - Math.sin(eps) * Math.sin(br),
      Math.sin(eps) * Math.cos(br) * Math.sin(lr) + Math.cos(eps) * Math.sin(br)
    ).normalize(),
    distKm
  }
}

/* ---------------- 类型 ---------------- */

export const TYPE_COLOR: Record<string, number> = {
  PAYLOAD: 0x4caf50,
  DEBRIS: 0xff4d4f,
  'ROCKET BODY': 0xff9800,
  UNKNOWN: 0xffffff
}

export const TYPE_LABEL: Record<string, string> = {
  PAYLOAD: '载荷卫星',
  DEBRIS: '空间碎片',
  'ROCKET BODY': '火箭箭体',
  UNKNOWN: '未知物体'
}

export const TYPE_KEYS = ['PAYLOAD', 'DEBRIS', 'ROCKET BODY', 'UNKNOWN']

/* ---------------- 天体图层开关 ---------------- */

export type SkyLayerKey = 'sun' | 'moon' | 'stars'
export const skyLayers = reactive<Record<SkyLayerKey, boolean>>({
  sun: true,
  moon: true,
  stars: true
})

/* ---------------- 仿真时钟 ---------------- */

/** 仿真时刻（毫秒时间戳），默认等于真实 UTC 当前时间 */
export const simTimeMs = ref(Date.now())
/** 仿真倍率 */
export const simSpeed = ref(1)
/** 是否播放 */
export const simPlaying = ref(true)

/* ---------------- 数字格式化 ---------------- */

export function fmtNum(v?: number | null, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  return Number(v).toFixed(digits)
}

/* ---------------- 右侧星历分析面板 ---------------- */

/** 星历分析面板开关（与原系统一致：独立于左侧 dock，可与左侧面板同时展开） */
export const ephOpen = ref(false)

/* ---------------- 移动端底部抽屉 ---------------- */

/** 抽屉默认高度（vh）：打开面板时的初始高度 */
export const DRAWER_DEFAULT_VH = 20
/** 抽屉高度下限（vh）：松手后允许停住的最小高度 */
export const DRAWER_MIN_VH = 15
/** 拖拽视觉下限（vh）：拖拽中允许压到的最低高度 */
const DRAG_FLOOR_VH = 10
/** 关闭判定阈值（vh）：松手时原始高度低于该值则关闭面板 */
const CLOSE_VH = 13
/** 顶部预留高度（px） */
const DRAWER_TOP_RESERVED_PX = 145
/** 底部 dock 占位（px） */
const DRAWER_DOCK_PX = 88

function drawerMaxVh() {
  const page = document.querySelector('.constel-page') as HTMLElement | null
  const pageH = page?.clientHeight || window.innerHeight || 800
  const viewH = window.innerHeight || 800
  return Math.max(DRAWER_MIN_VH, ((pageH - DRAWER_TOP_RESERVED_PX - DRAWER_DOCK_PX) / viewH) * 100)
}

export const drawerHeightVh = ref(DRAWER_DEFAULT_VH)
export const isDrawerDragging = ref(false)
/** 面板全部关闭时复位默认高度 */
watch(ephOpen, (v) => {
  if (!v) drawerHeightVh.value = DRAWER_DEFAULT_VH
})

/**
 * 移动端底部抽屉拖拽手势：绑定在面板 .sp-head 的 touch 事件上。
 * PC 无 touch 事件，不产生影响。
 */
export function useDrawerDrag(closeFn: () => void) {
  let startY = 0
  let active = false
  let startH = DRAWER_DEFAULT_VH
  let rawVh = DRAWER_DEFAULT_VH
  let maxVh = DRAWER_DEFAULT_VH

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    const target = e.target as HTMLElement
    if (target.closest('.sp-close')) return
    active = true
    isDrawerDragging.value = true
    startY = e.touches[0].clientY
    startH = drawerHeightVh.value
    rawVh = startH
    maxVh = drawerMaxVh()
  }

  function onTouchMove(e: TouchEvent) {
    if (!active) return
    e.preventDefault()
    const deltaY = e.touches[0].clientY - startY
    rawVh = startH - (deltaY / (window.innerHeight || 800)) * 100
    drawerHeightVh.value = Math.min(maxVh, Math.max(DRAG_FLOOR_VH, rawVh))
  }

  function onTouchEnd() {
    if (!active) return
    active = false
    isDrawerDragging.value = false
    if (rawVh < CLOSE_VH) {
      closeFn()
      return
    }
    drawerHeightVh.value = Math.min(maxVh, Math.max(DRAWER_MIN_VH, rawVh))
  }

  return { onTouchStart, onTouchMove, onTouchEnd }
}

/* ---------------- 场景状态 ---------------- */

export const loading = ref(true)
export const error = ref('')
