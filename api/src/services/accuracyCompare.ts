/**
 * G2 精度对比：同一 NORAD 目标两套轨道源在重叠时段的 RTN 残差摘要。
 *
 * 源类型：
 *  - ocm：星历库（ephemeris 表，format='OCM'）的 CCSDS OCM PV 序列（ITRF→ECI，60s 点列）；
 *  - tle：系统编目 sat_tle 最新两行根数 → SGP4 传播（J2000）；
 *  - aoe：AOE 历算 sat_aoe 两行根数 → SGP4 传播（J2000）。
 *
 * 残差口径（与参考项目 tleCompare 一致）：
 *  - 采样时刻以「源 A」为基准：A 为 OCM 时取其点列抽稀，否则在重叠窗内均匀采样；
 *  - RTN 基由源 A 状态定义：R = r̂，N = (r×v)/|r×v|，T = N×R；
 *  - Δr = rB − rA，radial = Δr·R，along = Δr·T，cross = Δr·N；
 *  - RMS = sqrt(mean(x²))，另给总 RMS / 最大偏差 / 平均偏差。
 *
 * TLE/AOE 为根数源，有效窗取历元 [-2d, +3d]（SGP4 根数龄期外精度迅速劣化）；
 * 与 OCM 窗口无交集时明确报「无重叠时段」。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { getRowDb, canViewEphemeris, applyViewerFilter, type EphemViewer } from '../ephem/ephemDb.js'
import { EPH_ROOT } from '../ephem/ingest.js'
import { parseOcmPv, pvAt, type PvState } from '../ephem/parsePv.js'
import { buildSatrec, propagateJ2000 } from '../screen/coarse.js'
import type { Vec3 } from '../screen/types.js'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

export type CompareKind = 'ocm' | 'tle' | 'aoe'

export interface SourceDesc {
  kind: CompareKind
  /** kind='ocm' 时为 ephemeris.id */
  id?: string
}

export interface AccuracySourceItem {
  kind: CompareKind
  id: string
  name: string
  label: string
  epochMs: number
  startMs: number
  stopMs: number
  points: number
  stepSec: number
}

/** TLE/AOE 根数源的有效窗（SGP4 龄期约束） */
const ROOT_EARLY_MS = 2 * 86400000
const ROOT_LATE_MS = 3 * 86400000

/* ---------------------------- 源列举 ---------------------------- */

