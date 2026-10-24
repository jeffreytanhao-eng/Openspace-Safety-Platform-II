import type { EphemSet, QualityReport } from './types'
import { interpolateAt } from './interp'

/** scoreQuality 的输入指标（都是可选，缺项会扣分并写入 notes） */
export interface QualityMetrics {
  selfConsistencyRmsKm?: number
  selfDriftKmPerDay?: number
  tleRmsKm?: number
  tleMaxKm?: number
  nees?: number
  /** 星历跨度（天） */
  spanDays?: number
  /** 是否带协方差 */
  hasCovariance?: boolean
}

export interface SetCompareResult {
  rmsKm: number
  maxKm: number
  driftKmPerDay: number
  commonSec: number
}

/** 取最近状态（仅考虑带协方差的状态）的协方差 */
function covAt(set: EphemSet, t: number): Float64Array | null {
  let best: Float64Array | null = null
  let bestD = Infinity
  for (const st of set.states) {
    if (!st.cov) continue
    const d = Math.abs(st.t - t)
    if (d < bestD) {
      bestD = d
      best = st.cov
    }
  }
  return best
}

/** 3x3 对称矩阵求逆，奇异时返回 null */
function invert3(m: number[]): number[] | null {
  const a = m[0]
  const b = m[1]
  const c = m[2]
  const d = m[3]
  const e = m[4]
  const f = m[5]
  const g = m[6]
  const h = m[7]
  const i = m[8]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!(Math.abs(det) > 1e-30) || !Number.isFinite(det)) return null
  const inv = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det
  ]
  return inv
}

/**
 * 比较两条星历：重叠时段每 60s 采样插值求差。
 * driftKmPerDay 用距离随时间的最小二乘斜率（km/天）表示发散速度。
 */
export function compareTwoSets(a: EphemSet, b: EphemSet): SetCompareResult {
  const start = Math.max(a.start, b.start)
  const stop = Math.min(a.stop, b.stop)
  if (!(stop > start)) return { rmsKm: NaN, maxKm: NaN, driftKmPerDay: NaN, commonSec: 0 }

  const stepMs = 60000
  const n = Math.floor((stop - start) / stepMs) + 1
  let sum2 = 0
  let max = 0
  let count = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0

  for (let i = 0; i < n; i++) {
    const t = start + i * stepMs
    const sa = interpolateAt(a.states, t)
    const sb = interpolateAt(b.states, t)
    if (!sa || !sb) continue
    const dx = sa.r[0] - sb.r[0]
    const dy = sa.r[1] - sb.r[1]
    const dz = sa.r[2] - sb.r[2]
    const dist = Math.hypot(dx, dy, dz)
    sum2 += dist * dist
    if (dist > max) max = dist
    const days = (t - start) / 86400000
    sx += days
    sy += dist
    sxx += days * days
    sxy += days * dist
    count++
  }

  if (count === 0) return { rmsKm: NaN, maxKm: NaN, driftKmPerDay: NaN, commonSec: 0 }
  const denom = count * sxx - sx * sx
  const slope = Math.abs(denom) > 1e-12 ? (count * sxy - sx * sy) / denom : 0
  return {
    rmsKm: Math.sqrt(sum2 / count),
    maxKm: max,
    driftKmPerDay: Math.abs(slope),
    commonSec: Math.round((count - 1) * (stepMs / 1000))
  }
}

/**
 * NEES 均值：mean(Δrᵀ(P1+P2)⁻¹Δr)/3，理想值接近 1。
 * 任一侧缺少协方差时返回 NaN。
 */
