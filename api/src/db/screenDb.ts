/**
 * 筛查任务库层（Epic E1）：
 *  - screening_jobs：异步筛查任务（queued/running/done/failed），params 留 JSON 供 F1 重算对比；
 *  - conjunction_events：筛查产出的交会事件（job_id 关联 run，org 维度隔离）。
 */
import { pool } from './pool.js'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

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
  /** R0-3 进度：0-100（粗筛阶段按已完成步数推进） */
  progress_pct: number
  /** R0-3 进度说明（加载中/粗筛中/精化中/写入中） */
  progress_note: string | null
  /** R0-3 心跳：worker 每次推进进度时刷新，超时看门狗据此判僵死 */
  heartbeat_at: string | null
  /** R0-3 取消请求标记（1 = 执行侧应尽快终止） */
  cancel_requested: number
  /** R2-8 主星状态源：tle（系统池/组织快照）| ephem（已绑定精密星历）| aoe（系统池 AOE 两行根数） */
  primary_source: string
  /** R2-8 副星/对照源：catalog（编目 GP）| cdm（已入站 CDM 复核）| aoe（系统池 AOE 编目） */
  secondary_source: string
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
  \`status\`        varchar(10) NOT NULL DEFAULT 'queued' COMMENT 'queued|running|done|failed|cancelled',
  \`params_json\`   mediumtext,
  \`window_h\`      int NOT NULL DEFAULT 72,
  \`miss_max_km\`   double NOT NULL DEFAULT 10,
  \`hbr_m\`         double NOT NULL DEFAULT 15,
  \`n_primary\`     int NOT NULL DEFAULT 0,
  \`n_secondary\`   int NOT NULL DEFAULT 0,
  \`n_candidates\`  int NOT NULL DEFAULT 0,
  \`n_events\`      int NOT NULL DEFAULT 0,
  \`progress_pct\`  tinyint unsigned NOT NULL DEFAULT 0 COMMENT 'R0-3 进度百分比',
  \`progress_note\` varchar(200) NULL COMMENT 'R0-3 阶段说明',
  \`heartbeat_at\`  datetime(3) NULL COMMENT 'R0-3 心跳（僵死看门狗）',
  \`cancel_requested\` tinyint NOT NULL DEFAULT 0 COMMENT 'R0-3 取消请求标记',
  \`primary_source\` varchar(16) NOT NULL DEFAULT 'tle' COMMENT 'R2-8 主星源 tle|ephem|aoe',
  \`secondary_source\` varchar(16) NOT NULL DEFAULT 'catalog' COMMENT 'R2-8 副星/对照源 catalog|cdm|aoe',
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

/**
 * R0-3：老库补列（MySQL 8 无 ADD COLUMN IF NOT EXISTS），重复列错误忽略。
 * 幂等：每次启动执行一次，已存在时 ALTER 报 1060 直接跳过。
 */
async function ensureJobColumns(): Promise<void> {
  const cols = [
    "ADD COLUMN `progress_pct` tinyint unsigned NOT NULL DEFAULT 0 COMMENT 'R0-3 进度百分比'",
    "ADD COLUMN `progress_note` varchar(200) NULL COMMENT 'R0-3 阶段说明'",
    "ADD COLUMN `heartbeat_at` datetime(3) NULL COMMENT 'R0-3 心跳（僵死看门狗）'",
    "ADD COLUMN `cancel_requested` tinyint NOT NULL DEFAULT 0 COMMENT 'R0-3 取消请求标记'",
    "ADD COLUMN `primary_source` varchar(16) NOT NULL DEFAULT 'tle' COMMENT 'R2-8 主星源 tle|ephem|aoe'",
    "ADD COLUMN `secondary_source` varchar(16) NOT NULL DEFAULT 'catalog' COMMENT 'R2-8 副星/对照源 catalog|cdm|aoe'"
  ]
  for (const c of cols) {
    try {
      await pool.query(`ALTER TABLE \`screening_jobs\` ${c}`)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ER_DUP_FIELDNAME') {
        console.error('[screen] alter screening_jobs failed:', (e as Error).message)
      }
    }
  }
}

