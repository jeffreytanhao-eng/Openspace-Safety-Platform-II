/**
 * 星历元数据库层（MySQL，复用 src/db/pool.ts 连接池）。
 *
 * 设计口径：
 * - 原始 .txt.gz 保留在文件系统（data/ephemerides/{itc,ocm}/…），数据库只存元数据 —— 万级文件（10-20GB）
 *   不入 blob，备份/检索均走文件系统 + 索引查询的标准对象存储模式；
 * - 数据库不可用时全部接口自动回退 data/ephemerides/index.json（现状行为），星历功能零回归；
 * - maneuverEpochs 以 JSON 列存储（展示所需的 count / maxΔv / 历元列表同属一行，
 *   避免万级 join 复杂度；后续按时间范围筛机动时再拆表）。
 */
import { pool, pingDb } from '../db/pool.js'
import type { RowDataPacket } from 'mysql2'
import type { EphemManeuverEpoch } from './parseMeta.js'
import { formatSize, rangeLabel } from './parseMeta.js'

/** 与前端 EphListItem 对齐的行结构 */
export interface EphemRow {
  id: string
  name: string
  norad: string
  objectId: string
  format: 'ITC' | 'OCM'
  file: string
  fileMtime: number
  fileSize: number
  /** 解压后原始字节数（列表 size 展示用；0 = 未知，回退 fileSize） */
  rawSize: number
  points: number
  stepSec: number
  startMs: number
  stopMs: number
  /** 发布时间（OCM CREATION_DATE / ITC CREATED 行），无则用文件 mtime 兜底 */
  publishedMs: number
  covariance: boolean
  covFrame: string
  maneuvers: number
  maneuverSummary: string
  maneuverEpochs: EphemManeuverEpoch[]
  status: string
  updatedAt: string
  originator: string
  sourceName: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`ephemeris\` (
  \`id\`              varchar(64)  NOT NULL,
  \`name\`            varchar(128) NOT NULL DEFAULT '',
  \`norad\`           varchar(16)  NOT NULL DEFAULT '0',
  \`object_id\`       varchar(64)  NOT NULL DEFAULT '',
  \`format\`          varchar(8)   NOT NULL DEFAULT 'ITC',
  \`file\`            varchar(255) NOT NULL DEFAULT '',
  \`file_mtime\`      bigint       NOT NULL DEFAULT 0,
  \`file_size\`       bigint       NOT NULL DEFAULT 0,
  \`raw_size\`        bigint       NOT NULL DEFAULT 0,
  \`source_name\`     varchar(255) NOT NULL DEFAULT '',
  \`points\`          int          NOT NULL DEFAULT 0,
  \`step_sec\`        int          NOT NULL DEFAULT 60,
  \`start_ms\`        bigint       NOT NULL DEFAULT 0,
  \`stop_ms\`         bigint       NOT NULL DEFAULT 0,
  \`published_at\`    bigint       NOT NULL DEFAULT 0,
  \`covariance\`      tinyint      NOT NULL DEFAULT 0,
  \`cov_frame\`       varchar(16)  NOT NULL DEFAULT '',
  \`maneuvers\`       int          NOT NULL DEFAULT 0,
  \`maneuver_summary\` varchar(255) NOT NULL DEFAULT '',
  \`maneuver_epochs\` mediumtext,
  \`status\`          varchar(16)  NOT NULL DEFAULT 'local',
  \`updated_at\`      varchar(32)  NOT NULL DEFAULT '',
  \`originator\`      varchar(128) NOT NULL DEFAULT '',
  PRIMARY KEY (\`id\`),
  KEY \`idx_eph_norad\` (\`norad\`),
  KEY \`idx_eph_format\` (\`format\`),
  KEY \`idx_eph_name\` (\`name\`),
  KEY \`idx_eph_start\` (\`start_ms\`),
  KEY \`idx_eph_published\` (\`published_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='星历元数据索引（原始 .txt.gz 在文件系统 data/ephemerides/）'`

let schemaReady: Promise<boolean> | null = null

/** 建表（幂等）+ 旧表补列（已存在的 ephemeris 表加 published_at）；失败返回 false */
export function ensureEphemSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        // 已存在的表补列（CREATE TABLE IF NOT EXISTS 不会更新旧表结构）
        const upgradeCols: Array<[string, string, string | null]> = [
          ['published_at', 'bigint NOT NULL DEFAULT 0 AFTER `stop_ms`', 'ADD KEY `idx_eph_published` (`published_at`)'],
          ['raw_size', 'bigint NOT NULL DEFAULT 0 AFTER `file_size`', null]
        ]
        for (const [col, def, extraIdx] of upgradeCols) {
          const [cols] = await pool.query<RowDataPacket[]>(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ephemeris' AND COLUMN_NAME = ?`,
            [col]
          )
          if (!cols.length) {
            await pool.query(`ALTER TABLE \`ephemeris\` ADD COLUMN \`${col}\` ${def}`)
            if (extraIdx) await pool.query(`ALTER TABLE \`ephemeris\` ${extraIdx}`)
            console.log(`[ephem] schema upgraded: + ${col}`)
          }
        }
        return true
      } catch (e) {
        console.error('[ephem] ensure schema failed:', (e as Error).message)
        return false
      }
    })()
  }
  return schemaReady
}

