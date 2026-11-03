/**
 * 协方差来源（P2-5）
 *
 * 1) 星历一侧：ITC 每个历元给 21 项 UVW 下三角（单位 km²，已实测：σ_U≈0.7 m）。
 *    TCA 落在相邻两点之间时按线性（凸组合）插值，再旋转到 J2000。
 * 2) TLE / AOE 一侧：按「根数龄期」给 σ_T 分段线性模型（Starlink TLE 中位误差），
 *    σ_R = σ_N = max(0.2 km, 0.1·σ_T)，构造 RTN 对角阵后旋转到 J2000。
 *    龄期越大 σ 越大，Pc 越低或被标「数据不足」——如实反映，不人为调小。
 */
import { EARTH_MU, semiMajorAxisKm } from '../utils/orbit.js'
import type { Vec3 } from './frames.js'
import { fromLower21, uvwCovToEci } from './frames.js'
import type { EphTrack } from './types.js'

/** TLE 侧沿迹误差锚点（小时 → km）：锚点来自既有前端 screening.ts，单位一致 */
const SIGMA_T_ANCHORS: [number, number][] = [
  [0, 1.0],
  [6, 1.0],
  [72, 11.7],
  [168, 38.5]
]
const SIGMA_T_MAX_KM = 200

/** 龄期（小时）→ 沿迹 σ（km） */
export function tleSigmaT(ageHours: number): number {
  const h = Math.max(0, ageHours)
  if (h <= SIGMA_T_ANCHORS[0][0]) return SIGMA_T_ANCHORS[0][1]
  for (let i = 1; i < SIGMA_T_ANCHORS.length; i++) {
    const [h1, s1] = SIGMA_T_ANCHORS[i]
    if (h <= h1) {
      const [h0, s0] = SIGMA_T_ANCHORS[i - 1]
      return s0 + ((s1 - s0) * (h - h0)) / (h1 - h0)
    }
  }
  // 超过最后锚点：按最后一段斜率线性外推，上限 200 km
  const [h0, s0] = SIGMA_T_ANCHORS[SIGMA_T_ANCHORS.length - 2]
  const [h1, s1] = SIGMA_T_ANCHORS[SIGMA_T_ANCHORS.length - 1]
  const slope = (s1 - s0) / (h1 - h0)
  return Math.min(SIGMA_T_MAX_KM, s1 + slope * (h - h1))
}

/** RTN 对角协方差（km²）→ J2000 6x6 */
export function rtnCovToEci(
  rJ2000: Vec3,
  vJ2000: Vec3,
  sigmaRKm: number,
  sigmaTKm: number,
  sigmaNKm: number
): Float64Array {
  const c = new Float64Array(36)
  // 位置块（RTN）+ 速度块（按 0.1σ 给量级，Pc 只用到位置块）
  c[0] = sigmaRKm * sigmaRKm
  c[7] = sigmaTKm * sigmaTKm
  c[14] = sigmaNKm * sigmaNKm
  c[21] = (0.1 * sigmaRKm) ** 2
  c[28] = (0.1 * sigmaTKm) ** 2
  c[35] = (0.1 * sigmaNKm) ** 2
  return uvwCovToEci(c, rJ2000, vJ2000)
}

/** TLE / AOE 一侧：按 TCA − 根数历元 的龄期给协方差 */
export function tleCovariance(
  rJ2000: Vec3,
  vJ2000: Vec3,
  epochMs: number,
  tcaMs: number
): { cov: Float64Array; sigmaT: number; ageHours: number } {
  const ageHours = Math.max(0, (tcaMs - epochMs) / 3600_000)
  const sigmaT = tleSigmaT(ageHours)
  const sigmaR = Math.max(0.2, 0.1 * sigmaT)
  const sigmaN = sigmaR
  return { cov: rtnCovToEci(rJ2000, vJ2000, sigmaR, sigmaT, sigmaN), sigmaT, ageHours }
}

/**
 * 星历一侧：在 idx 与 idx+1 之间按 frac∈[0,1) 线性插值 21 项协方差，
 * 再按 TCA 处的 UVW 基旋转到 J2000。
 */
export function ephCovariance(track: EphTrack, idx: number, frac: number, rJ2000: Vec3, vJ2000: Vec3): Float64Array | null {
  if (!track.cov || track.cov.length < (idx + 2) * 21) return null
  const a = fromLower21(track.cov, idx * 21)
  const b = fromLower21(track.cov, (idx + 1) * 21)
  const m = new Float64Array(36)
  for (let i = 0; i < 36; i++) m[i] = a[i] * (1 - frac) + b[i] * frac
  // 位置块保持半正定：对角兜底
  for (const i of [0, 7, 14]) if (!(m[i] > 0)) m[i] = 1e-12
  return uvwCovToEci(m, rJ2000, vJ2000)
}

/** 由 TLE 平均运动与偏心率算近/远地点高度（km，用于粗筛区间过滤） */
export function apsisFromElements(meanMotionRevPerDay: number, ecc: number): { perigee: number; apogee: number } {
  const sma = semiMajorAxisKm(meanMotionRevPerDay)
  if (!(sma > 0)) return { perigee: 0, apogee: 0 }
  const rp = sma * (1 - ecc) - 6378.137
  const ra = sma * (1 + ecc) - 6378.137
  return { perigee: rp, apogee: ra }
}

/** 圆轨道角速度（rad/s），用于估计相对速度上限 */
export function meanMotionRadPerSec(meanMotionRevPerDay: number): number {
  return (meanMotionRevPerDay * 2 * Math.PI) / 86400
}

export { EARTH_MU }
