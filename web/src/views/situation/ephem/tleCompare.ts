/**
 * 与 TLE（SGP4 外推）的偏差评估。
 *
 * 用途：判断一份高精度星历是否与编目 TLE 描述的是同一个轨道。
 * - 逐点用 SGP4 从 TLE 外推到星历时刻，求位置差；
 * - 按 TLE 状态自身的 RTN 基分解为径向 / 沿迹 / 横向，便于区分
 *   「沿迹漂移（平均运动不一致）」与「横向偏差（面内/面外倾角不一致）」；
 * - 同时给出 TLE 历元与星历起点的时差，供面板提示参考性
 *   （TLE 越旧，偏差里 TLE 自身误差占比越高）。
 *
 * 注意：satellite.js 输出为 TEME，本项目星历按其自身 ECI 直接使用；
 * 两者存在岁差级的坐标系差异（横向几十 km 量级），故本指标只作量级参考，
 * 不参与总分（见 EphemPanel 的说明文案）。
 */
import { twoline2satrec, propagate } from 'satellite.js'
import type { EphemSet } from './types'

export interface TleDeviationPoint {
  /** Unix ms */
  t: number
  /** 位置差模长 km */
  dist: number
  /** RTN 分解（km）：径向 / 沿迹 / 横向 */
  radial: number
  along: number
  cross: number
}

export interface TleDeviationResult {
  /** TLE 历元（Unix ms） */
  tleEpochMs: number
  /** 星历起点 − TLE 历元（天，正数表示星历比 TLE 新） */
  epochLagDays: number
  /** 有效采样点数 */
  samples: number
  rmsKm: number
  maxKm: number
  radialRmsKm: number
  alongRmsKm: number
  crossRmsKm: number
  /** 偏差-时间序列（已抽稀，最多 MAX_SAMPLES 点） */
  points: TleDeviationPoint[]
}

/** 曲线与统计的最大采样数（1440 点逐点算也很快，但曲线不需要这么密） */
const MAX_SAMPLES = 240
/** Unix 纪元对应的儒略日 */
const UNIX_JD = 2440587.5

/** 从 satrec 取 TLE 历元（兼容新旧两版 satellite.js 的字段拆分方式） */
function epochMsOf(rec: ReturnType<typeof twoline2satrec>): number {
  const jd = Number(rec.jdsatepoch)
  const frac = Number((rec as unknown as { jdsatepochF?: number }).jdsatepochF)
  if (!Number.isFinite(jd)) return NaN
  return (jd + (Number.isFinite(frac) ? frac : 0) - UNIX_JD) * 86400000
}

/**
 * 逐点比较星历与 TLE 外推位置。
 * 失败（TLE 解析失败 / 有效样本不足）返回 null，由调用方给出提示。
 */
export function compareWithTle(set: EphemSet, line1: string, line2: string): TleDeviationResult | null {
  let rec: ReturnType<typeof twoline2satrec>
  try {
    rec = twoline2satrec(line1.trim(), line2.trim())
  } catch {
    return null
  }
  if (!rec) return null
  const tleEpochMs = epochMsOf(rec)
  if (!Number.isFinite(tleEpochMs)) return null

  const st = set.states
  if (st.length < 3) return null

  const stride = Math.max(1, Math.ceil(st.length / MAX_SAMPLES))
  const idxs: number[] = []
  for (let i = 0; i < st.length; i += stride) idxs.push(i)
  if (idxs[idxs.length - 1] !== st.length - 1) idxs.push(st.length - 1)

  const points: TleDeviationPoint[] = []
  let sum2 = 0
  let max = 0
  let sumR = 0
  let sumA = 0
  let sumC = 0

  for (const i of idxs) {
    const s = st[i]
    const pv = propagate(rec, new Date(s.t))
    const p = pv?.position
    const v = pv?.velocity
    if (!p || !v) continue
    if (typeof p === 'boolean' || typeof v === 'boolean') continue
    const px = p.x
    const py = p.y
    const pz = p.z
    if (![px, py, pz, v.x, v.y, v.z].every((n) => Number.isFinite(n))) continue

    const dx = s.r[0] - px
    const dy = s.r[1] - py
    const dz = s.r[2] - pz
    const dist = Math.hypot(dx, dy, dz)
    if (!Number.isFinite(dist)) continue

    // RTN 基：R = r̂，N = (r×v)/|r×v|，T = N×R
    const rn = Math.hypot(px, py, pz)
    if (!(rn > 1e-6)) continue
    const ux = px / rn
    const uy = py / rn
    const uz = pz / rn
    const hx = py * v.z - pz * v.y
    const hy = pz * v.x - px * v.z
    const hz = px * v.y - py * v.x
    const hn = Math.hypot(hx, hy, hz)
    if (!(hn > 1e-9)) continue
    const wx = hx / hn
    const wy = hy / hn
    const wz = hz / hn
    const tx = wy * uz - wz * uy
    const ty = wz * ux - wx * uz
    const tz = wx * uy - wy * ux

    const radial = dx * ux + dy * uy + dz * uz
    const along = dx * tx + dy * ty + dz * tz
    const cross = dx * wx + dy * wy + dz * wz

    points.push({ t: s.t, dist, radial, along, cross })
    sum2 += dist * dist
    sumR += radial * radial
    sumA += along * along
    sumC += cross * cross
    if (dist > max) max = dist
  }

  const n = points.length
  if (n < 3) return null

  const firstT = st[0].t
  return {
    tleEpochMs,
    epochLagDays: (firstT - tleEpochMs) / 86400000,
    samples: n,
    rmsKm: Math.sqrt(sum2 / n),
    maxKm: max,
    radialRmsKm: Math.sqrt(sumR / n),
    alongRmsKm: Math.sqrt(sumA / n),
    crossRmsKm: Math.sqrt(sumC / n),
    points
  }
}
