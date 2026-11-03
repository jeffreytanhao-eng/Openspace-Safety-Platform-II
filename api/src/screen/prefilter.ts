/**
 * 粗筛前置过滤（P2-1）：近/远地点高度区间不重叠的直接排除。
 * 余量 PAD_KM=50 覆盖 TLE 根数误差与摄动引起的半径变化。
 */
import type { CatalogObject, EphTrack } from './types.js'

export const PAD_KM = 50

/** 星历轨迹的半径范围 → 近/远地点高度（km，相对赤道半径） */
export function trackApsis(track: EphTrack, earthRadiusKm = 6378.137): { perigee: number; apogee: number } {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < track.n; i++) {
    const x = track.r[i * 3]
    const y = track.r[i * 3 + 1]
    const z = track.r[i * 3 + 2]
    const rad = Math.hypot(x, y, z)
    if (rad < min) min = rad
    if (rad > max) max = rad
  }
  if (!Number.isFinite(min)) return { perigee: 0, apogee: 0 }
  return { perigee: min - earthRadiusKm, apogee: max - earthRadiusKm }
}

/** 区间是否可能重叠（带余量） */
export function apsisOverlap(
  a: { perigee: number; apogee: number },
  b: { perigee: number; apogee: number },
  pad = PAD_KM
): boolean {
  return a.perigee - pad <= b.apogee + pad && b.perigee - pad <= a.apogee + pad
}

/** 按区间过滤出每个主星可用的副星下标（结果按主星缓存） */
export function prefilter(
  primaries: EphTrack[],
  catalog: CatalogObject[],
  pad = PAD_KM
): { apsis: { perigee: number; apogee: number }[]; allowed: number[][] } {
  const apsis = primaries.map((p) => trackApsis(p))
  const allowed = primaries.map((_, i) =>
    catalog.reduce<number[]>((acc, c, j) => {
      if (apsisOverlap(apsis[i], { perigee: c.perigeeKm, apogee: c.apogeeKm }, pad)) acc.push(j)
      return acc
    }, [])
  )
  return { apsis, allowed }
}
