/**
 * 超管路由（Epic B1，/cgi/admin/*，仅 platform_super_admin）：
 * - GET    /admin/orgs            组织列表（含成员数）
 * - POST   /admin/orgs            开通向导：建组织 + 首个管理员 + 初始档位
 * - GET    /admin/orgs/:id        组织详情（含成员）
 * - PATCH  /admin/orgs/:id        升降级 plan / 关停 suspended / 关闭 closed / 恢复 active / 备注
 * - POST   /admin/orgs/:id/members 新建组织成员（受 members_max 配额）
 * - GET    /admin/audit           审计只读列表
 * 全部写操作写 admin_audit_logs。
 */
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import type { RowDataPacket } from 'mysql2'
import { ok, fail } from '../utils/response.js'
import { pool } from '../db/pool.js'
import { ensureOrgSchema, findUserByEmail, findOrgById, createOrgWithAdmin, type OrgRow } from '../db/orgDb.js'
import { ensureAdminSchema, writeAudit, listAudit } from '../db/adminDb.js'
import { ensurePlanSchema, getEffectiveLimits, getOrgQuotaRows, getOrgFlagRows, setOrgQuotaOverride, clearOrgQuotaOverride, setOrgFlagOverride, clearOrgFlagOverride, FEATURE_KEYS, FLAG_CATALOG, TLE_SCOPE, PC_BIT } from '../db/planDb.js'
import { requireAuth, type AuthContext } from './auth.js'
import { QUOTA_EXCEEDED } from '../middleware/plan.js'

const router = Router()

type ScopedRequest = import('express').Request & { auth?: AuthContext }

/** 超管守卫（B1 只放行 platform_super_admin） */
export function requireSuperAdmin(req: ScopedRequest, res: import('express').Response, next: import('express').NextFunction): void {
  if (req.auth?.user.role !== 'platform_super_admin') {
    res.status(403).json(fail(403, '需要平台超级管理员权限'))
    return
  }
  next()
}

const PLANS = ['free', 'normal', 'vip'] as const
type Plan = (typeof PLANS)[number]
const STATUSES = ['active', 'suspended', 'closed'] as const
type OrgStatus = (typeof STATUSES)[number]

interface OrgListRow extends RowDataPacket {
  id: number
  name: string
  plan: Plan
  status: OrgStatus
  trial_ends_at: string | null
  notes: string | null
  created_at: string
  members: number
}

/** 组织列表（含成员数） */
router.get('/admin/orgs', requireAuth, requireSuperAdmin, async (_req, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const [rows] = await pool.query<OrgListRow[]>(
    `SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS members
     FROM organizations o ORDER BY o.id DESC LIMIT 500`
  )
  res.json(ok({ items: rows }))
})

/** 开通向导：建组织 + 首个管理员 + 初始档位 */
router.post('/admin/orgs', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const body = req.body || {}
  const name = String(body.name || '').trim()
  const plan = PLANS.includes(body.plan) ? (body.plan as Plan) : 'free'
  const email = String(body.adminEmail || '').trim().toLowerCase()
  const password = String(body.adminPassword || '')
  const displayName = String(body.adminDisplayName || '').trim()

  if (!name || name.length > 128) {
    res.status(400).json(fail(400, '组织名不能为空且不超过 128 字'))
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json(fail(400, '管理员邮箱格式不正确'))
    return
  }
  if (password.length < 8) {
    res.status(400).json(fail(400, '管理员密码至少 8 位'))
    return
  }
  try {
    if (await findUserByEmail(email)) {
      res.status(409).json(fail(409, '该邮箱已被注册'))
      return
    }
    const passwordHash = await bcrypt.hash(password, 10)
    const { org, user } = await createOrgWithAdmin({
      orgName: name,
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
      plan
    })
    await writeAudit({
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      orgId: org.id,
      action: 'org.create',
      after: { name: org.name, plan: org.plan, adminEmail: user.email }
    })
    res.json(ok({ org, admin: { id: user.id, email: user.email, role: user.role } }))
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('uk_org_name')) {
      res.status(409).json(fail(409, '组织名已存在'))
      return
    }
    if (msg.includes('uk_user_email')) {
      res.status(409).json(fail(409, '该邮箱已被注册'))
      return
    }
    console.error('[admin] create org failed:', msg)
    res.status(500).json(fail(500, '开通失败'))
  }
})

