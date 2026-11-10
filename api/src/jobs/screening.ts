/**
 * 交会筛查引擎（Epic E1）：组织目标（TLE 主星）× 系统编目（副星）。
 *
 * 流程（移植自参考项目 heat-sidecar/src/screen/run.ts 的 TLE×TLE 通道）：
 *  1) 目标 → sat_tle 两行根数 → SGP4 采样成 EphTrack（60s 步长）；
 *  2) 副星目录 sat_tle（is_active=1）；粗筛 = Δt 步进 + 三维空间哈希（worker 线程并行）；
 *  3) Brent 细化 TCA → TLE 龄期协方差 → Foster 2D Pc（+ Alfano PcMax）；
 *  4) 官方 CDM（sat_cdm）按 NORAD 无序对 + |ΔTCA|≤120s 匹配，命中以 CDM Pc 为准；
 *  5) 分级（红 ≥1e-4 / 橙 ≥1e-5 / 黄 ≥1e-7，稀释兜底）写 conjunction_events。
 *
 * 星历主星：EphTrack 结构已就绪（track.cov 非空时走 ephCovariance），接入点在 loadPrimaryTracks。
 */
import { cpus } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Worker } from 'node:worker_threads'
import * as satellite from 'satellite.js'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import {
  ensureScreenSchema,
  claimNextQueuedJob,
  finishScreenJob,
  resetStaleRunningJobs,
  markJobStarted,
  updateJobProgress,
  isCancelRequested,
  finishCancelledJob,
  type ScreenJobRow
} from '../db/screenDb.js'
import { coarseScan, buildSatrec, propagateJ2000, type CoarseInput } from '../screen/coarse.js'
import { levelOfPc } from '../screen/levels.js'
import type { Candidate, CatalogObject, EphTrack, ScreenParams, Vec3 } from '../screen/types.js'
import { tleCovariance } from '../screen/covariance.js'
import { j2000ToTeme } from '../screen/frames.js'
import { collisionProbability } from '../screen/pc.js'
import { missRTN, refineCandidate } from '../screen/refine.js'
import { EPH_ROOT } from '../ephem/ingest.js'
import { parseOcmPv, pvAt, type PvState } from '../ephem/parsePv.js'
import { levelOfEvent } from '../screen/levels.js'
import { cdmIsolation } from '../services/systemPool.js'

let workerBusy = false

/* ---------------------- R0-3：取消 / 超时控制 ---------------------- */

/** 任务被中止（用户取消或看门狗超时），由 drainQueue 落到 cancelled / failed */
class JobAborted extends Error {}

/** 当前执行任务的控制句柄（进程内同一时间仅一个筛查任务） */
let activeControl: { id: number; abort: (reason: string) => void } | null = null

/** 取消正在执行的筛查任务（同进程内）；不在执行则返回 false，由路由直接落库 */
export function abortActiveScreening(id: number): boolean {
  if (!activeControl || activeControl.id !== id) return false
  activeControl.abort('用户已取消')
  return true
}

/** 看门狗阈值：超过该时长无任何进度心跳即判定僵死并自动终止 */
const STALE_MS = Math.max(60_000, Number(process.env.SCREEN_STALE_MS ?? 10 * 60_000))

/** 启动后台队列泵：串行领取 queued 任务执行（进程内同一时间只跑一个筛查） */
export function kickScreeningRunner(): void {
  if (workerBusy) return
  workerBusy = true
  void drainQueue()
    .catch((e) => console.error('[screen] runner crashed:', (e as Error).message))
    .finally(() => {
      workerBusy = false
    })
}

