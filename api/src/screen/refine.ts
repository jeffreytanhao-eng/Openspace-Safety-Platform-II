/**
 * TCA 细化（P2-3）
 * 主星用三次 Hermite（位置 + 速度）插值，副星逐次调用 SGP4（或星历插值），
 * 在候选 ±Δt 内用 Brent 方法最小化 d(t)，容差 1 ms。
 */
import type { EphTrack, Vec3 } from './types.js'
import { cross, dot, norm3 } from './frames.js'

export interface RefineInput {
  primary: EphTrack
  /** 副星位置（J2000 km）/速度（km/s）取数函数，返回 null 表示该时刻无解 */
  secondary: (tMs: number) => { r: Vec3; v: Vec3 } | null
  centerMs: number
  stepMs: number
}

export interface RefineResult {
  tcaMs: number
  missKm: number
  miss: Vec3
  /** 本星（主星）与对方在 TCA 处的位置、速度（J2000） */
  rP: Vec3
  vP: Vec3
  rS: Vec3
  vS: Vec3
}

/** 主星 Hermite 插值（s∈[0,1] 落在区间 [k, k+1]） */
export function hermitePrimary(track: EphTrack, tMs: number): { r: Vec3; v: Vec3 } | null {
  const x = (tMs - track.startMs) / track.stepMs
  const k = Math.floor(x)
  if (k < 0 || k + 1 >= track.n) return null
  const s = x - k
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  const dt = track.stepMs / 1000
  const out = { r: [0, 0, 0] as Vec3, v: [0, 0, 0] as Vec3 }
  const d00 = (6 * s2 - 6 * s) / dt
  const d10 = 3 * s2 - 4 * s + 1
  const d01 = (-6 * s2 + 6 * s) / dt
  const d11 = 3 * s2 - 2 * s
  for (let i = 0; i < 3; i++) {
    const r0 = track.r[k * 3 + i]
    const r1 = track.r[(k + 1) * 3 + i]
    const v0 = track.v[k * 3 + i]
    const v1 = track.v[(k + 1) * 3 + i]
    out.r[i] = h00 * r0 + h10 * dt * v0 + h01 * r1 + h11 * dt * v1
    out.v[i] = d00 * r0 + d10 * v0 + d01 * r1 + d11 * v1
  }
  return out
}

function sqDist(pa: { r: Vec3 }, ps: { r: Vec3 }): number {
  const dx = ps.r[0] - pa.r[0]
  const dy = ps.r[1] - pa.r[1]
  const dz = ps.r[2] - pa.r[2]
  return dx * dx + dy * dy + dz * dz
}

/** 标准 Brent 求极小（容差 tolMs，毫秒） */
export function brentMin(f: (t: number) => number, a: number, b: number, tolMs = 1): number {
  const golden = 0.3819660112501051
  let x = a + golden * (b - a)
  let w = x
  let v = x
  let fx = f(x)
  let fw = fx
  let fv = fx
  let d = 0
  let e = 0
  const eps = 1e-12
  for (let iter = 0; iter < 100; iter++) {
    const m = 0.5 * (a + b)
    const tol1 = tolMs * 0.5
    if (Math.abs(x - m) <= tol1 - 0.5 * (b - a)) break
    let useGolden = true
    if (Math.abs(e) > eps) {
      const r = (x - w) * (fx - fv)
      let q = (x - v) * (fx - fw)
      let p = (x - v) * q - (x - w) * r
      q = 2 * (q - r)
      if (q > 0) p = -p
      q = Math.abs(q)
      const etemp = e
      e = d
      if (Math.abs(p) < Math.abs(0.5 * q * etemp) && p > q * (a - x) && p < q * (b - x)) {
        d = p / q
        const u = x + d
        if (u - a < 2 * tol1 || b - u < 2 * tol1) d = x < m ? tol1 : -tol1
        useGolden = false
      }
    }
    if (useGolden) {
      e = x < m ? b - x : a - x
      d = golden * e
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + Math.sign(d) * tol1
    const fu = f(u)
    if (fu <= fx) {
      if (u < x) b = x
      else a = x
      v = w
      fv = fw
      w = x
      fw = fx
      x = u
      fx = fu
    } else {
      if (u < x) a = u
      else b = u
      if (fu <= fw || w === x) {
        v = w
        fv = fw
        w = u
        fw = fu
      } else if (fu <= fv || v === x || v === w) {
        v = u
        fv = fu
      }
    }
  }
  return x
}

export function refineCandidate(input: RefineInput): RefineResult | null {
  const { primary, secondary, centerMs, stepMs } = input
  const tMin = Math.max(primary.startMs, centerMs - stepMs)
  const tMax = Math.min(primary.startMs + (primary.n - 1) * primary.stepMs, centerMs + stepMs)
  if (!(tMax > tMin)) return null

  const f = (t: number): number => {
    const p = hermitePrimary(primary, t)
    if (!p) return Number.POSITIVE_INFINITY
    const s = secondary(t)
    if (!s) return Number.POSITIVE_INFINITY
    return sqDist(p, s)
  }

  const tcaMs = brentMin(f, tMin, tMax, 1)
  const p = hermitePrimary(primary, tcaMs)
  const s = secondary(tcaMs)
  if (!p || !s) return null
  const miss: Vec3 = [s.r[0] - p.r[0], s.r[1] - p.r[1], s.r[2] - p.r[2]]
  return { tcaMs, missKm: norm3(miss), miss, rP: p.r, vP: p.v, rS: s.r, vS: s.v }
}

/** 相对位置在 RTN（径向 R / 沿迹 T / 法向 N）上的分量（km） */
export function missRTN(rP: Vec3, vP: Vec3, miss: Vec3): { r: number; t: number; n: number } {
  const rn = norm3(rP) || 1
  const R: Vec3 = [rP[0] / rn, rP[1] / rn, rP[2] / rn]
  const h = cross(rP, vP)
  const hn = norm3(h) || 1
  const N: Vec3 = [h[0] / hn, h[1] / hn, h[2] / hn]
  const T = cross(N, R)
  return { r: dot(miss, R), t: dot(miss, T), n: dot(miss, N) }
}
