/**
 * 交会事件路由（Epic E2）：
 *  - POST /cgi/events/import          客户上传 CDM（KVN/XML/JSON）解析入站，source='customer'；
 *  - GET  /cgi/events                 sat_cdm 按主/副星对 + 近 TCA 聚合成事件时间线（公开只读）；
 *  - GET  /cgi/events/:key            事件详情：成员 CDM 列表 + 双方 sat_tle 档案；
 *  - GET  /cgi/events/:key/cdm/:id/raw 单条 CDM 原文（raw_json）；
 *  - POST /cgi/events/pc-compare    多算法 Pc 比对（E3）：同源输入 = 双方 TLE 传播 +
 *                                   龄期协方差，Foster/Chan/Alfano + 官方 CDM Pc 对照行；
 *  - POST /cgi/events/:key/recompute  参数重算（F1）：组织默认/仅本次参数 → 共享计算核 →
 *                                   落 conjunction_pc_runs（新 run_id），计入 recompute_day 配额；
 *  - GET  /cgi/events/:key/recompute  本事件 run 历史（本组织隔离，旧 run 可对比）。
 *
 * 聚合口径：默认窗口 tca ∈ [now-1d, now+3d]（window 参数可调），按无序对分组后
 * 相邻 TCA gap ≤ 3h 归并为同一事件（防 90min 轨道周期把多次交会误并）；
 * 官方 Pc 原样保留，事件等级取成员最高档（红 ≥1e-4 / 橙 ≥1e-5 / 黄 ≥1e-7 / 其余灰）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import { writeUserAudit } from '../db/adminDb.js'
import { quotaExceeded } from '../middleware/plan.js'
import { parseCdmText } from '../services/cdmParse.js'
import { resolvePoolPolicy, poolBadge } from '../services/systemPool.js'
import { buildSatrec, propagateJ2000 } from '../screen/coarse.js'
import { tleCovariance } from '../screen/covariance.js'
import { encounterPlane, foster2D } from '../screen/pc.js'
import { alfano1D, chan2D } from '../screen/pcMethods.js'
import { norm3, uvwBasis, dot } from '../screen/frames.js'
import type { CatalogObject, Vec3 } from '../screen/types.js'
import { levelOfEvent, LEVEL_RANK, PC_YELLOW, type EventLevel, type LevelBasis } from '../screen/levels.js'
import {
  ensureScreenSchema,
  listOrgScreenEvents,
  countDoneScreenJobs,
  type OrgScreenEventRow
} from '../db/screenDb.js'
import {
  ensureCaSchema,
  getCaDefaults,
  caDefaultsToParams,
  listUserCaParams,
  getObjectCaParams,
  CA_SYSTEM_DEFAULTS,
  type CaParams,
  createPcRun,
  listPcRuns
} from '../db/caDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

/* ----------------------------- schema ------------------------------ */

let schemaReady = false

/** sat_cdm 补 source 列（区分系统日更与客户上传）+ 对/TCA 复合索引；MySQL 8 无 IF NOT EXISTS，先查再 ALTER。
 *  C3：补 org_id 列（source=customer 的上传组织，公开列表按组织隔离）。 */
export async function ensureCdmSchema(): Promise<boolean> {
  if (schemaReady) return true
  try {
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'sat_cdm'`
    )
    const names = new Set(cols.map((c) => String(c.COLUMN_NAME)))
    if (!names.has('source')) {
      await pool.query(
        `ALTER TABLE sat_cdm ADD COLUMN source varchar(20) NOT NULL DEFAULT 'system'`
      )
    }
    if (!names.has('org_id')) {
      await pool.query(
        `ALTER TABLE sat_cdm ADD COLUMN org_id bigint unsigned NULL DEFAULT NULL COMMENT '上传组织（source=customer 组织隔离）'`
      )
    }
    const [idx] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'sat_cdm' AND index_name = 'idx_cdm_pair_tca'`
    )
    if (!idx.length) {
      await pool.query(`ALTER TABLE sat_cdm ADD INDEX idx_cdm_pair_tca (norad_a, norad_b, tca)`)
    }
    schemaReady = true
    return true
  } catch (e) {
    console.error('[events] ensureCdmSchema failed:', (e as Error).message)
    return false
  }
}

/* ---------------------------- 聚合模型 ------------------------------ */

// R1-1：等级口径统一到 screen/levels（与筛查产出/CDM 入站共用），此处仅做聚合
export type { EventLevel } from '../screen/levels.js'

export interface CdmRow extends RowDataPacket {
  id: number
  cdm_id: string | null
  creation_date: Date | string | null
  originator: string | null
  tca: Date | string | null
  norad_a: number | null
  name_a: string | null
  norad_b: number | null
  name_b: string | null
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
  hard_body_radius_m: number | null
  source: string
  org_id: number | null
}

export interface ConjunctionEvent {
  key: string
  noradA: number
  noradB: number
  nameA: string
  nameB: string
  tca: string // 事件首条 TCA（ISO）
  tcaSpanH: number // 首→末 TCA 跨度（小时）
  cdmCount: number
  level: EventLevel
  /** 等级依据：pc = 官方 Pc 分档；miss = 无 Pc 时按脱靶距离兜底；none = 低 */
  levelBasis: LevelBasis
  pc: number | null // 官方 Pc（成员最大值，原样保留）
  pcSource: string // 命中 Pc 的成员来源（system/customer）
  missKm: number | null // 最小脱靶距离
  relSpeedKmS: number | null
  sources: string[] // 成员来源去重
  dataSource: 'system_pool' | 'org_credential' // C3：含客户上传成员 → org_credential
  /** 筛查事件：产出该事件的 screening_jobs.id；前端跳 /screens/{jobId} */
  jobId?: number
}

const GAP_MS = 3 * 3600 * 1000
const LIST_LIMIT = 5000

/** 窗口参数：24h/3d/7d/all（默认 3d）；from 缺省 = now-1d 保证刚过的 TCA 仍可见，
 *  all = 回看至当前档位 CDM 历史深度（C3：免费 3 天 / 普通 30 天 / VIP 365 天） */