/** 组织详情（含成员 / 生效限额 / 配额行 / 功能开关行） */
router.get('/admin/orgs/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const [members] = await pool.query<import('mysql2').RowDataPacket[]>(
    'SELECT id, email, display_name, role, status, created_at FROM users WHERE org_id = ? ORDER BY id',
    [orgId]
  )
  await ensurePlanSchema()
  const limits = await getEffectiveLimits(org.id, org.plan)
  const quotas = await getOrgQuotaRows(org.id, org.plan)
  const flags = await getOrgFlagRows(org.id)
  res.json(ok({ org, members, limits, quotas, flags }))
})

/** 功能键取值合法性（scope/bitmap 有语义枚举；count/days 须为非负整数） */
function validQuotaValue(feature: string, value: number): boolean {
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) return false
  if (feature === 'system_tle_scope') return [TLE_SCOPE.NONE, TLE_SCOPE.SAMPLE, TLE_SCOPE.MANAGED, TLE_SCOPE.FULL].includes(value as 0 | 1 | 2 | 3)
  if (feature === 'pc_methods') {
    const all = PC_BIT.Foster | PC_BIT.Chan | PC_BIT.Alfano | PC_BIT.OfficialCDM
    return value > 0 && (value & ~all) === 0
  }
  return true
}

/** 设置数字 override（立即生效：effective 每次实时解析） */
router.put('/admin/orgs/:id/quotas/:feature', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const feature = String(req.params.feature || '')
  if (!FEATURE_KEYS.some((f) => f.key === feature)) {
    res.status(404).json(fail(404, '未知功能键'))
    return
  }
  const limit = Number((req.body || {}).limit)
  if (!validQuotaValue(feature, limit)) {
    res.status(400).json(fail(400, '限额必须为非负整数（scope/位图键另有取值约束）'))
    return
  }
  await ensurePlanSchema()
  const before = (await getOrgQuotaRows(org.id, org.plan)).find((q) => q.feature === feature) ?? null
  await setOrgQuotaOverride(org.id, feature, limit)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'quota.override.set',
    before: before ? { feature, override: before.override, effective: before.effective } : { feature },
    after: { feature, override: limit }
  })
  const after = (await getOrgQuotaRows(org.id, org.plan)).find((q) => q.feature === feature)
  res.json(ok(after))
})

/** 清除数字 override（恢复档位默认） */
router.delete('/admin/orgs/:id/quotas/:feature', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const feature = String(req.params.feature || '')
  await ensurePlanSchema()
  const before = (await getOrgQuotaRows(org.id, org.plan)).find((q) => q.feature === feature) ?? null
  if (!before?.overridden) {
    res.status(409).json(fail(409, '该功能键没有组织覆盖，无需恢复'))
    return
  }
  await clearOrgQuotaOverride(org.id, feature)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'quota.override.clear',
    before: { feature, override: before.override, effective: before.effective },
    after: { feature, override: null, effective: before.default }
  })
  const after = (await getOrgQuotaRows(org.id, org.plan)).find((q) => q.feature === feature)
  res.json(ok(after))
})

/** 设置功能开关 override */
router.put('/admin/orgs/:id/flags/:key', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const key = String(req.params.key || '')
  if (!FLAG_CATALOG.some((f) => f.key === key)) {
    res.status(404).json(fail(404, '未知功能开关'))
    return
  }
  const enabled = (req.body || {}).enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json(fail(400, 'enabled 必须为布尔值'))
    return
  }
  await ensurePlanSchema()
  const before = (await getOrgFlagRows(org.id)).find((f) => f.key === key) ?? null
  await setOrgFlagOverride(org.id, key, enabled)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'flag.override.set',
    before: before ? { key, override: before.override, enabled: before.enabled } : { key },
    after: { key, override: enabled }
  })
  const after = (await getOrgFlagRows(org.id)).find((f) => f.key === key)
  res.json(ok(after))
})

