import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'

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

/** Catalog stats for Overview / health dashboards */
router.get('/catalog/stats', async (_req, res) => {
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
  res.json(
    ok({
      db: 'up',
      tle: Number(tleRows[0]?.c ?? 0),
      cdm: Number(cdmRows[0]?.c ?? 0),
      lastGpSync: sync[0] ?? null,
      lastCdmSync: cdmSync[0] ?? null
    })
  )
})

/**
 * Space-Track TLE catalog (sat_tle).
 * Query: q (name/norad), type, regime, limit (default 200, max 2000), offset
 */
router.get('/catalog/tles', async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const q = String(req.query.q || '').trim()
  const type = String(req.query.type || '').trim().toUpperCase()
  const regime = String(req.query.regime || '').trim().toUpperCase()
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 25000)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const where: string[] = ['tle_line1 <> \'\'', 'tle_line2 <> \'\'']
  const params: unknown[] = []
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
  res.json(ok({ total: Number(cnt[0]?.c ?? 0), items: rows }))
})

/** Recent Space-Track public CDMs */
router.get('/catalog/cdms', async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
  const [rows] = await pool.query<CdmRow[]>(
    `SELECT cdm_id, creation_date, tca, norad_a, name_a, norad_b, name_b,
            miss_distance_km, rel_speed_km_per_s, collision_probability
     FROM sat_cdm ORDER BY tca ASC LIMIT ?`,
    [limit]
  )
  res.json(ok({ total: rows.length, items: rows }))
})

export default router
