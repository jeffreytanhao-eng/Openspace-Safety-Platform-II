/**
 * Old Openspace-Safety-Platform public sat_tle routes
 * (reconstructed from frontend sat_public.ts + server.jsc string/SQL hints).
 * Mounted at /cgi/sat_tle/* — no bytenode runtime.
 *
 * C3 按档裁剪：匿名/免费=样例窗、普通=托管相关、VIP=全量；
 * constellation / tle_lines / detail 三条出站口统一走 systemPool 策略。
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
import { requireAuth } from './auth.js'
import { PLAN_FORBIDDEN } from '../middleware/plan.js'
import { getVisibleNorads, poolBadge, resolvePoolPolicy, type PoolPolicy } from '../services/systemPool.js'

const router = Router()

/** 可见 NORAD 判定器：'all' = 全量不裁剪（full 档）；Set = 白名单（空集 = 全不可见） */
async function visibleSet(policy: PoolPolicy): Promise<Set<number> | 'all'> {
  if (policy.mode === 'full') return 'all'
  const vis = await getVisibleNorads(policy)
  return new Set(vis ?? [])
}

router.get('/constellation', requireAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  try {
    const force = String(req.query.refresh || '') === '1'
    const t0 = Date.now()
    const policy = await resolvePoolPolicy(req.auth?.org ?? null)
    const snap = await buildConstellationSnapshot(force)
    const vs = await visibleSet(policy)
    const list = vs === 'all' ? snap.list : snap.list.filter((r) => vs.has(r[0]))
    res.setHeader('X-Snap-Build-Ms', String(Date.now() - t0))
    res.json(
      ok({
        ...snap,
        list,
        total: list.length,
        data_source: 'system_pool',
        pool: poolBadge(policy)
      })
    )
  } catch (e) {
    console.error('[sat_tle/constellation]', e)
    res.status(500).json({ code: 500, msg: 'constellation failed', data: null })
  }
})

router.get('/tle_lines', requireAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  try {
    const policy = await resolvePoolPolicy(req.auth?.org ?? null)
    const data = await listTleLines()
    const vs = await visibleSet(policy)
    const list = (vs === 'all' ? data.list : data.list.filter((r) => vs.has(r[0]))) as [number, string, string][]
    res.json(
      ok({
        total: list.length,
        list,
        data_source: 'system_pool',
        pool: poolBadge(policy)
      })
    )
  } catch (e) {
    console.error('[sat_tle/tle_lines]', e)
    res.status(500).json({ code: 500, msg: 'tle_lines failed', data: null })
  }
})

router.get('/detail/:noradId', requireAuth, async (req, res) => {
  const up = await pingDb()
  if (!up) {
    res.status(503).json({ code: 503, msg: 'database down', data: null })
    return
  }
  const policy = await resolvePoolPolicy(req.auth?.org ?? null)
  if (policy.mode === 'none') {
    res.status(403).json({
      code: PLAN_FORBIDDEN,
      msg: '当前档位未开放系统池，请升级',
      data: { pool: poolBadge(policy) }
    })
    return
  }
  const norad = Number(req.params.noradId)
  if (!Number.isFinite(norad)) {
    res.status(400).json({ code: 400, msg: 'bad norad', data: null })
    return
  }
  // 样例窗 / 托管相关档：仅可见集合内的 NORAD 可查详情
  if (policy.mode !== 'full') {
    const vis = await getVisibleNorads(policy)
    if (!vis || !vis.includes(norad)) {
      res.status(403).json({
        code: PLAN_FORBIDDEN,
        msg: '该目标不在当前档位可见范围内，请升级',
        data: { pool: poolBadge(policy) }
      })
      return
    }
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
  res.json(ok({ ...rows[0], data_source: 'system_pool', pool: poolBadge(policy) }))
})

/** Dev/ops: drop in-process snapshot cache */
router.post('/constellation/cache-clear', (_req, res) => {
  clearConstellationCache()
  res.json(ok({ cleared: true }))
})

export default router
