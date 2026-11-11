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
  uploadedBy: string
  /** 上传者用户 id（NULL = 平台/同步导入，非业主私有） */
  ownerUserId: number | null
  ownerOrgId: number | null
  /** public=全平台只读可用 / vip=仅 VIP 账号可用 / private=仅上传业主可用 */
  visibility: 'public' | 'vip' | 'private'
}

/** 列表可见性过滤：未登录只看 public；登录用户额外看自己的 private（VIP 账号额外看 vip） */
export interface EphemViewer {
  userId: number | null
  superAdmin: boolean
  /** 账号级 VIP（用户标记或组织 VIP 档） */
  vip?: boolean
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
  \`uploaded_by\`     varchar(190) NOT NULL DEFAULT '' COMMENT '上传者邮箱（审计）',
  \`owner_user_id\`   bigint unsigned NULL COMMENT '上传者用户；非 NULL 表示业主私有星历',
  \`owner_org_id\`    bigint unsigned NULL COMMENT '上传者组织',
  \`visibility\`      varchar(16)  NOT NULL DEFAULT 'public' COMMENT 'public=全平台只读可用 / vip=仅 VIP 可见 / private=仅业主可用',
  PRIMARY KEY (\`id\`),
  KEY \`idx_eph_norad\` (\`norad\`),
  KEY \`idx_eph_format\` (\`format\`),
  KEY \`idx_eph_name\` (\`name\`),
  KEY \`idx_eph_start\` (\`start_ms\`),
  KEY \`idx_eph_published\` (\`published_at\`),
  KEY \`idx_eph_owner\` (\`owner_user_id\`),
  KEY \`idx_eph_visibility\` (\`visibility\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='星历元数据索引（原始 .txt.gz 在文件系统 data/ephemerides/）'`

/** G1 星历版本归档：每次上传/扫描 append 一行；内容按 sha256 去重存储，删除仅软删 */
const VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`ephemeris_versions\` (
  \`id\`           bigint       NOT NULL AUTO_INCREMENT,
  \`norad\`        varchar(16)  NOT NULL DEFAULT '0',
  \`format\`       varchar(8)   NOT NULL DEFAULT 'ITC',
  \`source\`       varchar(16)  NOT NULL DEFAULT 'upload',
  \`file\`         varchar(255) NOT NULL DEFAULT '',
  \`sha256\`       char(64)     NOT NULL DEFAULT '',
  \`bytes\`        bigint       NOT NULL DEFAULT 0,
  \`raw_bytes\`    bigint       NOT NULL DEFAULT 0,
  \`published_at\` bigint       NOT NULL DEFAULT 0,
  \`uploaded_by\`  varchar(190) NOT NULL DEFAULT '',
  \`deleted_at\`   bigint       NULL DEFAULT NULL,
  \`created_at\`   varchar(32)  NOT NULL DEFAULT '',
  PRIMARY KEY (\`id\`),
  KEY \`idx_ephver_norad\` (\`norad\`, \`format\`, \`id\`),
  KEY \`idx_ephver_sha\` (\`sha256\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='星历版本归档账本（versions/<sha>.txt.gz 在文件系统，append-only + 软删）'`

let schemaReady: Promise<boolean> | null = null

/** 建表（幂等）+ 旧表补列（已存在的 ephemeris 表加 published_at）；失败返回 false */
export function ensureEphemSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        await pool.query(VERSION_SCHEMA)
        // 已存在的表补列（CREATE TABLE IF NOT EXISTS 不会更新旧表结构）
        const upgradeCols: Array<[string, string, string | null]> = [
          ['published_at', 'bigint NOT NULL DEFAULT 0 AFTER `stop_ms`', 'ADD KEY `idx_eph_published` (`published_at`)'],
          ['raw_size', 'bigint NOT NULL DEFAULT 0 AFTER `file_size`', null],
          ['bound_object_id', 'bigint NULL AFTER `object_id`', 'ADD KEY `idx_eph_bound` (`bound_object_id`)'],
          ['uploaded_by', "varchar(190) NOT NULL DEFAULT '' AFTER `originator`", null],
          ['owner_user_id', 'bigint unsigned NULL AFTER `uploaded_by`', 'ADD KEY `idx_eph_owner` (`owner_user_id`)'],
          ['owner_org_id', 'bigint unsigned NULL AFTER `owner_user_id`', null],
          ['visibility', "varchar(16) NOT NULL DEFAULT 'public' AFTER `owner_org_id`", 'ADD KEY `idx_eph_visibility` (`visibility`)']
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
  /** 旧表为 varchar（UTC 字符串）；新 schema 为 datetime（会话本地时间，读回 Date） */
  updated_at: string | Date
  originator: string
  uploaded_by: string
  owner_user_id: number | null
  owner_org_id: number | null
  visibility: string
}

/** 旧 varchar（UTC 字符串）保持原样；新 datetime（Date）转 UTC 分钟后展示，接口契约不变 */
function dbTimeToMinute(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 16).replace('T', ' ')
  return v.toISOString().slice(0, 16).replace('T', ' ')
}