function windowRange(window: string | undefined, cdmDays = 3): { from: Date; to: Date } {
  const now = Date.now()
  const fwdMs =
    window === '24h' ? 24 * 3600e3 : window === '7d' ? 7 * 24 * 3600e3 : window === 'all' ? 30 * 24 * 3600e3 : 3 * 24 * 3600e3
  const backMs = window === 'all' ? Math.min(Math.max(cdmDays, 0), 365) * 24 * 3600e3 : 24 * 3600e3
  return { from: new Date(now - backMs), to: new Date(now + fwdMs) }
}

function toIso(d: Date | string | null): string {
  if (d === null) return ''
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/** 把 sat_cdm 行聚合成事件列表（gap-island 聚类）；日报 job（H2）复用同口径 */
export function aggregateEvents(rows: CdmRow[]): ConjunctionEvent[] {
  interface Pair {
    a: number
    b: number
    items: CdmRow[]
  }
  const pairs = new Map<string, Pair>()
  for (const r of rows) {
    if (r.norad_a == null || r.norad_b == null || r.tca === null) continue
    const a = Math.min(r.norad_a, r.norad_b)
    const b = Math.max(r.norad_a, r.norad_b)
    const k = `${a}:${b}`
    let p = pairs.get(k)
    if (!p) {
      p = { a, b, items: [] }
      pairs.set(k, p)
    }
    p.items.push(r)
  }

  const events: ConjunctionEvent[] = []
  for (const p of pairs.values()) {
    p.items.sort((x, y) => new Date(x.tca!).getTime() - new Date(y.tca!).getTime())
    // gap-island：相邻 TCA 差 > 3h 即切分新事件
    let island: CdmRow[] = [p.items[0]]
    const flush = (): void => {
      if (island.length) pushEvent(p.a, p.b, island)
      island = []
    }
    const pushEvent = (a: number, b: number, items: CdmRow[]): void => {
      const tcaMs = new Date(items[0].tca!).getTime()
      const lastMs = new Date(items[items.length - 1].tca!).getTime()
      let pc: number | null = null
      let pcSource = ''
      let missKm: number | null = null
      for (const it of items) {
        if (it.collision_probability !== null && (pc === null || it.collision_probability > pc)) {
          pc = it.collision_probability
          pcSource = it.source
        }
        if (it.miss_distance_km !== null && (missKm === null || it.miss_distance_km < missKm)) {
          missKm = it.miss_distance_km
        }
      }
      // R1-1：统一分级（Pc 优先，无 Pc 时按最小脱靶距离兜底）
      const graded = levelOfEvent(pc, missKm)
      events.push({
        key: `${a}:${b}:${tcaMs}`,
        noradA: a,
        noradB: b,
        nameA: items[0].norad_a === a ? items[0].name_a || '' : items[0].name_b || '',
        nameB: items[0].norad_a === a ? items[0].name_b || '' : items[0].name_a || '',
        tca: toIso(items[0].tca),
        tcaSpanH: Math.round(((lastMs - tcaMs) / 3600e3) * 10) / 10,
        cdmCount: items.length,
        level: graded.level,
        levelBasis: graded.basis,
        pc,
        pcSource,
        missKm,
        relSpeedKmS: items.find((x) => x.rel_speed_km_per_s !== null)?.rel_speed_km_per_s ?? null,
        sources: [...new Set(items.map((x) => x.source))],
        dataSource: items.some((x) => x.source === 'customer') ? 'org_credential' : 'system_pool'
      })
    }
    for (let i = 1; i < p.items.length; i++) {
      const prevMs = new Date(p.items[i - 1].tca!).getTime()
      const curMs = new Date(p.items[i].tca!).getTime()
      if (curMs - prevMs > GAP_MS) {
        flush()
        island = [p.items[i]]
      } else {
        island.push(p.items[i])
      }
    }
    flush()
  }

  // 高危优先，同级按 TCA 升序
  events.sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || x.tca.localeCompare(y.tca))
  return events
}

/** 从行集中重跑 gap-island 聚类（与 aggregateEvents 同口径），返回首条 TCA 命中的岛 */
function findIsland(rows: CdmRow[], a: number, b: number, firstTcaMs: number): CdmRow[] | null {
  const items = rows
    .filter(
      (r) =>
        r.norad_a != null &&
        r.norad_b != null &&
        Math.min(r.norad_a, r.norad_b) === a &&
        Math.max(r.norad_a, r.norad_b) === b
    )
    .sort((x, y) => new Date(x.tca!).getTime() - new Date(y.tca!).getTime())
  if (!items.length) return null
  const islands: CdmRow[][] = []
  let cur: CdmRow[] = [items[0]]
  for (let i = 1; i < items.length; i++) {
    const diff = new Date(items[i].tca!).getTime() - new Date(items[i - 1].tca!).getTime()
    if (diff > GAP_MS) {
      islands.push(cur)
      cur = [items[i]]
    } else {
      cur.push(items[i])
    }
  }
  islands.push(cur)
  for (const isl of islands) {
    if (new Date(isl[0].tca!).getTime() === firstTcaMs) return isl
  }
  return null
}


const SCREEN_ISLAND_MS = 5 * 60 * 1000

function passesWatchFloor(e: ConjunctionEvent): boolean {
  if (e.pc === null || !Number.isFinite(e.pc)) return true
  if (e.pc >= PC_YELLOW) return true
  // 稀释关注：筛查已按 Pc 口径标为黄/橙/红，即使中心 Pc < 1e-7 也保留
  if (e.levelBasis === 'pc' && LEVEL_RANK[e.level] > 0) return true
  return false
}

