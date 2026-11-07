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
import type { ResultSetHeader, RowDataPacket } from 'mysql2'

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
  /** R2-28：用户级 VIP 标记（组织档位之外的独立 VIP，可由升级申请审核通过） */
  is_vip: number
  /** 账号简介（≤20 字） */
  bio: string
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
  \`is_vip\`        tinyint(1) NOT NULL DEFAULT 0 COMMENT 'R2-28 用户级 VIP（升级申请通过）',
  \`bio\`           varchar(20) NOT NULL DEFAULT '' COMMENT '账号简介（≤20 字）',
  \`password_hash\` varchar(100) NOT NULL,
  \`status\`        enum('active','disabled') NOT NULL DEFAULT 'active',
  \`created_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_user_email\` (\`email\`),
  KEY \`idx_user_org\` (\`org_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台与组织用户（platform_* 角色 org_id 为空）';

CREATE TABLE IF NOT EXISTS \`org_upgrade_requests\` (
  \`id\`          bigint unsigned NOT NULL AUTO_INCREMENT,
  \`user_id\`     bigint unsigned NOT NULL,
  \`reason\`      varchar(500) NOT NULL DEFAULT '',
  \`status\`      enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  \`review_note\` varchar(500) NOT NULL DEFAULT '',
  \`reviewed_by\` bigint unsigned NULL,
  \`reviewed_at\` datetime NULL,
  \`created_at\`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_upgrade_user\` (\`user_id\`, \`status\`),
  KEY \`idx_upgrade_status\` (\`status\`, \`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='R2-28 VIP 升级申请单'`

let schemaReady: Promise<boolean> | null = null

