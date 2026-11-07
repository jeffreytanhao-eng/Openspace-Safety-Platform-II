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
import {
  ensureOrgSchema,
  findUserByEmail,
  findOrgById,
  createOrgForExistingUser,
  countOrgMembers,
  listAssignableVipUsers,
  listUpgradeRequests,
  approveUpgradeRequest,
  rejectUpgradeRequest,
  type OrgRow
} from '../db/orgDb.js'
import { ensureAdminSchema, writeAudit, listAudit } from '../db/adminDb.js'
import { ensurePlanSchema, getEffectiveLimits, getOrgQuotaRows, getOrgFlagRows, setOrgQuotaOverride, clearOrgQuotaOverride, setOrgFlagOverride, clearOrgFlagOverride, FEATURE_KEYS, FLAG_CATALOG, TLE_SCOPE, PC_BIT } from '../db/planDb.js'
import { requireAuth, type AuthContext } from './auth.js'
import { listClaimScopes, replaceClaimScopes, type ClaimScopeType, ensureObjectsSchema, listOwnerClaims, approveOwnerClaim, rejectOwnerClaim } from '../db/objectsDb.js'
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

/** R2-30：组织成员硬上限（不含管理员本人），账号页与超管后台同一口径 */
const MAX_ORG_MEMBERS = 3

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

/**
 * R2-29 开通组织：组织只能由超管创建，并指定一个「已有 VIP」作为组织管理员。
 * - 不再新建管理员邮箱/密码（公开注册只建普通账号，VIP 须先经升级申请审核）；
 * - 被指定账号必须：已是 VIP、尚未加入任何组织（含不能已是其它组织管理员）；
 * - 档位固定 vip（成员据此享有 VIP 能力）。
 */
router.post('/admin/orgs', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const body = req.body || {}
  const name = String(body.name || '').trim()
  const email = String(body.adminEmail || '').trim().toLowerCase()

  if (!name || name.length > 128) {
    res.status(400).json(fail(400, '组织名不能为空且不超过 128 字'))
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json(fail(400, '请指定已有 VIP 账号的邮箱'))
    return
  }
  try {
    const admin = await findUserByEmail(email)
    if (!admin) {
      res.status(404).json(fail(404, '该邮箱尚未注册，请先让用户注册并通过 VIP 升级申请'))
      return
    }
    if (admin.role.startsWith('platform_')) {
      res.status(400).json(fail(400, '平台账号不能作为组织管理员'))
      return
    }
    if (Number(admin.is_vip) !== 1) {
      res.status(409).json(fail(409, '该账号尚未通过 VIP 升级申请，请先在「升级申请」中审核通过'))
      return
    }
    // 系统自动创建的「个人工作区」不算正式组织，可被新组织收编；其它组织一律拒绝
    let personalOrgId: number | undefined
    if (admin.org_id) {
      const existingOrg = await findOrgById(admin.org_id)
      if (!existingOrg || existingOrg.notes !== 'auto:personal') {
        res.status(409).json(fail(409, '该账号已属于其它组织，请先移出后再指定'))
        return
      }
      personalOrgId = admin.org_id
    }
    const { org, user } = await createOrgForExistingUser({
      orgName: name,
      userId: admin.id,
      plan: 'vip',
      allowPersonalOrgId: personalOrgId
    })
    await writeAudit({
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      orgId: org.id,
      action: 'org.create',
      after: { name: org.name, plan: org.plan, adminEmail: user.email, assignedExistingVip: true }
    })
    res.json(ok({ org, admin: { id: user.id, email: user.email, role: user.role } }))
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('uk_org_name')) {
      res.status(409).json(fail(409, '组织名已存在'))
      return
    }
    if (msg === 'USER_HAS_ORG') {
      res.status(409).json(fail(409, '该账号已属于其它组织，请先移出后再指定'))
      return
    }
    console.error('[admin] create org failed:', msg)
    res.status(500).json(fail(500, '开通失败'))
  }
})

/** R2-29：可选的组织管理员候选（已通过 VIP、尚未加入组织） */
router.get('/admin/vip-users', requireAuth, requireSuperAdmin, async (req, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const q = String((req.query as { q?: string }).q || '')
  const items = await listAssignableVipUsers(q)
  res.json(ok({ items }))
})

/* ---------------------- R2-28：VIP 升级申请审核 ---------------------- */

router.get('/admin/upgrade-requests', requireAuth, requireSuperAdmin, async (req, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const status = String((req.query as { status?: string }).status || 'pending') === 'all' ? 'all' : 'pending'
  const items = await listUpgradeRequests(status)
  res.json(ok({ items, status }))
})

