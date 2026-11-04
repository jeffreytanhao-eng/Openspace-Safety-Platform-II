/**
 * 机动候选库层（Epic J，占位任务）：
 *  - maneuver_plans：组织为托管目标登记的机动候选（OKAPI 式 observe/critical → 机动候选）。
 *  - 本期不实现机动引擎（不做 ΔV→轨道推演）；「再筛查」= 以当前在编根数对机动窗口结束后
 *    的 10 天窗口发起单主星防新交会筛查（复用 Epic E1 管线，rescreen_job_id 关联）。
 *  - 状态机：proposed（候选）→ approved（批准）→ executed（已执行）；cancelled（取消，终态）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type ManeuverStatus = 'proposed' | 'approved' | 'executed' | 'cancelled'

export interface ManeuverRow {
  id: number
  org_id: number
  object_id: number
  norad_id: number
  object_name: string
  event_key: string | null
  event_tca: string | null
  event_level: string | null
  window_start: string
  window_end: string
  dv_m_s: number | null
  direction: string
  status: ManeuverStatus
  rescreen_job_id: number | null
  rescreen_at: string | null
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`maneuver_plans\` (
  \`id\`             bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`         bigint unsigned NOT NULL,
  \`object_id\`      bigint unsigned NOT NULL,
  \`norad_id\`       int NOT NULL,
  \`object_name\`    varchar(100) NOT NULL DEFAULT '',
  \`event_key\`      varchar(64) NULL COMMENT '来源交会事件（E2 聚合 key，可空=常规机动）',
  \`event_tca\`      datetime(3) NULL COMMENT '来源事件 TCA（冗余展示）',
  \`event_level\`    varchar(10) NULL COMMENT '来源事件分级（冗余展示）',
  \`window_start\`   datetime(3) NOT NULL,
  \`window_end\`     datetime(3) NOT NULL,
  \`dv_m_s\`         double NULL COMMENT '计划速度增量 m/s（记录用，不做推演）',
  \`direction\`      varchar(24) NOT NULL DEFAULT '' COMMENT 'prograde|retrograde|radial|cross_track|other',
  \`status\`         varchar(12) NOT NULL DEFAULT 'proposed',
  \`rescreen_job_id\` bigint NULL COMMENT '最近一次再筛查任务',
  \`rescreen_at\`    datetime(3) NULL,
  \`notes\`          varchar(500) NULL,
  \`created_by\`     varchar(128) NOT NULL DEFAULT '',
  \`created_at\`     datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\`     datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_mp_org\` (\`org_id\`),
  KEY \`idx_mp_obj\` (\`object_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='机动候选（Epic J 占位：候选管理+机动后再筛查，无机动引擎）'`

let schemaReady: Promise<boolean> | null = null

export function ensureManeuverSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = pool
      .query(SCHEMA)
      .then(() => true)
      .catch((e) => {
        console.error('[maneuver] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      })
  }
  return schemaReady
}

interface RawManeuver extends RowDataPacket, ManeuverRow {}

const COLS =
  'id, org_id, object_id, norad_id, object_name, event_key, event_tca, event_level, window_start, window_end, dv_m_s, direction, status, rescreen_job_id, rescreen_at, notes, created_by, created_at, updated_at'

export async function listManeuversByObject(orgId: number, objectId: number): Promise<ManeuverRow[]> {
  const [rows] = await pool.query<RawManeuver[]>(
    `SELECT ${COLS} FROM maneuver_plans WHERE org_id = ? AND object_id = ? ORDER BY id DESC`,
    [orgId, objectId]
  )
  return rows as ManeuverRow[]
}

export async function getManeuver(orgId: number, id: number): Promise<ManeuverRow | null> {
  const [rows] = await pool.query<RawManeuver[]>(
    `SELECT ${COLS} FROM maneuver_plans WHERE org_id = ? AND id = ? LIMIT 1`,
    [orgId, id]
  )
  return (rows[0] as ManeuverRow) ?? null
}

export interface CreateManeuverInput {
  orgId: number
  objectId: number
  noradId: number
  objectName: string
  eventKey?: string | null
  eventTca?: Date | null
  eventLevel?: string | null
  windowStart: Date
  windowEnd: Date
  dvMs?: number | null
  direction?: string
  notes?: string | null
  createdBy: string
}

export async function createManeuver(input: CreateManeuverInput): Promise<ManeuverRow> {
  const [r] = await pool.query(
    `INSERT INTO maneuver_plans
       (org_id, object_id, norad_id, object_name, event_key, event_tca, event_level,
        window_start, window_end, dv_m_s, direction, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    [
      input.orgId,
      input.objectId,
      input.noradId,
      input.objectName.slice(0, 100),
      input.eventKey ?? null,
      input.eventTca ?? null,
      input.eventLevel ?? null,
      input.windowStart,
      input.windowEnd,
      input.dvMs ?? null,
      input.direction ?? '',
      input.notes ?? null,
      input.createdBy
    ]
  )
  const id = Number((r as { insertId: number }).insertId)
  return (await getManeuver(input.orgId, id)) as ManeuverRow
}

export interface UpdateManeuverInput {
  status?: ManeuverStatus
  windowStart?: Date
  windowEnd?: Date
  dvMs?: number | null
  direction?: string
  notes?: string | null
}

export async function updateManeuver(orgId: number, id: number, patch: UpdateManeuverInput): Promise<void> {
  // 动态 SET：undefined = 不改；null = 显式清空（dv/notes 可清）
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.windowStart !== undefined) {
    sets.push('window_start = ?')
    vals.push(patch.windowStart)
  }
  if (patch.windowEnd !== undefined) {
    sets.push('window_end = ?')
    vals.push(patch.windowEnd)
  }
  if (patch.dvMs !== undefined) {
    sets.push('dv_m_s = ?')
    vals.push(patch.dvMs ?? null)
  }
  if (patch.direction !== undefined) {
    sets.push('direction = ?')
    vals.push(patch.direction)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    vals.push(patch.notes ?? null)
  }
  if (!sets.length) return
  vals.push(orgId, id)
  await pool.query(`UPDATE maneuver_plans SET ${sets.join(', ')} WHERE org_id = ? AND id = ?`, vals)
}

export async function deleteManeuver(orgId: number, id: number): Promise<void> {
  await pool.query(`DELETE FROM maneuver_plans WHERE org_id = ? AND id = ?`, [orgId, id])
}

/** 记录最近一次再筛查任务 */
export async function setRescreenJob(orgId: number, id: number, jobId: number): Promise<void> {
  await pool.query(
    `UPDATE maneuver_plans SET rescreen_job_id = ?, rescreen_at = NOW(3) WHERE org_id = ? AND id = ?`,
    [jobId, orgId, id]
  )
}
