/**
 * 交会筛查引擎（Epic E1）：组织托管目标（TLE 主星）× 系统编目（副星）。
 *
 * 流程（移植自参考项目 heat-sidecar/src/screen/run.ts 的 TLE×TLE 通道）：
 *  1) 托管目标 → sat_tle 两行根数 → SGP4 采样成 EphTrack（60s 步长）；
 *  2) 副星目录 sat_tle（is_active=1）；粗筛 = Δt 步进 + 三维空间哈希（worker 线程并行）；
 *  3) Brent 细化 TCA → TLE 龄期协方差 → Foster 2D Pc（+ Alfano PcMax）；
 *  4) 官方 CDM（sat_cdm）按 NORAD 无序对 + |ΔTCA|≤120s 匹配，命中以 CDM Pc 为准；
 *  5) 分级（红 ≥1e-4 / 橙 ≥1e-5 / 黄 ≥1e-7，稀释兜底）写 conjunction_events。
 *
 * 星历主星：EphTrack 结构已就绪（track.cov 非空时走 ephCovariance），接入点在 loadPrimaryTracks。
 */
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import * as satellite from 'satellite.js'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import {
  ensureScreenSchema,
  claimNextQueuedJob,
  finishScreenJob,
  resetStaleRunningJobs,
  type ScreenJobRow
} from '../db/screenDb.js'
import { coarseScan, buildSatrec, propagateJ2000, type CoarseInput } from '../screen/coarse.js'
import type { Candidate, CatalogObject, EphTrack, ScreenParams, Vec3 } from '../screen/types.js'
import { tleCovariance } from '../screen/covariance.js'
import { j2000ToTeme } from '../screen/frames.js'
import { collisionProbability } from '../screen/pc.js'
import { missRTN, refineCandidate } from '../screen/refine.js'

let workerBusy = false

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
      await runJob(job)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[screen] job ${job.id} failed: ${msg}`)
      await finishScreenJob(job.id, 'failed', { errorMessage: msg }).catch(() => {})
    }
  }
}

/* ------------------------------ 分级与 CDM ------------------------------ */

/** Pc 分级：红 ≥1e-4 / 橙 ≥1e-5 / 黄 ≥1e-7；黄档兜底 = 稀释（pcMax 达危险但中心 Pc 低） */
export function levelOfPc(pc: number, pcMax: number): { level: 'red' | 'orange' | 'yellow'; diluted: boolean } | null {
  if (pc >= 1e-4) return { level: 'red', diluted: pcMax >= 1e-4 && pc < 1e-4 }
  if (pc >= 1e-5) return { level: 'orange', diluted: false }
  if (pc >= 1e-7) return { level: 'yellow', diluted: false }
  if (pcMax >= 1e-4) return { level: 'yellow', diluted: true }
  return null
}

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

/** 官方 CDM 索引：sat_cdm（日更覆盖快照），Pc 非正/缺失的跳过 */
async function loadCdmIndex(): Promise<Map<string, CdmMatch[]>> {
  const map = new Map<string, CdmMatch[]>()
  try {
    const [rows] = await pool.query<CdmRow[]>(
      `SELECT cdm_id, norad_a, norad_b, tca, miss_distance_km, collision_probability
       FROM sat_cdm WHERE tca IS NOT NULL`
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

async function loadCatalog(): Promise<CatalogObject[]> {
  const [rows] = await pool.query<CatalogRow[]>(
    `SELECT norad_id, object_name, epoch, apogee, perigee, tle_line1, tle_line2
     FROM sat_tle
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
      src: 'tle',
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