/** 同一无序星对 + 数分钟内 TCA 视为同一交会，保留最高 Pc，其次最新 job */
function dedupScreenEvents(rows: OrgScreenEventRow[]): OrgScreenEventRow[] {
  const groups = new Map<string, OrgScreenEventRow[]>()
  for (const r of rows) {
    const a = Math.min(Number(r.primary_norad), Number(r.secondary_norad))
    const b = Math.max(Number(r.primary_norad), Number(r.secondary_norad))
    const k = `${a}:${b}`
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const out: OrgScreenEventRow[] = []
  const pick = (island: OrgScreenEventRow[]): OrgScreenEventRow => {
    return [...island].sort((x, y) => {
      const px = x.pc == null ? null : Number(x.pc)
      const py = y.pc == null ? null : Number(y.pc)
      const pxOk = px != null && Number.isFinite(px)
      const pyOk = py != null && Number.isFinite(py)
      if (pxOk && pyOk && px !== py) return (py as number) - (px as number)
      if (pxOk && !pyOk) return -1
      if (!pxOk && pyOk) return 1
      return Number(y.job_id) - Number(x.job_id)
    })[0]
  }
  for (const items of groups.values()) {
    items.sort((x, y) => new Date(x.tca).getTime() - new Date(y.tca).getTime())
    let island: OrgScreenEventRow[] = []
    const flush = (): void => {
      if (!island.length) return
      out.push(pick(island))
      island = []
    }
    for (const it of items) {
      if (!island.length) {
        island = [it]
        continue
      }
      const prev = new Date(island[island.length - 1].tca).getTime()
      const cur = new Date(it.tca).getTime()
      if (cur - prev > SCREEN_ISLAND_MS) flush()
      island.push(it)
    }
    flush()
  }
  return out
}

function screenRowsToEvents(
  rows: OrgScreenEventRow[],
  primarySource: 'tle' | 'ephem' | 'aoe'
): ConjunctionEvent[] {
  const events: ConjunctionEvent[] = []
  for (const e of dedupScreenEvents(rows)) {
    const pc = e.pc != null && Number.isFinite(Number(e.pc)) ? Number(e.pc) : null
    const missKm = e.miss_km != null && Number.isFinite(Number(e.miss_km)) ? Number(e.miss_km) : null
    const pcMax = e.pc_max != null && Number.isFinite(Number(e.pc_max)) ? Number(e.pc_max) : null
    const graded = levelOfEvent(pc, missKm, pcMax)
    const stored = String(e.level)
    const level: EventLevel =
      stored === 'red' || stored === 'orange' || stored === 'yellow' ? stored : graded.level
    events.push({
      key: `scr-${e.job_id}-${e.id}`,
      jobId: Number(e.job_id),
      noradA: Number(e.primary_norad),
      noradB: Number(e.secondary_norad),
      nameA: e.primary_name || '',
      nameB: e.secondary_name || '',
      tca: toIso(e.tca as unknown as Date | string | null),
      tcaSpanH: 0,
      cdmCount: e.cdm_id ? 1 : 0,
      level,
      levelBasis: graded.basis,
      pc,
      pcSource: `screen-${primarySource}`,
      missKm,
      relSpeedKmS:
        e.rel_speed_kms != null && Number.isFinite(Number(e.rel_speed_kms)) ? Number(e.rel_speed_kms) : null,
      sources: [`screen-${primarySource}`],
      dataSource: 'system_pool'
    })
  }
  events.sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || x.tca.localeCompare(y.tca))
  return events
}

/* ------------------------------ 路由 ------------------------------- */

