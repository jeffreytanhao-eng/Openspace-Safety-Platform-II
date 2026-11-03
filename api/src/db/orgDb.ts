/**
 * 组织与用户数据库层（Epic A1，复用 src/db/pool.ts 连接池）。
 *
 * 设计口径：
 * - organizations = 租户组织（plan 档位 + status 生命周期）；
 * - users = 平台侧与组织侧账号共用一张表：platform_* 角色 org_id 为空，
 *   org_* 角色 org_id 必填；
 * - 认证走 JWT（无 sessions 表），密码 bcryptjs 哈希存储。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

/** 组织行（password_hash 永不出库） */
export interface OrgRow {
  id: number
  name: string
  plan: 'free' | 'normal' | 'vip'
  status: 'active' | 'suspended' | 'closed'
  trial_ends_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** 用户行（含 password_hash，仅认证层内部使用） */
export interface UserRow {
  id: number
  org_id: number | null
  email: string
  display_name: string
  role: 'platform_super_admin' | 'platform_ops' | 'org_admin' | 'org_member'
  password_hash: string
  status: 'active' | 'disabled'
  created_at: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`organizations\` (
  \`id\`            bigint unsigned NOT NULL AUTO_INCREMENT,
  \`name\`          varchar(128) NOT NULL,
  \`plan\`          enum('free','normal','vip') NOT NULL DEFAULT 'free',
  \`status\`        enum('active','suspended','closed') NOT NULL DEFAULT 'active',
  \`trial_ends_at\` datetime NULL DEFAULT NULL,
  \`notes\`         text,
  \`created_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_org_name\` (\`name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='租户组织（plan 档位 + status 生命周期）';

CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\`            bigint unsigned NOT NULL AUTO_INCREMENT,
  \`org_id\`        bigint unsigned NULL DEFAULT NULL,
  \`email\`         varchar(190) NOT NULL,
  \`display_name\`  varchar(64) NOT NULL DEFAULT '',
  \`role\`          enum('platform_super_admin','platform_ops','org_admin','org_member') NOT NULL DEFAULT 'org_member',
  \`password_hash\` varchar(100) NOT NULL,
  \`status\`        enum('active','disabled') NOT NULL DEFAULT 'active',
  \`created_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_user_email\` (\`email\`),
  KEY \`idx_user_org\` (\`org_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台与组织用户（platform_* 角色 org_id 为空）'`

let schemaReady: Promise<boolean> | null = null

/** 建表（幂等，两条 DDL 逐条执行）；失败返回 false */
export function ensureOrgSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
          await pool.query(ddl)
        }
        return true
      } catch (e) {
        console.error('[org] ensure schema failed:', (e as Error).message)
        return false
      }
    })()
  }
  return schemaReady
}

const USER_COLS = 'id, org_id, email, display_name, role, status, created_at'

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM users WHERE email = ? LIMIT 1',
    [email.trim().toLowerCase()]
  )
  return (rows[0] as UserRow) || null
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM users WHERE id = ? LIMIT 1',
    [id]
  )
  return (rows[0] as UserRow) || null
}

export async function findOrgById(id: number): Promise<OrgRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM organizations WHERE id = ? LIMIT 1',
    [id]
  )
  return (rows[0] as OrgRow) || null
}

/** 平台超管 bootstrap：不存在该邮箱的账号时创建 platform_super_admin；已存在返回 false */
export async function ensurePlatformAdmin(email: string, passwordHash: string): Promise<boolean> {
  if (await findUserByEmail(email)) return false
  await pool.query(
    'INSERT INTO users (org_id, email, display_name, role, password_hash) VALUES (NULL, ?, ?, ?, ?)',
    [email, '平台超管', 'platform_super_admin', passwordHash]
  )
  return true
}

/** 注册/开通：建组织 + 首个组织管理员（事务，保证两者同生） */
export async function createOrgWithAdmin(params: {
  orgName: string
  email: string
  passwordHash: string
  displayName: string
  plan?: 'free' | 'normal' | 'vip'
}): Promise<{ org: OrgRow; user: UserRow }> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [orgRes] = await conn.query<import('mysql2').ResultSetHeader>(
      'INSERT INTO organizations (name, plan) VALUES (?, ?)',
      [params.orgName, params.plan ?? 'free']
    )
    const orgId = orgRes.insertId
    const [userRes] = await conn.query<import('mysql2').ResultSetHeader>(
      'INSERT INTO users (org_id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)',
      [orgId, params.email, params.displayName, 'org_admin', params.passwordHash]
    )
    await conn.commit()
    const [org, user] = await Promise.all([
      findOrgById(orgId),
      findUserById(userRes.insertId)
    ])
    return { org: org as OrgRow, user: user as UserRow }
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