/** 托管目标 → sat_tle TLE → SGP4 采样 EphTrack（startMs 缺省 = 当前时刻对齐分钟，Epic J 再筛查可显式指定） */
async function loadPrimaryTracks(
  norads: Array<{ objectId: number; noradId: number; name: string }>,
  windowH: number,
  startMs?: number
): Promise<EphTrack[]> {
  if (!norads.length) return []
  const ids = norads.map((n) => n.noradId)
  const [rows] = await pool.query<CatalogRow[]>(
    `SELECT norad_id, object_name, epoch, tle_line1, tle_line2 FROM sat_tle WHERE norad_id IN (?)`,
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
      src: 'tle',
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

/* ------------------------------ 粗筛并行 ------------------------------ */

function workerCount(): number {
  // SCREEN_WORKERS 可显式指定（低配主机/本地冒烟降载用）；缺省 min(4, CPU 核数)
  const n = Number(process.env.SCREEN_WORKERS)
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n
  return Math.min(4, Math.max(1, cpus().length))
}

async function runCoarseParallel(
  primaries: EphTrack[],
  catalog: CatalogObject[],
  params: ScreenParams,
  totalSteps: number
): Promise<Candidate[]> {
  const n = Math.max(1, Math.min(workerCount(), totalSteps))
  if (n === 1) {
    return coarseScan({ primaries, catalog, params, stepFrom: 0, stepTo: totalSteps })
  }
  const chunk = Math.ceil(totalSteps / n)
  const jobs: Promise<Candidate[]>[] = []
  for (let i = 0; i < n; i++) {
    const from = i * chunk
    const to = Math.min(totalSteps, from + chunk)
    if (to <= from) continue
    const data: CoarseInput = { primaries, catalog, params, stepFrom: from, stepTo: to }
    jobs.push(
      new Promise<Candidate[]>((resolve, reject) => {
        const w = new Worker(new URL('../screen/worker.js', import.meta.url), { workerData: data })
        let done = false
        w.on('message', (msg: Candidate[]) => {
          done = true
          resolve(msg)
        })
        w.on('error', reject)
        w.on('exit', (code) => {
          if (!done) reject(new Error(`worker 退出（code=${code}）`))
        })
      })
    )
  }
  const lists = await Promise.all(jobs)
  return lists.flat()
}

/* ------------------------------ 单任务执行 ------------------------------ */

interface EventInsert {
  values: unknown[]
}

async function runJob(job: ScreenJobRow): Promise<void> {
  const t0 = Date.now()
  const windowH = job.window_h
  const missMaxKm = job.miss_max_km
  const hbrM = job.hbr_m
  const orgId = job.org_id

  // Epic J 再筛查参数（params_json 扩展）：主星白名单 + 窗口起点；普通筛查两值为空
  let primaryNorads: number[] = []
  let startMs: number | undefined
  try {
    const p = job.params_json ? (JSON.parse(job.params_json) as { primaryNorads?: unknown; startMs?: unknown }) : null
    if (Array.isArray(p?.primaryNorads)) {
      primaryNorads = p!.primaryNorads!.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
    }
    if (p && Number.isFinite(Number(p.startMs)) && Number(p.startMs) > 0) startMs = Number(p.startMs)
  } catch {
    /* params 解析失败按普通筛查处理 */
  }

  // 托管目标（当前 TLE 主星；绑定星历的主星通道在 G1/后续接入）
  const [objs] = await pool.query<Array<RowDataPacket & { id: number; norad_id: number; name: string }>>(
    `SELECT id, norad_id, name FROM objects WHERE org_id = ? AND claim_status = 'claimed'${
      primaryNorads.length ? ' AND norad_id IN (?)' : ''
    }`,
    primaryNorads.length ? [orgId, primaryNorads] : [orgId]
  )
  const primaries = await loadPrimaryTracks(
    objs.map((o) => ({ objectId: Number(o.id), noradId: Number(o.norad_id), name: String(o.name ?? '') })),
    windowH,
    startMs
  )
  if (!primaries.length) {
    throw new Error('无可筛查的主星（托管目标缺少有效两行根数）')
  }

  const catalog = await loadCatalog()
  if (!catalog.length) throw new Error('副星目录为空（sat_tle 无 is_active=1 的两行根数）')

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

  // 心跳：长任务期间每 30s 输出进度，便于运维观察（也避免日志长期静默）
  const hb = setInterval(() => {
    console.log(`[screen] job=${job.id} 计算中… ${Math.round((Date.now() - t0) / 1000)}s`)
  }, 30_000)
  try {
    await runJobInner(job, primaries, catalog, params, objs, t0)
  } finally {
    clearInterval(hb)
  }
}

async function runJobInner(
  job: ScreenJobRow,
  primaries: EphTrack[],
  catalog: CatalogObject[],
  params: ScreenParams,
  objs: Array<RowDataPacket & { id: number; norad_id: number; name: string }>,
  t0: number
): Promise<void> {
  const orgId = job.org_id
  const missMaxKm = params.missMaxKm
  const hbrM = params.hbrKm * 1000
  const stepMs = params.stepMs
  const totalSteps = Math.max(0, Math.floor((params.windowEndMs - params.windowStartMs) / stepMs))

  console.log(
    `[screen] job=${job.id} 开始：主星 ${primaries.length} 副星 ${catalog.length} 步长 ${stepMs / 1000}s 窗口 ${totalSteps} 步`
  )
  const candidates = await runCoarseParallel(primaries, catalog, params, totalSteps)
  console.log(`[screen] job=${job.id} 粗筛完成：候选 ${candidates.length} 个（${Math.round((Date.now() - t0) / 1000)}s）`)

  const catByNorad = new Map<number, CatalogObject>()
  for (const c of catalog) catByNorad.set(c.norad, c)
  const trackByNorad = new Map<number, EphTrack>()
  for (const t of primaries) if (t.noradId != null) trackByNorad.set(t.noradId, t)
  const satrecCache = new Map<number, ReturnType<typeof buildSatrec>>()
  const cdmIndex = await loadCdmIndex()

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

  if (rows.length) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (let i = 0; i < rows.length; i += 500) {
        await conn.query(
          `INSERT INTO conjunction_events
           (job_id, org_id, primary_object_id, primary_norad, primary_name, secondary_norad, secondary_name,
            tca, miss_km, miss_r_km, miss_t_km, miss_n_km, rel_speed_kms, pc, pc_max, pc_method, hbr_m,
            sigma_p_src, sigma_p_t_km, sigma_s_src, sigma_s_t_km, sec_epoch, sec_age_h, level, diluted,
            a_x, a_y, a_z, b_x, b_y, b_z, cdm_id, cdm_pc, pc_source)
           VALUES ?`,
          [rows.slice(i, i + 500)]
        )
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
    nEvents: rows.length
  })
  console.log(
    `[screen] job=${job.id} 完成：候选 ${candidates.length} 事件 ${rows.length} 用时 ${Math.round(durationMs / 1000)}s`
  )
}