router.use('/events', async (_req, _res, next) => {
  if (!(await ensureCdmSchema())) {
    _res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

/** 客户上传 CDM 入站：解析 → upsert（source='customer'，同 cdm_id 覆盖更新） */
router.post('/events/import', requireAuth, async (req: ScopedRequest, res) => {
  if (!req.auth?.org || !req.auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  const body = (req.body ?? {}) as { text?: unknown }
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    res.status(400).json(fail(400, '缺少 CDM 文本'))
    return
  }
  if (text.length > 8 * 1024 * 1024) {
    res.status(413).json(fail(413, '文本超过 8MB 上限'))
    return
  }

  const { parsed, failed } = parseCdmText(text)
  if (!parsed.length) {
    res.status(422).json(fail(422, '未解析到任何 CDM 报文（支持 KVN / XML / Space-Track JSON）'))
    return
  }

  let inserted = 0
  let updated = 0
  const skipped = failed
  const orgId = req.auth.org!.id
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const c of parsed) {
      if (c.noradA === null || c.noradB === null || !c.tca) {
        continue
      }
      const cdmId = c.cdmId || `CUSTOM-${c.noradA}-${c.noradB}-${c.tca.getTime()}`
      const [ex] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM sat_cdm WHERE source = 'customer' AND cdm_id = ? LIMIT 1`,
        [cdmId]
      )
      const vals = [
        cdmId, c.creationDate, c.originator || 'CUSTOMER', c.tca, 'SCREENING', 0,
        c.noradA, c.nameA, c.noradB, c.nameB,
        c.missDistanceKm, null, c.relSpeedKmS, c.collisionProbability, c.hardBodyRadiusM, c.rawJson, orgId
      ]
      if (ex.length) {
        await conn.query(
          `UPDATE sat_cdm SET cdm_id=?, creation_date=?, originator=?, tca=?, type=?, focus_a=?,
           norad_a=?, name_a=?, norad_b=?, name_b=?, miss_distance_km=?, radial_distance_km=?,
           rel_speed_km_per_s=?, collision_probability=?, hard_body_radius_m=?, raw_json=?, org_id=?, source='customer'
           WHERE id=?`,
          [...vals, ex[0].id]
        )
        updated++
      } else {
        await conn.query(
          `INSERT INTO sat_cdm (cdm_id, creation_date, originator, tca, type, focus_a,
           norad_a, name_a, norad_b, name_b, miss_distance_km, radial_distance_km,
           rel_speed_km_per_s, collision_probability, hard_body_radius_m, raw_json, org_id, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer')`,
          vals
        )
        inserted++
      }
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  const by = req.auth?.user.email ?? ''
  console.log(`[events] CDM import by ${by}: +${inserted} ~${updated} skip=${skipped}`)
  await writeUserAudit(req.auth, 'event.cdm_import', {
    after: {
      summary: `导入 CDM ${parsed.length} 条（新增 ${inserted}，更新 ${updated}，跳过 ${skipped}）`,
      parsed: parsed.length,
      inserted,
      updated,
      skipped
    }
  })
  res.json(ok({ parsed: parsed.length, inserted, updated, skipped }))
})

/** 事件聚合列表（R0-1 登录可读，C3 按档裁剪）：window=24h|3d|7d|all，level/q 前端过滤即可；
 *  eventSource=cdm|tle|ephem|aoe（缺省 cdm）。CDM 走 sat_cdm；tle/ephem/aoe 走本组织已完成筛查。
 *  客户上传 CDM（source=customer）仅上传组织可见；all 窗口回看深度按档 system_cdm_days。
 *  平台超管（无所属组织）仅可见系统池 CDM，筛查源因无组织而返回空（不跨组织泄露）。
 *  scope=mine 时只返回本组织关注/认领（claim_status=claimed）目标参与的星对。
 *  列表过滤 Pc < 1e-7 的事件（无 Pc 仍可按脱靶距离保留）；不删除库内 CDM。 */
router.get('/events', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org ?? null
  const policy = await resolvePoolPolicy(org)
  const { from, to } = windowRange(String(req.query.window ?? ''), policy.cdmDays)
  const rawSource = String(req.query.eventSource ?? 'cdm').trim().toLowerCase()
  const eventSource = rawSource || 'cdm'
  const windowMeta = { from: from.toISOString(), to: to.toISOString() }
  const scope = String(req.query.scope ?? '')

  if (eventSource === 'tle' || eventSource === 'ephem' || eventSource === 'aoe') {
    if (!(await ensureScreenSchema())) {
      res.status(503).json(fail(503, '数据库不可用'))
      return
    }
    if (!org) {
      res.json(ok({ events: [], hasScreenJobs: false, window: windowMeta, pool: poolBadge(policy) }))
      return
    }
    const jobCount = await countDoneScreenJobs(org.id, eventSource)
    const rows = await listOrgScreenEvents({
      orgId: org.id,
      primarySource: eventSource,
      from,
      to,
      claimedOnly: scope === 'mine'
    })
    res.json(
      ok({
        events: screenRowsToEvents(rows, eventSource).filter(passesWatchFloor),
        hasScreenJobs: jobCount > 0,
        window: windowMeta,
        pool: poolBadge(policy)
      })
    )
    return
  }

  if (eventSource !== 'cdm') {
    res.json(ok({ events: [], hasScreenJobs: false, window: windowMeta, pool: poolBadge(policy) }))
    return
  }

  // 客户 CDM 组织隔离：登录组织额外可见自己上传的行；超管/无组织只见系统池
  const isoSql = org ? `AND (source <> 'customer' OR org_id = ?)` : `AND source <> 'customer'`
  const params: unknown[] = org ? [from, to, org.id] : [from, to]
  // 只看关注/认领目标：无组织账号（平台超管）没有关注目标，直接返回空列表
  let scopeSql = ''
  if (scope === 'mine') {
    if (!org) {
      res.json(ok({ events: [], hasScreenJobs: false, window: windowMeta, pool: poolBadge(policy) }))
      return
    }
    scopeSql = `AND (norad_a IN (SELECT norad_id FROM objects WHERE org_id = ? AND claim_status = 'claimed')
                  OR norad_b IN (SELECT norad_id FROM objects WHERE org_id = ? AND claim_status = 'claimed'))`
    params.push(org.id, org.id)
  }
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source, org_id
     FROM sat_cdm
     WHERE tca IS NOT NULL AND tca >= ? AND tca <= ? ${isoSql} ${scopeSql}
     ORDER BY tca ASC
     LIMIT ${LIST_LIMIT}`,
    params
  )
  res.json(
    ok({
      events: aggregateEvents(rows).filter(passesWatchFloor),
      hasScreenJobs: false,
      window: windowMeta,
      pool: poolBadge(policy)
    })
  )
})

/** 事件详情：成员 CDM（不含 raw）+ 双方 sat_tle 档案（R0-1 登录可读；C3：客户 CDM 组织隔离） */
router.get('/events/:key', requireAuth, async (req: ScopedRequest, res) => {
  const key = String(req.params.key ?? '')
  const m = /^(\d+):(\d+):(\d+)$/.exec(key)
  if (!m) {
    res.status(400).json(fail(400, '事件 key 无效'))
    return
  }
  const a = Number(m[1])
  const b = Number(m[2])
  const firstTcaMs = Number(m[3])

  // 宽窗口取行（覆盖多圈内多次交会 + 聚类边界），再精确定位岛
  const tcaFrom = new Date(firstTcaMs - 10 * 24 * 3600e3)
  const tcaTo = new Date(firstTcaMs + 10 * 24 * 3600e3)
  const org = req.auth?.org ?? null
  const isoSql = org ? `AND (source <> 'customer' OR org_id = ?)` : `AND source <> 'customer'`
  const qParams: unknown[] = org
    ? [tcaFrom, tcaTo, a, b, a, b, org.id]
    : [tcaFrom, tcaTo, a, b, a, b]
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source, org_id
     FROM sat_cdm
     WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
       AND (norad_a IN (?, ?)) AND (norad_b IN (?, ?)) ${isoSql}
     ORDER BY tca ASC
     LIMIT ${LIST_LIMIT}`,
    qParams
  )
  const island = findIsland(rows, a, b, firstTcaMs)
  if (!island || !island.length) {
    res.status(404).json(fail(404, '交会事件不存在或已过期'))
    return
  }

  const events = aggregateEvents(island)
  const ev = events[0]

  interface TleRow extends RowDataPacket {
    norad_id: number
    object_name: string
    object_type: string
    intl_desig: string
    regime: string
    epoch: Date | string | null
    incl: number | null
    ecc: number | null
    apogee: number | null
    perigee: number | null
    period: number | null
    tle_line1: string
    tle_line2: string
    is_active: number
    updated_at: Date | string | null
  }
  const [tleRows] = await pool.query<TleRow[]>(
    `SELECT norad_id, object_name, object_type, intl_desig, regime, epoch, incl, ecc,
            apogee, perigee, period, tle_line1, tle_line2, is_active, updated_at
     FROM sat_tle WHERE norad_id IN (?, ?)`,
    [a, b]
  )
  const profile = (n: number): TleRow | null => tleRows.find((t) => Number(t.norad_id) === n) ?? null

  res.json(ok({
    event: ev,
    cdms: island.map((c) => ({
      id: c.id,
      cdm_id: c.cdm_id,
      creation_date: toIso(c.creation_date),
      originator: c.originator,
      tca: toIso(c.tca),
      miss_distance_km: c.miss_distance_km,
      rel_speed_km_per_s: c.rel_speed_km_per_s,
      collision_probability: c.collision_probability,
      hard_body_radius_m: c.hard_body_radius_m,
      source: c.source
    })),
    primary: profile(a),
    secondary: profile(b)
  }))
})