/** 列出某 NORAD 可参与精度对比的源（OCM 星历 + 系统 TLE + AOE）；OCM 按查看者可见性裁剪 */
export async function listAccuracySources(norad: string, viewer?: EphemViewer | null): Promise<AccuracySourceItem[]> {
  const out: AccuracySourceItem[] = []
  const noradNum = Number(norad)
  if (!Number.isFinite(noradNum) || noradNum <= 0) return out

  const where = [`norad = ?`, `format = 'OCM'`]
  const params: unknown[] = [String(noradNum)]
  applyViewerFilter(viewer, where, params)
  const [ephRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, norad, points, step_sec, start_ms, stop_ms, published_at, originator
     FROM ephemeris WHERE ${where.join(' AND ')}
     ORDER BY published_at DESC LIMIT 50`,
    params
  )
  for (const r of ephRows) {
    out.push({
      kind: 'ocm',
      id: String(r.id),
      name: String(r.name || r.id),
      label: `OCM ${String(r.name || r.id)}`,
      epochMs: Number(r.published_at || r.start_ms || 0),
      startMs: Number(r.start_ms),
      stopMs: Number(r.stop_ms),
      points: Number(r.points),
      stepSec: Number(r.step_sec)
    })
  }

  const [tleRows] = await pool.query<RowDataPacket[]>(
    `SELECT norad_id, object_name, epoch FROM sat_tle WHERE norad_id = ? LIMIT 1`,
    [noradNum]
  )
  if (tleRows.length) {
    const r = tleRows[0]
    const ep = r.epoch ? new Date(r.epoch).getTime() : 0
    out.push({
      kind: 'tle',
      id: 'system_tle',
      name: String(r.object_name || `NORAD ${noradNum}`),
      label: `TLE ${String(r.object_name || '')}`.trim(),
      epochMs: ep,
      startMs: ep - ROOT_EARLY_MS,
      stopMs: ep + ROOT_LATE_MS,
      points: 0,
      stepSec: 0
    })
  }

  const [aoeRows] = await pool.query<RowDataPacket[]>(
    `SELECT norad_id, object_name, epoch FROM sat_aoe WHERE norad_id = ? AND is_active = 1 LIMIT 1`,
    [noradNum]
  )
  if (aoeRows.length) {
    const r = aoeRows[0]
    const ep = r.epoch ? new Date(r.epoch).getTime() : 0
    out.push({
      kind: 'aoe',
      id: 'aoe',
      name: String(r.object_name || `NORAD ${noradNum}`),
      label: `AOE ${String(r.object_name || '')}`.trim(),
      epochMs: ep,
      startMs: ep - ROOT_EARLY_MS,
      stopMs: ep + ROOT_LATE_MS,
      points: 0,
      stepSec: 0
    })
  }

  return out
}

/* ---------------------------- 源加载 ---------------------------- */

interface LoadedSource {
  kind: CompareKind
  label: string
  epochMs: number
  windowStartMs: number
  windowEndMs: number
  /** 时刻状态（ocm：插值；根数：SGP4 传播） */
  at: (tMs: number) => { r: Vec3; v: Vec3 } | null
}

function safeResolveEphFile(rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) return null
  const full = path.resolve(EPH_ROOT, cleaned)
  if (!full.startsWith(EPH_ROOT)) return null
  return full
}

async function loadOcmSource(
  id: string,
  label: string,
  viewer?: EphemViewer | null
): Promise<LoadedSource | null> {
  const row = await getRowDb(id)
  if (!row || row.format !== 'OCM') return null
  if (!canViewEphemeris(row, viewer)) throw new Error('OCM 星历不存在或无权访问')
  const full = safeResolveEphFile(row.file)
  if (!full || !fs.existsSync(full)) throw new Error(`OCM 文件缺失：${row.file}`)
  const buf = fs.readFileSync(full)
  const text = full.toLowerCase().endsWith('.gz')
    ? zlib.gunzipSync(buf).toString('utf8')
    : buf.toString('utf8')
  const parsed = parseOcmPv(text)
  if (!parsed) throw new Error('OCM 文件未解析出有效轨迹段')
  const states: PvState[] = parsed.states
  const realLabel = row.name ? `OCM ${row.name}` : label
  return {
    kind: 'ocm',
    label: realLabel,
    epochMs: row.publishedMs || states[0].t,
    windowStartMs: states[0].t,
    windowEndMs: states[states.length - 1].t,
    at: (t) => {
      const st = pvAt(states, t)
      return st ? { r: st.r, v: st.v } : null
    }
  }
}

type RootRow = RowDataPacket & { tle_line1: string; tle_line2: string; epoch: Date | string | null }

async function loadRootSource(
  table: 'sat_tle' | 'sat_aoe',
  norad: number,
  kind: CompareKind,
  label: string
): Promise<LoadedSource | null> {
  const sql =
    table === 'sat_tle'
      ? `SELECT object_name, tle_line1, tle_line2, epoch FROM sat_tle WHERE norad_id = ? LIMIT 1`
      : `SELECT object_name, tle_line1, tle_line2, epoch FROM sat_aoe WHERE norad_id = ? AND is_active = 1 LIMIT 1`
  const [rows] = await pool.query<RootRow[]>(sql, [norad])
  if (!rows.length || !rows[0].tle_line1 || !rows[0].tle_line2) return null
  const epochMs = rows[0].epoch ? new Date(rows[0].epoch).getTime() : 0
  const rec = buildSatrec({
    norad,
    name: '',
    line1: rows[0].tle_line1.trim(),
    line2: rows[0].tle_line2.trim(),
    epochMs,
    src: table === 'sat_tle' ? 'tle' : 'aoe',
    perigeeKm: 0,
    apogeeKm: 0
  })
  if (!rec) throw new Error(`${label} 两行根数无法解析（SGP4 初始化失败）`)
  const realLabel = rows[0].object_name ? `${kind.toUpperCase()} ${rows[0].object_name}`.trim() : label
  return {
    kind,
    label: realLabel,
    epochMs,
    windowStartMs: epochMs - ROOT_EARLY_MS,
    windowEndMs: epochMs + ROOT_LATE_MS,
    at: (t) => propagateJ2000(rec, t)
  }
}

async function loadSource(
  norad: number,
  desc: SourceDesc,
  fallbackLabel: string,
  viewer?: EphemViewer | null
): Promise<LoadedSource> {
  if (desc.kind === 'ocm') {
    const s = await loadOcmSource(desc.id || '', fallbackLabel, viewer)
    if (s) return s
    throw new Error('OCM 星历不存在或非 OCM 格式')
  }
  if (desc.kind === 'tle') {
    const s = await loadRootSource('sat_tle', norad, 'tle', fallbackLabel)
    if (s) return s
    throw new Error('系统编目（sat_tle）中无该 NORAD 的两行根数')
  }
  const s = await loadRootSource('sat_aoe', norad, 'aoe', fallbackLabel)
  if (s) return s
  throw new Error('AOE 历算（sat_aoe）中无该 NORAD 的两行根数')
}

/* ---------------------------- 对比计算 ---------------------------- */

export interface ComparePoint {
  tMs: number
  radialKm: number
  alongKm: number
  crossKm: number
  distKm: number
}

export interface CompareResult {
  norad: string
  a: { kind: CompareKind; id: string; label: string; epochMs: number }
  b: { kind: CompareKind; id: string; label: string; epochMs: number }
  overlap: { startMs: number; stopMs: number }
  samples: number
  rms: {
    radialKm: number
    alongKm: number
    crossKm: number
    totalKm: number
    maxKm: number
    meanKm: number
  }
  points: ComparePoint[]
  warnings: string[]
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** 两源对比主入口；maxPoints 缺省 240（曲线/CSV 都不需要更密） */
export async function compareSources(
  norad: string,
  aDesc: SourceDesc,
  bDesc: SourceDesc,
  maxPoints = 240,
  viewer?: EphemViewer | null
): Promise<CompareResult> {
  const noradNum = Number(norad)
  if (!Number.isFinite(noradNum) || noradNum <= 0) throw new Error('无效的 NORAD 编号')
  const cap = Math.min(Math.max(maxPoints, 10), 1000)

  const a = await loadSource(noradNum, aDesc, '源A', viewer)
  const b = await loadSource(noradNum, bDesc, '源B', viewer)

  const startMs = Math.max(a.windowStartMs, b.windowStartMs)
  const stopMs = Math.min(a.windowEndMs, b.windowEndMs)
  if (!(stopMs - startMs >= 10 * 60000)) {
    throw new Error('两源时间窗无重叠（或重叠不足 10 分钟）：请换用历元更接近的两源')
  }

  // 采样时刻：基准源 A 为 OCM 时取其点列抽稀，否则均匀采样
  const warnings: string[] = []
  let times: number[] = []
  if (a.kind === 'ocm') {
    // 直接在 [start, stop] 均匀取 cap 个时刻（OCM 60s 步长足够密，均匀采样不丢信息）
    const n = cap
    for (let i = 0; i < n; i++) {
      times.push(startMs + ((stopMs - startMs) * i) / (n - 1))
    }
  } else {
    for (let i = 0; i < cap; i++) {
      times.push(startMs + ((stopMs - startMs) * i) / (cap - 1))
    }
  }

  const points: ComparePoint[] = []
  let sumR = 0
  let sumA = 0
  let sumC = 0
  let sumD = 0
  let maxD = 0
  let sgp4Fail = 0

  for (const t of times) {
    const pa = a.at(t)
    const pb = b.at(t)
    if (!pa || !pb) {
      sgp4Fail++
      continue
    }
    const dx = pb.r[0] - pa.r[0]
    const dy = pb.r[1] - pa.r[1]
    const dz = pb.r[2] - pa.r[2]
    const dist = Math.hypot(dx, dy, dz)
    if (!Number.isFinite(dist)) continue

    // RTN 基（源 A 状态）：R = r̂，N = (r×v)/|r×v|，T = N×R
    const rn = Math.hypot(pa.r[0], pa.r[1], pa.r[2])
    if (!(rn > 1e-6)) continue
    const u: Vec3 = [pa.r[0] / rn, pa.r[1] / rn, pa.r[2] / rn]
    const hx = pa.r[1] * pa.v[2] - pa.r[2] * pa.v[1]
    const hy = pa.r[2] * pa.v[0] - pa.r[0] * pa.v[2]
    const hz = pa.r[0] * pa.v[1] - pa.r[1] * pa.v[0]
    const hn = Math.hypot(hx, hy, hz)
    if (!(hn > 1e-9)) continue
    const w: Vec3 = [hx / hn, hy / hn, hz / hn]
    const tv: Vec3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]]

    const radial = dot3([dx, dy, dz], u)
    const along = dot3([dx, dy, dz], tv)
    const cross = dot3([dx, dy, dz], w)

    points.push({ tMs: t, radialKm: radial, alongKm: along, crossKm: cross, distKm: dist })
    sumR += radial * radial
    sumA += along * along
    sumC += cross * cross
    sumD += dist
    if (dist > maxD) maxD = dist
  }

  const n = points.length
  if (n < 3) throw new Error('有效采样点不足（两源在该时段均无法给出状态）')
  if (sgp4Fail > 0 && a.kind !== 'ocm' && b.kind !== 'ocm') {
    warnings.push(`SGP4 有 ${sgp4Fail} 个采样时刻未返回状态，已跳过`)
  }

  return {
    norad: String(noradNum),
    a: { kind: a.kind, id: aDesc.id || a.kind, label: a.label, epochMs: a.epochMs },
    b: { kind: b.kind, id: bDesc.id || b.kind, label: b.label, epochMs: b.epochMs },
    overlap: { startMs, stopMs },
    samples: n,
    rms: {
      radialKm: Math.sqrt(sumR / n),
      alongKm: Math.sqrt(sumA / n),
      crossKm: Math.sqrt(sumC / n),
      totalKm: Math.sqrt((sumR + sumA + sumC) / n),
      maxKm: maxD,
      meanKm: sumD / n
    },
    points,
    warnings
  }
}
