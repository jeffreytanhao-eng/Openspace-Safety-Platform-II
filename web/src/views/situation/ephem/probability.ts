import type { Vec3 } from './types'

/** 经验位置标准差（km） */
export type SigmaRegime = 'leo' | 'meo' | 'geo'

/** 缺少协方差时的经验 1σ 位置误差（km） */
export function defaultSigmaKm(regime: SigmaRegime = 'leo'): number {
  if (regime === 'geo') return 5
  if (regime === 'meo') return 2
  return 0.5
}

export interface CollisionProbabilityOptions {
  /** 最小距离 km */
  missKm: number
  /** 相对速度 km/s */
  relSpeedKmS: number
  /** 本星 6x6 协方差（ECI），缺省用经验 σ */
  covSelf?: Float64Array | null
  /** 对方 6x6 协方差（ECI），缺省用经验 σ */
  covOther?: Float64Array | null
  /** 联合硬体半径 km */
  hardBodyKm: number
  /** 标记协方差是否 RTN 语义（标量 Pc 计算无需额外旋转，仅作语义说明） */
  rtn?: boolean
  /** 缺省协方差时选用的轨道区制 */
  regime?: SigmaRegime
}

/** 取 6x6 协方差的位置块（行主序 3x3，返回长度 9 的数组） */
function positionBlock(cov?: Float64Array | null): number[] | null {
  if (!cov || cov.length < 36) return null
  const out = [cov[0], cov[1], cov[2], cov[6], cov[7], cov[8], cov[12], cov[13], cov[14]]
  return out.every((x) => Number.isFinite(x)) ? out : null
}

/** 3x3 对称矩阵乘向量 */
function mulVec(m: number[], x: Vec3): Vec3 {
  return [
    m[0] * x[0] + m[1] * x[1] + m[2] * x[2],
    m[3] * x[0] + m[4] * x[1] + m[5] * x[2],
    m[6] * x[0] + m[7] * x[1] + m[8] * x[2]
  ]
}

/**
 * 幂迭代求最大特征值对应的特征向量，作为「最不确定方向」。
 * 缺少相对速度矢量时，用它作为投影平面的法向：
 * 法向取最大方差方向等价于把投影面取在协方差最小的截面上，Pc 偏保守。
 */
function principalAxis(c: number[]): Vec3 {
  const s = 1 / Math.sqrt(3)
  let x: Vec3 = [s, s, s]
  for (let it = 0; it < 40; it++) {
    const y = mulVec(c, x)
    const n = Math.hypot(y[0], y[1], y[2])
    if (!(n > 1e-30)) return [1, 0, 0]
    x = [y[0] / n, y[1] / n, y[2] / n]
  }
  return x
}

/**
 * 碰撞概率（二维高斯在硬球上的近似）。
 *
 * 合并两侧位置协方差 → 投影到垂直于相对速度（缺失时取最大方差轴）的平面 →
 * `Pc = R² / (2π√det C) · exp(-0.5 dᵀC⁻¹d)`。
 * 数值异常（det ≤ 0、NaN）一律返回 0。
 */
export function collisionProbability(opts: CollisionProbabilityOptions): number {
  const hardBody = opts.hardBodyKm
  const miss = Math.abs(opts.missKm)
  if (!(hardBody > 0) || !Number.isFinite(miss) || !Number.isFinite(opts.relSpeedKmS)) return 0

  const regime = opts.regime ?? 'leo'
  const sigma = defaultSigmaKm(regime)
  const a = positionBlock(opts.covSelf)
  const b = positionBlock(opts.covOther)

  // 合并协方差；缺失的一侧用经验 σ²I 补齐
  const c = new Array<number>(9).fill(0)
  const addDiag = (v: number) => {
    c[0] += v
    c[4] += v
    c[8] += v
  }
  if (a) for (let i = 0; i < 9; i++) c[i] += a[i]
  else addDiag(sigma * sigma)
  if (b) for (let i = 0; i < 9; i++) c[i] += b[i]
  else addDiag(sigma * sigma)

  // 对称化
  const c01 = (c[1] + c[3]) / 2
  const c02 = (c[2] + c[6]) / 2
  const c12 = (c[5] + c[7]) / 2
  c[1] = c[3] = c01
  c[2] = c[6] = c02
  c[5] = c[7] = c12
  if (!c.every((x) => Number.isFinite(x))) return 0

  const n = principalAxis(c)
  // 构造与 n 正交的平面基 e1、e2
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const d0 = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2]
  let e1: Vec3 = [ref[0] - d0 * n[0], ref[1] - d0 * n[1], ref[2] - d0 * n[2]]
  const e1n = Math.hypot(e1[0], e1[1], e1[2])
  if (!(e1n > 1e-12)) return 0
  e1 = [e1[0] / e1n, e1[1] / e1n, e1[2] / e1n]
  const e2: Vec3 = [
    n[1] * e1[2] - n[2] * e1[1],
    n[2] * e1[0] - n[0] * e1[2],
    n[0] * e1[1] - n[1] * e1[0]
  ]

  const ce1 = mulVec(c, e1)
  const ce2 = mulVec(c, e2)
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const p11 = dot(e1, ce1)
  const p12 = dot(e1, ce2)
  const p22 = dot(e2, ce2)

  const det = p11 * p22 - p12 * p12
  if (!(det > 0) || !Number.isFinite(det)) return 0

  const inv11 = p22 / det
  const inv12 = -p12 / det
  const inv22 = p11 / det
  const maha = miss * miss * inv11

  const pc = ((hardBody * hardBody) / (2 * Math.PI * Math.sqrt(det))) * Math.exp(-0.5 * maha)
  if (!Number.isFinite(pc) || pc <= 0) return 0
  return Math.min(1, pc)
}