/** 单条 CDM 原文（raw_json）—— C3：客户上传的原文仅上传组织可读 */
router.get('/events/:key/cdm/:cdmId/raw', requireAuth, async (req: ScopedRequest, res) => {
  const key = String(req.params.key ?? '')
  const m = /^(\d+):(\d+):(\d+)$/.exec(key)
  const cdmId = Number(req.params.cdmId)
  if (!m || !Number.isInteger(cdmId)) {
    res.status(400).json(fail(400, '参数无效'))
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, cdm_id, raw_json, source, org_id FROM sat_cdm WHERE id = ? LIMIT 1`,
    [cdmId]
  )
  if (!rows.length) {
    res.status(404).json(fail(404, 'CDM 不存在'))
    return
  }
  const row = rows[0]
  if (String(row.source) === 'customer') {
    const ownerOrgId = row.org_id == null ? null : Number(row.org_id)
    const reqOrgId = req.auth?.org?.id ?? null
    if (ownerOrgId === null || ownerOrgId !== reqOrgId) {
      res.status(403).json(fail(403, '客户上传的 CDM 仅上传组织可读'))
      return
    }
  }
  const raw = row.raw_json
  res.json(ok({
    id: row.id,
    cdm_id: row.cdm_id,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  }))
})

/* --------------------- Pc 多算法比对（E3）与参数重算（F1） --------------------------- */

export type PcMethodName = 'official' | 'foster' | 'chan' | 'alfano'

interface PcCompareRow {
  method: PcMethodName
  pc: number | null
  missKm: number | null
  tca: string
  hbrM: number
  covSource: string
  ms: number
  disabled: boolean
  note: string
}

type PcAgreement = 'green' | 'yellow' | 'red'

interface PcComputeInput {
  noradA: number
  noradB: number
  tcaMs: number
  /** 生效 HBR（m），single 合并值或 both 组合值，由调用方解析 */
  hbrM: number
  officialPc?: number | null
  officialMissKm?: number | null
  officialRelSpeedKms?: number | null
  /** 参与计算的方法（官方 CDM 始终作对照行） */
  methods: Array<Exclude<PcMethodName, 'official'>>
}

interface PcComputeResult {
  rows: PcCompareRow[]
  agreement: PcAgreement
  plane: { missKm: number; inPlaneKm: number; relSpeedKms: number } | null
  cov: { sigmaT: [number, number]; ageHours: [number, number] } | null
  disableNote: string
}

/** 共享计算核：双方 TLE → SGP4 到 TCA → miss/relVel → 根数龄期协方差 → 交会平面投影，
 * 按请求方法各计时计算一次；官方 CDM Pc / miss / relSpeed 仅作对照行（不参与计算）。
 * 方法行禁用语义：缺 TLE 档案 / SGP4 失败 / 几何退化 → disabled + 原因，绝不静默给数。 */
async function computePcCompare(input: PcComputeInput): Promise<PcComputeResult> {
  const { noradA, noradB, tcaMs, hbrM, methods } = input
  const hbrKm = hbrM / 1000
  const tcaIso = new Date(tcaMs).toISOString()
  // R1-2：null/undefined/'' 必须保持 null（Number(null)=0 会把「无官方 Pc」显示成 0）
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  const rows: PcCompareRow[] = [
    {
      method: 'official',
      pc: num(input.officialPc),
      missKm: num(input.officialMissKm),
      tca: tcaIso,
      hbrM,
      covSource: 'cdm',
      ms: 0,
      disabled: num(input.officialPc) === null,
      note: num(input.officialPc) === null ? 'CDM 未提供官方 Pc' : ''
    }
  ]

  interface TlePick extends RowDataPacket {
    norad_id: number
    object_name: string
    tle_line1: string
    tle_line2: string
    epoch: Date | string | null
  }
  const [tleRows] = await pool.query<TlePick[]>(
    `SELECT norad_id, object_name, tle_line1, tle_line2, epoch FROM sat_tle WHERE norad_id IN (?, ?)`,
    [noradA, noradB]
  )
  const ta = tleRows.find((t) => Number(t.norad_id) === noradA) ?? null
  const tb = tleRows.find((t) => Number(t.norad_id) === noradB) ?? null

  const recOf = (t: TlePick | null) =>
    t ? buildSatrec({ line1: t.tle_line1, line2: t.tle_line2 } as unknown as CatalogObject) : null
  const recA = recOf(ta)
  const recB = recOf(tb)
  const pA = recA ? propagateJ2000(recA, tcaMs) : null
  const pB = recB ? propagateJ2000(recB, tcaMs) : null

  let plane: ReturnType<typeof encounterPlane> = null
  let cov: PcComputeResult['cov'] = null
  let planeResp: PcComputeResult['plane'] = null
  let disableNote = ''
  if (!ta || !tb) {
    disableNote = '缺一方 TLE 档案，无法同源传播'
  } else if (!pA || !pB) {
    disableNote = 'SGP4 传播失败（TLE 可能过期或根数异常）'
  } else {
    const covA = tleCovariance(pA.r, pA.v, new Date(ta.epoch ?? 0).getTime(), tcaMs)
    const covB = tleCovariance(pB.r, pB.v, new Date(tb.epoch ?? 0).getTime(), tcaMs)
    const missVec: Vec3 = [pB.r[0] - pA.r[0], pB.r[1] - pA.r[1], pB.r[2] - pA.r[2]]
    const relVelVec: Vec3 = [pB.v[0] - pA.v[0], pB.v[1] - pA.v[1], pB.v[2] - pA.v[2]]
    plane = encounterPlane({ missVec, relVelVec, covA: covA.cov, covB: covB.cov, hbrKm })
    if (!plane) {
      disableNote = '交会几何退化（协方差非正定或相对速度过小）'
    } else {
      cov = { sigmaT: [covA.sigmaT, covB.sigmaT], ageHours: [covA.ageHours, covB.ageHours] }
      planeResp = { missKm: norm3(missVec), inPlaneKm: Math.hypot(plane.mx, plane.my), relSpeedKms: plane.relSpeed }

      const timed = (fn: () => number): { pc: number; ms: number } => {
        const t0 = process.hrtime.bigint()
        const pc = fn()
        return { pc, ms: Number(process.hrtime.bigint() - t0) / 1e6 }
      }
      const missInPlane = Math.hypot(plane.mx, plane.my)
      const all = {
        foster: () => foster2D(plane!.mx, plane!.my, plane!.c2, hbrKm),
        chan: () => chan2D(plane!.mx, plane!.my, plane!.c2, hbrKm),
        alfano: () => alfano1D(plane!.mx, plane!.my, plane!.c2, hbrKm)
      } as const
      for (const method of methods) {
        const r = timed(all[method])
        rows.push({
          method,
          pc: r.pc,
          missKm: missInPlane,
          tca: tcaIso,
          hbrM,
          covSource: 'tle-age',
          ms: Math.round(r.ms * 100) / 100,
          disabled: false,
          note: ''
        })
      }
    }
  }
  if (disableNote) {
    for (const method of methods) {
      rows.push({ method, pc: null, missKm: null, tca: tcaIso, hbrM, covSource: '—', ms: 0, disabled: true, note: disableNote })
    }
  }

  // 一致性灯：取可比 Pc（已选方法 + 官方若有）的 max/min 比 —— ≤10 绿 / ≤100 黄 / 其余红；
  // 任一方法行禁用或可比值不足 2 个 → 红（无法评估一致性，如实降级）
  const methodRows = rows.filter((r) => r.method !== 'official')
  const pcs = methodRows.filter((r) => !r.disabled && r.pc !== null).map((r) => r.pc as number)
  if (rows[0].pc !== null) pcs.push(rows[0].pc)
  let agreement: PcAgreement = 'red'
  if (!methodRows.some((r) => r.disabled) && pcs.length >= 2) {
    const ratio = Math.min(...pcs) > 0 ? Math.max(...pcs) / Math.min(...pcs) : Infinity
    agreement = ratio <= 10 ? 'green' : ratio <= 100 ? 'yellow' : 'red'
  }

  return { rows, agreement, plane: planeResp, cov, disableNote }
}

/** E3 多算法比对（公开，全方法）：入参校验后走共享计算核 */
router.post('/events/pc-compare', requireAuth, async (req: ScopedRequest, res) => {
  const body = (req.body ?? {}) as {
    noradA?: number
    noradB?: number
    tcaMs?: number
    hbrM?: number
    officialPc?: number | null
    officialMissKm?: number | null
    officialRelSpeedKms?: number | null
  }
  const noradA = Number(body.noradA)
  const noradB = Number(body.noradB)
  const tcaMs = Number(body.tcaMs)
  if (!Number.isInteger(noradA) || !Number.isInteger(noradB) || !Number.isFinite(tcaMs) || noradA === noradB) {
    res.status(400).json(fail(400, '参数无效（noradA / noradB / tcaMs）'))
    return
  }
  const hbrM = Number.isFinite(Number(body.hbrM)) && Number(body.hbrM) > 0 ? Number(body.hbrM) : 15
  const result = await computePcCompare({
    noradA,
    noradB,
    tcaMs,
    hbrM,
    officialPc: body.officialPc,
    officialMissKm: body.officialMissKm,
    officialRelSpeedKms: body.officialRelSpeedKms,
    methods: ['foster', 'chan', 'alfano']
  })
  res.json(ok(result))
})

/* ----------------------- 参数重算（F1）：run 化 + 配额 + 对比 ----------------------- */

/** 系统级缺省 CA 参数统一取自 caDb.CA_SYSTEM_DEFAULTS（与设置页建议值同源） */

function parseEventKey(raw: string): { a: number; b: number; tcaMs: number } | null {
  const m = /^(\d+):(\d+):(\d+)$/.exec(raw)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const tcaMs = Number(m[3])
  if (a === b) return null
  return { a, b, tcaMs }
}

/** POST /cgi/events/:key/recompute —— 按配置重算（登录组织，计入 recompute_day 配额）。
 * 参数解析顺序：请求体（仅本次）> 组织默认（ca_org_defaults）> 系统缺省；
 * 结果落 conjunction_pc_runs（新 run_id），旧 run 经 GET 同路径可对比。 */
router.post('/events/:key/recompute', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org || !auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  if (!(await ensureCaSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const parsed = parseEventKey(String(req.params.key ?? ''))
  if (!parsed) {
    res.status(400).json(fail(400, '事件 key 无效'))
    return
  }
  const { a, b, tcaMs } = parsed

  // 配额：recompute_day（参数校验通过后再拦，避免 403 掩盖 400 语义）
  const exceeded = await quotaExceeded('recompute_day', auth.org)
  if (exceeded) {
    res.status(exceeded.status).json(exceeded.body)
    return
  }

  const orgDefaults = await getCaDefaults(auth.org.id)
  const body = (req.body ?? {}) as Record<string, unknown>
  // 第 3/4 项：参数来源 default（组织默认）| mine1 | mine2（个人参数组）| target（目标自定义，仅业主）
  const paramsSource = String(body.paramsSource || 'default')
  let base: CaParams = caDefaultsToParams(orgDefaults)
  if (paramsSource === 'mine1' || paramsSource === 'mine2') {
    const slot = paramsSource === 'mine1' ? 1 : 2
    const slotParams = (await listUserCaParams(auth.user.id)).find((s) => s.slot === slot)?.params
    if (!slotParams) {
      res.status(400).json(fail(400, `自定义参数组 ${slot} 尚未配置，请先在设置页保存`))
      return
    }
    base = slotParams
  } else if (paramsSource === 'target') {
    const [claimRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
      `SELECT id FROM objects
        WHERE norad_id IN (?, ?) AND org_id = ? AND claim_type = 'owner' AND claim_status = 'claimed'
        LIMIT 1`,
      [a, b, auth.org.id]
    )
    if (!claimRows.length) {
      res.status(403).json(fail(403, '交会双方均非本组织业主认领目标，无法使用目标自定义参数'))
      return
    }
    const targetParams = await getObjectCaParams(Number(claimRows[0].id))
    if (!targetParams) {
      res.status(400).json(fail(400, '该目标尚未保存自定义参数'))
      return
    }
    base = targetParams
  }
  const numOr = (reqVal: unknown, orgVal: number | null | undefined, sys: number, lo: number, hi: number): number => {
    if (Number.isFinite(Number(reqVal))) return Math.min(hi, Math.max(lo, Number(reqVal)))
    if (Number.isFinite(Number(orgVal))) return Math.min(hi, Math.max(lo, Number(orgVal)))
    return sys
  }

  // HBR：mode（single/both）+ 半径；both 用 sqrt(a²+b²) 组合，缺一侧回落单侧值
  const hbrMode: string =
    body.hbrMode === 'both' || body.hbrMode === 'single'
      ? String(body.hbrMode)
      : base.hbr_mode
  let hbrM: number
  let hbrA: number | null = null
  let hbrB: number | null = null
  if (hbrMode === 'both') {
    hbrA = numOr(body.hbrAM, base.hbr_a_m, CA_SYSTEM_DEFAULTS.hbr_m, 0.1, 1000)
    hbrB = numOr(body.hbrBM, base.hbr_b_m, CA_SYSTEM_DEFAULTS.hbr_m, 0.1, 1000)
    hbrM = Math.round(Math.sqrt(hbrA * hbrA + hbrB * hbrB) * 100) / 100
  } else {
    hbrM = numOr(body.hbrM, base.hbr_m, CA_SYSTEM_DEFAULTS.hbr_m, 1, 1000)
  }

  const acceptedPc = numOr(body.acceptedPc, base.accepted_pc, CA_SYSTEM_DEFAULTS.accepted_pc, 1e-9, 1)
  const acceptedMissKm = numOr(body.acceptedMissKm, base.accepted_miss_km, CA_SYSTEM_DEFAULTS.accepted_miss_km, 0.01, 100)
  const screenDistanceKm = numOr(body.screenDistanceKm, base.screen_distance_km, CA_SYSTEM_DEFAULTS.screen_distance_km, 0.5, 100)
  const covarianceMode = body.covarianceMode === 'cdm' || body.covarianceMode === 'tle-age'
    ? String(body.covarianceMode)
    : base.covariance_mode
  const propagator = body.propagator === 'numeric' || body.propagator === 'sgp4'
    ? String(body.propagator)
    : base.propagator
  const windowH = Math.round(numOr(body.windowH, base.window_h, CA_SYSTEM_DEFAULTS.window_h, 1, 168))
  const stepS = Math.round(numOr(body.stepS, base.step_s, CA_SYSTEM_DEFAULTS.step_s, 1, 3600))

  // 方法集：请求体 > 参数来源 > 系统缺省
  const allowed = new Set(['foster', 'chan', 'alfano'])
  let methods = Array.isArray(body.methods)
    ? (body.methods.map((s) => String(s).toLowerCase()).filter((s) => allowed.has(s)) as Array<'foster' | 'chan' | 'alfano'>)
    : base.pc_methods
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => allowed.has(s)) as Array<'foster' | 'chan' | 'alfano'>
  methods = [...new Set(methods)]
  if (!methods.length) {
    res.status(400).json(fail(400, '至少勾选一个 Pc 方法'))
    return
  }

  // 事件官方口径（聚合 Pc/miss/relSpeed 作对照行）：null 安全解析，缺省时回查本事件关联 CDM
  const numOrNull = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  let officialPc = numOrNull(body.officialPc)
  let officialMissKm = numOrNull(body.officialMissKm)
  let officialRelSpeedKms = numOrNull(body.officialRelSpeedKms)
  if (officialPc === null) {
    const tcaFrom = new Date(tcaMs - 10 * 24 * 3600e3)
    const tcaTo = new Date(tcaMs + 10 * 24 * 3600e3)
    const [rows] = await pool.query<CdmRow[]>(
      `SELECT id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
              miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source, org_id
         FROM sat_cdm
        WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
          AND (norad_a IN (?, ?)) AND (norad_b IN (?, ?))
          AND (source <> 'customer' OR org_id = ?)
        ORDER BY tca ASC
        LIMIT ${LIST_LIMIT}`,
      [tcaFrom, tcaTo, a, b, a, b, auth.org.id]
    )
    const island = findIsland(rows, a, b, tcaMs)
    for (const it of island ?? []) {
      if (it.collision_probability !== null && (officialPc === null || it.collision_probability > officialPc)) {
        officialPc = it.collision_probability
      }
      if (it.miss_distance_km !== null && (officialMissKm === null || it.miss_distance_km < officialMissKm)) {
        officialMissKm = it.miss_distance_km
      }
      if (it.rel_speed_km_per_s !== null && officialRelSpeedKms === null) {
        officialRelSpeedKms = it.rel_speed_km_per_s
      }
    }
  }

  const result = await computePcCompare({
    noradA: a,
    noradB: b,
    tcaMs,
    hbrM,
    officialPc,
    officialMissKm,
    officialRelSpeedKms,
    methods
  })

  // 如实降级说明：当前计算内核固定 SGP4 + TLE 龄期协方差；所选模式记录在 run 参数里供对比
  const engineNotes: string[] = []
  if (covarianceMode === 'cdm') engineNotes.push('协方差模式=cdm：当前内核暂以 TLE 龄期协方差计算，已如实标注')
  if (propagator === 'numeric') engineNotes.push('传播器=numeric：当前内核暂以 SGP4 计算，已如实标注')

  const resolvedParams = {
    hbr_mode: hbrMode,
    hbr_m: hbrM,
    hbr_a_m: hbrA,
    hbr_b_m: hbrB,
    accepted_pc: acceptedPc,
    accepted_miss_km: acceptedMissKm,
    screen_distance_km: screenDistanceKm,
    covariance_mode: covarianceMode,
    propagator,
    window_h: windowH,
    step_s: stepS,
    methods,
    engine_notes: engineNotes,
    params_source: paramsSource
  }

  const runId = await createPcRun({
    orgId: auth.org.id,
    eventKey: `${a}:${b}:${tcaMs}`,
    noradA: a,
    noradB: b,
    tca: new Date(tcaMs),
    paramsJson: JSON.stringify(resolvedParams),
    rowsJson: JSON.stringify(result.rows),
    agreement: result.agreement,
    planeJson: JSON.stringify({ plane: result.plane, cov: result.cov }),
    triggeredBy: auth.user.email
  })
  console.log(
    `[events] recompute run=${runId} org=${auth.org.id} ${a}:${b} hbr=${hbrM}m methods=${methods.join('+')} ` +
      `pc=${result.rows.find((r) => r.method !== 'official')?.pc ?? '—'} by=${auth.user.email}`
  )
  await writeUserAudit(auth, 'event.recompute', {
    after: {
      summary: `重算交会事件 ${a}:${b}，run=#${runId}，HBR ${hbrM}m，${methods.join('+')}`,
      runId,
      noradA: a,
      noradB: b,
      tcaMs,
      hbrM,
      methods,
      paramsSource,
      params: resolvedParams
    }
  })

  res.json(ok({
    run: { id: runId, created_at: new Date().toISOString(), params: resolvedParams },
    rows: result.rows,
    agreement: result.agreement,
    plane: result.plane,
    cov: result.cov,
    disableNote: result.disableNote || null,
    notes: engineNotes
  }))
})

