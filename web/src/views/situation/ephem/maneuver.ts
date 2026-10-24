import type { EphemState, Vec3 } from './types'
import { interpolateAt } from './interp'
import { twoBodyPropagate } from './screening'

/** 由状态构造 RTN 基：R = r̂，N = (r×v)/|r×v|，T = N×R */
function rtnBasis(r: Vec3, v: Vec3): { R: Vec3; T: Vec3; N: Vec3 } {
  const rn = Math.hypot(r[0], r[1], r[2]) || 1
  const R: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn]
  const hx = r[1] * v[2] - r[2] * v[1]
  const hy = r[2] * v[0] - r[0] * v[2]
  const hz = r[0] * v[1] - r[1] * v[0]
  const hn = Math.hypot(hx, hy, hz) || 1
  const N: Vec3 = [hx / hn, hy / hn, hz / hn]
  const T: Vec3 = [
    N[1] * R[2] - N[2] * R[1],
    N[2] * R[0] - N[0] * R[2],
    N[0] * R[1] - N[1] * R[0]
  ]
  return { R, T, N }
}

function cloneState(st: EphemState): EphemState {
  const out: EphemState = { t: st.t, r: [st.r[0], st.r[1], st.r[2]], v: [st.v[0], st.v[1], st.v[2]] }
  if (st.cov) out.cov = new Float64Array(st.cov)
  return out
}

/**
 * 脉冲机动：在 atMs 处按 RTN 基施加 Δv（单位 m/s，分量顺序 [R, T, N]）。
 *
 * 位置增量用「二体差传播」估计：分别从机动时刻的原始状态与加速后状态做二体推进，
 * 把两者之差叠加到原星历上。这样既保留星历本身的绝对精度（J2、大气等摄动都在星历里），
 * 又能让机动后的轨迹真实偏离（只改速度不推位置的话，24 小时内位置几乎不动）。
 */
export function applyImpulse(states: EphemState[], atMs: number, dvRtn: Vec3): EphemState[] {
  const out = states.map(cloneState)
  const s = interpolateAt(states, atMs)
  if (!s) return out
  const { R, T, N } = rtnBasis(s.r, s.v)
  const dR = dvRtn[0] / 1000
  const dT = dvRtn[1] / 1000
  const dN = dvRtn[2] / 1000
  const dv: Vec3 = [
    R[0] * dR + T[0] * dT + N[0] * dN,
    R[1] * dR + T[1] * dT + N[1] * dN,
    R[2] * dR + T[2] * dT + N[2] * dN
  ]
  const vNew: Vec3 = [s.v[0] + dv[0], s.v[1] + dv[1], s.v[2] + dv[2]]
  for (const st of out) {
    if (st.t < atMs) continue
    const dtSec = (st.t - atMs) / 1000
    const ref = dtSec > 0 ? twoBodyPropagate(s.r, s.v, dtSec) : null
    const man = dtSec > 0 ? twoBodyPropagate(s.r, vNew, dtSec) : null
    if (ref && man) {
      // 机动后的位置 / 速度 = 原星历 + 二体差传播增量
      st.r = [st.r[0] + man.r[0] - ref.r[0], st.r[1] + man.r[1] - ref.r[1], st.r[2] + man.r[2] - ref.r[2]]
      st.v = [st.v[0] + man.v[0] - ref.v[0], st.v[1] + man.v[1] - ref.v[1], st.v[2] + man.v[2] - ref.v[2]]
    } else {
      st.v = [st.v[0] + dv[0], st.v[1] + dv[1], st.v[2] + dv[2]]
    }
  }
  return out
}

/** 沿单一方向（T/R/N）按步长枚举 Δv，生成候选机动星历 */
export function maneuverGrid(
  states: EphemState[],
  atMs: number,
  dir: 'T' | 'R' | 'N',
  fromMps: number,
  toMps: number,
  stepMps: number
): { dvMps: number; states: EphemState[] }[] {
  const out: { dvMps: number; states: EphemState[] }[] = []
  if (!(stepMps > 0) || !Number.isFinite(fromMps) || !Number.isFinite(toMps)) return out
  const lo = Math.min(fromMps, toMps)
  const hi = Math.max(fromMps, toMps)
  const maxCount = 1000
  let count = 0
  for (let dv = lo; dv <= hi + 1e-9 && count < maxCount; dv += stepMps, count++) {
    const vec: Vec3 = dir === 'R' ? [dv, 0, 0] : dir === 'T' ? [0, dv, 0] : [0, 0, dv]
    out.push({ dvMps: dv, states: applyImpulse(states, atMs, vec) })
  }
  return out
}
