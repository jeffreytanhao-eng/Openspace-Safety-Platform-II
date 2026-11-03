/**
 * 交会事件路由（Epic E2）：
 *  - POST /cgi/events/import          客户上传 CDM（KVN/XML/JSON）解析入站，source='customer'；
 *  - GET  /cgi/events                 sat_cdm 按主/副星对 + 近 TCA 聚合成事件时间线（公开只读）；
 *  - GET  /cgi/events/:key            事件详情：成员 CDM 列表 + 双方 sat_tle 档案；
 *  - GET  /cgi/events/:key/cdm/:id/raw 单条 CDM 原文（raw_json）；
 *  - POST /cgi/events/pc-compare    多算法 Pc 比对（E3）：同源输入 = 双方 TLE 传播 +
 *                                   龄期协方差，Foster/Chan/Alfano + 官方 CDM Pc 对照行。
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
import { parseCdmText } from '../services/cdmParse.js'
import { buildSatrec, propagateJ2000 } from '../screen/coarse.js'
import { tleCovariance } from '../screen/covariance.js'
import { encounterPlane, foster2D } from '../screen/pc.js'
import { alfano1D, chan2D } from '../screen/pcMethods.js'
import { norm3 } from '../screen/frames.js'
import type { CatalogObject, Vec3 } from '../screen/types.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

/* ----------------------------- schema ------------------------------ */

let schemaReady = false

/** sat_cdm 补 source 列（区分系统日更与客户上传）+ 对/TCA 复合索引；MySQL 8 无 IF NOT EXISTS，先查再 ALTER */
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

export type EventLevel = 'red' | 'orange' | 'yellow' | 'low'

/** 单档分级：无 Pc / 低于 1e-7 → low（灰） */
function levelOfPc(pc: number | null): EventLevel {
  if (pc === null) return 'low'
  if (pc >= 1e-4) return 'red'
  if (pc >= 1e-5) return 'orange'
  if (pc >= 1e-7) return 'yellow'
  return 'low'
}

const LEVEL_RANK: Record<EventLevel, number> = { red: 3, orange: 2, yellow: 1, low: 0 }

interface CdmRow extends RowDataPacket {
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
  pc: number | null // 官方 Pc（成员最大值，原样保留）
  pcSource: string // 命中 Pc 的成员来源（system/customer）
  missKm: number | null // 最小脱靶距离
  relSpeedKmS: number | null
  sources: string[] // 成员来源去重
}

const GAP_MS = 3 * 3600 * 1000
const LIST_LIMIT = 5000

/** 窗口参数：24h/3d/7d/all（默认 3d）；from = now-1d 保证刚过的 TCA 仍可见 */
function windowRange(window: string | undefined): { from: Date; to: Date } {
  const now = Date.now()
  const fwdMs =
    window === '24h' ? 24 * 3600e3 : window === '7d' ? 7 * 24 * 3600e3 : window === 'all' ? 30 * 24 * 3600e3 : 3 * 24 * 3600e3
  return { from: new Date(now - 24 * 3600e3), to: new Date(now + fwdMs) }
}