/** 旧 varchar 是 UTC 字符串，补 Z 解析；新 datetime 直接取 Date */
function dbTimeToIso(v: string | Date): string {
  if (typeof v === 'string') {
    const d = new Date(`${v.replace(' ', 'T')}Z`)
    return Number.isNaN(d.getTime()) ? v : d.toISOString()
  }
  return v.toISOString()
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
    updatedAt: dbTimeToMinute(r.updated_at),
    originator: r.originator,
    sourceName: r.source_name,
    uploadedBy: r.uploaded_by || '',
    ownerUserId: r.owner_user_id == null ? null : Number(r.owner_user_id),
    ownerOrgId: r.owner_org_id == null ? null : Number(r.owner_org_id),
    visibility: r.visibility === 'private' ? 'private' : r.visibility === 'vip' ? 'vip' : 'public'
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
    // 第 6 项：星历归属与可见性
    uploadedBy: r.uploadedBy || undefined,
    ownerUserId: r.ownerUserId ?? undefined,
    visibility: r.visibility,
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

/** 可见性过滤片段：超管全见；VIP 账号看 public + vip + 自己的 private；普通账号看 public + 自己的 private；匿名仅 public */
export function applyViewerFilter(viewer: EphemViewer | null | undefined, where: string[], params: unknown[]): void {
  if (viewer?.superAdmin) return
  if (viewer?.userId != null) {
    const visible = viewer.vip ? `visibility IN ('public', 'vip')` : `visibility = 'public'`
    where.push(`(${visible} OR owner_user_id = ?)`)
    params.push(viewer.userId)
  } else {
    where.push(`visibility = 'public'`)
  }
}

/** 单行可见性判定（列表过滤之外的按行校验：meta / 文件 / 精度对比） */
export function canViewEphemeris(
  row: Pick<EphemRow, 'visibility' | 'ownerUserId'>,
  viewer: EphemViewer | null | undefined
): boolean {
  if (row.visibility === 'public') return true
  if (viewer?.superAdmin) return true
  if (!viewer || viewer.userId == null) return false
  if (row.ownerUserId != null && row.ownerUserId === viewer.userId) return true
  return row.visibility === 'vip' && !!viewer.vip
}

/** 分页查询（q 匹配 name/norad 前缀子串）；返回 total 与当前页行 */
export async function listRowsDb(
  query: ListQuery,
  viewer?: EphemViewer | null
): Promise<{ total: number; rows: EphemRow[] }> {
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
  applyViewerFilter(viewer, where, params)
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
export async function listAllRowsDb(limit = 5000, viewer?: EphemViewer | null): Promise<EphemRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  applyViewerFilter(viewer, where, params)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [rows] = await pool.query<DbRow[]>(
    `SELECT * FROM \`ephemeris\` ${whereSql} ORDER BY published_at DESC, CAST(norad AS UNSIGNED) ASC, format ASC LIMIT ?`,
    [...params, limit]
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

/** 按 NORAD + 格式取当前星历行（版本可见性校验用） */
export async function getRowByNoradFormatDb(norad: string, format: string): Promise<EphemRow | null> {
  const fmt = format === 'OCM' ? 'OCM' : 'ITC'
  const [rows] = await pool.query<DbRow[]>('SELECT * FROM `ephemeris` WHERE norad = ? AND format = ? LIMIT 1', [norad, fmt])
  return rows.length ? rowToEphemRow(rows[0]) : null
}

export async function listRowsByNoradDb(norad: string): Promise<EphemRow[]> {
  const [rows] = await pool.query<DbRow[]>('SELECT * FROM `ephemeris` WHERE norad = ?', [norad])
  return rows.map(rowToEphemRow)
}

/** 行键集合（norad|format，供前端与 IndexedDB 本机行去重；按可见性过滤） */
export async function listAllKeysDb(viewer?: EphemViewer | null): Promise<string[]> {
  const where: string[] = []
  const params: unknown[] = []
  applyViewerFilter(viewer, where, params)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT norad, format FROM \`ephemeris\` ${whereSql}`,
    params
  )
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

/** 业主上传后写归属与可见性（owner 为空 = 平台/超管导入） */
export async function setEphemerisOwnershipDb(
  id: string,
  opts: {
    ownerUserId: number | null
    ownerOrgId: number | null
    visibility: 'public' | 'vip' | 'private'
    uploadedBy: string
  }
): Promise<void> {
  await pool.query(
    `UPDATE \`ephemeris\` SET owner_user_id = ?, owner_org_id = ?, visibility = ?, uploaded_by = ? WHERE id = ?`,
    [opts.ownerUserId, opts.ownerOrgId, opts.visibility, opts.uploadedBy.slice(0, 190), id]
  )
}

/** 切换星历可见性（仅业主本人 / 超管，鉴权在路由层） */
export async function setEphemerisVisibilityDb(
  id: string,
  visibility: 'public' | 'vip' | 'private'
): Promise<boolean> {
  const [r] = await pool.query('UPDATE `ephemeris` SET visibility = ? WHERE id = ?', [visibility, id])
  return Number((r as { affectedRows?: number }).affectedRows ?? 0) > 0
}

/** 删除元数据行（返回被删行用于清理物理文件）；业主本人 / 超管 */
export async function deleteRowDb(id: string): Promise<EphemRow | null> {
  const row = await getRowDb(id)
  if (!row) return null
  await pool.query('DELETE FROM `ephemeris` WHERE id = ?', [id])
  return row
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

/* --------------------- G1 星历版本归档（ephemeris_versions） --------------------- */

/** 版本行（与前端 EphVersion 对齐） */
export interface EphemVersionRow {
  id: number
  norad: string
  format: 'ITC' | 'OCM'
  /** 来源：upload=管理页上传 / scan=rebuild 扫描 */
  source: string
  /** 版本文件相对 EPH_ROOT 路径（versions/…/<sha前16>.txt.gz） */
  file: string
  sha256: string
  bytes: number
  rawBytes: number
  publishedMs: number
  uploadedBy: string
  /** 软删时间戳 ms；null=未删 */
  deletedAt: number | null
  createdAt: string
}

interface VerDbRow extends RowDataPacket {
  id: number
  norad: string
  format: string
  source: string
  file: string
  sha256: string
  bytes: number
  raw_bytes: number
  published_at: number
  uploaded_by: string
  deleted_at: number | null
  created_at: string | Date
}

function rowToVersion(r: VerDbRow): EphemVersionRow {
  return {
    id: Number(r.id),
    norad: r.norad,
    format: r.format === 'OCM' ? 'OCM' : 'ITC',
    source: r.source,
    file: r.file,
    sha256: r.sha256,
    bytes: Number(r.bytes),
    rawBytes: Number(r.raw_bytes),
    publishedMs: Number(r.published_at),
    uploadedBy: r.uploaded_by,
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
    createdAt: dbTimeToIso(r.created_at)
  }
}

/** 插入版本行（append-only，不做 upsert；重复内容由 ingest 层去重） */
export async function insertEphemerisVersionDb(v: EphemVersionRow): Promise<number> {
  const [ret] = await pool.query(
    `INSERT INTO \`ephemeris_versions\`
       (norad, format, source, file, sha256, bytes, raw_bytes, published_at, uploaded_by, deleted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [v.norad, v.format, v.source, v.file, v.sha256, v.bytes, v.rawBytes, v.publishedMs, v.uploadedBy, v.createdAt]
  )
  return (ret as { insertId: number }).insertId
}

/** 同内容 + 同来源 + 同操作者的版本行（append 账本防重复；如重复 scan） */
export async function findVersionByShaSourceDb(
  sha256: string,
  source: string,
  uploadedBy: string
): Promise<EphemVersionRow | null> {
  const [rows] = await pool.query<VerDbRow[]>(
    'SELECT * FROM `ephemeris_versions` WHERE sha256 = ? AND source = ? AND uploaded_by = ? ORDER BY id DESC LIMIT 1',
    [sha256, source, uploadedBy]
  )
  return rows.length ? rowToVersion(rows[0]) : null
}

export interface VersionQuery {
  norad?: string
  format?: string
  page?: number
  size?: number
  /** 1 = 含软删行（默认只列未删） */
  includeDeleted?: boolean
}

/** 版本历史分页（同 NORAD 倒序） */
export async function listVersionsDb(q: VersionQuery): Promise<{ total: number; rows: EphemVersionRow[] }> {
  const where: string[] = []
  const params: unknown[] = []
  const norad = (q.norad || '').trim()
  if (norad) {
    where.push('norad = ?')
    params.push(norad)
  }
  if (q.format === 'ITC' || q.format === 'OCM') {
    where.push('format = ?')
    params.push(q.format)
  }
  if (!q.includeDeleted) where.push('deleted_at IS NULL')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [cntRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM \`ephemeris_versions\` ${whereSql}`,
    params
  )
  const total = Number((cntRows[0] as { c: number }).c) || 0
  const size = Math.min(Math.max(q.size || 20, 1), 200)
  const pages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(q.page || 1, 1), pages)
  const [rows] = await pool.query<VerDbRow[]>(
    `SELECT * FROM \`ephemeris_versions\` ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size]
  )
  return { total, rows: rows.map(rowToVersion) }
}

export async function getEphemerisVersionDb(id: number): Promise<EphemVersionRow | null> {
  const [rows] = await pool.query<VerDbRow[]>('SELECT * FROM `ephemeris_versions` WHERE id = ? LIMIT 1', [id])
  return rows.length ? rowToVersion(rows[0]) : null
}

/** 软删：仅标记 deleted_at，文件与行均保留 */
export async function softDeleteVersionDb(id: number): Promise<boolean> {
  const [ret] = await pool.query(
    'UPDATE `ephemeris_versions` SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    [Date.now(), id]
  )
  return ((ret as { affectedRows: number }).affectedRows || 0) > 0
}
