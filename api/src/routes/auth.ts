/**
 * 认证路由（Epic A1）：注册 / 登录 / 当前用户。
 *
 * - JWT（HS256，7 天有效期），payload = { uid, orgId, role, email }；
 * - requireAuth 每次请求回库取最新用户与组织（停用/关停立即生效，
 *   也为 A2 档位配额中间件直接提供 org 上下文）；
 * - 统一响应沿用 ok()/fail()，错误码 = HTTP 状态码。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { ok, fail } from '../utils/response.js'
import {
  ensureOrgSchema,
  findUserByEmail,
  findUserById,
  findOrgById,
  createOrgWithAdmin,
  type UserRow,
  type OrgRow
} from '../db/orgDb.js'

const router = Router()

const TOKEN_TTL_SEC = 7 * 24 * 3600
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 脱敏后的用户视图（不含 password_hash） */
export interface SafeUser {
  id: number
  orgId: number | null
  email: string
  displayName: string
  role: UserRow['role']
  status: UserRow['status']
}

export interface SafeOrg {
  id: number
  name: string
  plan: OrgRow['plan']
  status: OrgRow['status']
  trialEndsAt: string | null
}

export interface AuthContext {
  user: SafeUser
  org: SafeOrg | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}

function toSafeUser(u: UserRow): SafeUser {
  return {
    id: u.id,
    orgId: u.org_id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    status: u.status
  }
}

function toSafeOrg(o: OrgRow): SafeOrg {
  return { id: o.id, name: o.name, plan: o.plan, status: o.status, trialEndsAt: o.trial_ends_at }
}

function signToken(u: UserRow): string {
  return jwt.sign(
    { uid: u.id, orgId: u.org_id, role: u.role, email: u.email },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL_SEC }
  )
}

/** 认证中间件：校验 Bearer token 并回库装配最新 user/org；失败一律 401 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) {
      res.status(401).json(fail(401, '未登录'))
      return
    }
    const payload = jwt.verify(token, config.jwtSecret) as { uid?: number }
    if (!payload.uid) {
      res.status(401).json(fail(401, '登录已过期'))
      return
    }
    const row = await findUserById(payload.uid)
    if (!row || row.status !== 'active') {
      res.status(401).json(fail(401, '账号不存在或已停用'))
      return
    }
    const org = row.org_id ? await findOrgById(row.org_id) : null
    if (org && org.status === 'closed') {
      res.status(401).json(fail(401, '组织已关闭，请联系平台管理员'))
      return
    }
    req.auth = { user: toSafeUser(row), org: org ? toSafeOrg(org) : null }
    next()
  } catch {
    res.status(401).json(fail(401, '登录已过期，请重新登录'))
  }
}

/** 注册：创建组织 + 首个组织管理员（plan 默认 free） */
router.post('/auth/register', async (req, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const body = req.body || {}
  const orgName = String(body.orgName || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const displayName = String(body.displayName || '').trim()

  if (!orgName || orgName.length > 128) {
    res.status(400).json(fail(400, '组织名不能为空且不超过 128 字'))
    return
  }
  if (!EMAIL_RE.test(email) || email.length > 190) {
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
    const passwordHash = await bcrypt.hash(password, 10)
    const { org, user } = await createOrgWithAdmin({
      orgName,
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0]
    })
    res.json(ok({ token: signToken(user), user: toSafeUser(user), org: toSafeOrg(org) }))
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
    console.error('[auth] register failed:', msg)
    res.status(500).json(fail(500, '注册失败'))
  }
})

/** 登录：邮箱 + 密码 → JWT */
router.post('/auth/login', async (req, res) => {
  if (!(await ensureOrgSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const body = req.body || {}
  const rawId = String(body.email || '').trim().toLowerCase()
  // 固定测试账号允许直接用用户名登录（无 @ 时补默认域）
  const email = rawId && !rawId.includes('@') ? `${rawId}@openspace.local` : rawId
  const password = String(body.password || '')
  if (!email || !password) {
    res.status(400).json(fail(400, '请输入账号和密码'))
    return
  }
  try {
    const user = await findUserByEmail(email)
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json(fail(401, '账号或密码错误'))
      return
    }
    if (user.status !== 'active') {
      res.status(403).json(fail(403, '账号已停用，请联系平台管理员'))
      return
    }
    const org = user.org_id ? await findOrgById(user.org_id) : null
    if (org?.status === 'suspended') {
      res.status(403).json(fail(403, '组织已被暂停，请联系平台管理员'))
      return
    }
    if (org?.status === 'closed') {
      res.status(403).json(fail(403, '组织已关闭，请联系平台管理员'))
      return
    }
    res.json(ok({ token: signToken(user), user: toSafeUser(user), org: org ? toSafeOrg(org) : null }))
  } catch (e) {
    console.error('[auth] login failed:', (e as Error).message)
    res.status(500).json(fail(500, '登录失败'))
  }
})

/** 当前登录用户 + 组织（受保护接口样例，供前端「保持登录」探测） */
router.get('/auth/me', requireAuth, async (req, res) => {
  res.json(ok(req.auth ?? null))
})

/**
 * 可选认证（C3 按档裁剪用）：带合法 Bearer token 则装配 auth 上下文，
 * 无 token / token 失效一律匿名放行（不拒绝），供公开接口按档位差异化响应。
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (token) {
      const payload = jwt.verify(token, config.jwtSecret) as { uid?: number }
      const row = payload.uid ? await findUserById(payload.uid) : null
      if (row && row.status === 'active') {
        const org = row.org_id ? await findOrgById(row.org_id) : null
        if (!org || org.status !== 'closed') {
          req.auth = { user: toSafeUser(row), org: org ? toSafeOrg(org) : null }
        }
      }
    }
  } catch {
    // 匿名放行
  }
  next()
}

export default router