async function drainQueue(): Promise<void> {
  if (!(await ensureScreenSchema())) return
  await resetStaleRunningJobs()
  for (;;) {
    const job = await claimNextQueuedJob()
    if (!job) return
    try {
      // R0-3：领取时若已存在取消请求（队列里被取消的边界情况），直接落终态
      if (await isCancelRequested(job.id)) {
        await finishCancelledJob(job.id)
        continue
      }
      await runJob(job)
    } catch (e) {
      if (e instanceof JobAborted) {
        // 用户取消 → cancelled；看门狗超时 → failed
        if (e.message === '用户已取消') {
          console.warn(`[screen] job ${job.id} 已取消`)
          await finishCancelledJob(job.id).catch(() => {})
        } else {
          console.error(`[screen] job ${job.id} 终止：${e.message}`)
          await finishScreenJob(job.id, 'failed', { errorMessage: e.message }).catch(() => {})
        }
        continue
      }
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[screen] job ${job.id} failed: ${msg}`)
      await finishScreenJob(job.id, 'failed', { errorMessage: msg }).catch(() => {})
    }
  }
}

/* ------------------------------ 分级与 CDM ------------------------------ */

// R1-1：分级口径统一到 screen/levels（与 CDM 事件聚合共用）
export { levelOfPc }

const CDM_TOL_S = 120

interface CdmRow extends RowDataPacket {
  cdm_id: string | null
  norad_a: number | null
  norad_b: number | null
  tca: Date | string
  miss_distance_km: number | null
  collision_probability: number | null
}

interface CdmMatch {
  cdmId: string | null
  tcaMs: number
  pc: number
  missKm: number | null
}

/**
 * 官方 CDM 索引：sat_cdm（日更覆盖快照），Pc 非正/缺失的跳过。
 * C4：客户上传 CDM 仅本任务所属组织可见（系统池全可见），禁止跨组织串用。
 */
async function loadCdmIndex(orgId: number): Promise<Map<string, CdmMatch[]>> {
  const map = new Map<string, CdmMatch[]>()
  const iso = cdmIsolation(orgId)
  try {
    const [rows] = await pool.query<CdmRow[]>(
      `SELECT cdm_id, norad_a, norad_b, tca, miss_distance_km, collision_probability
       FROM sat_cdm WHERE tca IS NOT NULL ${iso.sql}`,
      iso.params
    )
    for (const r of rows) {
      if (r.norad_a == null || r.norad_b == null) continue
      const tcaMs = new Date(r.tca).getTime()
      const pc = Number(r.collision_probability)
      if (!Number.isFinite(tcaMs) || !Number.isFinite(pc) || pc <= 0) continue
      const a = Math.min(Number(r.norad_a), Number(r.norad_b))
      const b = Math.max(Number(r.norad_a), Number(r.norad_b))
      const arr = map.get(`${a}:${b}`) ?? []
      const miss = r.miss_distance_km == null ? null : Number(r.miss_distance_km)
      arr.push({ cdmId: r.cdm_id ?? null, tcaMs, pc, missKm: Number.isFinite(miss as number) ? miss : null })
      map.set(`${a}:${b}`, arr)
    }
  } catch (e) {
    console.warn(`[screen] CDM 索引加载失败，本轮全部使用核心 Pc：${e instanceof Error ? e.message : String(e)}`)
  }
  return map
}

function matchCdm(
  index: Map<string, CdmMatch[]>,
  noradA: number,
  noradB: number,
  tcaMs: number
): CdmMatch | null {
  const a = Math.min(noradA, noradB)
  const b = Math.max(noradA, noradB)
  const list = index.get(`${a}:${b}`)
  if (!list?.length) return null
  let best: CdmMatch | null = null
  let bestDt = Number.POSITIVE_INFINITY
  for (const c of list) {
    const dt = Math.abs(c.tcaMs - tcaMs) / 1000
    if (dt <= CDM_TOL_S && dt < bestDt) {
      best = c
      bestDt = dt
    }
  }
  return best
}

/* ------------------------------ 目录与主星轨迹 ------------------------------ */

interface CatalogRow extends RowDataPacket {
  norad_id: number
  object_name: string | null
  epoch: Date | null
  apogee: number | null
  perigee: number | null
  tle_line1: string | null
  tle_line2: string | null
}

async function loadCatalog(source: 'tle' | 'aoe' = 'tle'): Promise<CatalogObject[]> {
  const table = source === 'aoe' ? 'sat_aoe' : 'sat_tle'
  const [rows] = await pool.query<CatalogRow[]>(
    `SELECT norad_id, object_name, epoch, apogee, perigee, tle_line1, tle_line2
     FROM ${table}
      WHERE is_active = 1 AND tle_line1 IS NOT NULL AND tle_line1 <> '' AND tle_line2 IS NOT NULL AND tle_line2 <> ''`
  )
  const out: CatalogObject[] = []
  for (const r of rows) {
    if (!r.epoch) continue
    // 近/远地点：列值缺失（本库 35565/35607 行为 NULL）时从 TLE 根数现算；
    // 仍无法确定时放行为全区间（0 ~ 200000 km），宁可多算不可误杀
    let perigeeKm = Number(r.perigee)
    let apogeeKm = Number(r.apogee)
    if (!(perigeeKm >= 0 && apogeeKm > perigeeKm)) {
      const ap = apsisFromTle(r.tle_line1 as string, r.tle_line2 as string)
      if (ap) {
        perigeeKm = ap.perigeeKm
        apogeeKm = ap.apogeeKm
      } else {
        perigeeKm = 0
        apogeeKm = 200_000
      }
    }
    out.push({
      norad: r.norad_id,
      name: r.object_name ?? String(r.norad_id),
      line1: r.tle_line1 as string,
      line2: r.tle_line2 as string,
      epochMs: r.epoch.getTime(),
      src: source,
      perigeeKm,
      apogeeKm
    })
  }
  return out
}

const EARTH_R_KM = 6378.137
const EARTH_MU = 398600.4418

/** TLE 根数 → 近/远地点高度（km）：平均运动 → 半长轴 → a(1∓e)-Re */
function apsisFromTle(line1: string, line2: string): { perigeeKm: number; apogeeKm: number } | null {
  try {
    const rec = satellite.twoline2satrec(line1, line2)
    if (!rec || (rec as unknown as { error: number }).error) return null
    const s = rec as unknown as { no?: number; no_kozai?: number; ecco?: number }
    const noRadMin = s.no ?? s.no_kozai
    const e = s.ecco
    if (typeof noRadMin !== 'number' || !(noRadMin > 0)) return null
    if (typeof e !== 'number' || e < 0 || e >= 1) return null
    const nRadS = noRadMin / 60
    const a = Math.cbrt(EARTH_MU / (nRadS * nRadS))
    return { perigeeKm: a * (1 - e) - EARTH_R_KM, apogeeKm: a * (1 + e) - EARTH_R_KM }
  } catch {
    return null
  }
}

/** 主星轨迹时间步长（与粗筛 Δt 同口径） */
const PRIMARY_STEP_MS = 60_000

/** 目标 → sat_tle TLE → SGP4 采样 EphTrack（startMs 缺省 = 当前时刻对齐分钟，Epic J 再筛查可显式指定） */
async function loadPrimaryTracks(
  norads: Array<{ objectId: number; noradId: number; name: string }>,
  windowH: number,
  startMs?: number,
  source: 'tle' | 'aoe' = 'tle'
): Promise<EphTrack[]> {
  if (!norads.length) return []
  const ids = norads.map((n) => n.noradId)
  const table = source === 'aoe' ? 'sat_aoe' : 'sat_tle'
  const extra =
    source === 'aoe'
      ? ` AND is_active = 1 AND tle_line1 IS NOT NULL AND tle_line1 <> '' AND tle_line2 IS NOT NULL AND tle_line2 <> ''`
      : ''
  const [rows] = await pool.query<CatalogRow[]>(
    `SELECT norad_id, object_name, epoch, tle_line1, tle_line2 FROM ${table} WHERE norad_id IN (?)` + extra,
    [ids]
  )
  const byNorad = new Map(rows.map((r) => [Number(r.norad_id), r]))
  const n = Math.max(2, Math.floor((windowH * 3600_000) / PRIMARY_STEP_MS) + 1)
  const sMs = startMs ?? Date.now()
  const start = Math.floor(sMs / PRIMARY_STEP_MS) * PRIMARY_STEP_MS
  const tracks: EphTrack[] = []
  for (const p of norads) {
    const r = byNorad.get(p.noradId)
    if (!r?.epoch || !r.tle_line1 || !r.tle_line2) continue
    const obj: CatalogObject = {
      norad: p.noradId,
      name: p.name || r.object_name || String(p.noradId),
      line1: r.tle_line1,
      line2: r.tle_line2,
      epochMs: r.epoch.getTime(),
      src: source,
      perigeeKm: 0,
      apogeeKm: 0
    }
    const rec = buildSatrec(obj)
    if (!rec) continue
    const rv = new Float64Array(n * 3)
    const vv = new Float64Array(n * 3)
    let ok = true
    for (let i = 0; i < n; i++) {
      const pv = propagateJ2000(rec, start + i * PRIMARY_STEP_MS)
      if (!pv) {
        ok = false
        break
      }
      rv[i * 3] = pv.r[0]
      rv[i * 3 + 1] = pv.r[1]
      rv[i * 3 + 2] = pv.r[2]
      vv[i * 3] = pv.v[0]
      vv[i * 3 + 1] = pv.v[1]
      vv[i * 3 + 2] = pv.v[2]
    }
    if (!ok) continue
    tracks.push({
      memeId: p.noradId,
      noradId: p.noradId,
      name: obj.name,
      createdMs: r.epoch.getTime(),
      startMs: start,
      stepMs: PRIMARY_STEP_MS,
      n,
      r: rv,
      v: vv,
      cov: null,
      epochMs: r.epoch.getTime()
    })
  }
  return tracks
}

/* ------------- R2-8：主星 = 已绑定精密星历（OCM 归档，60s 重采样） ------------- */

interface BoundEphemRow extends RowDataPacket {
  bound_object_id: number
  norad: number | null
  file: string
  start_ms: number
  stop_ms: number
}

async function loadEphemPrimaryTracks(
  norads: Array<{ objectId: number; noradId: number; name: string }>,
  windowH: number,
  startMs?: number
): Promise<{ tracks: EphTrack[]; missing: string[] }> {
  if (!norads.length) return { tracks: [], missing: [] }
  const missing: string[] = []
  const ids = norads.map((n) => n.objectId)
  let rows: BoundEphemRow[] = []
  try {
    const [r] = await pool.query<BoundEphemRow[]>(
      `SELECT bound_object_id, norad, file, start_ms, stop_ms
         FROM ephemeris
        WHERE bound_object_id IN (?) AND format = 'OCM'
        ORDER BY published_at DESC, id DESC`,
      [ids]
    )
    rows = r
  } catch {
    /* 表不可用时按全部缺失处理 */
  }
  const newest = new Map<number, BoundEphemRow>()
  for (const r of rows) {
    const oid = Number(r.bound_object_id)
    if (!newest.has(oid)) newest.set(oid, r)
  }
  const n = Math.max(2, Math.floor((windowH * 3600_000) / PRIMARY_STEP_MS) + 1)
  const start = Math.floor((startMs ?? Date.now()) / PRIMARY_STEP_MS) * PRIMARY_STEP_MS
  const end = start + (n - 1) * PRIMARY_STEP_MS
  const tracks: EphTrack[] = []
  for (const p of norads) {
    const label = p.name || String(p.noradId)
    const meta = newest.get(p.objectId)
    if (!meta) {
      missing.push(`${label}（未绑定 OCM 星历）`)
      continue
    }
    if (start < Number(meta.start_ms) || end > Number(meta.stop_ms)) {
      missing.push(`${label}（星历时段不覆盖筛查窗口）`)
      continue
    }
    let states: PvState[] = []
    try {
      const raw = fs.readFileSync(path.join(EPH_ROOT, meta.file))
      const text =
        raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8')
      states = parseOcmPv(text)?.states ?? []
    } catch {
      missing.push(`${label}（星历文件不可读）`)
      continue
    }
    if (states.length < 2) {
      missing.push(`${label}（星历解析失败）`)
      continue
    }
    const rv = new Float64Array(n * 3)
    const vv = new Float64Array(n * 3)
    let ok = true
    for (let i = 0; i < n; i++) {
      const pv = pvAt(states, start + i * PRIMARY_STEP_MS)
      if (!pv) {
        ok = false
        break
      }
      rv[i * 3] = pv.r[0]
      rv[i * 3 + 1] = pv.r[1]
      rv[i * 3 + 2] = pv.r[2]
      vv[i * 3] = pv.v[0]
      vv[i * 3 + 1] = pv.v[1]
      vv[i * 3 + 2] = pv.v[2]
    }
    if (!ok) {
      missing.push(`${label}（星历插值失败）`)
      continue
    }
    tracks.push({
      memeId: p.noradId,
      noradId: p.noradId,
      name: label,
      createdMs: Number(meta.start_ms),
      startMs: start,
      stepMs: PRIMARY_STEP_MS,
      n,
      r: rv,
      v: vv,
      cov: null,
      epochMs: Number(meta.start_ms)
    })
  }
  return { tracks, missing }
}

/* ------------------------------ 粗筛并行 ------------------------------ */

function workerCount(): number {
  // SCREEN_WORKERS 可显式指定（低配主机/本地冒烟降载用）；缺省 min(4, CPU 核数)
  const n = Number(process.env.SCREEN_WORKERS)
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n
  return Math.min(4, Math.max(1, cpus().length))
}

/**
 * 并行粗筛（R0-3 增强）：支持进度回调与协作式中止。
 * worker 每 5 步上报 {type:'progress', step}；主线程聚合并节流回调 onProgress。
 * isAborted 返回非空字符串时立即 terminate 全部 worker 并抛 JobAborted。
 */
async function runCoarseParallel(
  primaries: EphTrack[],
  catalog: CatalogObject[],
  params: ScreenParams,
  totalSteps: number,
  onProgress?: (doneSteps: number) => void,
  isAborted?: () => string | null
): Promise<Candidate[]> {
  const n = Math.max(1, Math.min(workerCount(), totalSteps))
  if (n === 1) {
    const list = coarseScan({ primaries, catalog, params, stepFrom: 0, stepTo: totalSteps }, onProgress)
    const why = isAborted?.()
    if (why) throw new JobAborted(why)
    return list
  }
  const chunk = Math.ceil(totalSteps / n)
  const workers: Worker[] = []
  // worker 上报的是「绝对步号」，doneSteps 落为分片起点，保证多 worker 聚合不重复计数
  const doneSteps = new Array<number>(n).fill(0)
  let aborted: string | null = null
  let totalDone = 0

  const jobs: Promise<Candidate[]>[] = []
  for (let i = 0; i < n; i++) {
    const from = i * chunk
    const to = Math.min(totalSteps, from + chunk)
    if (to <= from) continue
    doneSteps[i] = from
    const data: CoarseInput = { primaries, catalog, params, stepFrom: from, stepTo: to }
    const idx = i
    jobs.push(
      new Promise<Candidate[]>((resolve, reject) => {
        const w = new Worker(new URL('../screen/worker.js', import.meta.url), { workerData: data })
        workers.push(w)
        let settled = false
        w.on('message', (msg: { type: string; step?: number; candidates?: Candidate[] }) => {
          if (msg?.type === 'progress') {
            const step = Math.max(0, Math.min(to, Number(msg.step ?? 0)))
            totalDone += step - doneSteps[idx]
            doneSteps[idx] = step
            onProgress?.(totalDone)
            return
          }
          if (msg?.type === 'done') {
            settled = true
            totalDone += to - doneSteps[idx]
            doneSteps[idx] = to
            onProgress?.(totalDone)
            resolve(msg.candidates ?? [])
          }
        })
        w.on('error', (e) => {
          if (!settled) reject(e)
        })
        w.on('exit', (code) => {
          // 中止时 terminate 也会走到这里，必须 reject 否则 Promise.all 永久挂起
          if (!settled) reject(new JobAborted(aborted ?? `worker 退出（code=${code}）`))
        })
      })
    )
  }

  // 中止轮询：每 300ms 检查一次（取消请求 / 看门狗超时）
  const killer = setInterval(() => {
    const why = isAborted?.()
    if (why && !aborted) {
      aborted = why
      for (const w of workers) void w.terminate()
    }
  }, 300)

  try {
    const lists = await Promise.all(jobs)
    if (aborted) throw new JobAborted(aborted)
    return lists.flat()
  } finally {
    clearInterval(killer)
    for (const w of workers) void w.terminate()
  }
}

/* ------------------------------ 单任务执行 ------------------------------ */

interface EventInsert {
  values: unknown[]
}

/* ------------- R2-8：副星 = CDM 复核（不跑全编目粗筛，直接用已入站 CDM 出对照事件） ------------- */

interface CdmReviewRow extends RowDataPacket {
  cdm_id: string | null
  norad_a: number | null
  norad_b: number | null
  name_a: string | null
  name_b: string | null
  tca: Date | string | null
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
  hard_body_radius_m: number | null
}

async function runCdmCompareJob(
  job: ScreenJobRow,
  objs: Array<RowDataPacket & { id: number; norad_id: number; name: string }>,
  windowH: number,
  startMs: number | undefined,
  t0: number
): Promise<void> {
  if (!objs.length) throw new Error('无可筛查的主星：本组织尚未认领目标')
  const norads = objs.map((o) => Number(o.norad_id))
  const byNorad = new Map(objs.map((o) => [Number(o.norad_id), o]))
  const start = Math.floor((startMs ?? Date.now()) / 60_000) * 60_000
  const end = start + windowH * 3600_000
  await markJobStarted(job.id, objs.length, 0)
  await updateJobProgress(job.id, 40, 'CDM 复核：按主星匹配已入站 CDM')

  const iso = cdmIsolation(job.org_id)
  const [rows] = await pool.query<CdmReviewRow[]>(
    `SELECT cdm_id, norad_a, norad_b, name_a, name_b, tca, miss_distance_km,
            rel_speed_km_per_s, collision_probability, hard_body_radius_m
       FROM sat_cdm
      WHERE tca BETWEEN ? AND ? AND (norad_a IN (?) OR norad_b IN (?)) ${iso.sql}
      ORDER BY tca ASC`,
    [new Date(start), new Date(end), norads, norads, ...iso.params]
  )
  if (await isCancelRequested(job.id)) throw new JobAborted('用户已取消')

  const values: unknown[][] = []
  const secondaries = new Set<number>()
  for (const r of rows) {
    if (r.norad_a == null || r.norad_b == null || !r.tca) continue
    const tcaMs = new Date(r.tca).getTime()
    if (!Number.isFinite(tcaMs)) continue
    const pA = byNorad.get(Number(r.norad_a))
    const pB = byNorad.get(Number(r.norad_b))
    const primary = pA ?? pB
    if (!primary) continue
    const secNorad = pA ? Number(r.norad_b) : Number(r.norad_a)
    const secName = pA ? r.name_b ?? String(secNorad) : r.name_a ?? String(secNorad)
    const pcRaw = r.collision_probability == null ? null : Number(r.collision_probability)
    const pc = pcRaw != null && Number.isFinite(pcRaw) ? pcRaw : null
    const missRaw = r.miss_distance_km == null ? null : Number(r.miss_distance_km)
    const miss = missRaw != null && Number.isFinite(missRaw) ? missRaw : null
    const relRaw = r.rel_speed_km_per_s == null ? null : Number(r.rel_speed_km_per_s)
    const rel = relRaw != null && Number.isFinite(relRaw) ? relRaw : null
    const hbr = r.hard_body_radius_m == null ? 5 : Number(r.hard_body_radius_m)
    const lv = levelOfEvent(pc, miss)
    secondaries.add(secNorad)
    values.push([
      job.id,
      job.org_id,
      Number(primary.id),
      Number(primary.norad_id),
      String(primary.name ?? primary.norad_id),
      secNorad,
      secName,
      new Date(tcaMs),
      miss,
      null,
      null,
      null,
      rel,
      pc,
      pc,
      'cdm',
      hbr,
      'cdm',
      null,
      'cdm',
      null,
      new Date(tcaMs),
      null,
      lv.level,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      r.cdm_id ?? null,
      pc,
      'cdm'
    ])
  }

  let inserted = 0
  if (values.length) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (let i = 0; i < values.length; i += 500) {
        const [ret] = await conn.query(
          `INSERT IGNORE INTO conjunction_events
           (job_id, org_id, primary_object_id, primary_norad, primary_name, secondary_norad, secondary_name,
            tca, miss_km, miss_r_km, miss_t_km, miss_n_km, rel_speed_kms, pc, pc_max, pc_method, hbr_m,
            sigma_p_src, sigma_p_t_km, sigma_s_src, sigma_s_t_km, sec_epoch, sec_age_h, level, diluted,
            a_x, a_y, a_z, b_x, b_y, b_z, cdm_id, cdm_pc, pc_source)
           VALUES ?`,
          [values.slice(i, i + 500)]
        )
        // 唯一键 uk_job_pair_tca 命中时该批会被忽略，按实际写入行数统计
        inserted += (ret as { affectedRows?: number }).affectedRows || 0
      }
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  }

  await finishScreenJob(job.id, 'done', {
    nPrimary: objs.length,
    nSecondary: secondaries.size,
    nCandidates: rows.length,
    nEvents: inserted
  })
  console.log(
    `[screen] job=${job.id} CDM 复核完成：CDM ${rows.length} 事件 ${inserted}（去重后）用时 ${Math.round((Date.now() - t0) / 1000)}s`
  )
}

async function runJob(job: ScreenJobRow): Promise<void> {
  const t0 = Date.now()
  const windowH = job.window_h
  const missMaxKm = job.miss_max_km
  const hbrM = job.hbr_m
  const orgId = job.org_id

  // R0-3：本任务的中止控制（用户取消 / 看门狗超时）
  let abortReason: string | null = null
  const control = {
    id: job.id,
    abort: (reason: string) => {
      if (!abortReason) abortReason = reason
    }
  }
  activeControl = control
  let lastProgressAt = Date.now()

  // Epic J 再筛查参数（params_json 扩展）：主星白名单 + 窗口起点；普通筛查两值为空
  let primaryNorads: number[] = []
  let startMs: number | undefined
  let primarySource: 'tle' | 'ephem' | 'aoe' = 'tle'
  let secondarySource: 'catalog' | 'cdm' | 'aoe' = 'catalog'
  try {
    const p = job.params_json
      ? (JSON.parse(job.params_json) as {
          primaryNorads?: unknown
          startMs?: unknown
          primarySource?: unknown
          secondarySource?: unknown
        })
      : null
    if (Array.isArray(p?.primaryNorads)) {
      primaryNorads = p!.primaryNorads!.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
    }
    if (p && Number.isFinite(Number(p.startMs)) && Number(p.startMs) > 0) startMs = Number(p.startMs)
    if (p?.primarySource === 'ephem' || p?.primarySource === 'aoe') primarySource = p.primarySource
    else if (job.primary_source === 'ephem' || job.primary_source === 'aoe') primarySource = job.primary_source
    if (p?.secondarySource === 'cdm' || p?.secondarySource === 'aoe') secondarySource = p.secondarySource
    else if (job.secondary_source === 'cdm' || job.secondary_source === 'aoe') secondarySource = job.secondary_source
  } catch {
    /* params 解析失败时回退到任务列 */
    if (job.primary_source === 'ephem' || job.primary_source === 'aoe') primarySource = job.primary_source
    if (job.secondary_source === 'cdm' || job.secondary_source === 'aoe') secondarySource = job.secondary_source
  }

  try {
    // 目标（R2-8：主星源 tle | ephem | aoe；副星源 catalog | cdm | aoe）
    const [objs] = await pool.query<Array<RowDataPacket & { id: number; norad_id: number; name: string }>>(
      `SELECT id, norad_id, name FROM objects WHERE org_id = ? AND claim_status = 'claimed'${
        primaryNorads.length ? ' AND norad_id IN (?)' : ''
      }`,
      primaryNorads.length ? [orgId, primaryNorads] : [orgId]
    )

    // 副星 = CDM 复核：不跑全编目粗筛，直接以已入站 CDM 作对照事件
    if (secondarySource === 'cdm') {
      await runCdmCompareJob(job, objs, windowH, startMs, t0)
      return
    }

    let primaries: EphTrack[]
    if (primarySource === 'ephem') {
      const { tracks, missing } = await loadEphemPrimaryTracks(
        objs.map((o) => ({ objectId: Number(o.id), noradId: Number(o.norad_id), name: String(o.name ?? '') })),
        windowH,
        startMs
      )
      if (!tracks.length) {
        throw new Error(
          `无可筛查的主星（精密星历）：${missing.slice(0, 5).join('、') || '所选目标未绑定 OCM 星历'}`
        )
      }
      primaries = tracks
    } else {
      primaries = await loadPrimaryTracks(
        objs.map((o) => ({ objectId: Number(o.id), noradId: Number(o.norad_id), name: String(o.name ?? '') })),
        windowH,
        startMs,
        primarySource === 'aoe' ? 'aoe' : 'tle'
      )
    }
    if (!primaries.length) {
      // R0-2：区分「没有目标」与「有目标但系统池无根数」，便于用户自查
      if (!objs.length) {
        throw new Error(
          primaryNorads.length
            ? `指定的 ${primaryNorads.length} 颗主星不在本组织目标内（请先在「目标」认领）`
            : '无可筛查的主星：本组织尚未认领目标'
        )
      }
      throw new Error(
        primarySource === 'aoe'
          ? `无可筛查的主星：目标 ${objs.length} 个，但系统池 AOE 编目无可用两行根数（请等待 AOE 日更）`
          : `无可筛查的主星：目标 ${objs.length} 个，但系统池无可用两行根数（TLE 可能未同步，请等待日更或用「同步根数」重试）`
      )
    }

    const catalog = await loadCatalog(secondarySource === 'aoe' ? 'aoe' : 'tle')
    if (!catalog.length) {
      throw new Error(
        secondarySource === 'aoe'
          ? '副星目录为空（sat_aoe 无可用两行根数）'
          : '副星目录为空（sat_tle 无 is_active=1 的两行根数）'
      )
    }

    const nowMs = Date.now()
    const windowStartMs = primaries[0].startMs
    const windowEndMs = windowStartMs + (primaries[0].n - 1) * primaries[0].stepMs
    const stepMs = primaries[0].stepMs
    const totalSteps = Math.max(0, Math.floor((windowEndMs - windowStartMs) / stepMs))
    if (totalSteps < 2) throw new Error('筛查窗口为空')

    const params: ScreenParams = {
      missMaxKm,
      hbrKm: hbrM / 1000,
      vRelMaxKms: 15.5,
      stepMs,
      windowStartMs,
      // 显式起点（再筛查）时不以当前时刻截断：窗口起点可在未来（机动预演）
      windowEndMs: startMs ? windowEndMs : Math.min(windowEndMs, nowMs + windowH * 3600_000)
    }

    // R0-3：主/副星数立即落库（running 期间即可观测，不再等结束）
    await markJobStarted(job.id, primaries.length, catalog.length)
    lastProgressAt = Date.now()

    // 心跳 + 看门狗：每 10s 检查取消请求 / 进度是否停滞
    const hb = setInterval(() => {
      void (async () => {
        try {
          if (await isCancelRequested(job.id)) control.abort('用户已取消')
        } catch {
          /* 轮询失败不影响计算 */
        }
        if (Date.now() - lastProgressAt > STALE_MS && !abortReason) {
          control.abort(`计算超时（${Math.round(STALE_MS / 60_000)} 分钟无进度），已自动终止`)
        }
        console.log(`[screen] job=${job.id} 计算中… ${Math.round((Date.now() - t0) / 1000)}s`)
      })()
    }, 10_000)

    try {
      await runJobInner(
        job,
        primaries,
        catalog,
        params,
        objs,
        t0,
        () => abortReason,
        () => {
          lastProgressAt = Date.now()
        }
      )
    } finally {
      clearInterval(hb)
    }
  } finally {
    if (activeControl === control) activeControl = null
  }
}

async function runJobInner(
  job: ScreenJobRow,
  primaries: EphTrack[],
  catalog: CatalogObject[],
  params: ScreenParams,
  objs: Array<RowDataPacket & { id: number; norad_id: number; name: string }>,
  t0: number,
  isAborted: () => string | null,
  bumpProgress: () => void
): Promise<void> {
  const orgId = job.org_id
  const missMaxKm = params.missMaxKm
  const hbrM = params.hbrKm * 1000
  const stepMs = params.stepMs
  const totalSteps = Math.max(0, Math.floor((params.windowEndMs - params.windowStartMs) / stepMs))

  console.log(
    `[screen] job=${job.id} 开始：主星 ${primaries.length} 副星 ${catalog.length} 步长 ${stepMs / 1000}s 窗口 ${totalSteps} 步`
  )

  // R0-3：粗筛进度 → 心跳（本地更快）+ 数据库（节流 3s 一次，供前端展示）
  let lastDbWrite = 0
  const candidates = await runCoarseParallel(
    primaries,
    catalog,
    params,
    totalSteps,
    (done) => {
      bumpProgress()
      const now = Date.now()
      if (now - lastDbWrite < 3000) return
      lastDbWrite = now
      const pct = totalSteps ? (done / totalSteps) * 90 : 0
      void updateJobProgress(job.id, pct, `粗筛中 ${done}/${totalSteps} 步`).catch(() => {})
    },
    isAborted
  )
  console.log(`[screen] job=${job.id} 粗筛完成：候选 ${candidates.length} 个（${Math.round((Date.now() - t0) / 1000)}s）`)
  await updateJobProgress(job.id, 92, '精化 TCA / 计算 Pc').catch(() => {})

  const catByNorad = new Map<number, CatalogObject>()
  for (const c of catalog) catByNorad.set(c.norad, c)
  const trackByNorad = new Map<number, EphTrack>()
  for (const t of primaries) if (t.noradId != null) trackByNorad.set(t.noradId, t)
  const satrecCache = new Map<number, ReturnType<typeof buildSatrec>>()
  const cdmIndex = await loadCdmIndex(orgId)

  const rows: unknown[][] = []
  const seen = new Set<string>()

  for (const cand of candidates) {
    const primary = trackByNorad.get(cand.primaryMeme)
    const sec = catByNorad.get(cand.secondaryNorad)
    if (!primary || !sec) continue
    // 自过滤：同一目标不与自己交会
    if (primary.noradId === sec.norad) continue

    const secondaryAt = (tMs: number): { r: Vec3; v: Vec3 } | null => {
      let rec = satrecCache.get(sec.norad)
      if (rec === undefined) {
        rec = buildSatrec(sec)
        satrecCache.set(sec.norad, rec)
      }
      return rec ? propagateJ2000(rec, tMs) : null
    }

    const refined = refineCandidate({ primary, secondary: secondaryAt, centerMs: cand.centerMs, stepMs })
    if (!refined || !(refined.missKm <= missMaxKm)) continue

    const key = `${primary.memeId}:${sec.norad}:${Math.round(refined.tcaMs / 60000)}`
    if (seen.has(key)) continue
    seen.add(key)

    // 协方差：TLE×TLE 双方均按根数龄期模型
    const covP = tleCovariance(refined.rP, refined.vP, primary.epochMs ?? primary.startMs, refined.tcaMs)
    const covS = tleCovariance(refined.rS, refined.vS, sec.epochMs, refined.tcaMs)

    const relVel: Vec3 = [refined.vS[0] - refined.vP[0], refined.vS[1] - refined.vP[1], refined.vS[2] - refined.vP[2]]
    const pcRes = collisionProbability({
      missVec: refined.miss,
      relVelVec: relVel,
      covA: covP.cov,
      covB: covS.cov,
      hbrKm: hbrM / 1000
    })

    // 官方 CDM 优先：命中则以 CDM Pc 与等级为准
    const cdm = matchCdm(cdmIndex, primary.noradId!, sec.norad, refined.tcaMs)
    const pcFinal = cdm ? cdm.pc : pcRes.pc
    const lv = levelOfPc(pcFinal, pcRes.pcMax)
    if (!lv) continue

    const rtn = missRTN(refined.rP, refined.vP, refined.miss)
    const aTeme = j2000ToTeme(refined.rP, refined.vP, refined.tcaMs).r
    const bTeme = j2000ToTeme(refined.rS, refined.vS, refined.tcaMs).r

    const objRow = objs.find((o) => Number(o.norad_id) === primary.noradId)
    const ev: EventInsert = {
      values: [
        job.id,
        orgId,
        objRow ? Number(objRow.id) : null,
        primary.noradId,
        primary.name.slice(0, 100),
        sec.norad,
        sec.name.slice(0, 100),
        new Date(refined.tcaMs),
        refined.missKm,
        rtn.r,
        rtn.t,
        rtn.n,
        Math.hypot(relVel[0], relVel[1], relVel[2]),
        pcFinal,
        pcRes.pcMax,
        'foster2d',
        hbrM,
        'tle',
        covP.sigmaT,
        'tle',
        covS.sigmaT,
        new Date(sec.epochMs),
        covS.ageHours,
        lv.level,
        lv.diluted ? 1 : 0,
        aTeme[0],
        aTeme[1],
        aTeme[2],
        bTeme[0],
        bTeme[1],
        bTeme[2],
        cdm?.cdmId ?? null,
        cdm?.pc ?? null,
        cdm ? 'cdm' : 'core'
      ]
    }
    rows.push(ev.values)
  }

  let insertedEvents = 0
  if (rows.length) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (let i = 0; i < rows.length; i += 500) {
        const [ret] = await conn.query(
          `INSERT IGNORE INTO conjunction_events
           (job_id, org_id, primary_object_id, primary_norad, primary_name, secondary_norad, secondary_name,
            tca, miss_km, miss_r_km, miss_t_km, miss_n_km, rel_speed_kms, pc, pc_max, pc_method, hbr_m,
            sigma_p_src, sigma_p_t_km, sigma_s_src, sigma_s_t_km, sec_epoch, sec_age_h, level, diluted,
            a_x, a_y, a_z, b_x, b_y, b_z, cdm_id, cdm_pc, pc_source)
           VALUES ?`,
          [rows.slice(i, i + 500)]
        )
        // 唯一键 uk_job_pair_tca 命中时该批会被忽略，按实际写入行数统计
        insertedEvents += (ret as { affectedRows?: number }).affectedRows || 0
      }
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  }

  const durationMs = Date.now() - t0
  await finishScreenJob(job.id, 'done', {
    nPrimary: primaries.length,
    nSecondary: catalog.length,
    nCandidates: candidates.length,
    nEvents: insertedEvents
  })
  console.log(
    `[screen] job=${job.id} 完成：候选 ${candidates.length} 事件 ${insertedEvents}（去重后）用时 ${Math.round(durationMs / 1000)}s`
  )
}