/** 建表（幂等，两条 DDL 逐条执行）；失败返回 false */
export function ensureOrgSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
          await pool.query(ddl)
        }
        // R2-28：老库补 is_vip 列（新库已在上方建表语句中包含）
        try {
          await pool.query(
            "ALTER TABLE `users` ADD COLUMN `is_vip` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'R2-28 用户级 VIP（升级申请通过）' AFTER `role`"
          )
        } catch (e) {
          if ((e as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw e
        }
        // 账号简介列（老库补齐）
        try {
          await pool.query(
            "ALTER TABLE `users` ADD COLUMN `bio` varchar(20) NOT NULL DEFAULT '' COMMENT '账号简介（≤20 字）' AFTER `is_vip`"
          )
        } catch (e) {
          if ((e as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw e
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

/** R2-21：仅更新当前用户自己的密码哈希 */
export async function updateUserPassword(id: number, passwordHash: string): Promise<boolean> {
  const [r] = await pool.query<ResultSetHeader>(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [passwordHash, id]
  )
  return r.affectedRows > 0
}

/** 更新当前用户的账号简介（≤20 字，由调用方校验） */
export async function updateUserBio(id: number, bio: string): Promise<boolean> {
  const [r] = await pool.query<ResultSetHeader>('UPDATE users SET bio = ? WHERE id = ?', [bio, id])
  return r.affectedRows > 0
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

/**
 * R2-29：超管建组织并把「已有 VIP」指定为组织管理员（不新建管理员账号）。
 * 事务内校验该用户仍未加入任何组织，避免并发下重复挂入。
 */
export async function createOrgForExistingUser(params: {
  orgName: string
  userId: number
  plan: OrgRow['plan']
  /** R2-29：系统自动创建的「个人工作区」不算真实组织，允许被正式组织收编 */
  allowPersonalOrgId?: number
}): Promise<{ org: OrgRow; user: UserRow }> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ? FOR UPDATE',
      [params.userId]
    )
    const user = rows[0] as UserRow | undefined
    if (!user) throw new Error('USER_NOT_FOUND')
    if (user.org_id && user.org_id !== params.allowPersonalOrgId) throw new Error('USER_HAS_ORG')
    const [r] = await conn.query<ResultSetHeader>(
      'INSERT INTO organizations (name, plan) VALUES (?, ?)',
      [params.orgName, params.plan]
    )
    await conn.query("UPDATE users SET org_id = ?, role = 'org_admin' WHERE id = ?", [
      r.insertId,
      params.userId
    ])
    if (params.allowPersonalOrgId && user.org_id === params.allowPersonalOrgId) {
      // 个人工作区被正式组织取代：迁移已关注目标，保留用户的关注列表
      await conn.query('UPDATE objects SET org_id = ? WHERE org_id = ?', [
        r.insertId,
        params.allowPersonalOrgId
      ])
      // 置为关闭，避免后台出现“活跃的个人组织”
      await conn.query(
        "UPDATE organizations SET status = 'closed', notes = 'auto:personal:retired' WHERE id = ? AND notes LIKE 'auto:personal%'",
        [params.allowPersonalOrgId]
      )
    }
    await conn.commit()
    const [org, fresh] = await Promise.all([findOrgById(r.insertId), findUserById(params.userId)])
    if (!org || !fresh) throw new Error('CREATE_ORG_FAILED')
    return { org, user: fresh }
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

/**
 * R2-28：公开注册只建账号（org_id 为空、org_member、非 VIP），不建组织。
 */
export async function createUser(params: {
  email: string
  passwordHash: string
  displayName: string
}): Promise<UserRow> {
  const [r] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (org_id, email, display_name, role, is_vip, password_hash)
     VALUES (NULL, ?, ?, 'org_member', 0, ?)`,
    [params.email, params.displayName, params.passwordHash]
  )
  return (await findUserById(r.insertId)) as UserRow
}

/**
 * R2-28：无组织普通用户首次关注时，自动创建一个隐藏的个人工作区（普通档），
 * 使其关注数据有归属组织；注册路径本身仍然不创建组织。
 * 并发安全：事务内 FOR UPDATE，多次调用只会建一个。
 */
export async function ensurePersonalWorkspace(
  userId: number
): Promise<{ org: OrgRow; user: UserRow } | null> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ? FOR UPDATE',
      [userId]
    )
    const user = rows[0] as UserRow | undefined
    if (!user) {
      await conn.rollback()
      return null
    }
    if (user.org_id) {
      const [orgRows] = await conn.query<RowDataPacket[]>(
        'SELECT * FROM organizations WHERE id = ? LIMIT 1',
        [user.org_id]
      )
      await conn.commit()
      const org = orgRows[0] as OrgRow | undefined
      return org ? { org, user } : null
    }
    const name = `个人空间-${userId}`
    const [r] = await conn.query<ResultSetHeader>(
      "INSERT INTO organizations (name, plan, notes) VALUES (?, 'normal', 'auto:personal')",
      [name]
    )
    await conn.query("UPDATE users SET org_id = ?, role = 'org_admin' WHERE id = ?", [r.insertId, userId])
    await conn.commit()
    const [org, fresh] = await Promise.all([findOrgById(r.insertId), findUserById(userId)])
    return org && fresh ? { org, user: fresh } : null
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

/** R2-28：用户级 VIP 判定（组织 VIP 或用户标记） */
export function isVipUser(user: Pick<UserRow, 'is_vip'>, org: { plan: string } | null): boolean {
  return Number(user.is_vip) === 1 || org?.plan === 'vip'
}

/* ------------------------- R2-28：VIP 升级申请 ------------------------- */

export interface UpgradeRequestRow {
  id: number
  user_id: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  review_note: string
  reviewed_by: number | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

export async function findPendingUpgrade(userId: number): Promise<UpgradeRequestRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM org_upgrade_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [userId]
  )
  return (rows[0] as UpgradeRequestRow) || null
}

export async function findLatestUpgrade(userId: number): Promise<UpgradeRequestRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM org_upgrade_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  )
  return (rows[0] as UpgradeRequestRow) || null
}

export async function createUpgradeRequest(userId: number, reason: string): Promise<UpgradeRequestRow> {
  const [r] = await pool.query<ResultSetHeader>(
    'INSERT INTO org_upgrade_requests (user_id, reason) VALUES (?, ?)',
    [userId, reason.slice(0, 500)]
  )
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM org_upgrade_requests WHERE id = ?',
    [r.insertId]
  )
  return rows[0] as UpgradeRequestRow
}

export interface UpgradeRequestListRow extends UpgradeRequestRow {
  email: string
  display_name: string
}

export async function listUpgradeRequests(status: 'pending' | 'all'): Promise<UpgradeRequestListRow[]> {
  const where = status === 'pending' ? "WHERE r.status = 'pending'" : ''
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.*, u.email, u.display_name
       FROM org_upgrade_requests r LEFT JOIN users u ON u.id = r.user_id
       ${where}
      ORDER BY r.id DESC LIMIT 300`
  )
  return rows as UpgradeRequestListRow[]
}

/** 通过：申请置 approved + 用户 is_vip=1（同一事务） */
export async function approveUpgradeRequest(
  id: number,
  reviewerId: number
): Promise<UpgradeRequestRow | null> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT * FROM org_upgrade_requests WHERE id = ? AND status = ? FOR UPDATE',
      [id, 'pending']
    )
    const req = rows[0] as UpgradeRequestRow | undefined
    if (!req) {
      await conn.rollback()
      return null
    }
    await conn.query(
      "UPDATE org_upgrade_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [reviewerId, id]
    )
    await conn.query('UPDATE users SET is_vip = 1 WHERE id = ?', [req.user_id])
    await conn.commit()
    const [after] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM org_upgrade_requests WHERE id = ?',
      [id]
    )
    return after[0] as UpgradeRequestRow
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

export async function rejectUpgradeRequest(
  id: number,
  reviewerId: number,
  note: string
): Promise<UpgradeRequestRow | null> {
  const [r] = await pool.query<ResultSetHeader>(
    "UPDATE org_upgrade_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ? AND status = 'pending'",
    [reviewerId, note.slice(0, 500), id]
  )
  if (!Number(r.affectedRows)) return null
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM org_upgrade_requests WHERE id = ?',
    [id]
  )
  return rows[0] as UpgradeRequestRow
}

/** R2-29：可被指定为组织管理员的已有 VIP（未加入任何组织） */
export async function listAssignableVipUsers(q: string): Promise<
  Array<{ id: number; email: string; display_name: string }>
> {
  const like = `%${q.trim().toLowerCase()}%`
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.email, u.display_name FROM users u
       LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.is_vip = 1 AND u.role NOT LIKE 'platform_%'
        AND (u.org_id IS NULL OR o.notes LIKE 'auto:personal%')
        AND (u.email LIKE ? OR u.display_name LIKE ?)
      ORDER BY u.id DESC LIMIT 50`,
    [like, like]
  )
  return rows as Array<{ id: number; email: string; display_name: string }>
}

/* ------------------------- R2-30：组织成员 ------------------------- */

export async function countOrgMembers(orgId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'org_member'",
    [orgId]
  )
  return Number((rows[0] as { n: number }).n)
}

export async function listOrgMembers(orgId: number): Promise<
  Array<{ id: number; email: string; display_name: string; status: string; created_at: string }>
> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, email, display_name, status, created_at FROM users
      WHERE org_id = ? AND role = 'org_member' ORDER BY id`,
    [orgId]
  )
  return rows as Array<{ id: number; email: string; display_name: string; status: string; created_at: string }>
}

/** 移除成员：卸出组织（org_id=NULL，角色降为 org_member），账号仍可登录为普通用户 */
export async function removeOrgMember(orgId: number, userId: number): Promise<boolean> {
  const [r] = await pool.query<ResultSetHeader>(
    "UPDATE users SET org_id = NULL, role = 'org_member' WHERE id = ? AND org_id = ? AND role = 'org_member'",
    [userId, orgId]
  )
  return Number(r.affectedRows) > 0
}
