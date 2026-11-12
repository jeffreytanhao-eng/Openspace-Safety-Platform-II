/**
 * 我的文档 API（全部 requireAuth）：
 *   GET    /documents              可见列表 + 配额
 *   GET    /documents/:id          元数据 + 预览（无权/不存在统一 404）
 *   GET    /documents/:id/file     下载原文件
 *   POST   /documents/from-report  保存总览报告（客户端按现有下载逻辑生成正文）
 *   POST   /documents/from-event-package 保存交会事件包（Markdown / HTML / CSV）
 *   POST   /documents/from-ephemeris 拷贝当前用户已有权查看的星历源文件
 *   POST   /documents/pin          超管推送置顶（原始字节，文件名走请求头）
 *   POST   /documents/:id/unpin    超管取消置顶
 *   DELETE /documents/:id          删除（创建者或超管；同事只读）
 */
import express, { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ok, fail } from '../utils/response.js'
import { requireAuth } from './auth.js'
import { requireSuperAdmin } from './admin.js'
import { EPH_ROOT } from '../ephem/ingest.js'
import { canViewEphemeris, ephemDbUp, getRowByFileDb, type EphemViewer } from '../ephem/ephemDb.js'
import {
  canDeleteDocument,
  canUnpinDocument,
  canViewDocument,
  deleteUserDocument,
  docsViewerOf,
  ensureUserDocsSchema,
  getDocumentById,
  listVisibleDocuments,
  saveUserDocument,
  storagePathOf,
  toPublicDoc,
  unpinUserDocument,
  countQuotaUsed,
  DocsQuotaError
} from '../db/userDocsDb.js'
import { mimeFromName, splitFilename } from '../utils/userDocsNames.js'
import { writeUserAudit } from '../db/adminDb.js'

const router = Router()

const REPORT_MAX = 5 * 1024 * 1024
const EPH_COPY_MAX = 50 * 1024 * 1024
const PIN_MAX = 20 * 1024 * 1024
const PREVIEW_LIMIT = 200 * 1024
const TEXT_MIME = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml'
])

function hidden404(res: Response): void {
  res.status(404).json(fail(404, '文档不存在'))
}

function viewerFromReq(req: Request) {
  return docsViewerOf(req.auth!.user, req.auth!.org)
}

function ephemViewerFromReq(req: Request): EphemViewer {
  const user = req.auth!.user
  const org = req.auth!.org
  return {
    userId: user.id,
    superAdmin: user.role === 'platform_super_admin',
    vip: !!user.isVip || org?.plan === 'vip'
  }
}

function safeEphResolve(rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) return null
  const full = path.resolve(EPH_ROOT, cleaned)
  if (!full.startsWith(path.resolve(EPH_ROOT))) return null
  return full
}

function contentDisposition(filename: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'document'
  const encoded = encodeURIComponent(filename)
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

const HTML_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'; object-src 'none'"

function isHtmlDoc(mime: string, title: string): boolean {
  const m = (mime || '').toLowerCase()
  const t = (title || '').toLowerCase()
  return m === 'text/html' || m === 'application/xhtml+xml' || t.endsWith('.html') || t.endsWith('.htm')
}

function buildPreview(filePath: string, mime: string, title: string): {
  kind: 'text' | 'html' | 'none'
  text: string
  truncated: boolean
} {
  if (isHtmlDoc(mime, title)) {
    return { kind: 'html', text: '', truncated: false }
  }
  let buf: Buffer
  try {
    buf = fs.readFileSync(filePath)
  } catch {
    return { kind: 'none', text: '', truncated: false }
  }
  const isGz =
    title.toLowerCase().endsWith('.gz') || mime === 'application/gzip' || mime === 'application/x-gzip'
  let raw = buf
  if (isGz) {
    try {
      raw = zlib.gunzipSync(buf)
    } catch {
      return { kind: 'none', text: '', truncated: false }
    }
  }
  const previewable = isGz || TEXT_MIME.has(mime) || mime.startsWith('text/')
  if (!previewable) return { kind: 'none', text: '', truncated: false }
  const slice = raw.subarray(0, PREVIEW_LIMIT)
  return {
    kind: 'text',
    text: slice.toString('utf8'),
    truncated: raw.length > PREVIEW_LIMIT
  }
}

async function ready(res: Response): Promise<boolean> {
  if (!(await ensureUserDocsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return false
  }
  return true
}

function quotaPayload(used: number, max: number | null, scope: 'personal' | 'org' | 'none') {
  return { used, max, scope }
}

router.get('/documents', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  try {
    const viewer = viewerFromReq(req)
    const rows = await listVisibleDocuments(viewer)
    const used = await countQuotaUsed(viewer)
    res.json(
      ok({
        items: rows.map((r) => toPublicDoc(r, viewer)),
        quota: quotaPayload(used, viewer.quotaMax, viewer.quotaScope),
        viewer: { superAdmin: viewer.superAdmin, canPin: viewer.superAdmin }
      })
    )
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '加载文档失败'))
  }
})