/** 清除功能开关 override（恢复目录默认） */
router.delete('/admin/orgs/:id/flags/:key', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const key = String(req.params.key || '')
  await ensurePlanSchema()
  const before = (await getOrgFlagRows(org.id)).find((f) => f.key === key) ?? null
  if (!before?.overridden) {
    res.status(409).json(fail(409, '该开关没有组织覆盖，无需恢复'))
    return
  }
  await clearOrgFlagOverride(org.id, key)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'flag.override.clear',
    before: { key, override: before.override, enabled: before.enabled },
    after: { key, override: null, enabled: before.default }
  })
  const after = (await getOrgFlagRows(org.id)).find((f) => f.key === key)
  res.json(ok(after))
})

/** 变更组织：plan / status / notes（before → after 全量审计） */
router.patch('/admin/orgs/:id', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const body = req.body || {}
  const plan = body.plan === undefined ? org.plan : body.plan
  const status = body.status === undefined ? org.status : body.status
  const notes = body.notes === undefined ? org.notes : body.notes
  if (!PLANS.includes(plan) || !STATUSES.includes(status)) {
    res.status(400).json(fail(400, 'plan 或 status 取值非法'))
    return
  }
  if (typeof notes !== 'string' && notes !== null) {
    res.status(400).json(fail(400, 'notes 必须为字符串'))
    return
  }
  await pool.query('UPDATE organizations SET plan = ?, status = ?, notes = ? WHERE id = ?', [
    plan,
    status,
    notes,
    orgId
  ])
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId,
    action: 'org.update',
    before: { plan: org.plan, status: org.status, notes: org.notes },
    after: { plan, status, notes }
  })
  const updated = (await findOrgById(orgId)) as OrgRow
  res.json(ok(updated))
})

/** 新建组织成员（org_admin / org_member，受 members_max 生效限额） */
router.post('/admin/orgs/:id/members', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const body = req.body || {}
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const displayName = String(body.displayName || '').trim()
  const role = body.role === 'org_admin' ? 'org_admin' : 'org_member'

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
    await ensurePlanSchema()
    const limits = await getEffectiveLimits(org.id, org.plan)
    const membersMax = limits.find((l) => l.feature === 'members_max')?.limit
    const [cnt] = await pool.query<import('mysql2').RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM users WHERE org_id = ?',
      [orgId]
    )
    const usage = Number((cnt[0] as { n: number }).n)
    if (membersMax !== undefined && usage >= membersMax) {
      res.status(403).json({
        code: QUOTA_EXCEEDED,
        msg: `已达组织成员数上限（${usage}/${membersMax}），请升级档位`,
        data: { feature: 'members_max', usage, limit: membersMax }
      })
      return
    }
    const passwordHash = await bcrypt.hash(password, 10)
    const [r] = await pool.query<import('mysql2').ResultSetHeader>(
      'INSERT INTO users (org_id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)',
      [orgId, email, displayName || email.split('@')[0], role, passwordHash]
    )
    await writeAudit({
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      orgId,
      action: 'member.create',
      after: { userId: r.insertId, email, role }
    })
    res.json(ok({ id: r.insertId, email, role }))
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('uk_user_email')) {
      res.status(409).json(fail(409, '该邮箱已被注册'))
      return
    }
    console.error('[admin] create member failed:', msg)
    res.status(500).json(fail(500, '创建成员失败'))
  }
})

/** 审计只读列表 */
router.get('/admin/audit', requireAuth, requireSuperAdmin, async (req, res) => {
  if (!(await ensureAdminSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
  const page = Math.max(Number(req.query.page) || 1, 1)
  const { items, total } = await listAudit(limit, (page - 1) * limit)
  res.json(ok({ items, total, page, limit }))
})

export default router
