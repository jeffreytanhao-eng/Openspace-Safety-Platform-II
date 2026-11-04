/**
 * 通知库层（Epic H2 日报与 Webhook）：
 *  - notify_channels：通知渠道（webhook / email），每组织多行，min_level + subscribe 控制投递范围；
 *  - daily_reports：每日一报（每组织同日唯一，upsert 覆盖），payload_json 存汇总 + 事件等级快照；
 *  - notify_deliveries：每次投递留痕（success / failed / skipped + 尝试次数 + 状态码 + 错误）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type ChannelKind = 'webhook' | 'email'
export type MinLevel = 'yellow' | 'orange' | 'red'
export type ChannelStatus = 'success' | 'failed' | 'skipped'
export type DeliveryKind = 'daily_report' | 'level_change' | 'test'

export interface NotifyChannel {
  id: number
  org_id: number
  kind: ChannelKind
  target: string
  min_level: MinLevel
  subscribe: string // 逗号分隔：daily,changes
  secret_enc: string | null // webhook HMAC 密钥（AES-256-GCM 密文）
  enabled: boolean
  last_ok_at: string | null
  last_error: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface DailyReportRow {
  id: number
  org_id: number
  report_date: string
  scope: 'managed' | 'global'
  payload_json: string
  created_at: string
}

export interface DeliveryRow {
  id: number
  org_id: number
  channel_id: number
  kind: DeliveryKind
  status: ChannelStatus
  attempts: number
  status_code: number | null
  error: string | null
  created_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`notify_channels\` (
  \`id\`          bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`      bigint unsigned NOT NULL,
  \`kind\`        varchar(10) NOT NULL COMMENT 'webhook | email',
  \`target\`      varchar(500) NOT NULL COMMENT 'webhook URL 或 收件邮箱',
  \`min_level\`   varchar(8) NOT NULL DEFAULT 'yellow' COMMENT '分级变化通知的最低等级（daily 不受此限）',
  \`subscribe\`   varchar(32) NOT NULL DEFAULT 'daily,changes' COMMENT '订阅项：daily 日报 | changes 分级变化',
  \`secret_enc\`  varchar(512) NULL COMMENT 'webhook HMAC 密钥（AES-256-GCM 密文）',
  \`enabled\`     tinyint(1) NOT NULL DEFAULT 1,
  \`last_ok_at\`  datetime(3) NULL,
  \`last_error\`  text NULL,
  \`created_by\`  varchar(128) NOT NULL DEFAULT '',
  \`created_at\`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_org\` (\`org_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='通知渠道（Epic H2）';

CREATE TABLE IF NOT EXISTS \`daily_reports\` (
  \`id\`           bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`       bigint unsigned NOT NULL,
  \`report_date\`  date NOT NULL,
  \`scope\`        varchar(10) NOT NULL DEFAULT 'managed' COMMENT 'managed=托管范围 | global=系统池',
  \`payload_json\` mediumtext NOT NULL,
  \`created_at\`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_org_date\` (\`org_id\`, \`report_date\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='日报（每组织同日唯一，Epic H2）';

CREATE TABLE IF NOT EXISTS \`notify_deliveries\` (
  \`id\`           bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`       bigint unsigned NOT NULL,
  \`channel_id\`   bigint NOT NULL,
  \`kind\`         varchar(20) NOT NULL COMMENT 'daily_report | level_change | test',
  \`status\`       varchar(10) NOT NULL COMMENT 'success | failed | skipped',
  \`attempts\`     int NOT NULL DEFAULT 0,
  \`status_code\`  int NULL,
  \`error\`        text NULL,
  \`payload_json\` mediumtext NULL,
  \`created_at\`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_org_time\` (\`org_id\`, \`created_at\`),
  KEY \`idx_channel\` (\`channel_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='通知投递审计（Epic H2）'`

let schemaReady: Promise<boolean> | null = null

export function ensureNotifySchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
        await pool.query(ddl)
      }
      return true
    })().catch((e) => {
      console.error('[notify] ensure schema failed:', (e as Error).message)
      schemaReady = null
      return false
    })
  }
  return schemaReady
}

/* ------------------------------ 渠道 ------------------------------ */

type RawChannel = RowDataPacket & NotifyChannel

export async function listChannels(orgId: number): Promise<NotifyChannel[]> {
  const [rows] = await pool.query<RawChannel[]>(
    `SELECT * FROM notify_channels WHERE org_id = ? ORDER BY id ASC`,
    [orgId]
  )
  return rows
}

export async function getChannel(orgId: number, id: number): Promise<NotifyChannel | null> {
  const [rows] = await pool.query<RawChannel[]>(
    `SELECT * FROM notify_channels WHERE org_id = ? AND id = ? LIMIT 1`,
    [orgId, id]
  )
  return rows[0] ?? null
}