export function neesScore(a: EphemSet, b: EphemSet): number {
  const start = Math.max(a.start, b.start)
  const stop = Math.min(a.stop, b.stop)
  if (!(stop > start)) return NaN

  const stepMs = 60000
  const n = Math.floor((stop - start) / stepMs) + 1
  let sum = 0
  let count = 0

  for (let i = 0; i < n; i++) {
    const t = start + i * stepMs
    const sa = interpolateAt(a.states, t)
    const sb = interpolateAt(b.states, t)
    if (!sa || !sb) continue
    const ca = covAt(a, t)
    const cb = covAt(b, t)
    if (!ca || !cb) continue

    const p: number[] = new Array<number>(9).fill(0)
    const idx = [0, 1, 2, 6, 7, 8, 12, 13, 14]
    for (let k = 0; k < 9; k++) p[k] = ca[idx[k]] + cb[idx[k]]
    const inv = invert3(p)
    if (!inv) continue

    const d = [sa.r[0] - sb.r[0], sa.r[1] - sb.r[1], sa.r[2] - sb.r[2]]
    const md = [
      inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2],
      inv[3] * d[0] + inv[4] * d[1] + inv[5] * d[2],
      inv[6] * d[0] + inv[7] * d[1] + inv[8] * d[2]
    ]
    const val = d[0] * md[0] + d[1] * md[1] + d[2] * md[2]
    if (!Number.isFinite(val)) continue
    sum += val / 3
    count++
  }

  return count > 0 ? sum / count : NaN
}

/**
 * 质量打分（满分 100）：
 * 自洽 RMS 40 分 + NEES 40 分 + 协方差与跨度 20 分。
 * 评级：≥85 优、≥70 良、≥50 可用、其余建议重传。
 */
export function scoreQuality(r: QualityMetrics): QualityReport {
  const notes: string[] = []
  let score = 0

  const rms = r.selfConsistencyRmsKm
  if (typeof rms === 'number' && Number.isFinite(rms)) {
    if (rms < 0.5) score += 40
    else if (rms < 2) {
      score += 30
      notes.push(`自洽性 RMS ${rms.toFixed(2)} km，略高于 0.5 km 阈值`)
    } else if (rms < 10) {
      score += 15
      notes.push(`自洽性 RMS ${rms.toFixed(2)} km，偏差偏大`)
    } else {
      score += 5
      notes.push(`自洽性 RMS ${rms.toFixed(2)} km，超过 10 km，数据可能损坏`)
    }
  } else {
    notes.push('缺少自洽性检验结果，该项不得分')
  }

  const nees = r.nees
  if (typeof nees === 'number' && Number.isFinite(nees) && nees > 0) {
    const dev = Math.abs(Math.log(nees))
    score += 40 * Math.exp(-0.7 * dev)
    if (dev > 0.7) notes.push(`NEES=${nees.toFixed(2)} 偏离理想值 1，协方差与残差不自洽`)
  } else {
    notes.push('无有效 NEES（缺少协方差或无可比数据），该项不得分')
  }

  if (r.hasCovariance) score += 8
  else notes.push('文件不含协方差，未获得协方差项加分')

  const span = r.spanDays ?? 0
  if (span >= 1) score += 12
  else if (span >= 0.5) {
    score += 8
    notes.push('星历跨度不足 1 天，长时间预报可信度下降')
  } else if (span >= 0.1) {
    score += 4
    notes.push('星历跨度不足半天，仅适合短期使用')
  } else {
    notes.push('星历跨度小于 2.4 小时，不建议用于长期筛选')
  }

  const drift = r.selfDriftKmPerDay
  if (typeof drift === 'number' && Number.isFinite(drift) && drift > 5) {
    notes.push(`自洽漂移 ${drift.toFixed(1)} km/天，存在明显系统性偏差`)
  }
  const tleRms = r.tleRmsKm
  if (typeof tleRms === 'number' && Number.isFinite(tleRms) && tleRms > 10) {
    notes.push(`与 TLE 外推偏差 RMS ${tleRms.toFixed(1)} km，星历版本可能偏旧`)
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)))
  const grade: QualityReport['grade'] =
    finalScore >= 85 ? '优' : finalScore >= 70 ? '良' : finalScore >= 50 ? '可用' : '建议重传'

  return {
    selfConsistencyRmsKm: r.selfConsistencyRmsKm,
    selfDriftKmPerDay: r.selfDriftKmPerDay,
    tleRmsKm: r.tleRmsKm,
    tleMaxKm: r.tleMaxKm,
    nees: r.nees,
    score: finalScore,
    grade,
    notes
  }
}
