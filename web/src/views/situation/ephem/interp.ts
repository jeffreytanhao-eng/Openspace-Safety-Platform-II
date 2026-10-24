import type { EphemState, Vec3 } from './types'

/** 二分查到满足 states[i].t <= tMs 的最大下标，若 tMs 早于首点返回 -1 */
function searchIndex(states: EphemState[], tMs: number): number {
  let lo = 0
  let hi = states.length - 1
  if (tMs < states[0].t) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (states[mid].t <= tMs) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * 在星历序列上做三次 Hermite 插值（位置切向取 v·h），不外推。
 * 越界返回 null。
 */
export function interpolateAt(
  states: EphemState[],
  tMs: number
): { r: Vec3; v: Vec3 } | null {
  const n = states.length
  if (n === 0 || !Number.isFinite(tMs)) return null
  if (n === 1) {
    return tMs === states[0].t ? { r: [...states[0].r], v: [...states[0].v] } : null
  }
  if (tMs < states[0].t || tMs > states[n - 1].t) return null

  const i = searchIndex(states, tMs)
  if (i < 0) return null
  if (i >= n - 1) {
    const last = states[n - 1]
    return { r: [...last.r], v: [...last.v] }
  }

  const a = states[i]
  const b = states[i + 1]
  const dtMs = b.t - a.t
  if (dtMs <= 0) return { r: [...a.r], v: [...a.v] }
  const u = (tMs - a.t) / dtMs
  const hSec = dtMs / 1000

  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const d00 = 6 * u2 - 6 * u
  const d10 = 3 * u2 - 4 * u + 1
  const d01 = -6 * u2 + 6 * u
  const d11 = 3 * u2 - 2 * u

  const r: Vec3 = [0, 0, 0]
  const v: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const p0 = a.r[k]
    const p1 = b.r[k]
    const m0 = a.v[k] * hSec
    const m1 = b.v[k] * hSec
    r[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
    v[k] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / hSec
  }
  return { r, v }
}

/** 按固定步长采样位置点，供画轨迹线（越界部分自动截断） */
export function sampleTrack(
  states: EphemState[],
  t0: number,
  t1: number,
  stepMs: number
): Vec3[] {
  const out: Vec3[] = []
  if (!states.length || !(stepMs > 0)) return out
  const from = Math.max(Math.min(t0, t1), states[0].t)
  const to = Math.min(Math.max(t0, t1), states[states.length - 1].t)
  if (to < from) return out
  const maxPoints = 200000
  let count = 0
  for (let t = from; t <= to && count < maxPoints; t += stepMs) {
    const s = interpolateAt(states, t)
    if (s) out.push(s.r)
    count++
  }
  // 补齐终点，避免末段缺失
  if (out.length) {
    const end = interpolateAt(states, to)
    const last = out[out.length - 1]
    if (end && Math.hypot(last[0] - end.r[0], last[1] - end.r[1], last[2] - end.r[2]) > 1e-9) {
      out.push(end.r)
    }
  }
  return out
}
