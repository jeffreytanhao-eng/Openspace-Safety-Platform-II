/**
 * 站内事件（左下角警铃）：
 *  - 每个用户独立一份事件列表，事件只增不删，用户点 × 才删除该条；
 *  - 认领成功/失败、筛查任务完成/失败、报告投递成功/失败 都会写入。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type UserEventType =
  | 'claim.approved'
  | 'claim.rejected'
  | 'screen.done'
  | 'screen.failed'
  | 'report.delivered'
  | 'report.failed'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`user_events\` (
  \`id\`           bigint NOT NULL AUTO_INCREMENT,
  \`user_id\`      bigint unsigned NOT NULL,
  \`event_type\`   varchar(40) NOT NULL,
  \`payload_json\` text NULL,
  \`created_at\`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_user_event\` (\`user_id\`, \`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='用户站内事件（警铃）'`

let schemaReady: Promise<boolean> | null = null

export function ensureUserEventSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        return true
      } catch (e) {
        console.error('[user-events] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

export interface UserEventRow extends RowDataPacket {
  id: number
  event_type: UserEventType
  payload_json: string | null
  created_at: string
}

/** 写一条事件（失败只记日志，不影响业务主流程） */
export async function addUserEvent(
  userId: number | null | undefined,
  eventType: UserEventType,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const uid = Number(userId || 0)
  if (!uid) return
  try {
    if (!(await ensureUserEventSchema())) return
    await pool.query(
      `INSERT INTO user_events (user_id, event_type, payload_json) VALUES (?, ?, ?)`,
      [uid, eventType, JSON.stringify(payload)]
    )
  } catch (e) {
    console.error('[user-events] insert failed:', (e as Error).message)
  }
}

/** 给组织全体在职用户写一条事件（报告投递等组织级事件） */
export async function addUserEventsForOrg(
  orgId: number,
  eventType: UserEventType,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    if (!(await ensureUserEventSchema())) return
    await pool.query(
      `INSERT INTO user_events (user_id, event_type, payload_json)
       SELECT id, ?, ? FROM users WHERE org_id = ? AND status = 'active'`,
      [eventType, JSON.stringify(payload), orgId]
    )
  } catch (e) {
    console.error('[user-events] insert org events failed:', (e as Error).message)
  }
}

export async function listUserEvents(userId: number, limit = 50): Promise<UserEventRow[]> {
  const n = Math.min(Math.max(1, Number(limit) || 50), 200)
  const [rows] = await pool.query<UserEventRow[]>(
    `SELECT id, event_type, payload_json, created_at FROM user_events
      WHERE user_id = ? ORDER BY id DESC LIMIT ${n}`,
    [userId]
  )
  return rows
}

export async function countUserEvents(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM user_events WHERE user_id = ?`,
    [userId]
  )
  return Number(rows[0]?.c ?? 0)
}

export async function deleteUserEvent(userId: number, id: number): Promise<boolean> {
  const [r] = await pool.query(
    `DELETE FROM user_events WHERE id = ? AND user_id = ?`,
    [id, userId]
  )
  return Number((r as { affectedRows?: number }).affectedRows ?? 0) > 0
}
