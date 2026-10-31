import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'

const router = Router()

/** Old `/cgi/sat_constellation/all` — registry for panel cards */
router.get('/all', async (_req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, c.code, c.name, c.name_en, c.regime, c.regime_label, c.status,
            c.plan_count, c.keywords,
            (SELECT COUNT(*) FROM sat_constellation_sat s WHERE s.constellation_id = c.id) AS satellite_count
     FROM sat_constellation c
     ORDER BY satellite_count DESC, c.name ASC`
  )
  res.json(ok(rows))
})

router.get('/of/:noradId', async (req, res) => {
  const norad = Number(req.params.noradId)
  if (!Number.isFinite(norad)) {
    res.status(400).json({ code: 400, msg: 'bad norad', data: null })
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, c.code, c.name, c.name_en
     FROM sat_constellation_sat s
     JOIN sat_constellation c ON c.id = s.constellation_id
     WHERE s.norad_id = ?`,
    [norad]
  )
  res.json(ok(rows))
})

export default router