router.get('/documents/:id', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const viewer = viewerFromReq(req)
  const row = await getDocumentById(String(req.params.id || ''))
  if (!row || !canViewDocument(row, viewer)) {
    hidden404(res)
    return
  }
  const abs = storagePathOf(row.storage_key)
  const preview =
    abs && fs.existsSync(abs)
      ? buildPreview(abs, row.mime, row.title)
      : { kind: 'none' as const, text: '', truncated: false }
  res.json(ok({ ...toPublicDoc(row, viewer), preview }))
})

router.get('/documents/:id/file', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const viewer = viewerFromReq(req)
  const row = await getDocumentById(String(req.params.id || ''))
  if (!row || !canViewDocument(row, viewer)) {
    hidden404(res)
    return
  }
  const abs = storagePathOf(row.storage_key)
  if (!abs || !fs.existsSync(abs)) {
    hidden404(res)
    return
  }
  try {
    const buf = fs.readFileSync(abs)
    const inline = String(req.query.inline || '') === '1' || String(req.query.inline || '') === 'true'
    const html = isHtmlDoc(row.mime, row.title)
    res.setHeader('Content-Type', row.mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', contentDisposition(row.title, inline ? 'inline' : 'attachment'))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (html) {
      res.setHeader('Content-Security-Policy', HTML_CSP)
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    }
    if (!inline) {
      await writeUserAudit(req.auth, 'document.download', {
        after: {
          summary: `下载文档「${row.title}」`,
          id: row.id,
          title: row.title,
          sourceType: row.source_type ?? null
        }
      })
    }
    res.send(buf)
  } catch {
    res.status(500).json(fail(500, '读取文档失败'))
  }
})

router.post('/documents/from-report', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const user = req.auth!.user
  const org = req.auth!.org
  if (!org && user.role !== 'platform_super_admin') {
    res.status(403).json(fail(403, '平台账号无组织，报告导出仅限组织账号'))
    return
  }
  const body = req.body || {}
  const kind = String(body.kind || '')
  if (kind !== 'summary' && kind !== 'events') {
    res.status(400).json(fail(400, '不支持的报告类型'))
    return
  }
  const content = typeof body.content === 'string' ? body.content : ''
  if (!content) {
    res.status(400).json(fail(400, '报告内容为空'))
    return
  }
  const buf = Buffer.from(content, 'utf8')
  if (buf.length > REPORT_MAX) {
    res.status(400).json(fail(400, '报告文件过大'))
    return
  }
  const titleBase = kind === 'summary' ? '组织日报摘要' : '关注事件包'
  try {
    const viewer = viewerFromReq(req)
    const saved = await saveUserDocument({
      viewer,
      buffer: buf,
      titleBase,
      ext: '.csv',
      mime: 'text/csv',
      originalName: `${titleBase}.csv`,
      sourceType: 'report'
    })
    await writeUserAudit(req.auth, 'document.create', {
      after: {
        summary: `生成文档「${saved.title}」（报告）`,
        id: saved.id,
        title: saved.title,
        sourceType: 'report',
        kind
      }
    })
    res.json(ok(toPublicDoc(saved, viewer)))
  } catch (e) {
    if (e instanceof DocsQuotaError) {
      res.status(409).json(fail(409, e.message))
      return
    }
    res.status(500).json(fail(500, (e as Error).message || '保存报告失败'))
  }
})

