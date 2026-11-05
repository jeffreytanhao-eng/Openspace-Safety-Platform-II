import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'
import { optionalAuth, requireAuth } from './auth.js'
import { getVisibleNorads, poolBadge, resolvePoolPolicy, type PoolPolicy } from '../services/systemPool.js'
import { getDailyFetchStatus } from '../db/fetchDb.js'

const router = Router()

interface TleRow extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  epoch: Date | null
  incl: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
  is_active: number
  source: string
  updated_at: Date | null
  owner_code: string
}

interface CdmRow extends RowDataPacket {
  cdm_id: string
  creation_date: Date | null
  tca: Date | null
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
}

/** 可见 NORAD 集合 → SQL IN 片段（null = 不限制；空数组 = 不可见，由调用方短路） */
function noradFilter(vis: number[] | null): { sql: string; params: unknown[] } | null {
  if (vis === null) return null
  if (!vis.length) return { sql: '1 = 0', params: [] }
  return { sql: `norad_id IN (${vis.map(() => '?').join(',')})`, params: vis }
}

/** Catalog stats for Overview / health dashboards（C3：附带当前档位可见计数） */
router.get('/catalog/stats', optionalAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.json(ok({ db: 'down', tle: 0, cdm: 0 }))
    return
  }
  const [tleRows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM sat_tle')
  const [cdmRows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM sat_cdm')
  const [sync] = await pool.query<RowDataPacket[]>(
    'SELECT id, source, status, message, created_at FROM sat_sync_log ORDER BY id DESC LIMIT 1'
  )
  const [cdmSync] = await pool.query<RowDataPacket[]>(
    'SELECT id, status, message, created_at FROM sat_cdm_sync_log ORDER BY id DESC LIMIT 1'
  )
  const tle = Number(tleRows[0]?.c ?? 0)
  const cdm = Number(cdmRows[0]?.c ?? 0)
  // R1-3：与 /cgi/health 同口径的日更状态（GP+CDM 为出门标准；AOE 暂不接入）
  let dailyFetch: unknown = null
  try {
    dailyFetch = await getDailyFetchStatus()
  } catch {
    dailyFetch = null
  }
  const policy = await resolvePoolPolicy(req.auth?.org ?? null)
  let tleVisible = tle
  if (policy.mode === 'none') tleVisible = 0
  else if (policy.mode === 'managed') tleVisible = policy.managedNorads?.length ?? 0
  else if (policy.mode === 'sample') tleVisible = Math.min(tle, policy.sampleLimit)
  const [cdmVisRows] = policy.cdmDays > 0
    ? await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM sat_cdm WHERE tca IS NOT NULL AND tca >= DATE_SUB(NOW(), INTERVAL ? DAY)',
        [policy.cdmDays]
      )
    : [{ c: 0 } as RowDataPacket]
  res.json(
    ok({
      db: 'up',
      tle,
      cdm,
      tleVisible,
      cdmVisible: Number((cdmVisRows[0] as { c: number } | undefined)?.c ?? 0),
      data_source: 'system_pool',
      pool: poolBadge(policy),
      lastGpSync: sync[0] ?? null,
      lastCdmSync: cdmSync[0] ?? null,
      daily_fetch: dailyFetch
    })
  )
})

/**
 * Space-Track TLE catalog (sat_tle) — R0-1 登录可读 + C3 按档裁剪：
 * 免费=样例窗（最新 500 条），普通=托管 NORAD 相关，VIP=全量；
 * 响应带 data_source='system_pool' 与 pool 徽标。
 * Query: q (name/norad), type, regime, limit (default 200), offset
 */
router.get('/catalog/tles', requireAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const policy = await resolvePoolPolicy(req.auth?.org ?? null)
  const badge = { data_source: 'system_pool', pool: poolBadge(policy) }
  if (policy.mode === 'none') {
    res.json(ok({ total: 0, items: [], ...badge }))
    return
  }
  const q = String(req.query.q || '').trim()
  const type = String(req.query.type || '').trim().toUpperCase()
  const regime = String(req.query.regime || '').trim().toUpperCase()
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 25000)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const where: string[] = ['tle_line1 <> \'\'', 'tle_line2 <> \'\'']
  const params: unknown[] = []

  // C3 可见范围：样例窗 / 托管相关档限定 NORAD 集合（q 搜索也只能在该集合内命中）
  const vis = await getVisibleNorads(policy)
  const nf = noradFilter(vis)
  if (nf) {
    where.push(nf.sql)
    params.push(...nf.params)
  }

  if (q) {
    if (/^\d+$/.test(q)) {
      where.push('norad_id = ?')
      params.push(Number(q))
    } else {
      where.push('(object_name LIKE ? OR CAST(norad_id AS CHAR) LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
  }
  if (type) {
    // support comma-separated types, e.g. PAYLOAD,DEBRIS or UNKNOWN
    const types = type.split(',').map((t) => t.trim()).filter(Boolean)
    const clauses: string[] = []
    for (const t of types) {
      if (t === 'UNKNOWN') {
        clauses.push("(UPPER(IFNULL(object_type,'')) NOT IN ('PAYLOAD','DEBRIS','ROCKET BODY'))")
      } else {
        clauses.push('UPPER(object_type) = ?')
        params.push(t)
      }
    }
    if (clauses.length === 1) where.push(clauses[0])
    else if (clauses.length > 1) where.push('(' + clauses.join(' OR ') + ')')
  }
  if (regime) {
    where.push('UPPER(regime) = ?')
    params.push(regime)
  }
  const sql =
    `SELECT norad_id, object_name, object_type, regime, epoch, incl, apogee, perigee, ` +
    `tle_line1, tle_line2, is_active, source, updated_at, owner_code FROM sat_tle WHERE ${where.join(' AND ')} ` +
    `ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const [rows] = await pool.query<TleRow[]>(sql, params)
  const [cnt] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM sat_tle WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  )
  res.json(ok({ total: Number(cnt[0]?.c ?? 0), items: rows, ...badge }))
})

/** Recent Space-Track public CDMs（R0-1 登录可读；C3：按档限定历史天数窗） */
router.get('/catalog/cdms', requireAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const policy = await resolvePoolPolicy(req.auth?.org ?? null)
  const badge = { data_source: 'system_pool', pool: poolBadge(policy) }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
  if (policy.cdmDays <= 0) {
    res.json(ok({ total: 0, items: [], ...badge }))
    return
  }
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT cdm_id, creation_date, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability
     FROM sat_cdm
     WHERE tca IS NOT NULL AND tca >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY tca ASC LIMIT ?`,
    [policy.cdmDays, limit]
  )
  res.json(ok({ total: rows.length, items: rows, ...badge }))
})

export default router