function toIso(d: Date | string | null): string {
  if (d === null) return ''
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/** 把 sat_cdm 行聚合成事件列表（gap-island 聚类） */
function aggregateEvents(rows: CdmRow[]): ConjunctionEvent[] {
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
      let level: EventLevel = 'low'
      let pc: number | null = null
      let pcSource = ''
      let missKm: number | null = null
      for (const it of items) {
        const lv = levelOfPc(it.collision_probability)
        if (LEVEL_RANK[lv] > LEVEL_RANK[level]) level = lv
        if (it.collision_probability !== null && (pc === null || it.collision_probability > pc)) {
          pc = it.collision_probability
          pcSource = it.source
        }
        if (it.miss_distance_km !== null && (missKm === null || it.miss_distance_km < missKm)) {
          missKm = it.miss_distance_km
        }
      }
      events.push({
        key: `${a}:${b}:${tcaMs}`,
        noradA: a,
        noradB: b,
        nameA: items[0].norad_a === a ? items[0].name_a || '' : items[0].name_b || '',
        nameB: items[0].norad_a === a ? items[0].name_b || '' : items[0].name_a || '',
        tca: toIso(items[0].tca),
        tcaSpanH: Math.round(((lastMs - tcaMs) / 3600e3) * 10) / 10,
        cdmCount: items.length,
        level,
        pc,
        pcSource,
        missKm,
        relSpeedKmS: items.find((x) => x.rel_speed_km_per_s !== null)?.rel_speed_km_per_s ?? null,
        sources: [...new Set(items.map((x) => x.source))]
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
        c.missDistanceKm, null, c.relSpeedKmS, c.collisionProbability, c.hardBodyRadiusM, c.rawJson
      ]
      if (ex.length) {
        await conn.query(
          `UPDATE sat_cdm SET cdm_id=?, creation_date=?, originator=?, tca=?, type=?, focus_a=?,
           norad_a=?, name_a=?, norad_b=?, name_b=?, miss_distance_km=?, radial_distance_km=?,
           rel_speed_km_per_s=?, collision_probability=?, hard_body_radius_m=?, raw_json=?, source='customer'
           WHERE id=?`,
          [...vals, ex[0].id]
        )
        updated++
      } else {
        await conn.query(
          `INSERT INTO sat_cdm (cdm_id, creation_date, originator, tca, type, focus_a,
           norad_a, name_a, norad_b, name_b, miss_distance_km, radial_distance_km,
           rel_speed_km_per_s, collision_probability, hard_body_radius_m, raw_json, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer')`,
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
  res.json(ok({ parsed: parsed.length, inserted, updated, skipped }))
})

/** 事件聚合列表（公开只读）：window=24h|3d|7d|all，level/q 前端过滤即可 */
router.get('/events', async (req, res) => {
  const { from, to } = windowRange(String(req.query.window ?? ''))
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source
     FROM sat_cdm
     WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
     ORDER BY tca ASC
     LIMIT ${LIST_LIMIT}`,
    [from, to]
  )
  res.json(ok({ events: aggregateEvents(rows), window: { from: from.toISOString(), to: to.toISOString() } }))
})

/** 事件详情：成员 CDM（不含 raw）+ 双方 sat_tle 档案 */
router.get('/events/:key', async (req, res) => {
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
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source
     FROM sat_cdm
     WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
       AND (norad_a IN (?, ?)) AND (norad_b IN (?, ?))
     ORDER BY tca ASC
     LIMIT ${LIST_LIMIT}`,
    [tcaFrom, tcaTo, a, b, a, b]
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

/** 单条 CDM 原文（raw_json） */
router.get('/events/:key/cdm/:cdmId/raw', async (req, res) => {
  const key = String(req.params.key ?? '')
  const m = /^(\d+):(\d+):(\d+)$/.exec(key)
  const cdmId = Number(req.params.cdmId)
  if (!m || !Number.isInteger(cdmId)) {
    res.status(400).json(fail(400, '参数无效'))
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, cdm_id, raw_json FROM sat_cdm WHERE id = ? LIMIT 1`,
    [cdmId]
  )
  if (!rows.length) {
    res.status(404).json(fail(404, 'CDM 不存在'))
    return
  }
  const raw = rows[0].raw_json
  res.json(ok({
    id: rows[0].id,
    cdm_id: rows[0].cdm_id,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  }))
})

/* --------------------- Pc 多算法比对（E3） --------------------------- */

interface PcCompareRow {
  method: 'official' | 'foster' | 'chan' | 'alfano'
  pc: number | null
  missKm: number | null
  tca: string
  hbrM: number
  covSource: string
  ms: number
  disabled: boolean
  note: string
}

/** 多算法 Pc 比对：统一走服务端 TLE 传播（同源输入）——
 * 双方 sat_tle → SGP4 到 TCA → miss/relVel → 根数龄期协方差 → 交会平面投影，
 * Foster（数值基准）/ Chan（级数）/ Alfano（Bessel 一维积分）各计时一次；
 * 官方 CDM Pc / miss / relSpeed 仅作对照行（不参与计算）。
 * 方法行禁用语义：缺 TLE 档案 / SGP4 失败 / 几何退化 → disabled + 原因，绝不静默给数。 */
router.post('/events/pc-compare', async (req, res) => {
  const body = (req.body ?? {}) as {
    noradA?: unknown
    noradB?: unknown
    tcaMs?: unknown
    hbrM?: unknown
    officialPc?: unknown
    officialMissKm?: unknown
    officialRelSpeedKms?: unknown
  }
  const noradA = Number(body.noradA)
  const noradB = Number(body.noradB)
  const tcaMs = Number(body.tcaMs)
  if (!Number.isInteger(noradA) || !Number.isInteger(noradB) || !Number.isFinite(tcaMs) || noradA === noradB) {
    res.status(400).json(fail(400, '参数无效（noradA / noradB / tcaMs）'))
    return
  }
  const hbrM = Number.isFinite(Number(body.hbrM)) && Number(body.hbrM) > 0 ? Number(body.hbrM) : 15
  const hbrKm = hbrM / 1000
  const tcaIso = new Date(tcaMs).toISOString()
  const num = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null)

  const rows: PcCompareRow[] = [
    {
      method: 'official',
      pc: num(body.officialPc),
      missKm: num(body.officialMissKm),
      tca: tcaIso,
      hbrM,
      covSource: 'cdm',
      ms: 0,
      disabled: num(body.officialPc) === null,
      note: num(body.officialPc) === null ? 'CDM 未提供官方 Pc' : ''
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
  let cov: { sigmaT: [number, number]; ageHours: [number, number] } | null = null
  let planeResp: { missKm: number; inPlaneKm: number; relSpeedKms: number } | null = null
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
      const results = [
        ['foster', timed(() => foster2D(plane!.mx, plane!.my, plane!.c2, hbrKm))],
        ['chan', timed(() => chan2D(plane!.mx, plane!.my, plane!.c2, hbrKm))],
        ['alfano', timed(() => alfano1D(plane!.mx, plane!.my, plane!.c2, hbrKm))]
      ] as const
      for (const [method, r] of results) {
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
    for (const method of ['foster', 'chan', 'alfano'] as const) {
      rows.push({ method, pc: null, missKm: null, tca: tcaIso, hbrM, covSource: '—', ms: 0, disabled: true, note: disableNote })
    }
  }

  // 一致性灯：取可比 Pc（三方法 + 官方若有）的 max/min 比 —— ≤10 绿 / ≤100 黄 / 其余红；
  // 任一方法行禁用或可比值不足 2 个 → 红（无法评估一致性，如实降级）
  const methodRows = rows.filter((r) => r.method !== 'official')
  const pcs = methodRows.filter((r) => !r.disabled && r.pc !== null).map((r) => r.pc as number)
  if (rows[0].pc !== null) pcs.push(rows[0].pc)
  let agreement: 'green' | 'yellow' | 'red' = 'red'
  if (!methodRows.some((r) => r.disabled) && pcs.length >= 2) {
    const ratio = Math.min(...pcs) > 0 ? Math.max(...pcs) / Math.min(...pcs) : Infinity
    agreement = ratio <= 10 ? 'green' : ratio <= 100 ? 'yellow' : 'red'
  }

  res.json(ok({ rows, agreement, plane: planeResp, cov }))
})

export default router
