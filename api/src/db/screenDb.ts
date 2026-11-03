/**
 * 筛查任务库层（Epic E1）：
 *  - screening_jobs：异步筛查任务（queued/running/done/failed），params 留 JSON 供 F1 重算对比；
 *  - conjunction_events：筛查产出的交会事件（job_id 关联 run，org 维度隔离）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface ScreenJobRow {
  id: number
  org_id: number
  triggered_by: string
  status: ScreenJobStatus
  params_json: string | null
  window_h: number
  miss_max_km: number
  hbr_m: number
  n_primary: number
  n_secondary: number
  n_candidates: number
  n_events: number
  error_message: string | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number
}

export interface ScreenEventRow {
  id: number
  job_id: number
  org_id: number
  primary_object_id: number | null
  primary_norad: number
  primary_name: string
  secondary_norad: number
  secondary_name: string
  tca: string
  miss_km: number
  miss_r_km: number | null
  miss_t_km: number | null
  miss_n_km: number | null
  rel_speed_kms: number | null
  pc: number | null
  pc_max: number | null
  pc_method: string
  hbr_m: number | null
  sigma_p_src: string | null
  sigma_p_t_km: number | null
  sigma_s_src: string | null
  sigma_s_t_km: number | null
  sec_epoch: string | null
  sec_age_h: number | null
  level: 'red' | 'orange' | 'yellow'
  diluted: number
  cdm_id: string | null
  cdm_pc: number | null
  pc_source: 'core' | 'cdm'
  created_at: string
}

const SCHEMA_JOBS = `
CREATE TABLE IF NOT EXISTS \`screening_jobs\` (
  \`id\`            bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`        bigint unsigned NOT NULL,
  \`triggered_by\`  varchar(128) NOT NULL DEFAULT '',
  \`status\`        varchar(10) NOT NULL DEFAULT 'queued' COMMENT 'queued|running|done|failed',
  \`params_json\`   mediumtext,
  \`window_h\`      int NOT NULL DEFAULT 72,
  \`miss_max_km\`   double NOT NULL DEFAULT 10,
  \`hbr_m\`         double NOT NULL DEFAULT 15,
  \`n_primary\`     int NOT NULL DEFAULT 0,
  \`n_secondary\`   int NOT NULL DEFAULT 0,
  \`n_candidates\`  int NOT NULL DEFAULT 0,
  \`n_events\`      int NOT NULL DEFAULT 0,
  \`error_message\` varchar(1000) NULL,
  \`queued_at\`     datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`started_at\`    datetime(3) NULL,
  \`finished_at\`   datetime(3) NULL,
  \`duration_ms\`   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`),
  KEY \`idx_job_org\` (\`org_id\`),
  KEY \`idx_job_status\` (\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='交会筛查任务（Epic E1）'`

const SCHEMA_EVENTS = `
CREATE TABLE IF NOT EXISTS \`conjunction_events\` (
  \`id\`                bigint NOT NULL AUTO_INCREMENT,
  \`job_id\`            bigint NOT NULL,
  \`org_id\`            bigint unsigned NOT NULL,
  \`primary_object_id\` bigint NULL COMMENT 'objects.id（TLE 主星时可空）',
  \`primary_norad\`     int NOT NULL,
  \`primary_name\`      varchar(100) NOT NULL DEFAULT '',
  \`secondary_norad\`   int NOT NULL,
  \`secondary_name\`    varchar(100) NOT NULL DEFAULT '',
  \`tca\`               datetime(3) NOT NULL,
  \`miss_km\`           double NOT NULL,
  \`miss_r_km\`         double NULL,
  \`miss_t_km\`         double NULL,
  \`miss_n_km\`         double NULL,
  \`rel_speed_kms\`     double NULL,
  \`pc\`                double NULL,
  \`pc_max\`            double NULL,
  \`pc_method\`         varchar(30) NOT NULL DEFAULT 'foster2d',
  \`hbr_m\`             double NULL,
  \`sigma_p_src\`       varchar(8) NULL,
  \`sigma_p_t_km\`      double NULL,
  \`sigma_s_src\`       varchar(8) NULL,
  \`sigma_s_t_km\`      double NULL,
  \`sec_epoch\`         datetime(3) NULL,
  \`sec_age_h\`         double NULL,
  \`level\`             varchar(10) NOT NULL DEFAULT 'yellow' COMMENT 'red|orange|yellow',
  \`diluted\`           tinyint NOT NULL DEFAULT 0,
  \`a_x\`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 x (km)',
  \`a_y\`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 y (km)',
  \`a_z\`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 z (km)',
  \`b_x\`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 x (km)',
  \`b_y\`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 y (km)',
  \`b_z\`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 z (km)',
  \`cdm_id\`            varchar(64) NULL,
  \`cdm_pc\`            double NULL,
  \`pc_source\`         varchar(10) NOT NULL DEFAULT 'core' COMMENT 'core|cdm',
  \`created_at\`        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_ev_job\` (\`job_id\`),
  KEY \`idx_ev_org_tca\` (\`org_id\`, \`tca\`),
  KEY \`idx_ev_tca\` (\`tca\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='交会事件（筛查产出，Epic E1）'`

let schemaReady: Promise<boolean> | null = null

export function ensureScreenSchema(): Promise<boolean> {
  if (!schemaReady) {
    // mysql2 单次 query 不支持多语句，双表分两条顺序执行
    schemaReady = pool
      .query(SCHEMA_JOBS)
      .then(() => pool.query(SCHEMA_EVENTS))
      .then(() => true)
      .catch((e) => {
        console.error('[screen] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      })
  }
  return schemaReady
}

export async function createScreenJob(input: {
  orgId: number
  triggeredBy: string
  windowH: number
  missMaxKm: number
  hbrM: number
}): Promise<number> {
  const params = JSON.stringify({ windowH: input.windowH, missMaxKm: input.missMaxKm, hbrM: input.hbrM })
  const [r] = await pool.query(
    `INSERT INTO screening_jobs (org_id, triggered_by, status, params_json, window_h, miss_max_km, hbr_m)
     VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    [input.orgId, input.triggeredBy, params, input.windowH, input.missMaxKm, input.hbrM]
  )
  return Number((r as { insertId: number }).insertId)
}

/** 领取下一个排队任务（单进程内由 runner 串行调用） */
export async function claimNextQueuedJob(): Promise<ScreenJobRow | null> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT * FROM screening_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1`
  )
  const job = rows[0]
  if (!job) return null
  await pool.query(
    `UPDATE screening_jobs SET status = 'running', started_at = NOW(3), error_message = NULL WHERE id = ? AND status = 'queued'`,
    [job.id]
  )
  const [after] = await pool.query<RawJob[]>(`SELECT * FROM screening_jobs WHERE id = ?`, [job.id])
  return after[0] ?? null
}

export async function finishScreenJob(
  id: number,
  status: 'done' | 'failed',
  fields: Partial<{
    nPrimary: number
    nSecondary: number
    nCandidates: number
    nEvents: number
    errorMessage: string
  }> = {}
): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET status = ?, finished_at = NOW(3),
       duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) DIV 1000,
       n_primary = ?, n_secondary = ?, n_candidates = ?, n_events = ?, error_message = ?
     WHERE id = ?`,
    [
      status,
      fields.nPrimary ?? 0,
      fields.nSecondary ?? 0,
      fields.nCandidates ?? 0,
      fields.nEvents ?? 0,
      (fields.errorMessage ?? '').slice(0, 1000) || null,
      id
    ]
  )
}

