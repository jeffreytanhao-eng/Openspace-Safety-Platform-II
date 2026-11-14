/**
 * 固定测试账号（用户要求：三个账号不随版本与部署变化）。
 *
 * 每次 API 启动幂等对齐：
 *  - 组织不存在则创建（并保持 plan/status 为约定值）；
 *  - 用户不存在则创建；
 *  - 用户已存在则校正组织/角色/启用态，密码不一致时重置；
 *  - createOnly 账号（平台超管 admin）仅不存在时创建：已存在则完全跳过，
 *    保留运维在线上自行修改过的密码，重部署不再重置；
 *
 * 登录支持用户名（无 @ 时自动补 @openspace.local，见 routes/auth.ts）。
 */
import bcrypt from 'bcryptjs'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from './pool.js'

interface FixedAccount {
  email: string
  password: string
  displayName: string
  role: 'platform_super_admin' | 'org_admin'
  org: { name: string; plan: 'normal' | 'vip' } | null
  /** true = 仅不存在时创建；已存在不再校正（保留线上改过的密码与资料） */
  createOnly?: boolean
}

const FIXED_ACCOUNTS: FixedAccount[] = [
  {
    email: 'xingwang@openspace.local',
    password: 'a1234',
    displayName: 'xingwang',
    role: 'org_admin',
    org: { name: '星网测试组织', plan: 'vip' }
  },
  {
    email: 'gaoxiao@openspace.local',
    password: 'a1234',
    displayName: 'gaoxiao',
    role: 'org_admin',
    org: { name: '高校测试组织', plan: 'normal' }
  },
  {
    email: 'admin@openspace.local',
    password: 'a1234',
    displayName: '平台超管',
    role: 'platform_super_admin',
    org: null,
    createOnly: true
  }
]

/** 按名称对齐组织（存在则校正档位/状态，不存在则创建），返回 org_id */
async function ensureOrg(name: string, plan: 'normal' | 'vip'): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM organizations WHERE name = ? LIMIT 1',
    [name]
  )
  if (rows.length) {
    const id = Number(rows[0].id)
    await pool.query(
      "UPDATE organizations SET plan = ?, status = 'active' WHERE id = ?",
      [plan, id]
    )
    return id
  }
  const [res] = await pool.query<ResultSetHeader>(
    "INSERT INTO organizations (name, plan, status) VALUES (?, ?, 'active')",
    [name, plan]
  )
  return Number(res.insertId)
}

/** 启动时调用：幂等创建/校正三个固定测试账号 */
export async function ensureFixedAccounts(): Promise<void> {
  for (const acc of FIXED_ACCOUNTS) {
    const orgId = acc.org ? await ensureOrg(acc.org.name, acc.org.plan) : null
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, password_hash FROM users WHERE email = ? LIMIT 1',
      [acc.email]
    )
    if (!rows.length) {
      await pool.query(
        'INSERT INTO users (org_id, email, display_name, role, password_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
        [orgId, acc.email, acc.displayName, acc.role, await bcrypt.hash(acc.password, 10), 'active']
      )
      console.log(`[test-account] created ${acc.email}`)
      continue
    }
    // 仅创建型账号：已存在则保留现状（不改密码/角色/资料），避免重部署覆盖线上口令
    if (acc.createOnly) continue
    const row = rows[0]
    const same = await bcrypt.compare(acc.password, String(row.password_hash))
    await pool.query(
      'UPDATE users SET org_id = ?, display_name = ?, role = ?, status = ?, password_hash = ? WHERE id = ?',
      [
        orgId,
        acc.displayName,
        acc.role,
        'active',
        same ? String(row.password_hash) : await bcrypt.hash(acc.password, 10),
        Number(row.id)
      ]
    )
    if (!same) console.log(`[test-account] password reset ${acc.email}`)
  }
}
