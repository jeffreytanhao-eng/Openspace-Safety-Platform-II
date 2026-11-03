/**
 * 粗筛（P2-2）：Δt=60 s 扫描 + 空间哈希。
 *
 * 每个时间步把副星目录（SGP4 → TEME → J2000）放进格宽 G 的三维哈希，
 * 再对每个主星查 27 邻格；距离 < G 的记为候选：
 *   G = MISS_MAX_KM + 0.5·Δt·V_REL_MAX（缺省 10 + 0.5·60·15.5 ≈ 475 km）
 * 同一 (pair, 圈次) 只保留最近的一步，避免重复细化。
 */
import * as satellite from 'satellite.js'
import type { Candidate, CatalogObject, EphTrack, ScreenParams, Vec3 } from './types.js'
import { temeToJ2000 } from './frames.js'
import { apsisOverlap, trackApsis } from './prefilter.js'

export interface CoarseInput {
  primaries: EphTrack[]
  catalog: CatalogObject[]
  params: ScreenParams
  /** 只要该下标区间的步长（worker 分片） */
  stepFrom: number
  stepTo: number
}

/** 每圈约 90 min，用于把同一 pair 的不同圈次拆成独立候选 */
const BUCKET_STEPS = 90

interface Satrec {
  satrec: satellite.SatRec
  epochMs: number
}

export function buildSatrec(obj: CatalogObject): satellite.SatRec | null {
  try {
    const r = satellite.twoline2satrec(obj.line1, obj.line2)
    if (!r || (r as unknown as { error: number }).error) return null
    return r
  } catch {
    return null
  }
}

/** SGP4 传播到指定 UTC，返回 J2000 位置/速度（km、km/s）；失败返回 null */
export function propagateJ2000(satrec: satellite.SatRec, tMs: number): { r: Vec3; v: Vec3 } | null {
  const pv = satellite.propagate(satrec, new Date(tMs))
  const pos = pv?.position as { x: number; y: number; z: number } | undefined
  const vel = pv?.velocity as { x: number; y: number; z: number } | undefined
  if (!pos || !vel) return null
  if (![pos.x, pos.y, pos.z, vel.x, vel.y, vel.z].every((x) => Number.isFinite(x))) return null
  return temeToJ2000([pos.x, pos.y, pos.z], [vel.x, vel.y, vel.z], tMs)
}

export function coarseScan(input: CoarseInput): Candidate[] {
  const { primaries, catalog, params, stepFrom, stepTo } = input
  const { missMaxKm, vRelMaxKms, stepMs, windowStartMs, windowEndMs } = params
  const G = missMaxKm + 0.5 * (stepMs / 1000) * vRelMaxKms
  const G2 = G * G
  const cell = G

  const tracks = primaries.map((p) => trackApsis(p))
  // 预过滤：每个主星只扫区间可能重叠的副星（用位图，避免热循环里 O(n) 查找）
  const allowed: Uint8Array[] = primaries.map((_, i) => {
    const mask = new Uint8Array(catalog.length)
    for (let j = 0; j < catalog.length; j++) {
      const c = catalog[j]
      mask[j] = apsisOverlap(tracks[i], { perigee: c.perigeeKm, apogee: c.apogeeKm }) ? 1 : 0
    }
    return mask
  })

  // 副星 satrec（构建一次，整轮复用）
  const satrecs: (satellite.SatRec | null)[] = catalog.map((c) => buildSatrec(c))
  const pos = new Float64Array(catalog.length * 3)

  // key = primaryIdx * 1e6 + secondaryIdx；value = Map<bucket, {step, dist}>
  const best = new Map<number, Map<number, { step: number; dist: number }>>()

  const nSteps = Math.max(0, Math.min(stepTo, Math.floor((windowEndMs - windowStartMs) / stepMs)))
  for (let s = Math.max(0, stepFrom); s < nSteps; s++) {
    const t = windowStartMs + s * stepMs

    // 1) 副星位置（J2000）
    const grid = new Map<number, number[]>()
    for (let j = 0; j < catalog.length; j++) {
      const rec = satrecs[j]
      if (!rec) continue
      const pv = propagateJ2000(rec, t)
      if (!pv) continue
      pos[j * 3] = pv.r[0]
      pos[j * 3 + 1] = pv.r[1]
      pos[j * 3 + 2] = pv.r[2]
      const key = cellKey(pv.r, cell)
      const bucket = grid.get(key)
      if (bucket) bucket.push(j)
      else grid.set(key, [j])
    }

    // 2) 主星查邻格
    for (let i = 0; i < primaries.length; i++) {
      const tr = primaries[i]
      const k = Math.round((t - tr.startMs) / tr.stepMs)
      if (k < 0 || k >= tr.n) continue
      const pr: Vec3 = [tr.r[k * 3], tr.r[k * 3 + 1], tr.r[k * 3 + 2]]
      const [cx, cy, cz] = cellIndex(pr, cell)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(pack(cx + dx, cy + dy, cz + dz))
            if (!bucket) continue
            for (const j of bucket) {
              if (allowed[i][j] === 0) continue
              const ddx = pos[j * 3] - pr[0]
              const ddy = pos[j * 3 + 1] - pr[1]
              const ddz = pos[j * 3 + 2] - pr[2]
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz
              if (d2 > G2) continue
              const pairKey = i * 1e6 + j
              const bucketIdx = Math.floor(s / BUCKET_STEPS)
              let m = best.get(pairKey)
              if (!m) {
                m = new Map()
                best.set(pairKey, m)
              }
              const prev = m.get(bucketIdx)
              const dist = Math.sqrt(d2)
              if (!prev || dist < prev.dist) m.set(bucketIdx, { step: s, dist })
            }
          }
        }
      }
    }
  }

  const out: Candidate[] = []
  for (const [pairKey, m] of best) {
    const i = Math.floor(pairKey / 1e6)
    const j = pairKey % 1e6
    const primary = primaries[i]
    for (const { step, dist } of m.values()) {
      out.push({
        primaryMeme: primary.memeId,
        secondaryNorad: catalog[j].norad,
        centerMs: windowStartMs + step * stepMs,
        distKm: dist
      })
    }
  }
  return out
}

function cellIndex(r: Vec3, cell: number): [number, number, number] {
  return [Math.floor(r[0] / cell), Math.floor(r[1] / cell), Math.floor(r[2] / cell)]
}

function cellKey(r: Vec3, cell: number): number {
  const [x, y, z] = cellIndex(r, cell)
  return pack(x, y, z)
}

/** 11 bit/轴打包（±1024 格，475 km 格宽下覆盖 ±48 万 km，足够地心惯性系） */
function pack(x: number, y: number, z: number): number {
  const cx = Math.max(-1024, Math.min(1023, x)) + 1024
  const cy = Math.max(-1024, Math.min(1023, y)) + 1024
  const cz = Math.max(-1024, Math.min(1023, z)) + 1024
  return (cx << 22) | (cy << 11) | cz
}