/** 服务重启后把僵死的 running 任务标记为失败 */
export async function resetStaleRunningJobs(): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET status = 'failed', finished_at = NOW(3),
       error_message = '服务重启中断，请重新发起筛查'
     WHERE status = 'running'`
  )
}

export async function getScreenJob(orgId: number, id: number): Promise<ScreenJobRow | null> {
  const [rows] = await pool.query<RawJob[]>(`SELECT * FROM screening_jobs WHERE id = ? AND org_id = ?`, [id, orgId])
  return rows[0] ?? null
}

export async function listScreenJobs(orgId: number, limit = 50): Promise<ScreenJobRow[]> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT * FROM screening_jobs WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
    [orgId, Math.min(200, Math.max(1, limit))]
  )
  return rows
}

export async function listJobEvents(jobId: number, limit = 200): Promise<ScreenEventRow[]> {
  const [rows] = await pool.query<RawEvent[]>(
    `SELECT * FROM conjunction_events WHERE job_id = ? ORDER BY miss_km ASC LIMIT ?`,
    [jobId, Math.min(1000, Math.max(1, limit))]
  )
  return rows
}

/** 总览（D2）：今日已完成筛查次数 */
export async function countScreensToday(orgId: number): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
    `SELECT COUNT(*) AS n FROM screening_jobs
      WHERE org_id = ? AND status IN ('done','failed') AND finished_at >= CURDATE()`,
    [orgId]
  )
  return Number(rows[0]?.n) || 0
}

type RawJob = RowDataPacket & ScreenJobRow
type RawEvent = RowDataPacket & ScreenEventRow