export async function ephemDbUp(): Promise<boolean> {
  return (await ensureEphemSchema()) && (await pingDb())
}

interface DbRow extends RowDataPacket {
  id: string
  name: string
  norad: string
  object_id: string
  format: string
  file: string
  file_mtime: number
  file_size: number
  raw_size: number
  source_name: string
  points: number
  step_sec: number
  start_ms: number
  stop_ms: number
  published_at: number
  covariance: number
  cov_frame: string
  maneuvers: number
  maneuver_summary: string
  maneuver_epochs: string | null
  status: string
  updated_at: string
  originator: string
}

function rowToEphemRow(r: DbRow): EphemRow {
  let epochs: EphemManeuverEpoch[] = []
  try {
    epochs = r.maneuver_epochs ? (JSON.parse(r.maneuver_epochs) as EphemManeuverEpoch[]) : []
  } catch {
    epochs = []
  }
  return {
    id: r.id,
    name: r.name,
    norad: r.norad,
    objectId: r.object_id,
    format: (r.format === 'OCM' ? 'OCM' : 'ITC'),
    file: r.file,
    fileMtime: Number(r.file_mtime),
    fileSize: Number(r.file_size),
    rawSize: Number(r.raw_size) || 0,
    points: Number(r.points),
    stepSec: Number(r.step_sec),
    startMs: Number(r.start_ms),
    stopMs: Number(r.stop_ms),
    publishedMs: Number(r.published_at) || 0,
    covariance: !!r.covariance,
    covFrame: r.cov_frame,
    maneuvers: Number(r.maneuvers),
    maneuverSummary: r.maneuver_summary,
    maneuverEpochs: epochs,
    status: r.status,
    updatedAt: r.updated_at,
    originator: r.originator,
    sourceName: r.source_name
  }
}

/** 行 → 前端 EphListItem（含 range/step/size 展示字段） */
export function toListItem(r: EphemRow) {
  return {
    id: r.id,
    name: r.name,
    norad: r.norad,
    objectId: r.objectId,
    points: r.points,
    step: `${r.stepSec} s`,
    stepSec: r.stepSec,
    range: rangeLabel(r.startMs, r.stopMs),
    startMs: r.startMs,
    stopMs: r.stopMs,
    publishedMs: r.publishedMs,
    covariance: r.covariance,
    covFrame: r.covFrame || undefined,
    maneuvers: r.maneuvers,
    maneuverSummary: r.maneuverSummary,
    maneuverEpochs: r.maneuverEpochs,
    status: r.status,
    updatedAt: r.updatedAt,
    originator: r.originator,
    format: r.format,
    file: r.file,
    // 列表 size 显示解压后原大小（rawSize 缺失时回退压缩大小）
    size: formatSize(r.rawSize || r.fileSize)
  }
}

export interface ListQuery {
  format?: string
  q?: string
  page?: number
  size?: number
}

