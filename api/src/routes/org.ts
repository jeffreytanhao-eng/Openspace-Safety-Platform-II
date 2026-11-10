/**
 * 组织资料与配额路由（Epic A2）：
 * - GET  /cgi/org        本组织资料（requireAuth）
 * - PATCH /cgi/org       组织管理员改名（org_admin 专属）
 * - GET  /cgi/org/quota  生效限额 + 当前用量（前端升级提示/设置页展示）
 */
import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import { ok, fail } from '../utils/response.js'
import { pool } from '../db/pool.js'
import { ensurePlanSchema, getEffectiveLimits, getUsage, FEATURE_KEYS } from '../db/planDb.js'
import { requireAuth, type SafeUser, type SafeOrg } from './auth.js'
import {
  ensureOrgSchema,
  findUserByEmail,
  listOrgMembers,
  countOrgMembers,
  removeOrgMember
} from '../db/orgDb.js'
import { writeAudit } from '../db/adminDb.js'
import { QUOTA_EXCEEDED } from '../middleware/plan.js'

/** 组织成员数上限：读档位默认/组织覆盖（VIP 默认 2 = 管理员之外最多 2 人） */
async function orgMembersMax(org: { id: number; plan: string }): Promise<number | null> {
  if (!(await ensurePlanSchema())) return null
  const limits = await getEffectiveLimits(org.id, org.plan)
  return limits.find((l) => l.feature === 'members_max')?.limit ?? 0
}

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
  if (auth.user.role !== 'org_admin' || auth.org.plan !== 'vip') {
    res.status(403).json(fail(403, '仅 VIP 组织管理员可修改组织资料'))
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

/* --------------------- R2-30：组织管理员管理成员 --------------------- */

/**
 * 成员管理闸门：仅本组织 org_admin（且组织为 VIP、状态正常）可调用；
 * org_member 一律 403（成员不能管理其他账号），平台账号无 org 也不放行。
 */
function memberManager(auth: ScopedRequest['auth'], res: Response): boolean {
  if (!auth?.org || !auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return false
  }
  if (auth.user.role !== 'org_admin') {
    res.status(403).json(fail(403, '仅组织管理员可管理组织成员'))
    return false
  }
  if (auth.org.plan !== 'vip' || auth.org.status !== 'active') {
    res.status(403).json(fail(403, '仅 VIP 组织管理员可管理组织成员'))
    return false
  }
  return true
}

/** 成员列表（不含管理员本人） */
router.get('/org/members', requireAuth, async (req: ScopedRequest, res) => {
  if (!memberManager(req.auth, res)) return
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const orgId = req.auth!.org!.id
  const items = await listOrgMembers(orgId)
  res.json(
    ok({
      items,
      usage: items.length,
      max: (await orgMembersMax(req.auth!.org!)) ?? 0,
      can_manage: true
    })
  )
})

/** 添加成员：新成员 role=org_member，随组织享有 VIP 能力 */
router.post('/org/members', requireAuth, async (req: ScopedRequest, res) => {
  if (!memberManager(req.auth, res)) return
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const org = req.auth!.org!
  const body = req.body || {}
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const displayName = String(body.displayName || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json(fail(400, '邮箱格式不正确'))
    return
  }
  if (password.length < 8) {
    res.status(400).json(fail(400, '密码至少 8 位'))
    return
  }
  try {
    if (await findUserByEmail(email)) {
      res.status(409).json(fail(409, '该邮箱已被注册'))
      return
    }
    const limit = await orgMembersMax(org)
    if (limit === null) {
      res.status(503).json(fail(503, '数据库不可用'))
      return
    }
    const usage = await countOrgMembers(org.id)
    if (usage >= limit) {
      res.status(403).json({
        code: QUOTA_EXCEEDED,
        msg: `已达单位成员数上限（${usage}/${limit}），请先移除成员`,
        data: { feature: 'members_max', usage, limit }
      })
      return
    }
    const passwordHash = await bcrypt.hash(password, 10)
    const [r] = await pool.query<import('mysql2').ResultSetHeader>(
      "INSERT INTO users (org_id, email, display_name, role, password_hash) VALUES (?, ?, ?, 'org_member', ?)",
      [org.id, email, displayName || email.split('@')[0], passwordHash]
    )
    await writeAudit({
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      orgId: org.id,
      action: 'member.create',
      after: { userId: r.insertId, email, role: 'org_member', by: 'org_admin' }
    })
    res.json(ok({ id: r.insertId, email, role: 'org_member' }))
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('uk_user_email')) {
      res.status(409).json(fail(409, '该邮箱已被注册'))
      return
    }
    console.error('[org] create member failed:', msg)
    res.status(500).json(fail(500, '创建成员失败'))
  }
})

/** 移除成员：卸出组织（org_id=NULL），账号仍可登录为普通用户 */
router.delete('/org/members/:id', requireAuth, async (req: ScopedRequest, res) => {
  if (!memberManager(req.auth, res)) return
  const org = req.auth!.org!
  const uid = Number(req.params.id)
  if (!Number.isInteger(uid)) {
    res.status(400).json(fail(400, '成员编号无效'))
    return
  }
  // 管理员不能移除自己；也不能移除超管 / 其它管理员（只允许移除本组织 org_member）
  if (uid === req.auth!.user.id) {
    res.status(403).json(fail(403, '不能移除自己'))
    return
  }
  const removed = await removeOrgMember(org.id, uid)
  if (!removed) {
    res.status(404).json(fail(404, '成员不存在、不属于本组织或无权移除'))
    return
  }
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'member.remove',
    after: { userId: uid, by: 'org_admin' }
  })
  res.json(ok({ id: uid, removed: true }))
})

export default router