/** GET /cgi/events/:key/recompute —— 本事件的重算 run 历史（本组织隔离，最新在前） */
router.get('/events/:key/recompute', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org || !auth.user.orgId) {
    // 平台账号只读：重算 run 按组织隔离，平台视图不展示具体组织的计算记录
    if (auth?.user.role?.startsWith('platform_')) {
      res.json(ok({ runs: [], platform: true }))
      return
    }
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  if (!(await ensureCaSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const parsed = parseEventKey(String(req.params.key ?? ''))
  if (!parsed) {
    res.status(400).json(fail(400, '事件 key 无效'))
    return
  }
  const runs = await listPcRuns(auth.org.id, `${parsed.a}:${parsed.b}:${parsed.tcaMs}`)
  res.json(ok({
    runs: runs.map((r) => ({
      id: r.id,
      event_key: r.event_key,
      tca: r.tca,
      params: safeParse(r.params_json),
      rows: safeParse<Array<unknown>>(r.rows_json) ?? [],
      agreement: r.agreement,
      plane: safeParse(r.plane_json),
      triggered_by: r.triggered_by,
      created_at: r.created_at
    }))
  }))
})

function safeParse<T = Record<string, unknown>>(s: string | null): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

/**
 * GET /cgi/events/:key/relative-motion?minutes=30&stepS=30  （R2-16）
 * TCA 附近相对运动时间序列：双方 sat_tle 经 SGP4 传播到同一惯性系（J2000），
 * d = r_B − r_A 再投到该时刻主星 A 的 UVW(=RIC) 基：
 *   dR 径向（远离地球为正）、dI 迹向（沿轨道前进为正）、dC 法向（轨道面法向）。
 * 数据来源固定为 TLE/SGP4，前端必须原样标注，不得暗示精密定轨。
 */
router.get('/events/:key/relative-motion', requireAuth, async (req, res) => {
  const parsed = parseEventKey(String(req.params.key ?? ''))
  if (!parsed) {
    res.status(400).json(fail(400, '事件 key 无效'))
    return
  }
  const { a, b, tcaMs } = parsed
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const minutes = clamp(Math.round(Number(req.query.minutes) || 30), 1, 240)
  const stepS = clamp(Math.round(Number(req.query.stepS) || 30), 5, 600)

  interface TlePick extends RowDataPacket {
    norad_id: number
    object_name: string
    tle_line1: string
    tle_line2: string
  }
  try {
    const [rows] = await pool.query<TlePick[]>(
      `SELECT norad_id, object_name, tle_line1, tle_line2 FROM sat_tle WHERE norad_id IN (?, ?)`,
      [a, b]
    )
    const ta = rows.find((t) => Number(t.norad_id) === a) ?? null
    const tb = rows.find((t) => Number(t.norad_id) === b) ?? null
    if (!ta || !tb) {
      res.status(404).json(fail(404, '缺少双方 TLE，无法计算相对运动'))
      return
    }
    const recA = buildSatrec({ line1: ta.tle_line1, line2: ta.tle_line2 } as unknown as CatalogObject)
    const recB = buildSatrec({ line1: tb.tle_line1, line2: tb.tle_line2 } as unknown as CatalogObject)
    if (!recA || !recB) {
      res.status(422).json(fail(422, 'TLE 解析失败，无法计算相对运动'))
      return
    }

    const halfMs = minutes * 60 * 1000
    const stepMs = stepS * 1000
    const samples: Array<{ tMs: number; dR: number; dI: number; dC: number; dist: number }> = []
    for (let off = -halfMs; off <= halfMs; off += stepMs) {
      const t = tcaMs + off
      const pa = propagateJ2000(recA, t)
      const pb = propagateJ2000(recB, t)
      if (!pa || !pb) continue
      const d: Vec3 = [pb.r[0] - pa.r[0], pb.r[1] - pa.r[1], pb.r[2] - pa.r[2]]
      const m = uvwBasis(pa.r, pa.v)
      const dR = dot(m[0], d)
      const dI = dot(m[1], d)
      const dC = dot(m[2], d)
      samples.push({
        tMs: t,
        dR: Math.round(dR * 1000) / 1000,
        dI: Math.round(dI * 1000) / 1000,
        dC: Math.round(dC * 1000) / 1000,
        dist: Math.round(Math.hypot(dR, dI, dC) * 1000) / 1000
      })
    }
    res.json(
      ok({
        noradA: a,
        noradB: b,
        tcaMs,
        minutes,
        stepS,
        source: 'tle-sgp4',
        names: { a: ta.object_name, b: tb.object_name },
        samples
      })
    )
  } catch (e) {
    console.error('[events] relative-motion failed:', (e as Error).message)
    res.status(500).json(fail(500, '相对运动计算失败'))
  }
})

export default router
