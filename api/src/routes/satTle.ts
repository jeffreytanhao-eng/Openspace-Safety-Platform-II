/**
 * Old Openspace-Safety-Platform public sat_tle routes
 * (reconstructed from frontend sat_public.ts + server.jsc string/SQL hints).
 * Mounted at /cgi/sat_tle/* — no bytenode runtime.
 */
import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'
import {
  buildConstellationSnapshot,
  listTleLines,
  clearConstellationCache
} from '../services/constellationSnapshot.js'

const router = Router()

router.get('/constellation', async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  try {
    const force = String(req.query.refresh || '') === '1'
    const t0 = Date.now()
    const snap = await buildConstellationSnapshot(force)
    res.setHeader('X-Snap-Build-Ms', String(Date.now() - t0))
    res.json(ok(snap))
  } catch (e) {
    console.error('[sat_tle/constellation]', e)
    res.status(500).json({ code: 500, msg: 'constellation failed', data: null })
  }
})

router.get('/tle_lines', async (_req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  try {
    const data = await listTleLines()
    res.json(ok(data))
  } catch (e) {
    console.error('[sat_tle/tle_lines]', e)
    res.status(500).json({ code: 500, msg: 'tle_lines failed', data: null })
  }
})

router.get('/detail/:noradId', async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const norad = Number(req.params.noradId)
  if (!Number.isFinite(norad)) {
    res.status(400).json({ code: 400, msg: 'bad norad', data: null })
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT norad_id, object_name, object_type, regime, epoch, incl, apogee, perigee,
            tle_line1, tle_line2, is_active, source, updated_at, owner_code
     FROM sat_tle WHERE norad_id = ? LIMIT 1`,
    [norad]
  )
  if (!rows[0]) {
    res.status(404).json({ code: 404, msg: 'not found', data: null })
    return
  }
  res.json(ok(rows[0]))
})

/** Dev/ops: drop in-process snapshot cache */
router.post('/constellation/cache-clear', (_req, res) => {
  clearConstellationCache()
  res.json(ok({ cleared: true }))
})

export default router