/** 分页查询（q 匹配 name/norad 前缀子串）；返回 total 与当前页行 */
export async function listRowsDb(query: ListQuery): Promise<{ total: number; rows: EphemRow[] }> {
  const where: string[] = []
  const params: unknown[] = []
  if (query.format === 'ITC' || query.format === 'OCM') {
    where.push('format = ?')
    params.push(query.format)
  }
  const q = (query.q || '').trim()
  if (q) {
    where.push('(name LIKE ? OR norad LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [cntRows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`ephemeris\` ${whereSql}`, params)
  const total = Number((cntRows[0] as { c: number }).c) || 0
  const size = Math.min(Math.max(query.size || 20, 1), 500)
  const pages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(query.page || 1, 1), pages)
  const [rows] = await pool.query<DbRow[]>(
    `SELECT * FROM \`ephemeris\` ${whereSql}
     ORDER BY published_at DESC, CAST(norad AS UNSIGNED) ASC, format ASC
     LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size]
  )
  return { total, rows: rows.map(rowToEphemRow) }
}

/** 全量行（legacy 模式 / index.json 导出）；limit 兜底防超大响应 */
export async function listAllRowsDb(limit = 5000): Promise<EphemRow[]> {
  const [rows] = await pool.query<DbRow[]>(
    `SELECT * FROM \`ephemeris\` ORDER BY published_at DESC, CAST(norad AS UNSIGNED) ASC, format ASC LIMIT ?`,
    [limit]
  )
  return rows.map(rowToEphemRow)
}

export async function getRowDb(id: string): Promise<EphemRow | null> {
  const [rows] = await pool.query<DbRow[]>('SELECT * FROM `ephemeris` WHERE id = ? LIMIT 1', [id])
  return rows.length ? rowToEphemRow(rows[0]) : null
}

export async function getRowByFileDb(file: string): Promise<EphemRow | null> {
  const [rows] = await pool.query<DbRow[]>('SELECT * FROM `ephemeris` WHERE file = ? LIMIT 1', [file])
  return rows.length ? rowToEphemRow(rows[0]) : null
}

export async function getRowBySourceNameDb(sourceName: string): Promise<EphemRow | null> {
  const [rows] = await pool.query<DbRow[]>('SELECT * FROM `ephemeris` WHERE source_name = ? LIMIT 1', [sourceName])
  return rows.length ? rowToEphemRow(rows[0]) : null
}

/** 行键集合（norad|format，供前端与 IndexedDB 本机行去重） */
export async function listAllKeysDb(): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT norad, format FROM `ephemeris`')
  return (rows as { norad: string; format: string }[]).map((r) => `${r.norad}|${r.format}`)
}

/** upsert（同 id 覆盖） */
export async function upsertRowDb(r: EphemRow): Promise<void> {
  await pool.query(
    `INSERT INTO \`ephemeris\`
       (id, name, norad, object_id, format, file, file_mtime, file_size, raw_size, source_name,
        points, step_sec, start_ms, stop_ms, published_at, covariance, cov_frame,
        maneuvers, maneuver_summary, maneuver_epochs, status, updated_at, originator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), norad=VALUES(norad), object_id=VALUES(object_id), format=VALUES(format),
       file=VALUES(file), file_mtime=VALUES(file_mtime), file_size=VALUES(file_size),
       raw_size=VALUES(raw_size),
       source_name=VALUES(source_name), points=VALUES(points), step_sec=VALUES(step_sec),
       start_ms=VALUES(start_ms), stop_ms=VALUES(stop_ms), published_at=VALUES(published_at),
       covariance=VALUES(covariance),
       cov_frame=VALUES(cov_frame), maneuvers=VALUES(maneuvers), maneuver_summary=VALUES(maneuver_summary),
       maneuver_epochs=VALUES(maneuver_epochs), status=VALUES(status), updated_at=VALUES(updated_at),
       originator=VALUES(originator)`,
    [
      r.id, r.name, r.norad, r.objectId, r.format, r.file, r.fileMtime, r.fileSize, r.rawSize, r.sourceName,
      r.points, r.stepSec, r.startMs, r.stopMs, r.publishedMs, r.covariance ? 1 : 0, r.covFrame,
      r.maneuvers, r.maneuverSummary, JSON.stringify(r.maneuverEpochs), r.status, r.updatedAt, r.originator
    ]
  )
}

/** 清空全部行（force rebuild 用：解析口径变更后全量重入库） */
export async function clearRowsDb(): Promise<void> {
  await pool.query('TRUNCATE TABLE `ephemeris`')
}

/** 删除不存在文件的脏行（扫描收尾用） */
export async function deleteRowsByFilesDb(files: string[]): Promise<number> {
  if (!files.length) return 0
  const [ret] = await pool.query('DELETE FROM `ephemeris` WHERE file IN (?)', [files])
  return (ret as { affectedRows: number }).affectedRows || 0
}

export async function countRowsDb(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM `ephemeris`')
  return Number((rows[0] as { c: number }).c) || 0
}