router.post('/documents/from-event-package', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const user = req.auth!.user
  const org = req.auth!.org
  if (!org && user.role !== 'platform_super_admin') {
    res.status(403).json(fail(403, '平台账号无组织，事件包保存仅限组织账号'))
    return
  }
  const body = req.body || {}
  const format = String(body.format || '').toLowerCase()
  const meta: Record<string, { ext: string; mime: string }> = {
    md: { ext: '.md', mime: 'text/markdown' },
    html: { ext: '.html', mime: 'text/html' },
    csv: { ext: '.csv', mime: 'text/csv' }
  }
  const kind = meta[format]
  if (!kind) {
    res.status(400).json(fail(400, '不支持的事件包格式'))
    return
  }
  const content = typeof body.content === 'string' ? body.content : ''
  if (!content.trim()) {
    res.status(400).json(fail(400, '事件包内容为空'))
    return
  }
  const buf = Buffer.from(content, 'utf8')
  if (buf.length > REPORT_MAX) {
    res.status(400).json(fail(400, '事件包文件过大'))
    return
  }
  const titleBase = String(body.titleBase || '').trim() || '交会事件包'
  try {
    const viewer = viewerFromReq(req)
    const saved = await saveUserDocument({
      viewer,
      buffer: buf,
      titleBase,
      ext: kind.ext,
      mime: kind.mime,
      originalName: `${titleBase}${kind.ext}`,
      sourceType: 'event-package'
    })
    await writeUserAudit(req.auth, 'document.create', {
      after: {
        summary: `存储至文档「${saved.title}」（事件包）`,
        id: saved.id,
        title: saved.title,
        sourceType: 'event-package',
        format
      }
    })
    res.json(ok(toPublicDoc(saved, viewer)))
  } catch (e) {
    if (e instanceof DocsQuotaError) {
      res.status(409).json(fail(409, e.message))
      return
    }
    res.status(500).json(fail(500, (e as Error).message || '保存事件包失败'))
  }
})

router.post('/documents/from-ephemeris', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const rel = String((req.body || {}).path || '').replace(/\\/g, '/')
  const full = safeEphResolve(rel)
  if (!full || !fs.existsSync(full)) {
    res.status(404).json(fail(404, '文件不存在'))
    return
  }
  const ev = ephemViewerFromReq(req)
  if (await ephemDbUp()) {
    try {
      const row = await getRowByFileDb(rel)
      if (row && !canViewEphemeris(row, ev)) {
        res.status(403).json(fail(403, '无权保存该星历文件'))
        return
      }
    } catch {
      res.status(503).json(fail(503, '星历元数据查询失败，无法校验权限'))
      return
    }
  }
  let st: fs.Stats
  try {
    st = fs.statSync(full)
  } catch {
    res.status(404).json(fail(404, '文件不存在'))
    return
  }
  if (!st.isFile() || st.size > EPH_COPY_MAX) {
    res.status(400).json(fail(400, '星历文件过大或不可读'))
    return
  }
  const suggested = String((req.body || {}).name || '').trim()
  const parts = splitFilename(suggested || path.basename(full))
  try {
    const buf = fs.readFileSync(full)
    const viewer = viewerFromReq(req)
    const saved = await saveUserDocument({
      viewer,
      buffer: buf,
      titleBase: parts.base,
      ext: parts.ext || '.txt.gz',
      mime: mimeFromName(path.basename(full), 'application/gzip'),
      originalName: path.basename(full),
      sourceType: 'ephemeris'
    })
    await writeUserAudit(req.auth, 'document.create', {
      after: {
        summary: `生成文档「${saved.title}」（星历）`,
        id: saved.id,
        title: saved.title,
        sourceType: 'ephemeris'
      }
    })
    res.json(ok(toPublicDoc(saved, viewer)))
  } catch (e) {
    if (e instanceof DocsQuotaError) {
      res.status(409).json(fail(409, e.message))
      return
    }
    res.status(500).json(fail(500, (e as Error).message || '保存星历失败'))
  }
})

