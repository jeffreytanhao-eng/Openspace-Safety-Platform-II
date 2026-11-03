/**
 * 托管目标路由（Epic D1）：组织认领 NORAD 目标并维护档案。
 * 全部 requireAuth；认领挂 checkQuota('objects_max')（免费档 3 个，超限 403 + 升级提示）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import { quotaExceeded } from '../middleware/plan.js'
import {
  ensureObjectsSchema,
  listObjectsByOrg,
  getObjectById,
  getObjectByNorad,
  createObject,
  updateObject,
  deleteObject,
  countBoundEphem
} from '../db/objectsDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

/** 只放行组织账号（平台账号无 org 不可托管目标） */
function requireOrg(req: ScopedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.org || !req.auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  next()
}

/** 全部路由先过 requireAuth，进入业务前确保 schema（限定 /objects 前缀，避免拦截挂在后续的公开路由） */
router.use('/objects', requireAuth, async (req, res, next) => {
  if (!(await ensureObjectsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

interface SatTleInfo extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  epoch: string | null
  incl: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
}

async function satTleOf(noradId: number): Promise<SatTleInfo | null> {
  const [rows] = await pool.query<SatTleInfo[]>(
    `SELECT norad_id, object_name, object_type, regime, epoch, incl, apogee, perigee, tle_line1, tle_line2
     FROM sat_tle WHERE norad_id = ? LIMIT 1`,
    [noradId]
  )
  return rows[0] ?? null
}

/** 认领前预览：NORAD 在编目中的最新信息 */
router.get('/objects/lookup/:noradId', async (req, res) => {
  const norad = Number(req.params.noradId)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const tle = await satTleOf(norad)
  if (!tle) {
    res.status(404).json(fail(404, `编目中未找到 NORAD ${norad}`))
    return
  }
  const claimed = await getObjectByNorad(norad)
  res.json(ok({ sat: tle, claimed_by: claimed ? { orgId: claimed.org_id, id: claimed.id } : null }))
})

/** 本组织托管目标列表 */
router.get('/objects', requireOrg, async (req: ScopedRequest, res) => {
  const orgId = Number(req.auth!.user.orgId)
  const list = await listObjectsByOrg(orgId)
  const bound = await countBoundEphem(list.map((o) => o.id))
  res.json(ok(list.map((o) => ({ ...o, bound_ephemerides: bound.get(o.id) ?? 0 }))))
})

/** 认领目标：编目存在 → 唯一性（409）→ 配额（403）；冲突语义优先于配额，避免 403 掩盖 409 */
router.post('/objects', requireOrg, async (req: ScopedRequest, res) => {
  const orgId = Number(req.auth!.user.orgId)
  const body = req.body as { noradId?: unknown; massKg?: unknown; crossSectionM2?: unknown; propulsion?: unknown }
  const norad = Number(body.noradId)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const tle = await satTleOf(norad)
  if (!tle) {
    res.status(404).json(fail(404, `编目中未找到 NORAD ${norad}，无法认领`))
    return
  }
  const existing = await getObjectByNorad(norad)
  if (existing) {
    const mine = existing.org_id === orgId
    res.status(409).json(
      fail(409, mine ? '该目标已在本组织托管列表中' : `NORAD ${norad} 已被其他组织认领`)
    )
    return
  }
  const exceeded = await quotaExceeded('objects_max', req.auth!.org)
  if (exceeded) {
    res.status(exceeded.status).json(exceeded.body)
    return
  }
  const mass = body.massKg === undefined || body.massKg === null || body.massKg === '' ? null : Number(body.massKg)
  const cs = body.crossSectionM2 === undefined || body.crossSectionM2 === null || body.crossSectionM2 === '' ? null : Number(body.crossSectionM2)
  const row = await createObject({
    orgId,
    noradId: norad,
    name: tle.object_name || `NORAD ${norad}`,
    massKg: mass !== null && Number.isFinite(mass) ? mass : null,
    crossSectionM2: cs !== null && Number.isFinite(cs) ? cs : null,
    propulsion: typeof body.propulsion === 'string' ? body.propulsion.slice(0, 60) : ''
  })
  res.json(ok({ ...row, sat: tle }))
})

/** 目标详情：档案 + 最新轨道要素 + 绑定星历 */
router.get('/objects/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权查看其他组织的托管目标'))
    return
  }
  const sat = await satTleOf(row.norad_id)
  const [ephems] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, norad, format, points, published_at, status FROM ephemeris
     WHERE bound_object_id = ? ORDER BY published_at DESC LIMIT 50`,
    [id]
  )
  res.json(ok({ ...row, sat, ephemerides: ephems }))
})

/** 档案编辑 */
router.patch('/objects/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权修改其他组织的托管目标'))
    return
  }
  const b = req.body as Record<string, unknown>
  const numOrNull = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  await updateObject(id, {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : undefined,
    massKg: numOrNull(b.massKg),
    crossSectionM2: numOrNull(b.crossSectionM2),
    propulsion: typeof b.propulsion === 'string' ? b.propulsion.slice(0, 60) : undefined,
    acceptedPc: numOrNull(b.acceptedPc),
    acceptedMissKm: numOrNull(b.acceptedMissKm)
  })
  res.json(ok(await getObjectById(id)))
})

/** 释放认领 */
router.delete('/objects/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权释放其他组织的托管目标'))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE bound_object_id = ?', [id])
  await deleteObject(id)
  res.json(ok({ released: id }))
})

/** 星历绑定：校验星历 NORAD 与目标一致 + 目标归属 */
router.post('/objects/:id/bind-ephem', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权操作其他组织的托管目标'))
    return
  }
  const ephemId = String((req.body as { ephemId?: unknown }).ephemId ?? '').trim()
  if (!ephemId) {
    res.status(400).json(fail(400, '缺少 ephemId'))
    return
  }
  const [eph] = await pool.query<RowDataPacket[]>(
    'SELECT id, norad, name FROM ephemeris WHERE id = ? LIMIT 1',
    [ephemId]
  )
  if (!eph[0]) {
    res.status(404).json(fail(404, '星历不存在'))
    return
  }
  if (Number(eph[0].norad) !== row.norad_id) {
    res.status(400).json(fail(400, `星历 NORAD ${eph[0].norad} 与目标 NORAD ${row.norad_id} 不一致，拒绝绑定`))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = ? WHERE id = ?', [id, ephemId])
  res.json(ok({ bound: ephemId, to: id }))
})

/** 星历解绑 */
router.post('/objects/:id/unbind-ephem', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row || row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  const ephemId = String((req.body as { ephemId?: unknown }).ephemId ?? '').trim()
  if (!ephemId) {
    res.status(400).json(fail(400, '缺少 ephemId'))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE id = ? AND bound_object_id = ?', [ephemId, id])
  res.json(ok({ unbound: ephemId }))
})

export default router
