/**
 * 组织资料与配额路由（Epic A2）：
 * - GET  /cgi/org        本组织资料（requireAuth）
 * - PATCH /cgi/org       组织管理员改名（org_admin 专属）
 * - GET  /cgi/org/quota  生效限额 + 当前用量（前端升级提示/设置页展示）
 */
import { Router, type Request } from 'express'
import { ok, fail } from '../utils/response.js'
import { pool } from '../db/pool.js'
import { ensurePlanSchema, getEffectiveLimits, getUsage, FEATURE_KEYS } from '../db/planDb.js'
import { requireAuth, type SafeUser, type SafeOrg } from './auth.js'

const router = Router()

interface ScopedRequest extends Request {
  auth?: { user: SafeUser; org: SafeOrg | null }
}

/** 本组织资料 */
router.get('/org', requireAuth, (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  res.json(ok(org))
})

/** 组织管理员改名（status/plan 由超管 B1 管理，客户不可改） */
router.patch('/org', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (auth.user.role !== 'org_admin') {
    res.status(403).json(fail(403, '仅组织管理员可修改组织资料'))
    return
  }
  const name = String((req.body || {}).name || '').trim()
  if (!name || name.length > 128) {
    res.status(400).json(fail(400, '组织名不能为空且不超过 128 字'))
    return
  }
  try {
    await pool.query('UPDATE organizations SET name = ? WHERE id = ?', [name, auth.org.id])
    res.json(ok({ ...auth.org, name }))
  } catch (e) {
    if ((e as Error).message.includes('uk_org_name')) {
      res.status(409).json(fail(409, '组织名已存在'))
      return
    }
    console.error('[org] rename failed:', (e as Error).message)
    res.status(500).json(fail(500, '修改失败'))
  }
})

/** 生效限额 + 当前用量（前端升级提示与设置页数据源） */
router.get('/org/quota', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!(await ensurePlanSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const limits = await getEffectiveLimits(org.id, org.plan)
  const items = await Promise.all(
    FEATURE_KEYS.map(async (meta) => {
      const limit = limits.find((l) => l.feature === meta.key)?.limit ?? null
      const usage = org && limit !== null ? await getUsage(org.id, meta.key) : 0
      return { ...meta, limit, usage, overridden: limits.find((l) => l.feature === meta.key)?.overridden ?? false }
    })
  )
  res.json(ok({ plan: org.plan, items }))
})

export default router
