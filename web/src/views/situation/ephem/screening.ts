/**
 * 星历筛选内核：本星高精度星历 × 在轨目录快照 → 接近事件（威胁）列表。
 *
 * 目录侧只有「某一历元的 r/v」，要做 6~72 小时的筛选必须用**二体开普勒解析推进**
 * （线性化外推在小时量级就完全失真）；本星侧用星历自身的 Hermite 插值，精度最高。
 *
 * 流程：
 * 1) 半长轴 ±150 km、倾角 ±10° 预过滤（同轨道带才可能接近，顺带把 3.5 万目标降到数千）；
 * 2) 粗筛：按 coarseStepSec 建时间网格；每个网格点用「线性相对运动最近点」判据
 *    （τ = -Δr·Δv/|Δv|²，夹在本步内，取 |Δr+Δv·τ| < 报告距离），
 *    这样 1 分钟级的快速飞掠不会被步长漏掉；
 * 3) 精筛：候选对在 ±1 步内 5 s 扫描 + 黄金分割细化到 10 ms 求 TCA；
 * 4) 由 TCA 处两星状态算相对速度与碰撞概率 Pc，按最近距离排序。
 *
 * 纯函数、无 DOM 依赖，可直接在 Web Worker 中运行（见 screen.worker.ts）。
 */
import type { EphemSet, EphemState, ThreatEvent, Vec3 } from './types'
import { interpolateAt } from './interp'
import { collisionProbability } from './probability'
import type { SigmaRegime } from './probability'

/** 地球引力常数 km³/s² */
const MU = 398600.4418

/** 目录快照中的一条对象（a 单位 km、i 单位度，e 无量纲；缺失时由 r/v 反解） */
export interface CatalogSnapshotEntry {
  norad: number
  name: string
  r: Vec3
  v: Vec3
  a: number
  e: number
  i: number
}