export function ensureScreenSchema(): Promise<boolean> {
  if (!schemaReady) {
    // mysql2 单次 query 不支持多语句，双表分两条顺序执行
    schemaReady = pool
      .query(SCHEMA_JOBS)
      .then(() => ensureJobColumns())
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
  /** Epic J 再筛查：限定主星 NORAD 白名单（缺省 = 该组织全部目标） */
  primaryNorads?: number[]
  /** Epic J 再筛查：窗口起点 ms（缺省 = 当前时刻对齐分钟） */
  startMs?: number
  /** R2-8 主星源：tle | ephem | aoe */
  primarySource?: string
  /** R2-8 副星/对照源：catalog | cdm | aoe */
  secondarySource?: string
}): Promise<number> {
  const primarySource =
    input.primarySource === 'ephem' || input.primarySource === 'aoe' ? input.primarySource : 'tle'
  const secondarySource =
    input.secondarySource === 'cdm' || input.secondarySource === 'aoe' ? input.secondarySource : 'catalog'
  const params = JSON.stringify({
    windowH: input.windowH,
    missMaxKm: input.missMaxKm,
    hbrM: input.hbrM,
    primaryNorads: input.primaryNorads ?? null,
    startMs: input.startMs ?? null,
    primarySource,
    secondarySource
  })
  const [r] = await pool.query(
    `INSERT INTO screening_jobs (org_id, triggered_by, status, params_json, window_h, miss_max_km, hbr_m, primary_source, secondary_source)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    [
      input.orgId,
      input.triggeredBy,
      params,
      input.windowH,
      input.missMaxKm,
      input.hbrM,
      primarySource,
      secondarySource
    ]
  )
  return Number((r as { insertId: number }).insertId)
}

/**
 * 领取下一个排队任务（单进程内由 runner 串行调用）。
 * C3 优先队列：VIP > 普通 > 免费档，同级按排队先后（id ASC）。
 */
export async function claimNextQueuedJob(): Promise<ScreenJobRow | null> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT j.* FROM screening_jobs j
      LEFT JOIN organizations o ON o.id = j.org_id
      WHERE j.status = 'queued'
      ORDER BY CASE COALESCE(o.plan, 'free') WHEN 'vip' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC, j.id ASC
      LIMIT 1`
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
       n_primary = ?, n_secondary = ?, n_candidates = ?, n_events = ?, error_message = ?,
       progress_pct = ?, cancel_requested = 0
     WHERE id = ?`,
    [
      status,
      fields.nPrimary ?? 0,
      fields.nSecondary ?? 0,
      fields.nCandidates ?? 0,
      fields.nEvents ?? 0,
      (fields.errorMessage ?? '').slice(0, 1000) || null,
      status === 'done' ? 100 : 0,
      id
    ]
  )
}

/** 服务重启后把僵死的 running 任务标记为失败 */
export async function resetStaleRunningJobs(): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET status = 'failed', finished_at = NOW(3),
       progress_note = '服务重启中断', error_message = '服务重启中断，请重新发起筛查'
     WHERE status = 'running'`
  )
}

/* ---------------------- R0-3：进度 / 心跳 / 取消 ---------------------- */

/** 任务启动时登记主/副星数（不再等结束时才写入，running 期间即可观测） */
export async function markJobStarted(id: number, nPrimary: number, nSecondary: number): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET n_primary = ?, n_secondary = ?, progress_pct = 0,
       progress_note = '粗筛中', heartbeat_at = NOW(3) WHERE id = ?`,
    [nPrimary, nSecondary, id]
  )
}

/** 进度心跳：粗筛阶段按已完成步数推进；同时刷新 heartbeat_at 供看门狗判活 */
export async function updateJobProgress(id: number, pct: number, note: string): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET progress_pct = ?, progress_note = ?, heartbeat_at = NOW(3)
     WHERE id = ? AND status = 'running'`,
    [Math.max(0, Math.min(100, Math.round(pct))), note.slice(0, 200), id]
  )
}