router.post(
  '/documents/pin',
  requireAuth,
  requireSuperAdmin,
  express.raw({ type: () => true, limit: PIN_MAX }),
  async (req, res) => {
    if (!(await ready(res))) return
    const raw = req.body
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ? String(raw) : '')
    if (!buf.length) {
      res.status(400).json(fail(400, '文件为空'))
      return
    }
    if (buf.length > PIN_MAX) {
      res.status(400).json(fail(400, '文件过大'))
      return
    }
    let filename = ''
    try {
      filename = decodeURIComponent(String(req.headers['x-filename'] || ''))
    } catch {
      filename = String(req.headers['x-filename'] || '')
    }
    filename = filename.replace(/\\/g, '/').split('/').pop() || ''
    if (!filename) {
      res.status(400).json(fail(400, '缺少文件名'))
      return
    }
    let displayTitle = ''
    try {
      displayTitle = decodeURIComponent(String(req.headers['x-title'] || '')).trim()
    } catch {
      displayTitle = String(req.headers['x-title'] || '').trim()
    }
    displayTitle = displayTitle.replace(/\\/g, '/').split('/').pop() || ''
    const headerMime = String(req.headers['x-content-type'] || '').split(';')[0].trim()
    const parts = splitFilename(filename)
    try {
      const viewer = viewerFromReq(req)
      const saved = await saveUserDocument({
        viewer,
        pinned: true,
        buffer: buf,
        titleBase: parts.base,
        ext: parts.ext,
        mime: mimeFromName(filename, headerMime || 'application/octet-stream'),
        originalName: filename,
        sourceType: 'pinned',
        exactTitle: displayTitle || undefined
      })
      await writeUserAudit(req.auth, 'document.pin', {
        after: {
          summary: `推送置顶文档「${saved.title}」`,
          id: saved.id,
          title: saved.title,
          sourceType: 'pinned'
        }
      })
      res.json(ok(toPublicDoc(saved, viewer)))
    } catch (e) {
      if (e instanceof DocsQuotaError) {
        res.status(409).json(fail(409, e.message))
        return
      }
      res.status(500).json(fail(500, (e as Error).message || '推送置顶文档失败'))
    }
  }
)

router.post('/documents/:id/unpin', requireAuth, requireSuperAdmin, async (req, res) => {
  if (!(await ready(res))) return
  const viewer = viewerFromReq(req)
  const row = await getDocumentById(String(req.params.id || ''))
  if (!row) {
    hidden404(res)
    return
  }
  if (!canUnpinDocument(row, viewer)) {
    res.status(403).json(fail(403, '只能取消置顶文档'))
    return
  }
  const updated = await unpinUserDocument(row)
  await writeUserAudit(req.auth, 'document.unpin', {
    before: { id: row.id, title: row.title, pinned: true },
    after: { summary: `取消置顶文档「${row.title}」`, id: row.id, title: row.title }
  })
  res.json(ok(updated ? toPublicDoc(updated, viewer) : { id: row.id, pinned: false }))
})

router.delete('/documents/:id', requireAuth, async (req, res) => {
  if (!(await ready(res))) return
  const viewer = viewerFromReq(req)
  const row = await getDocumentById(String(req.params.id || ''))
  if (!row || !canViewDocument(row, viewer)) {
    hidden404(res)
    return
  }
  if (!canDeleteDocument(row, viewer)) {
    res.status(403).json(fail(403, '只能删除自己保存的文档'))
    return
  }
  try {
    await deleteUserDocument(row)
    await writeUserAudit(req.auth, 'document.delete', {
      before: { id: row.id, title: row.title, sourceType: row.source_type ?? null },
      after: { summary: `删除文档「${row.title}」`, id: row.id, title: row.title }
    })
    res.json(ok({ id: row.id }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '删除失败'))
  }
})

export default router