export interface ScreenOptions {
  t0: number
  t1: number
  /** 目录快照的历元（Unix ms）：目录里的 r/v 都是该时刻的 ECI 状态。
   *  缺省按 t0 处理（目录与筛选窗口同历元时无需传）。 */
  catalogT?: number
  /** 粗筛步长（秒），默认 300 */
  coarseStepSec?: number
  maxDistKm: number
  hardBodyKm: number
  pcThreshold: number
  /** 最大事件数，默认 2000 */
  maxEvents?: number
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

/** 由状态反解轨道根数（a: km，e 无量纲，i: 度） */
export function elementsFromRV(r: Vec3, v: Vec3): { a: number; e: number; i: number } {
  const rn = norm3(r)
  if (!(rn > 0)) return { a: NaN, e: NaN, i: NaN }
  const a = 1 / (2 / rn - dot(v, v) / MU)
  const h = cross(r, v)
  const hn = norm3(h)
  const eVec: Vec3 = [
    cross(v, h)[0] / MU - r[0] / rn,
    cross(v, h)[1] / MU - r[1] / rn,
    cross(v, h)[2] / MU - r[2] / rn
  ]
  const e = norm3(eVec)
  const cosi = hn > 0 ? Math.min(1, Math.max(-1, h[2] / hn)) : 1
  return { a, e, i: (Math.acos(cosi) * 180) / Math.PI }
}

/** 名称归一化：忽略大小写与多余空白，用于「同名即本星」判断 */
function normName(s: string): string {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

/**
 * 二体开普勒轨道（近焦点系基 + 历元平近点角）。
 * 一次构建、反复按任意时间差求位置速度，避免逐步数值积分累积误差。
 */
interface Orbit {
  a: number
  e: number
  b: number
  /** 平均角速度 rad/s */
  n: number
  /** 近地点方向单位向量 */
  P: Vec3
  /** 轨道面内与 P 垂直的单位向量（Q = W×P） */
  Q: Vec3
  /** 历元平近点角 */
  M0: number
  /** 是否可解（椭圆、非退化） */
  ok: boolean
}

/** 由历元 r/v 构建二体轨道；非椭圆 / 退化时 ok=false */
function buildOrbit(r: Vec3, v: Vec3): Orbit {
  const bad: Orbit = { a: NaN, e: NaN, b: NaN, n: NaN, P: [1, 0, 0], Q: [0, 1, 0], M0: 0, ok: false }
  const rn = norm3(r)
  const v2 = dot(v, v)
  if (!(rn > 0) || !(v2 > 0)) return bad
  const a = 1 / (2 / rn - v2 / MU)
  if (!(a > 0) || !Number.isFinite(a)) return bad
  const h = cross(r, v)
  const hn = norm3(h)
  if (!(hn > 0)) return bad
  const rv = dot(r, v)
  const eVec: Vec3 = [
    ((v2 - MU / rn) * r[0] - rv * v[0]) / MU,
    ((v2 - MU / rn) * r[1] - rv * v[1]) / MU,
    ((v2 - MU / rn) * r[2] - rv * v[2]) / MU
  ]
  const e = norm3(eVec)
  if (!(e < 1)) return bad
  const P: Vec3 = e > 1e-8
    ? [eVec[0] / e, eVec[1] / e, eVec[2] / e]
    : [r[0] / rn, r[1] / rn, r[2] / rn]
  const W: Vec3 = [h[0] / hn, h[1] / hn, h[2] / hn]
  const Q: Vec3 = [
    W[1] * P[2] - W[2] * P[1],
    W[2] * P[0] - W[0] * P[2],
    W[0] * P[1] - W[1] * P[0]
  ]
  const b = a * Math.sqrt(1 - e * e)
  const x0 = dot(r, P)
  const y0 = dot(r, Q)
  const E0 = Math.atan2(y0 / b, x0 / a + e)
  return { a, e, b, n: Math.sqrt(MU / (a * a * a)), P, Q, M0: E0 - e * Math.sin(E0), ok: true }
}

/** 解算轨道在 dt 秒后的 ECI 位置与速度（椭圆轨道；开普勒方程牛顿迭代） */
function orbitStateAt(o: Orbit, dtSec: number, outR: Vec3, outV: Vec3): void {
  const twoPi = Math.PI * 2
  let M = (o.M0 + o.n * dtSec) % twoPi
  if (M < 0) M += twoPi
  // 初值：E ≈ M + e·sinM（偏心率 < 0.3 时 3~4 次迭代即收敛到 1e-10）
  let E = M + o.e * Math.sin(M)
  for (let i = 0; i < 6; i++) {
    const f = E - o.e * Math.sin(E) - M
    const fp = 1 - o.e * Math.cos(E)
    const d = f / fp
    E -= d
    if (Math.abs(d) < 1e-10) break
  }
  const sinE = Math.sin(E)
  const cosE = Math.cos(E)
  const x = o.a * (cosE - o.e)
  const y = o.b * sinE
  // 近焦点系速度：Edot = n / (1 - e·cosE)
  const Edot = o.n / (1 - o.e * cosE)
  const vx = -o.a * sinE * Edot
  const vy = o.b * cosE * Edot
  outR[0] = o.P[0] * x + o.Q[0] * y
  outR[1] = o.P[1] * x + o.Q[1] * y
  outR[2] = o.P[2] * x + o.Q[2] * y
  outV[0] = o.P[0] * vx + o.Q[0] * vy
  outV[1] = o.P[1] * vx + o.Q[1] * vy
  outV[2] = o.P[2] * vx + o.Q[2] * vy
}

/** 椭圆二体推进：由历元 r/v 求 dt 秒后的状态（不可解时返回 null），供机动增量传播使用 */
export function twoBodyPropagate(r: Vec3, v: Vec3, dtSec: number): { r: Vec3; v: Vec3 } | null {
  const orb = buildOrbit(r, v)
  if (!orb.ok) return null
  const rr: Vec3 = [0, 0, 0]
  const vv: Vec3 = [0, 0, 0]
  orbitStateAt(orb, dtSec, rr, vv)
  return { r: rr, v: vv }
}

function regimeOf(a: number): SigmaRegime {
  if (!Number.isFinite(a)) return 'leo'
  if (a <= 8000) return 'leo'
  if (a < 30000) return 'meo'
  return 'geo'
}

/** 取 TCA 附近带协方差的状态 */
function covNear(states: EphemState[], t: number): Float64Array | null {
  let best: Float64Array | null = null
  let bestD = Infinity
  for (const st of states) {
    if (!st.cov) continue
    const d = Math.abs(st.t - t)
    if (d < bestD) {
      bestD = d
      best = st.cov
    }
  }
  return best
}

/** 预过滤阈值：半长轴差 / 倾角差 */
const FILTER_A_KM = 150
const FILTER_I_DEG = 10

/** 在 [lo, hi] 内「5s 扫描 + 黄金分割（10ms 精度）」求最小距离时刻 */
function refineTca(distAt: (t: number) => number, lo: number, hi: number): { tca: number; miss: number } {
  const scan = 5000
  let bestT = lo
  let bestD = Infinity
  for (let t = lo; t <= hi; t += scan) {
    const d = distAt(t)
    if (d < bestD) { bestD = d; bestT = t }
  }
  const phi = (Math.sqrt(5) - 1) / 2
  let a = Math.max(lo, bestT - scan)
  let b = Math.min(hi, bestT + scan)
  let c = b - phi * (b - a)
  let d = a + phi * (b - a)
  let fc = distAt(c)
  let fd = distAt(d)
  while (b - a > 10) {
    if (fc < fd) {
      b = d; d = c; fd = fc
      c = b - phi * (b - a); fc = distAt(c)
    } else {
      a = c; c = d; fc = fd
      d = a + phi * (b - a); fd = distAt(d)
    }
  }
  const tca = (a + b) / 2
  return { tca, miss: distAt(tca) }
}

/**
 * 星历粗筛 + 精筛（纯函数，可在 Web Worker 中调用）。
 */
export function screenEphemeris(
  self: EphemSet,
  catalog: CatalogSnapshotEntry[],
  opt: ScreenOptions,
  onProgress?: (p: number) => void
): ThreatEvent[] {
  const coarseSec = opt.coarseStepSec && opt.coarseStepSec > 0 ? opt.coarseStepSec : 300
  const maxEvents = opt.maxEvents && opt.maxEvents > 0 ? opt.maxEvents : 2000
  const maxDist = opt.maxDistKm
  if (!self.states.length || !catalog.length || !(opt.t1 > opt.t0) || !(maxDist > 0)) return []

  const selfEl = elementsFromRV(self.states[0].r, self.states[0].v)
  const regime = regimeOf(selfEl.a)
  const catalogT = opt.catalogT ?? opt.t0

  // 目录里的同一目标即本星自身，不算交会。
  // 星历里的编号可能是生产编号（如 STARLINK-38128 的样例 NORAD 不是编目号），
  // 只比 NORAD 会漏掉自身，因此 NORAD 相同或名称相同都排除。
  const selfName = normName(self.name)
  const orbs: Orbit[] = []
  const kept: CatalogSnapshotEntry[] = []
  for (const c of catalog) {
    if (c.norad === self.norad || (selfName !== '' && normName(c.name) === selfName)) continue
    const el = Number.isFinite(c.a) && Number.isFinite(c.i) ? c : elementsFromRV(c.r, c.v)
    if (!(Math.abs(el.a - selfEl.a) < FILTER_A_KM)) continue
    if (!(Math.abs(el.i - selfEl.i) < FILTER_I_DEG)) continue
    const orb = buildOrbit(c.r, c.v)
    if (!orb.ok) continue
    orbs.push(orb)
    kept.push(c)
  }
  if (!kept.length) return []

  const stepMs = coarseSec * 1000
  const gridCount = Math.floor((opt.t1 - opt.t0) / stepMs) + 1
  const progressEvery = Math.max(1, Math.floor(gridCount / 20))

  // 2) 粗筛：线性相对运动最近点判据（不依赖空间哈希，避免快速飞掠被网格漏掉）
  /** 候选：对象下标 → 粗筛得到的最近时刻（ms） */
  const candidates = new Map<number, number>()
  const rBuf: Vec3 = [0, 0, 0]
  const vBuf: Vec3 = [0, 0, 0]
  const nObj = orbs.length

  for (let g = 0; g < gridCount; g++) {
    const t = opt.t0 + g * stepMs
    const s = interpolateAt(self.states, t)
    if (s) {
      const dt = (t - catalogT) / 1000
      for (let k = 0; k < nObj; k++) {
        orbitStateAt(orbs[k], dt, rBuf, vBuf)
        const rx = rBuf[0] - s.r[0]
        const ry = rBuf[1] - s.r[1]
        const rz = rBuf[2] - s.r[2]
        const vx = vBuf[0] - s.v[0]
        const vy = vBuf[1] - s.v[1]
        const vz = vBuf[2] - s.v[2]
        const vv = vx * vx + vy * vy + vz * vz
        let tau = vv > 1e-9 ? -(rx * vx + ry * vy + rz * vz) / vv : 0
        if (tau < 0) tau = 0
        else if (tau > coarseSec) tau = coarseSec
        const cx = rx + vx * tau
        const cy = ry + vy * tau
        const cz = rz + vz * tau
        const dmin = Math.sqrt(cx * cx + cy * cy + cz * cz)
        if (dmin < maxDist) {
          const tNear = t + tau * 1000
          const prev = candidates.get(k)
          // 同一对象多次入网时保留更近的那次
          if (prev === undefined) candidates.set(k, tNear)
          else {
            // 用当前网格点的距离近似比较（足够做去重）
            const sp = interpolateAt(self.states, prev)
            if (sp) {
              orbitStateAt(orbs[k], (prev - catalogT) / 1000, rBuf, vBuf)
              const dPrev = Math.hypot(rBuf[0] - sp.r[0], rBuf[1] - sp.r[1], rBuf[2] - sp.r[2])
              if (dmin < dPrev) candidates.set(k, tNear)
            }
          }
        }
      }
    }
    if (onProgress && (g % progressEvery === 0 || g === gridCount - 1)) {
      onProgress(((g + 1) / gridCount) * 0.7)
    }
  }

  if (!candidates.size) return []

  // 3) 精筛：候选对在 ±1 步内 5s 扫描 + 黄金分割
  const distAt = (k: number, t: number): number => {
    const s = interpolateAt(self.states, t)
    if (!s) return Infinity
    orbitStateAt(orbs[k], (t - catalogT) / 1000, rBuf, vBuf)
    return Math.hypot(rBuf[0] - s.r[0], rBuf[1] - s.r[1], rBuf[2] - s.r[2])
  }

  const refine = (k: number, tCoarse: number): { tca: number; miss: number } =>
    refineTca(
      (t) => distAt(k, t),
      Math.max(opt.t0, tCoarse - stepMs),
      Math.min(opt.t1, tCoarse + stepMs)
    )

  const events: ThreatEvent[] = []
  let done = 0
  for (const [k, tCoarse] of candidates) {
    done++
    const other = kept[k]
    const { tca, miss } = refine(k, tCoarse)
    if (!Number.isFinite(miss)) continue

    const s = interpolateAt(self.states, tca)
    if (!s) continue
    orbitStateAt(orbs[k], (tca - catalogT) / 1000, rBuf, vBuf)
    const relSpeed = Math.hypot(vBuf[0] - s.v[0], vBuf[1] - s.v[1], vBuf[2] - s.v[2])

    const pc = collisionProbability({
      missKm: miss,
      relSpeedKmS: relSpeed,
      covSelf: covNear(self.states, tca),
      covOther: null,
      hardBodyKm: opt.hardBodyKm,
      regime
    })

    if (!(miss <= maxDist || pc >= opt.pcThreshold)) continue

    const missScore = Math.min(1, Math.max(0, 1 - miss / maxDist))
    const pcScore = pc > 0 ? Math.min(1, Math.max(0, 1 + Math.log10(pc) / 12)) : 0
    const risk = Math.max(missScore, pcScore)
    // 等级阈值随「报告距离」缩放：<10% 报告距离 = 高危，<30% = 警告，其余为关注
    const level: ThreatEvent['level'] =
      pc > 1e-4 || miss < maxDist * 0.1
        ? 'high'
        : pc > 1e-6 || miss < maxDist * 0.3
          ? 'medium'
          : 'low'

    events.push({
      id: `${self.id}-${other.norad}-${tca}`,
      selfNorad: self.norad,
      otherNorad: other.norad,
      otherName: other.name,
      tca,
      missKm: miss,
      relSpeedKmS: relSpeed,
      pc,
      risk,
      level,
      midEci: [s.r[0], s.r[1], s.r[2]],
      otherEci: [rBuf[0], rBuf[1], rBuf[2]],
      otherVel: [vBuf[0], vBuf[1], vBuf[2]]
    })
    if (onProgress && done % 20 === 0) {
      onProgress(0.7 + 0.3 * (done / candidates.size))
    }
  }

  if (onProgress) onProgress(1)
  events.sort((a, b) => a.missKm - b.missKm)
  return events.slice(0, maxEvents)
}

/* ============================================================
 * 单对重筛（机动前后对比）
 * ============================================================ */

/** 对手在某一时刻（通常取其 TCA 状态）的 ECI 状态：二体推进不需要原始目录历元 */
export interface PairTarget {
  norad: number
  name: string
  r: Vec3
  v: Vec3
  /** r/v 对应的时刻（Unix ms） */
  epochT: number
}

/** 单对重筛结果 */
export interface PairScreenResult {
  tca: number
  missKm: number
  relSpeedKmS: number
  pc: number
}

/** 一对目标的机动前 / 机动后对比行 */
export interface PairCompareRow {
  norad: number
  name: string
  before: PairScreenResult
  after: PairScreenResult | null
}

/** 单对重筛的时间扫描步长（秒）：Top-20 × 24h 仅约 2.9 万次推进，可在 Worker 内毫秒级完成 */
const PAIR_SCAN_SEC = 60

/**
 * 单对快速重筛：只对一个对手做粗扫 + 细化，输出 TCA / 最小距离 / 相对速度 / Pc。
 * 与全量筛选共用二体推进、精筛与 Pc 模型，保证「机动前」与「机动后」同口径可比。
 */
export function screenPair(
  self: { id: string; norad: number; states: EphemState[] },
  other: PairTarget,
  opt: ScreenOptions
): PairScreenResult | null {
  const states = self.states
  if (!states.length || !(opt.t1 > opt.t0)) return null
  const orb = buildOrbit(other.r, other.v)
  if (!orb.ok) return null
  const regime = regimeOf(elementsFromRV(states[0].r, states[0].v).a)

  const rBuf: Vec3 = [0, 0, 0]
  const vBuf: Vec3 = [0, 0, 0]
  const distAt = (t: number): number => {
    const s = interpolateAt(states, t)
    if (!s) return Infinity
    orbitStateAt(orb, (t - other.epochT) / 1000, rBuf, vBuf)
    return Math.hypot(rBuf[0] - s.r[0], rBuf[1] - s.r[1], rBuf[2] - s.r[2])
  }

  const stepMs = PAIR_SCAN_SEC * 1000
  let bestT = opt.t0
  let bestD = Infinity
  // 与全量筛选一致：按步内「线性相对运动最近点」判据取样，否则 60s 网格会漏掉
  // 十几公里级的快速飞掠（9 km/s 相对速度下接近持续时间只有几秒）
  for (let t = opt.t0; t <= opt.t1; t += stepMs) {
    const s = interpolateAt(states, t)
    if (!s) continue
    orbitStateAt(orb, (t - other.epochT) / 1000, rBuf, vBuf)
    const rx = rBuf[0] - s.r[0]
    const ry = rBuf[1] - s.r[1]
    const rz = rBuf[2] - s.r[2]
    const vx = vBuf[0] - s.v[0]
    const vy = vBuf[1] - s.v[1]
    const vz = vBuf[2] - s.v[2]
    const vv = vx * vx + vy * vy + vz * vz
    let tau = vv > 1e-9 ? -(rx * vx + ry * vy + rz * vz) / vv : 0
    if (tau < 0) tau = 0
    else if (tau > PAIR_SCAN_SEC) tau = PAIR_SCAN_SEC
    const cx = rx + vx * tau
    const cy = ry + vy * tau
    const cz = rz + vz * tau
    const dmin = Math.sqrt(cx * cx + cy * cy + cz * cz)
    if (dmin < bestD) {
      bestD = dmin
      bestT = t + tau * 1000
    }
  }
  if (!Number.isFinite(bestD)) return null

  const { tca, miss } = refineTca(distAt, Math.max(opt.t0, bestT - stepMs), Math.min(opt.t1, bestT + stepMs))
  const s = interpolateAt(states, tca)
  if (!s || !Number.isFinite(miss)) return null
  orbitStateAt(orb, (tca - other.epochT) / 1000, rBuf, vBuf)
  const relSpeed = Math.hypot(vBuf[0] - s.v[0], vBuf[1] - s.v[1], vBuf[2] - s.v[2])
  const pc = collisionProbability({
    missKm: miss,
    relSpeedKmS: relSpeed,
    covSelf: covNear(states, tca),
    covOther: null,
    hardBodyKm: opt.hardBodyKm,
    regime
  })
  return { tca, missKm: miss, relSpeedKmS: relSpeed, pc }
}
