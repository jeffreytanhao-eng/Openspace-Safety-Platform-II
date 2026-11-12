/**
 * 我的文档：元数据表 + 磁盘落盘（data/user-documents，文件名=服务端 UUID）。
 * 配额：普通/免费个人 50；VIP 同组织共享 500；置顶不计入。并发保存用 GET_LOCK 串行化计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { pool } from './pool.js'
import {
  buildDocumentTitle,
  formatShanghaiDateTime,
  sanitizeBase,
  shanghaiStamp,
  uniquifyExactTitle
} from '../utils/userDocsNames.js'
import type { SafeOrg, SafeUser } from '../routes/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DOCS_QUOTA_PERSONAL = 50
export const DOCS_QUOTA_VIP_ORG = 500

export type DocScope = 'personal' | 'org' | 'pinned'
export type DocSourceType = 'report' | 'event-package' | 'ephemeris' | 'upload' | 'pinned'

export interface DocsViewer {
  userId: number
  orgId: number | null
  superAdmin: boolean
  vip: boolean
  quotaMax: number | null
  quotaScope: 'personal' | 'org' | 'none'
}

export interface UserDocumentRow {
  id: string
  owner_user_id: number
  org_id: number | null
  title: string
  original_name: string
  storage_key: string
  size_bytes: number
  mime: string
  source_type: string
  pinned: number
  scope: DocScope
  created_by: number
  created_at: Date | string
  created_by_name?: string | null
}

export interface UserDocumentPublic {
  id: string
  title: string
  originalName: string
  size: number
  mime: string
  sourceType: string
  pinned: boolean
  scope: DocScope
  createdAt: string
  createdBy: number
  createdByName: string
  canDelete: boolean
  canUnpin: boolean
  canDownload: boolean
}

export class DocsQuotaError extends Error {
  used: number
  max: number
  constructor(used: number, max: number) {
    super(`已达文档数量上限（${used}/${max}），无法继续保存`)
    this.name = 'DocsQuotaError'
    this.used = used
    this.max = max
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`user_documents\` (
  \`id\`            char(36) NOT NULL COMMENT '服务端生成 UUID',
  \`owner_user_id\` bigint NOT NULL COMMENT '创建者用户 id',
  \`org_id\`        bigint NULL COMMENT '所属组织；置顶可为 NULL',
  \`title\`         varchar(255) NOT NULL COMMENT '展示文件名（含生成时间，无路径）',
  \`original_name\` varchar(255) NOT NULL COMMENT '原始/建议文件名',
  \`storage_key\`   varchar(80) NOT NULL COMMENT '磁盘文件名（UUID，不含用户文件名）',
  \`size_bytes\`    bigint NOT NULL,
  \`mime\`          varchar(127) NOT NULL,
  \`source_type\`   varchar(32) NOT NULL COMMENT 'report | ephemeris | upload | pinned',
  \`pinned\`        tinyint(1) NOT NULL DEFAULT 0,
  \`scope\`         varchar(16) NOT NULL COMMENT 'personal | org | pinned',
  \`created_by\`    bigint NOT NULL,
  \`created_at\`    datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_storage_key\` (\`storage_key\`),
  KEY \`idx_owner\` (\`owner_user_id\`, \`pinned\`, \`created_at\`),
  KEY \`idx_org_scope\` (\`org_id\`, \`scope\`, \`pinned\`, \`created_at\`),
  KEY \`idx_pinned\` (\`pinned\`, \`created_at\`),
  KEY \`idx_title\` (\`title\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='我的文档元数据'
`

let schemaReady: Promise<boolean> | null = null

export function ensureUserDocsSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
        await pool.query(ddl)
      }
      return true
    })().catch((e) => {
      console.error('[docs] ensure schema failed:', (e as Error).message)
      schemaReady = null
      return false
    })
  }
  return schemaReady
}

export function resolveDataRoot(): string {
  const env = (process.env.OSP_DATA_DIR || process.env.DATA_DIR || '').trim()
  const candidates = [
    env,
    path.resolve(process.cwd(), 'data'),
    path.resolve(process.cwd(), '../data'),
    path.resolve(__dirname, '../../data'),
    path.resolve(__dirname, '../../../data')
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[candidates.length - 1] || path.resolve(process.cwd(), '../data')
}

export function resolveDocsDir(): string {
  return path.join(resolveDataRoot(), 'user-documents')
}

export function ensureDocsDir(): string {
  const dir = resolveDocsDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  return dir
}

export function storagePathOf(storageKey: string): string | null {
  if (!/^[0-9a-fA-F-]{16,80}$/.test(storageKey)) return null
  const dir = resolveDocsDir()
  const full = path.resolve(dir, storageKey)
  if (!full.startsWith(path.resolve(dir))) return null
  return full
}

export function docsViewerOf(user: SafeUser, org: SafeOrg | null): DocsViewer {
  const superAdmin = user.role === 'platform_super_admin'
  const vip = !!user.isVip || org?.plan === 'vip'
  if (superAdmin) {
    return { userId: user.id, orgId: org?.id ?? null, superAdmin: true, vip, quotaMax: null, quotaScope: 'none' }
  }
  if (vip && org?.id) {
    return {
      userId: user.id,
      orgId: org.id,
      superAdmin: false,
      vip: true,
      quotaMax: DOCS_QUOTA_VIP_ORG,
      quotaScope: 'org'
    }
  }
  return {
    userId: user.id,
    orgId: org?.id ?? null,
    superAdmin: false,
    vip: false,
    quotaMax: DOCS_QUOTA_PERSONAL,
    quotaScope: 'personal'
  }
}

export function canViewDocument(row: UserDocumentRow, viewer: DocsViewer): boolean {
  if (viewer.superAdmin) return true
  if (Number(row.pinned) === 1 || row.scope === 'pinned') return true
  if (row.owner_user_id === viewer.userId) return true
  if (row.scope === 'org' && viewer.vip && viewer.orgId != null && row.org_id === viewer.orgId) return true
  return false
}

export function canDeleteDocument(row: UserDocumentRow, viewer: DocsViewer): boolean {
  if (viewer.superAdmin) return true
  if (Number(row.pinned) === 1 || row.scope === 'pinned') return false
  return row.created_by === viewer.userId || row.owner_user_id === viewer.userId
}

export function canUnpinDocument(row: UserDocumentRow, viewer: DocsViewer): boolean {
  return viewer.superAdmin && (Number(row.pinned) === 1 || row.scope === 'pinned')
}

function createdAtText(v: Date | string): string {
  if (v instanceof Date) return formatShanghaiDateTime(v)
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : formatShanghaiDateTime(d)
}

export function toPublicDoc(row: UserDocumentRow, viewer: DocsViewer): UserDocumentPublic {
  return {
    id: row.id,
    title: row.title,
    originalName: row.original_name,
    size: Number(row.size_bytes) || 0,
    mime: row.mime,
    sourceType: row.source_type,
    pinned: Number(row.pinned) === 1,
    scope: row.scope,
    createdAt: createdAtText(row.created_at),
    createdBy: row.created_by,
    createdByName: (row.created_by_name || '').trim(),
    canDelete: canDeleteDocument(row, viewer),
    canUnpin: canUnpinDocument(row, viewer),
    canDownload: true
  }
}

type RawDoc = RowDataPacket & UserDocumentRow & { created_by_name?: string }

const SELECT_WITH_NAME = `
  SELECT d.*, u.display_name AS created_by_name
  FROM user_documents d
  LEFT JOIN users u ON u.id = d.created_by
`

export async function countQuotaUsed(viewer: DocsViewer, conn?: PoolConnection): Promise<number> {
  const q = conn ?? pool
  if (viewer.quotaScope === 'org' && viewer.orgId != null) {
    const [rows] = await q.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM user_documents WHERE pinned = 0 AND scope = 'org' AND org_id = ?`,
      [viewer.orgId]
    )
    return Number(rows[0]?.n) || 0
  }
  if (viewer.quotaScope === 'personal') {
    const [rows] = await q.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM user_documents WHERE pinned = 0 AND scope = 'personal' AND owner_user_id = ?`,
      [viewer.userId]
    )
    return Number(rows[0]?.n) || 0
  }
  return 0
}

export async function listVisibleDocuments(viewer: DocsViewer): Promise<UserDocumentRow[]> {
  let sql = `${SELECT_WITH_NAME}`
  const params: unknown[] = []
  if (!viewer.superAdmin) {
    sql += ` WHERE d.pinned = 1 OR d.owner_user_id = ?`
    params.push(viewer.userId)
    if (viewer.vip && viewer.orgId != null) {
      sql += ` OR (d.scope = 'org' AND d.org_id = ?)`
      params.push(viewer.orgId)
    }
  }
  sql += ` ORDER BY d.pinned DESC, d.created_at DESC LIMIT 2000`
  const [rows] = await pool.query<RawDoc[]>(sql, params)
  return rows
}

export async function getDocumentById(id: string): Promise<UserDocumentRow | null> {
  const [rows] = await pool.query<RawDoc[]>(`${SELECT_WITH_NAME} WHERE d.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

async function existingTitlesLike(conn: PoolConnection, prefix: string): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT title FROM user_documents WHERE title LIKE ?`,
    [`${prefix}%`]
  )
  return rows.map((r) => String(r.title))
}

export async function saveUserDocument(args: {
  viewer: DocsViewer
  pinned?: boolean
  buffer: Buffer
  titleBase: string
  ext: string
  mime: string
  originalName: string
  sourceType: DocSourceType
  /** 若提供则作为展示名（不加时间戳）；用于超管置顶手册等固定标题 */
  exactTitle?: string
}): Promise<UserDocumentRow> {
  const pinned = !!args.pinned
  if (pinned && !args.viewer.superAdmin) {
    throw new Error('只有平台超管可以推送置顶文档')
  }
  const dir = ensureDocsDir()
  const id = crypto.randomUUID()
  const storageKey = id
  const abs = path.join(dir, storageKey)
  const lockName =
    pinned || args.viewer.quotaScope === 'none'
      ? `osp-docs-write-${args.viewer.userId}`
      : args.viewer.quotaScope === 'org'
        ? `osp-docs-org-${args.viewer.orgId}`
        : `osp-docs-user-${args.viewer.userId}`

  const conn = await pool.getConnection()
  let fileWritten = false
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lockName])
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw new Error('保存繁忙，请稍后重试')
    }
    try {
      if (!pinned && args.viewer.quotaMax != null) {
        const used = await countQuotaUsed(args.viewer, conn)
        if (used >= args.viewer.quotaMax) {
          throw new DocsQuotaError(used, args.viewer.quotaMax)
        }
      }
      let title: string
      if (args.exactTitle && args.exactTitle.trim()) {
        const desired = sanitizeBase(args.exactTitle)
        const titles = await existingTitlesLike(conn, desired)
        title = uniquifyExactTitle(desired, titles)
      } else {
        const stamp = shanghaiStamp()
        const titles = await existingTitlesLike(conn, `${sanitizeBase(args.titleBase)}_${stamp}`)
        title = buildDocumentTitle(args.titleBase, stamp, args.ext, titles)
      }
      fs.writeFileSync(abs, args.buffer, { mode: 0o640 })
      fileWritten = true

      const scope: DocScope = pinned ? 'pinned' : args.viewer.quotaScope === 'org' ? 'org' : 'personal'
      const orgId = pinned ? null : args.viewer.orgId
      await conn.query<ResultSetHeader>(
        `INSERT INTO user_documents
          (id, owner_user_id, org_id, title, original_name, storage_key, size_bytes, mime, source_type, pinned, scope, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          args.viewer.userId,
          orgId,
          title,
          sanitizeBase(args.originalName).slice(0, 255) || title,
          storageKey,
          args.buffer.length,
          (args.mime || 'application/octet-stream').slice(0, 127),
          args.sourceType,
          pinned ? 1 : 0,
          scope,
          args.viewer.userId
        ]
      )
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName])
    }
  } catch (e) {
    if (fileWritten) {
      try {
        fs.unlinkSync(abs)
      } catch {
        /* ignore */
      }
    }
    throw e
  } finally {
    conn.release()
  }
  const saved = await getDocumentById(id)
  if (!saved) throw new Error('保存成功但未能读取文档')
  return saved
}

export async function deleteUserDocument(row: UserDocumentRow): Promise<void> {
  await pool.query('DELETE FROM user_documents WHERE id = ?', [row.id])
  const abs = storagePathOf(row.storage_key)
  if (abs && fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs)
    } catch (e) {
      console.warn('[docs] unlink failed:', (e as Error).message)
    }
  }
}

export async function unpinUserDocument(row: UserDocumentRow): Promise<UserDocumentRow | null> {
  await pool.query(
    `UPDATE user_documents SET pinned = 0, scope = 'personal', org_id = NULL WHERE id = ?`,
    [row.id]
  )
  return getDocumentById(row.id)
}