router.post('/admin/upgrade-requests/:id/approve', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    res.status(400).json(fail(400, '申请编号无效'))
    return
  }
  const row = await approveUpgradeRequest(id, req.auth!.user.id)
  if (!row) {
    res.status(409).json(fail(409, '该申请不存在或已被处理'))
    return
  }
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: null,
    action: 'user.upgrade.approve',
    after: { requestId: id, userId: row.user_id }
  })
  res.json(ok(row))
})

router.post('/admin/upgrade-requests/:id/reject', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    res.status(400).json(fail(400, '申请编号无效'))
    return
  }
  const note = String((req.body || {}).note || '').trim()
  const row = await rejectUpgradeRequest(id, req.auth!.user.id, note)
  if (!row) {
    res.status(409).json(fail(409, '该申请不存在或已被处理'))
    return
  }
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: null,
    action: 'user.upgrade.reject',
    after: { requestId: id, userId: row.user_id, note }
  })
  res.json(ok(row))
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
  const claimScopes = await listClaimScopes(org.id)
  res.json(ok({ org, members, limits, quotas, flags, claim_scopes: claimScopes }))
})

const SCOPE_TYPES: ClaimScopeType[] = ['norad', 'tag', 'constellation_key']

/** C1：读取业主授权范围 */
router.get('/admin/orgs/:id/claim-scopes', requireAuth, requireSuperAdmin, async (req, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  res.json(ok({ org_id: org.id, scopes: await listClaimScopes(org.id) }))
})

/**
 * C1：全量替换业主授权范围（通用机制，无品牌硬编码）：
 *  - norad            按 NORAD 白名单
 *  - constellation_key 按编目星座编码（sat_constellation.code）
 *  - tag              按目标名/星座名/关键词的通用包含匹配
 * 空数组 = 收回该组织的全部业主认领权限（安全默认）。
 */
router.put('/admin/orgs/:id/claim-scopes', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const orgId = Number(req.params.id)
  const org = Number.isFinite(orgId) ? await findOrgById(orgId) : null
  if (!org) {
    res.status(404).json(fail(404, '组织不存在'))
    return
  }
  const raw = (req.body || {}).scopes
  if (!Array.isArray(raw) || raw.length > 200) {
    res.status(400).json(fail(400, 'scopes 必须为数组且不超过 200 条'))
    return
  }
  const items: Array<{ type: ClaimScopeType; value: string; note?: string }> = []
  for (const it of raw) {
    const type = String((it || {}).type ?? '') as ClaimScopeType
    const value = String((it || {}).value ?? '').trim()
    if (!SCOPE_TYPES.includes(type)) {
      res.status(400).json(fail(400, 'scope.type 仅支持 norad / tag / constellation_key'))
      return
    }
    if (!value || value.length > 64) {
      res.status(400).json(fail(400, 'scope.value 必填且不超过 64 字符'))
      return
    }
    if (type === 'norad' && (!/^\d+$/.test(value) || Number(value) <= 0)) {
      res.status(400).json(fail(400, 'norad 类型的 scope.value 必须为正整数'))
      return
    }
    items.push({ type, value, note: typeof (it || {}).note === 'string' ? (it || {}).note : '' })
  }
  const before = await listClaimScopes(org.id)
  const after = await replaceClaimScopes(org.id, items)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: org.id,
    action: 'claim_scope.update',
    before: { scopes: before.map((s) => ({ type: s.scope_type, value: s.scope_value })) },
    after: { scopes: after.map((s) => ({ type: s.scope_type, value: s.scope_value })) }
  })
  res.json(ok({ org_id: org.id, scopes: after }))
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
  // C5：审计快照含 plan/status/生效限额，便于回溯降档副作用
  await ensurePlanSchema()
  const snapLimits = async (p: Plan) => {
    const rows = await getEffectiveLimits(orgId, p)
    return Object.fromEntries(rows.map((r) => [r.feature, r.limit]))
  }
  const beforeLimits = await snapLimits(org.plan)
  const afterLimits = await snapLimits(plan as Plan)
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId,
    action: 'org.update',
    before: { plan: org.plan, status: org.status, notes: org.notes, limits: beforeLimits },
    after: { plan, status, notes, limits: afterLimits }
  })
  const updated = (await findOrgById(orgId)) as OrgRow
  res.json(ok(updated))
})

