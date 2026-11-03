/** P2 筛查引擎的共享类型 */
import type { Vec3 } from './frames.js'

export type { Vec3 }

/** 主星星历轨迹（J2000，km / km/s，协方差 21 项下三角 km²） */
export interface EphTrack {
  memeId: number
  noradId: number | null
  name: string
  createdMs: number | null
  startMs: number
  stepMs: number
  n: number
  r: Float64Array
  v: Float64Array
  cov: Float64Array | null
  /** TLE 主星轨迹的根数历元（ms）：协方差按龄期 TLE 模型给，星历轨迹不填 */
  epochMs?: number
}

/** 副星目录对象（TLE 两行；AOE 缺两行时已在同步阶段合成） */
export interface CatalogObject {
  norad: number
  name: string
  line1: string
  line2: string
  epochMs: number
  src: 'tle' | 'aoe' | 'supgp'
  perigeeKm: number
  apogeeKm: number
}

/** 粗筛候选（同一 pair 的某个时间段内最接近的一个步长） */
export interface Candidate {
  primaryMeme: number
  secondaryNorad: number
  /** 候选中心时刻（Unix ms，对齐到星历步长） */
  centerMs: number
  distKm: number
}

export interface ScreenParams {
  /** 报告门限（km） */
  missMaxKm: number
  /** 联合硬体半径（km） */
  hbrKm: number
  /** 粗筛相对速度上限（km/s） */
  vRelMaxKms: number
  /** 步长（ms，与星历对齐） */
  stepMs: number
  /** 窗口（ms 绝对时刻） */
  windowStartMs: number
  windowEndMs: number
}