export interface ChannelPatch {
  kind: ChannelKind
  target: string
  min_level: MinLevel
  subscribe: string
  /** null = 清除密钥；undefined = 保持不变 */
  secret_enc?: string | null
  enabled: boolean
}

export async function createChannel(orgId: number, p: ChannelPatch, createdBy: string): Promise<number> {
  const [r] = await pool.query(
    `INSERT INTO notify_channels (org_id, kind, target, min_level, subscribe, secret_enc, enabled, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [orgId, p.kind, p.target, p.min_level, p.subscribe, p.secret_enc ?? null, p.enabled ? 1 : 0, createdBy]
  )
  return Number((r as { insertId: number }).insertId)
}

export async function updateChannel(orgId: number, id: number, p: ChannelPatch): Promise<void> {
  // secret_enc 三态：undefined=不更新该列（保持原值），null=清除，字符串=重设
  if (p.secret_enc === undefined) {
    await pool.query(
      `UPDATE notify_channels SET kind=?, target=?, min_level=?, subscribe=?, enabled=? WHERE org_id=? AND id=?`,
      [p.kind, p.target, p.min_level, p.subscribe, p.enabled ? 1 : 0, orgId, id]
    )
    return
  }
  await pool.query(
    `UPDATE notify_channels SET kind=?, target=?, min_level=?, subscribe=?, secret_enc=?, enabled=? WHERE org_id=? AND id=?`,
    [p.kind, p.target, p.min_level, p.subscribe, p.secret_enc, p.enabled ? 1 : 0, orgId, id]
  )
}

export async function deleteChannel(orgId: number, id: number): Promise<void> {
  await pool.query(`DELETE FROM notify_channels WHERE org_id = ? AND id = ?`, [orgId, id])
}

export async function markChannelOk(id: number): Promise<void> {
  await pool.query(`UPDATE notify_channels SET last_ok_at = NOW(3), last_error = NULL WHERE id = ?`, [id])
}

export async function markChannelError(id: number, error: string): Promise<void> {
  await pool.query(`UPDATE notify_channels SET last_error = ? WHERE id = ?`, [error.slice(0, 1000), id])
}

/* ------------------------------ 日报 ------------------------------ */

type RawReport = RowDataPacket & DailyReportRow

export async function upsertReport(
  orgId: number,
  reportDate: string,
  scope: 'managed' | 'global',
  payloadJson: string
): Promise<void> {
  await pool.query(
    `INSERT INTO daily_reports (org_id, report_date, scope, payload_json) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE scope = VALUES(scope), payload_json = VALUES(payload_json), created_at = NOW(3)`,
    [orgId, reportDate, scope, payloadJson]
  )
}

export async function getLatestReport(orgId: number): Promise<DailyReportRow | null> {
  const [rows] = await pool.query<RawReport[]>(
    `SELECT * FROM daily_reports WHERE org_id = ? ORDER BY report_date DESC LIMIT 1`,
    [orgId]
  )
  return rows[0] ?? null
}

export async function getReportByDate(orgId: number, date: string): Promise<DailyReportRow | null> {
  const [rows] = await pool.query<RawReport[]>(
    `SELECT * FROM daily_reports WHERE org_id = ? AND report_date = ? LIMIT 1`,
    [orgId, date]
  )
  return rows[0] ?? null
}

/** 分级变化对比需要上一份报告（任意早于 date 的最近一份） */
export async function getPrevReport(orgId: number, beforeDate: string): Promise<DailyReportRow | null> {
  const [rows] = await pool.query<RawReport[]>(
    `SELECT * FROM daily_reports WHERE org_id = ? AND report_date < ? ORDER BY report_date DESC LIMIT 1`,
    [orgId, beforeDate]
  )
  return rows[0] ?? null
}

/** 全部活跃组织（cron 逐组织出报） */
export async function listActiveOrgIds(): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM organizations WHERE status = 'active' ORDER BY id ASC`
  )
  return rows.map((r) => Number(r.id))
}

/* ------------------------------ 投递审计 ------------------------------ */

export async function recordDelivery(d: {
  org_id: number
  channel_id: number
  kind: DeliveryKind
  status: ChannelStatus
  attempts: number
  status_code: number | null
  error: string | null
  payload_json: string
}): Promise<void> {
  await pool.query(
    `INSERT INTO notify_deliveries (org_id, channel_id, kind, status, attempts, status_code, error, payload_json)
     VALUES (?,?,?,?,?,?,?,?)`,
    [d.org_id, d.channel_id, d.kind, d.status, d.attempts, d.status_code, d.error, d.payload_json]
  )
}

export async function listDeliveries(orgId: number, limit: number): Promise<DeliveryRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, org_id, channel_id, kind, status, attempts, status_code, error, created_at
     FROM notify_deliveries WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
    [orgId, Math.min(Math.max(limit, 1), 100)]
  )
  return rows as unknown as DeliveryRow[]
}
