/**
 * 日更批次与版本化快照（Epic C1）：
 *  - orbital_fetch_batches：每次拉取一个批次（source × status × 计数 × 错误），失败的也有痕迹；
 *  - orbital_snapshots：TLE/AOE 轨道根数版本化追加（epoch + content_hash + batch_id），不覆盖历史。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from './pool.js'

export type FetchSource = 'spacetrack_gp' | 'spacetrack_cdm' | 'aoe'

export interface BatchRow extends RowDataPacket {
  id: number
  source: FetchSource
  status: 'running' | 'success' | 'failed'
  triggered_by: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  total: number
  inserted: number
  updated: number
  skipped: number
  error_message: string | null
}

let schemaReady: Promise<boolean> | null = null

/** 幂等建表（orbital_fetch_batches + orbital_snapshots） */
export function ensureFetchSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (!(await pingDb())) return false
      const SCHEMA = [
        `CREATE TABLE IF NOT EXISTS orbital_fetch_batches (
          id BIGINT NOT NULL AUTO_INCREMENT,
          source VARCHAR(30) NOT NULL COMMENT 'spacetrack_gp | spacetrack_cdm | aoe',
          status VARCHAR(10) NOT NULL DEFAULT 'running' COMMENT 'running | success | failed',
          triggered_by VARCHAR(60) NOT NULL DEFAULT 'cron' COMMENT 'cron | manual:<email>',
          started_at DATETIME(3) NOT NULL,
          finished_at DATETIME(3) NULL,
          duration_ms INT NULL,
          total INT NOT NULL DEFAULT 0,
          inserted INT NOT NULL DEFAULT 0,
          updated INT NOT NULL DEFAULT 0,
          skipped INT NOT NULL DEFAULT 0,
          error_message TEXT NULL,
          PRIMARY KEY (id),
          KEY idx_src_status (source, status),
          KEY idx_finished (finished_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS orbital_snapshots (
          id BIGINT NOT NULL AUTO_INCREMENT,
          batch_id BIGINT NOT NULL,
          provider VARCHAR(20) NOT NULL COMMENT 'spacetrack_gp | aoe',
          source VARCHAR(20) NOT NULL DEFAULT 'system_pool' COMMENT '系统池口径（C3 按档位裁剪）',
          norad_id INT NOT NULL,
          object_name VARCHAR(100) NOT NULL DEFAULT '',
          object_type VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
          epoch DATETIME(3) NULL,
          tle_line1 VARCHAR(100) NOT NULL DEFAULT '',
          tle_line2 VARCHAR(100) NOT NULL DEFAULT '',
          content_hash CHAR(40) NOT NULL COMMENT 'sha1(line1+line2)',
          raw_json MEDIUMTEXT NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uk_prov_norad_hash (provider, norad_id, content_hash),
          KEY idx_norad_epoch (norad_id, epoch),
          KEY idx_batch (batch_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      ]
      for (const sql of SCHEMA) await pool.query(sql)
      return true
    })().catch((e) => {
      console.error('[fetch] ensure schema failed:', (e as Error).message)
      schemaReady = null
      return false
    })
  }
  return schemaReady
}

/** 开启一个批次，返回批次 id */
export async function startBatch(source: FetchSource, triggeredBy: string): Promise<number> {
  const [r] = await pool.query(
    'INSERT INTO orbital_fetch_batches (source, status, triggered_by, started_at) VALUES (?,?,?,NOW(3))',
    [source, 'running', triggeredBy]
  )
  return Number((r as { insertId: number }).insertId)
}

/** 结束批次（success / failed） */
export async function finishBatch(
  batchId: number,
  status: 'success' | 'failed',
  counts: { total: number; inserted: number; updated: number; skipped: number },
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE orbital_fetch_batches
     SET status=?, finished_at=NOW(3), duration_ms=TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) DIV 1000,
         total=?, inserted=?, updated=?, skipped=?, error_message=?
     WHERE id=?`,
    [
      status,
      counts.total,
      counts.inserted,
      counts.updated,
      counts.skipped,
      errorMessage ? errorMessage.slice(0, 2000) : null,
      batchId
    ]
  )
}

export interface DailyFetchStatus {
  last_success: Record<string, string | null>
  last_batch: Record<string, BatchRow | null>
  running: boolean
}

/** 各数据源上次成功时间（health / status 接口用） */
export async function getDailyFetchStatus(): Promise<DailyFetchStatus> {
  const sources: FetchSource[] = ['spacetrack_gp', 'spacetrack_cdm', 'aoe']
  const lastSuccess: Record<string, string | null> = {}
  const lastBatch: Record<string, BatchRow | null> = {}
  for (const s of sources) {
    const [rows] = await pool.query<BatchRow[]>(
      'SELECT * FROM orbital_fetch_batches WHERE source=? ORDER BY id DESC LIMIT 1',
      [s]
    )
    lastBatch[s] = rows[0] ?? null
    lastSuccess[s] = rows[0]?.status === 'success' ? rows[0].finished_at : null
  }
  const [runRows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM orbital_fetch_batches WHERE status='running' AND started_at > (NOW(3) - INTERVAL 2 HOUR)"
  )
  return { last_success: lastSuccess, last_batch: lastBatch, running: Number(runRows[0]?.n ?? 0) > 0 }
}