/**
 * 新建组织成员（仅 org_member；R2-30 与账号页共用「最多 3 名成员」上限，防超管路径绕过）。
 * org_admin 只能在该组织创建时由超管指定已有 VIP，不在此处新建。
 */
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
  if (body.role === 'org_admin') {
    res.status(400).json(fail(400, '组织管理员须在建组织时指定已有 VIP；此处仅可添加普通成员'))
    return
  }
  const role = 'org_member' as const

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
    const effective = limits.find((l) => l.feature === 'members_max')?.limit
    const membersMax = Math.min(effective ?? MAX_ORG_MEMBERS, MAX_ORG_MEMBERS)
    const usage = await countOrgMembers(orgId)
    if (usage >= membersMax) {
      res.status(403).json({
        code: QUOTA_EXCEEDED,
        msg: `已达单位成员数上限（${usage}/${membersMax}），请先移除成员`,
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

/* ------------------------- 第 5 项：业主认领审核 ------------------------- */

/** 授权认领申请列表（默认待审；status=all 看全部） */
router.get('/admin/object-claims', requireAuth, requireSuperAdmin, async (req, res) => {
  if (!(await ensureObjectsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const status = String(req.query.status || 'pending')
  if (!['pending', 'claimed', 'rejected', 'all'].includes(status)) {
    res.status(400).json(fail(400, 'status 仅支持 pending / claimed / rejected / all'))
    return
  }
  const items = await listOwnerClaims(status as 'pending' | 'claimed' | 'rejected' | 'all')
  res.json(ok({ items }))
})

/** 审核通过：该用户成为目标唯一业主（同目标其它待审申请自动驳回） */
router.post('/admin/object-claims/:id/approve', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureObjectsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '申请编号无效'))
    return
  }
  const note = String((req.body || {}).note || '').slice(0, 255)
  const r = await approveOwnerClaim(id, req.auth!.user.email, note)
  if (!r.ok) {
    res.status(409).json(fail(409, r.error || '审核失败'))
    return
  }
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: Number(r.row?.org_id ?? 0),
    action: 'object_claim.approve',
    after: { claimId: id, norad: r.row?.norad_id ?? null, note }
  })
  res.json(ok({ id, status: 'claimed', object: r.row }))
})

/** 审核驳回 */
router.post('/admin/object-claims/:id/reject', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (!(await ensureObjectsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '申请编号无效'))
    return
  }
  const note = String((req.body || {}).note || '').slice(0, 255)
  const r = await rejectOwnerClaim(id, req.auth!.user.email, note)
  if (!r.ok) {
    res.status(409).json(fail(409, r.error || '驳回失败'))
    return
  }
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: 0,
    action: 'object_claim.reject',
    after: { claimId: id, note }
  })
  res.json(ok({ id, status: 'rejected' }))
})

/** C6：按 NORAD 查当前业主认领（全局唯一） */
router.get('/admin/owner/:norad', requireAuth, requireSuperAdmin, async (req, res) => {
  const norad = Number(req.params.norad)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(
    `SELECT o.id, o.org_id, o.norad_id, o.name, o.claim_type, o.created_at, o.updated_at, g.name AS org_name
       FROM objects o LEFT JOIN organizations g ON g.id = o.org_id
      WHERE o.norad_id = ? AND o.claim_type = 'owner' AND o.claim_status = 'claimed' LIMIT 1`,
    [norad]
  )
  res.json(ok({ norad, owner: rows[0] ?? null }))
})

/** C6：强制释放业主认领（超管兜底，写审计；星历绑定一并解除） */
router.delete('/admin/owner/:norad', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  const norad = Number(req.params.norad)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(
    `SELECT o.id, o.org_id, o.norad_id, o.name, o.claim_type, g.name AS org_name
       FROM objects o LEFT JOIN organizations g ON g.id = o.org_id
      WHERE o.norad_id = ? AND o.claim_type = 'owner' AND o.claim_status = 'claimed' LIMIT 1`,
    [norad]
  )
  const row = rows[0]
  if (!row) {
    res.status(404).json(fail(404, `NORAD ${norad} 当前没有业主认领`))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE bound_object_id = ?', [row.id])
  await pool.query('DELETE FROM object_ca_params WHERE object_id = ?', [row.id])
  await pool.query('DELETE FROM objects WHERE id = ?', [row.id])
  await writeAudit({
    actorUserId: req.auth!.user.id,
    actorEmail: req.auth!.user.email,
    orgId: Number(row.org_id),
    action: 'owner.force_release',
    before: { objectId: row.id, orgId: row.org_id, orgName: row.org_name ?? '', norad, name: row.name },
    after: { released: true, norad }
  })
  res.json(ok({ released: row.id, norad, orgId: row.org_id }))
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
