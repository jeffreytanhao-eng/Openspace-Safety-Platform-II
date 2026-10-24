/**
 * 高精度星历（ITC / OEM / OCM）内核的公共类型定义。
 *
 * 约定：
 * - 时间一律使用 Unix 毫秒（UTC），不引入本地时区；
 * - 位置单位 km，速度单位 km/s；
 * - 协方差为 6x6 行主序（36 个数），顺序 [x,y,z,vx,vy,vz]，已旋转到 ECI。
 */

/** 三维向量（行向量语义，索引 0/1/2 对应 X/Y/Z） */
export type Vec3 = [number, number, number]

/** 支持的星历文件格式 */
export type EphemFormat = 'itc' | 'oem' | 'ocm'

/** 星历参考坐标系 */
export type EphemFrame = 'UVW' | 'EME2000' | 'ICRF' | 'ITRF' | 'TEME'

/** 单条星历状态（历元 + 位置速度 + 可选协方差） */
export interface EphemState {
  /** Unix 毫秒（UTC） */
  t: number
  /** 位置 km（ECI） */
  r: Vec3
  /** 速度 km/s（ECI） */
  v: Vec3
  /** 6x6 行主序协方差（36 个），ECI 下的 [r,v] 分量 */
  cov?: Float64Array
}

/** 一条完整的星历序列 */
export interface EphemSet {
  id: string
  norad: number
  name: string
  format: EphemFormat
  frame: EphemFrame
  source: 'upload' | 'builtin'
  createdAt: number
  start: number
  stop: number
  stepSec: number
  states: EphemState[]
  objectId?: string
  warnings: string[]
}

/** 解析结果，失败时给出错误信息与行号（从 1 开始） */
export interface ParseResult {
  ok: boolean
  set?: EphemSet
  error?: string
  line?: number
  warnings: string[]
}

/** 星历质量评估报告 */
export interface QualityReport {
  /** 自洽性 RMS（km）：三点/多点多项式回代残差 */
  selfConsistencyRmsKm?: number
  /** 自洽性漂移（km/天） */
  selfDriftKmPerDay?: number
  /** 与 TLE 外推的 RMS（km） */
  tleRmsKm?: number
  /** 与 TLE 外推的最大偏差（km） */
  tleMaxKm?: number
  /** 归一化估计误差平方均值（理想值约为 1） */
  nees?: number
  score: number
  grade: '优' | '良' | '可用' | '建议重传'
  notes: string[]
}

/** 一次接近事件（威胁） */
export interface ThreatEvent {
  id: string
  selfNorad: number
  otherNorad: number
  otherName: string
  /** 最近接近时刻（Unix ms） */
  tca: number
  /** 最小距离 km */
  missKm: number
  /** 相对速度 km/s */
  relSpeedKmS: number
  /** 碰撞概率 */
  pc: number
  /** 风险归一化分值 0~1 */
  risk: number
  level: 'high' | 'medium' | 'low'
  /** TCA 时刻本星 ECI 位置 km */
  midEci: Vec3
  /** TCA 时刻对方 ECI 位置 / 速度（km、km/s），供三维绘制对方轨道 */
  otherEci?: Vec3
  otherVel?: Vec3
}
