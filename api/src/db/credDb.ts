/**
 * 客户数据凭证 DB（Epic C2）：
 *  - org_credentials：组织自配 Space-Track / AOE 凭据（AES-256-GCM 密文落库，
 *    明文永不存储、API 永不回传，仅返回掩码）；last_ok_at / last_error 供健康展示。
 *  - org_fetch_batches：组织拉取批次审计——每次拉取一条（含条数与错误），「审计记条数」。
 *  - org_snapshots：客户凭据拉到的数据按组织私有落库（不写 system_pool 的
 *    orbital_snapshots / sat_tle / sat_cdm），append 版本化（同内容幂等）。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { pool, pingDb } from './pool.js'

export type CredProvider = 'spacetrack' | 'aoe'
export type OrgFetchKind = 'gp' | 'cdm' | 'aoe'

export const CRED_PROVIDERS: CredProvider[] = ['spacetrack', 'aoe']

export interface CredRow extends RowDataPacket {
  id: number
  org_id: number
  provider: CredProvider
  ciphertext: string
  last_ok_at: string | null
  last_error: string | null
  updated_by: string
  updated_at: string
}

export interface OrgBatchRow extends RowDataPacket {
  id: number
  org_id: number
  provider: CredProvider
  kind: OrgFetchKind
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

/** 幂等建表（MySQL 8 无 IF NOT EXISTS 索引语法，三表均为 CREATE TABLE IF NOT EXISTS） */
export function ensureCredSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (!(await pingDb())) return false
      const SCHEMA = [
        `CREATE TABLE IF NOT EXISTS org_credentials (
          id BIGINT NOT NULL AUTO_INCREMENT,
          org_id INT NOT NULL,
          provider VARCHAR(20) NOT NULL COMMENT 'spacetrack | aoe',
          ciphertext TEXT NOT NULL COMMENT 'AES-256-GCM v1.<iv>.<tag>.<cipher>',
          last_ok_at DATETIME(3) NULL,
          last_error TEXT NULL,
          updated_by VARCHAR(128) NOT NULL DEFAULT '',
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uk_org_provider (org_id, provider)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS org_fetch_batches (
          id BIGINT NOT NULL AUTO_INCREMENT,
          org_id INT NOT NULL,
          provider VARCHAR(20) NOT NULL COMMENT 'spacetrack | aoe',
          kind VARCHAR(10) NOT NULL COMMENT 'gp | cdm | aoe',
          status VARCHAR(10) NOT NULL DEFAULT 'running' COMMENT 'running | success | failed',
          triggered_by VARCHAR(128) NOT NULL DEFAULT '',
          started_at DATETIME(3) NOT NULL,
          finished_at DATETIME(3) NULL,
          duration_ms INT NULL,
          total INT NOT NULL DEFAULT 0,
          inserted INT NOT NULL DEFAULT 0,
          updated INT NOT NULL DEFAULT 0,
          skipped INT NOT NULL DEFAULT 0,
          error_message TEXT NULL,
          PRIMARY KEY (id),
          KEY idx_org_started (org_id, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS org_snapshots (
          id BIGINT NOT NULL AUTO_INCREMENT,
          org_id INT NOT NULL,
          provider VARCHAR(20) NOT NULL COMMENT 'spacetrack | aoe',
          kind VARCHAR(10) NOT NULL COMMENT 'gp | cdm | aoe',
          norad_id INT NOT NULL DEFAULT 0 COMMENT '单目标行=目标 NORAD；CDM 行=0',
          object_name VARCHAR(100) NOT NULL DEFAULT '',
          epoch DATETIME(3) NULL COMMENT 'GP=根数历元；CDM=TCA',
          tle_line1 VARCHAR(100) NOT NULL DEFAULT '',
          tle_line2 VARCHAR(100) NOT NULL DEFAULT '',
          content_hash CHAR(40) NOT NULL COMMENT 'sha1(内容)',
          raw_json MEDIUMTEXT NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uk_org_kind_norad_hash (org_id, provider, kind, norad_id, content_hash),
          KEY idx_org_norad (org_id, norad_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      ]
      for (const sql of SCHEMA) await pool.query(sql)
      return true
    })().catch((e) => {
      console.error('[cred] ensure schema failed:', (e as Error).message)
      schemaReady = null
      return false
    })
  }
  return schemaReady
}

/* --------------------------- org_credentials --------------------------- */

export async function listCredStatus(orgId: number): Promise<CredRow[]> {
  const [rows] = await pool.query<CredRow[]>(
    'SELECT id, org_id, provider, ciphertext, last_ok_at, last_error, updated_by, updated_at FROM org_credentials WHERE org_id = ?',
    [orgId]
  )
  return rows
}

/** 取单条（含密文，供解密拉取/探测） */
export async function getCredential(orgId: number, provider: CredProvider): Promise<CredRow | null> {
  const [rows] = await pool.query<CredRow[]>(
    'SELECT id, org_id, provider, ciphertext, last_ok_at, last_error, updated_by, updated_at FROM org_credentials WHERE org_id = ? AND provider = ?',
    [orgId, provider]
  )
  return rows[0] ?? null
}

export async function upsertCredential(
  orgId: number,
  provider: CredProvider,
  ciphertext: string,
  updatedBy: string
): Promise<void> {
  await pool.query(
    `INSERT INTO org_credentials (org_id, provider, ciphertext, updated_by, last_error)
     VALUES (?,?,?,?,NULL)
     ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), updated_by = VALUES(updated_by), last_error = NULL`,
    [orgId, provider, ciphertext, updatedBy]
  )
}

export async function deleteCredential(orgId: number, provider: CredProvider): Promise<void> {
  await pool.query('DELETE FROM org_credentials WHERE org_id = ? AND provider = ?', [orgId, provider])
}

export async function markCredentialOk(orgId: number, provider: CredProvider): Promise<void> {
  await pool.query('UPDATE org_credentials SET last_ok_at = NOW(3), last_error = NULL WHERE org_id = ? AND provider = ?', [
    orgId,
    provider
  ])
}

export async function markCredentialError(orgId: number, provider: CredProvider, error: string): Promise<void> {
  await pool.query('UPDATE org_credentials SET last_error = ? WHERE org_id = ? AND provider = ?', [
    error.slice(0, 2000),
    orgId,
    provider
  ])
}

/* --------------------------- org_fetch_batches --------------------------- */

export async function startOrgBatch(
  orgId: number,
  provider: CredProvider,
  kind: OrgFetchKind,
  triggeredBy: string
): Promise<number> {
  const [r] = await pool.query(
    'INSERT INTO org_fetch_batches (org_id, provider, kind, status, triggered_by, started_at) VALUES (?,?,?,?,?,NOW(3))',
    [orgId, provider, kind, 'running', triggeredBy]
  )
  return Number((r as { insertId: number }).insertId)
}

export async function finishOrgBatch(
  batchId: number,
  status: 'success' | 'failed',
  counts: { total: number; inserted: number; updated: number; skipped: number },
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE org_fetch_batches
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

export async function listOrgBatches(orgId: number, limit = 20): Promise<OrgBatchRow[]> {
  const [rows] = await pool.query<OrgBatchRow[]>(
    'SELECT * FROM org_fetch_batches WHERE org_id = ? ORDER BY id DESC LIMIT ?',
    [orgId, Math.min(Math.max(1, limit), 100)]
  )
  return rows
}
