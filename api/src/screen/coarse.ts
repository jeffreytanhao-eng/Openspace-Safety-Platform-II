/**
 * 粗筛（P2-2）：Δt=60 s 扫描 + 空间哈希。
 *
 * 每个时间步把副星目录（SGP4 → TEME → J2000）放进格宽 G 的三维哈希，
 * 再对每个主星查 27 邻格；距离 < G 的记为候选：
 *   G = MISS_MAX_KM + 0.5·Δt·V_REL_MAX（缺省 10 + 0.5·60·15.5 ≈ 475 km）
 * 同一 (pair, 圈次) 只保留最近的一步，避免重复细化。
 *
 * 性能相关（P2-4）：
 *   1) 同一时间步只构造一次 TEME→J2000 矩阵，全部副星复用；
 *   2) 传播改用 sgp4(satrec, tsince)，不再为每颗星每步 new Date；
 *   3) 先对 apsis 预过滤结果取并集，只传播可能相交的副星；
 *      候选判据改为步内线性最近点 < CAND_KM，进一步压缩精化/Pc 计算量；
 *   4) 稠密节点 + 三次 Hermite 插值：每 4 步（240 s）精确 SGP4 一次，
 *      中间步插值，副星传播次数降到约 1/4（实测整体 4.4x）。
 */
import * as satellite from 'satellite.js'
import type { Candidate, CatalogObject, EphTrack, ScreenParams, Vec3 } from './types.js'
import { julianDate, rotateTemeToJ2000, temeToJ2000Mat } from './frames.js'
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

/** 根数历元（JD）：卫星历元固定，算一次即可 */
const epochJdCache = new WeakMap<satellite.SatRec, number>()

