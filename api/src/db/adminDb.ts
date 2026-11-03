/**
 * 超管与审计数据库层（Epic B1）。
 * - admin_audit_logs：平台写操作审计（actor / org / action / before / after）；
 * - 平台超管账号 bootstrap 由 server.ts 调 ensurePlatformAdmin（凭据来自 .env）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export interface AuditRow {
  id: number
  actor_user_id: number | null
  actor_email: string
  org_id: number | null
  action: string
  before_json: string | null
  after_json: string | null
  created_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`admin_audit_logs\` (
  \`id\`             bigint unsigned NOT NULL AUTO_INCREMENT,
  \`actor_user_id\`  bigint unsigned NULL DEFAULT NULL,
  \`actor_email\`    varchar(190) NOT NULL DEFAULT '',
  \`org_id\`         bigint unsigned NULL DEFAULT NULL,
  \`action\`         varchar(64) NOT NULL,
  \`before_json\`    text,
  \`after_json\`     text,
  \`created_at\`     datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_audit_org\` (\`org_id\`),
  KEY \`idx_audit_created\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台管理操作审计（只读展示）'`

let schemaReady: Promise<boolean> | null = null

export function ensureAdminSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        return true
      } catch (e) {
        console.error('[admin] ensure schema failed:', (e as Error).message)
        return false
      }
    })()
  }
  return schemaReady
}

/** 写审计（失败仅记服务端日志，不阻断业务操作） */
export async function writeAudit(entry: {
  actorUserId: number | null
  actorEmail: string
  orgId: number | null
  action: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO admin_audit_logs (actor_user_id, actor_email, org_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
      [
        entry.actorUserId,
        entry.actorEmail,
        entry.orgId,
        entry.action,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after)
      ]
    )
  } catch (e) {
    console.error('[admin] audit write failed:', (e as Error).message)
  }
}

export async function listAudit(limit: number, offset: number): Promise<{ items: AuditRow[]; total: number }> {
  const [items] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',
    [limit, offset]
  )
  const [cnt] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM admin_audit_logs')
  return { items: items as AuditRow[], total: Number((cnt[0] as { n: number }).n) }
}