/**
 * 取消任务（R0-3）：
 *  - queued  → 直接置 cancelled（runner 不会再领取）；
 *  - running → 置 cancel_requested=1（复用 progress_note 标记），由执行侧轮询后终止 worker；
 *  - 终态    → 返回 false（调用方回 409）。
 * @returns 'cancelled' 已取消 / 'requested' 已请求取消（等待执行侧终止） / 'gone' 终态或不存在
 */
export async function cancelScreenJob(orgId: number, id: number): Promise<'cancelled' | 'requested' | 'gone'> {
  const [q] = await pool.query<ResultSetHeader>(
    `UPDATE screening_jobs SET status = 'cancelled', finished_at = NOW(3),
       progress_note = '已取消', error_message = '任务已取消', cancel_requested = 1,
       duration_ms = TIMESTAMPDIFF(MICROSECOND, COALESCE(started_at, queued_at), NOW(3)) DIV 1000
     WHERE id = ? AND org_id = ? AND status = 'queued'`,
    [id, orgId]
  )
  if (q.affectedRows) return 'cancelled'
  const [r] = await pool.query<ResultSetHeader>(
    `UPDATE screening_jobs SET cancel_requested = 1, progress_note = '取消中…'
     WHERE id = ? AND org_id = ? AND status = 'running'`,
    [id, orgId]
  )
  if (r.affectedRows) return 'requested'
  return 'gone'
}

/** 执行侧轮询：本任务是否已被请求取消 */
export async function isCancelRequested(id: number): Promise<boolean> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT cancel_requested FROM screening_jobs WHERE id = ? AND status = 'running'`,
    [id]
  )
  return Number(rows[0]?.cancel_requested) === 1
}

/** 执行侧终止后落 cancelled 终态 */
export async function finishCancelledJob(id: number): Promise<void> {
  await pool.query(
    `UPDATE screening_jobs SET status = 'cancelled', finished_at = NOW(3),
       progress_note = '已取消', error_message = '任务已取消',
       duration_ms = TIMESTAMPDIFF(MICROSECOND, COALESCE(started_at, queued_at), NOW(3)) DIV 1000
     WHERE id = ? AND status = 'running'`,
    [id]
  )
}

export async function getScreenJob(orgId: number, id: number): Promise<ScreenJobRow | null> {
  const [rows] = await pool.query<RawJob[]>(`SELECT * FROM screening_jobs WHERE id = ? AND org_id = ?`, [id, orgId])
  return rows[0] ?? null
}

/** 平台账号只读：跨组织任务详情 */
export async function getScreenJobAny(id: number): Promise<ScreenJobRow | null> {
  const [rows] = await pool.query<RawJob[]>(`SELECT * FROM screening_jobs WHERE id = ?`, [id])
  return rows[0] ?? null
}

export async function listScreenJobs(orgId: number, limit = 50): Promise<ScreenJobRow[]> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT * FROM screening_jobs WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
    [orgId, Math.min(200, Math.max(1, limit))]
  )
  return rows
}

/** 平台账号只读：跨组织任务列表 */
export async function listAllScreenJobs(limit = 50): Promise<ScreenJobRow[]> {
  const [rows] = await pool.query<RawJob[]>(
    `SELECT * FROM screening_jobs ORDER BY id DESC LIMIT ?`,
    [Math.min(200, Math.max(1, limit))]
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

/** 总览（D2）：今日已完成筛查次数；orgId=null 表示平台账号口径（全平台） */
export async function countScreensToday(orgId: number | null): Promise<number> {
  if (orgId == null) {
    const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
      `SELECT COUNT(*) AS n FROM screening_jobs
        WHERE status IN ('done','failed') AND finished_at >= CURDATE()`
    )
    return Number(rows[0]?.n) || 0
  }
  const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
    `SELECT COUNT(*) AS n FROM screening_jobs
      WHERE org_id = ? AND status IN ('done','failed') AND finished_at >= CURDATE()`,
    [orgId]
  )
  return Number(rows[0]?.n) || 0
}

type RawJob = RowDataPacket & ScreenJobRow
type RawEvent = RowDataPacket & ScreenEventRow