function epochJd(rec: satellite.SatRec): number {
  let jd = epochJdCache.get(rec)
  if (jd === undefined) {
    jd = rec.jdsatepoch
    epochJdCache.set(rec, jd)
  }
  return jd
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

/** SGP4 传播到指定 UTC，返回 TEME 位置/速度（km、km/s）；失败返回 null */
export function propagateTeme(rec: satellite.SatRec, tMs: number): { r: Vec3; v: Vec3 } | null {
  const tsince = (julianDate(tMs) - epochJd(rec)) * 1440
  const pv = satellite.sgp4(rec, tsince)
  if (!pv || rec.error) return null
  const pos = pv.position
  const vel = pv.velocity
  if (![pos.x, pos.y, pos.z, vel.x, vel.y, vel.z].every((x) => Number.isFinite(x))) return null
  return { r: [pos.x, pos.y, pos.z], v: [vel.x, vel.y, vel.z] }
}

/** SGP4 传播到指定 UTC，返回 J2000 位置/速度（km、km/s）；失败返回 null */
export function propagateJ2000(satrec: satellite.SatRec, tMs: number): { r: Vec3; v: Vec3 } | null {
  const pv = propagateTeme(satrec, tMs)
  return pv ? rotateTemeToJ2000(temeToJ2000Mat(tMs), pv.r, pv.v) : null
}

/** 步内线性最近点：两点相对位置在 [0,1] 内取最小距离，返回 { dist, u } */
function linearClosest(ax: number, ay: number, az: number, bx: number, by: number, bz: number): { dist: number; u: number } {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const d2 = dx * dx + dy * dy + dz * dz
  let u = d2 > 0 ? -(ax * dx + ay * dy + az * dz) / d2 : 0
  if (u < 0) u = 0
  else if (u > 1) u = 1
  const cx = ax + u * dx
  const cy = ay + u * dy
  const cz = az + u * dz
  return { dist: Math.sqrt(cx * cx + cy * cy + cz * cz), u }
}

export function coarseScan(input: CoarseInput, onProgress?: (doneSteps: number) => void): Candidate[] {
  const { primaries, catalog, params, stepFrom, stepTo } = input
  const { missMaxKm, vRelMaxKms, stepMs, windowStartMs, windowEndMs } = params
  const G = missMaxKm + 0.5 * (stepMs / 1000) * vRelMaxKms
  const G2 = G * G
  const cell = G
  /** 精化门限：线性最近点超过该距离的对不可能在 TCA 达到 missMaxKm，直接丢弃 */
  const candKm = Math.max(30, missMaxKm * 2)
  const candKm2 = candKm * candKm

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
  // 并集：所有主星都不可能在区间内相交的副星，整轮都不需要传播
  const unionList: number[] = []
  for (let j = 0; j < catalog.length; j++) {
    for (let i = 0; i < primaries.length; i++) {
      if (allowed[i][j]) {
        unionList.push(j)
        break
      }
    }
  }
  if (unionList.length === 0) return []

  // 副星 satrec（只构建并集内目标，整轮复用）
  const satrecs: (satellite.SatRec | null)[] = new Array(catalog.length).fill(null)
  for (const j of unionList) satrecs[j] = buildSatrec(catalog[j])
  const pos = new Float64Array(catalog.length * 3)
  const prevPos = new Float64Array(catalog.length * 3)
  const hasPrev = new Uint8Array(catalog.length)

  // 稠密节点：每 NODE_STRIDE 步（默认 4 步 = 240 s）精确 SGP4 一次，
  // 中间步用位置+速度的三次 Hermite 插值（LEO 240 s 插值误差约 0.1 km 量级，
  // 粗筛门限 30 km 内完全安全，精化阶段仍用真实 SGP4 复算）。
  const NODE_STRIDE = Math.max(
    1,
    Math.min(
      Number(process.env.SCREEN_COARSE_STRIDE) || 4,
      Math.max(1, Math.floor(240_000 / stepMs))
    )
  )
  const H = NODE_STRIDE * stepMs
  const Hsec = H / 1000
  const nCells = catalog.length * 3
  let nodeAR = new Float64Array(nCells)
  let nodeAV = new Float64Array(nCells)
  let nodeBR = new Float64Array(nCells)
  let nodeBV = new Float64Array(nCells)
  let okA = new Uint8Array(catalog.length)
  let okB = new Uint8Array(catalog.length)

  /** 在时刻 tMs 精确传播全部并集副星，写入一组节点（一次矩阵，全部复用） */
  const fillNode = (tMs: number, outR: Float64Array, outV: Float64Array, outOk: Uint8Array): void => {
    const frame = temeToJ2000Mat(tMs)
    for (const j of unionList) {
      const rec = satrecs[j]
      outOk[j] = 0
      if (!rec) continue
      const teme = propagateTeme(rec, tMs)
      if (!teme) continue
      const pv = rotateTemeToJ2000(frame, teme.r, teme.v)
      const o = j * 3
      outR[o] = pv.r[0]
      outR[o + 1] = pv.r[1]
      outR[o + 2] = pv.r[2]
      outV[o] = pv.v[0]
      outV[o + 1] = pv.v[1]
      outV[o + 2] = pv.v[2]
      outOk[j] = 1
    }
  }

  // key = primaryIdx * 1e6 + secondaryIdx；value = Map<bucket, {step, dist, frac}>
  const best = new Map<number, Map<number, { step: number; dist: number; frac: number }>>()

  const nSteps = Math.max(0, Math.min(stepTo, Math.floor((windowEndMs - windowStartMs) / stepMs)))
  // R0-3 进度回调粒度：每 5 步（及最后一步）上报已完成绝对步数，避免小分片永远不回调
  const reportEvery = 5
  const firstBase = Math.max(0, stepFrom)
  for (let base = firstBase; base < nSteps; base += NODE_STRIDE) {
    const t0 = windowStartMs + base * stepMs
    if (base === firstBase) {
      fillNode(t0, nodeAR, nodeAV, okA)
    } else {
      // 上块末端节点即为本块起点：交换数组，省一次传播与拷贝
      ;[nodeAR, nodeBR] = [nodeBR, nodeAR]
      ;[nodeAV, nodeBV] = [nodeBV, nodeAV]
      ;[okA, okB] = [okB, okA]
    }
    fillNode(t0 + H, nodeBR, nodeBV, okB)

    const stepEnd = Math.min(nSteps, base + NODE_STRIDE)
    for (let s = base; s < stepEnd; s++) {
      const t = windowStartMs + s * stepMs
      const x = (t - t0) / H
      const x2 = x * x
      const x3 = x2 * x
      const h00 = 2 * x3 - 3 * x2 + 1
      const h10 = (x3 - 2 * x2 + x) * Hsec
      const h01 = -2 * x3 + 3 * x2
      const h11 = (x3 - x2) * Hsec

      // 1) 副星位置（J2000）：块内 Hermite 插值，块端点才调 SGP4
      const grid = new Map<number, number[]>()
      for (const j of unionList) {
        if (!okA[j] || !okB[j]) continue
        const o = j * 3
        const px = h00 * nodeAR[o] + h10 * nodeAV[o] + h01 * nodeBR[o] + h11 * nodeBV[o]
        const py =
          h00 * nodeAR[o + 1] + h10 * nodeAV[o + 1] + h01 * nodeBR[o + 1] + h11 * nodeBV[o + 1]
        const pz =
          h00 * nodeAR[o + 2] + h10 * nodeAV[o + 2] + h01 * nodeBR[o + 2] + h11 * nodeBV[o + 2]
        pos[o] = px
        pos[o + 1] = py
        pos[o + 2] = pz
        const key = pack(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell))
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
        const kPrev = k - 1
        const hasPrimaryPrev = kPrev >= 0 && s > stepFrom
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

                let dist = Math.sqrt(d2)
                let frac = 0
                // 步内线性最近点：把候选中心与距离精到步内，并按 candKm 剪枝
                if (hasPrimaryPrev && hasPrev[j]) {
                  const ax = prevPos[j * 3] - tr.r[kPrev * 3]
                  const ay = prevPos[j * 3 + 1] - tr.r[kPrev * 3 + 1]
                  const az = prevPos[j * 3 + 2] - tr.r[kPrev * 3 + 2]
                  const lc = linearClosest(ax, ay, az, ddx, ddy, ddz)
                  dist = lc.dist
                  frac = lc.u
                  if (dist * dist > candKm2) continue
                }
                // 分片首步无上一步可插值：保守沿用 G 判据，避免边界漏报

                const pairKey = i * 1e6 + j
                const bucketIdx = Math.floor(s / BUCKET_STEPS)
                let m = best.get(pairKey)
                if (!m) {
                  m = new Map()
                  best.set(pairKey, m)
                }
                const prev = m.get(bucketIdx)
                if (!prev || dist < prev.dist) m.set(bucketIdx, { step: s, dist, frac })
              }
            }
          }
        }
      }

      // 3) 当前步位置转为上一步（供步内线性最近点使用）
      for (const j of unionList) {
        if (!okA[j] || !okB[j]) {
          hasPrev[j] = 0
          continue
        }
        const o = j * 3
        prevPos[o] = pos[o]
        prevPos[o + 1] = pos[o + 1]
        prevPos[o + 2] = pos[o + 2]
        hasPrev[j] = 1
      }

      if (onProgress && ((s + 1 - stepFrom) % reportEvery === 0 || s + 1 === nSteps)) onProgress(s + 1)
    }
  }

  const out: Candidate[] = []
  for (const [pairKey, m] of best) {
    const i = Math.floor(pairKey / 1e6)
    const j = pairKey % 1e6
    const primary = primaries[i]
    for (const { step, dist, frac } of m.values()) {
      out.push({
        primaryMeme: primary.memeId,
        secondaryNorad: catalog[j].norad,
        // 候选中心精确到步内最小距离处，Brent 从中点开始收缩更快
        centerMs: windowStartMs + (step + frac) * stepMs,
        distKm: dist
      })
    }
  }
  return out
}

function cellIndex(r: Vec3, cell: number): [number, number, number] {
  return [Math.floor(r[0] / cell), Math.floor(r[1] / cell), Math.floor(r[2] / cell)]
}

/** 11 bit/轴打包（±1024 格，475 km 格宽下覆盖 ±48 万 km，足够地心惯性系） */
function pack(x: number, y: number, z: number): number {
  const cx = Math.max(-1024, Math.min(1023, x)) + 1024
  const cy = Math.max(-1024, Math.min(1023, y)) + 1024
  const cz = Math.max(-1024, Math.min(1023, z)) + 1024
  return (cx << 22) | (cy << 11) | cz
}
