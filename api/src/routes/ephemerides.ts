import express, { Router, type Request, type Response, type NextFunction } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import jwt from 'jsonwebtoken'
import { ok, fail } from '../utils/response.js'
import { config } from '../config.js'
import {
  ephemDbUp,
  listRowsDb,
  listAllRowsDb,
  getRowDb,
  listAllKeysDb,
  toListItem,
  listVersionsDb,
  getEphemerisVersionDb,
  softDeleteVersionDb
} from '../ephem/ephemDb.js'
import { EPH_ROOT, scanAndIngest, ingestUploadFile } from '../ephem/ingest.js'
import { compareSources, listAccuracySources } from '../services/accuracyCompare.js'
import { requireAuth } from './auth.js'
import { isOrgFlagEnabled } from '../db/planDb.js'
import { quotaExceeded } from '../middleware/plan.js'
import { findOrgById } from '../db/orgDb.js'

const router = Router()

/** 可选身份：请求带有效 Bearer token 时返回其邮箱（归档 uploaded_by 用），否则 anonymous */
function tryAuthName(req: Request): string {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return 'anonymous'
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { email?: string }
    return payload.email || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

/** 可选身份：有效 token 时返回 orgId（配额计量用），否则 null */
function tryAuthOrgId(req: Request): number | null {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return null
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { orgId?: number | null }
    const orgId = Number(payload.orgId)
    return Number.isFinite(orgId) && orgId > 0 ? orgId : null
  } catch {
    return null
  }
}

function safeResolve(rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) return null
  const full = path.resolve(EPH_ROOT, cleaned)
  if (!full.startsWith(EPH_ROOT)) return null
  return full
}

/* ---------------- index.json 回退（数据库不可用时保持现状功能） ---------------- */

interface IndexItem {
  id: string
  [k: string]: unknown
}

function readIndexFile(): { generatedAt: string | null; items: IndexItem[] } | null {
  const indexPath = path.join(EPH_ROOT, 'index.json')
  if (!fs.existsSync(indexPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      generatedAt?: string
      items: IndexItem[]
    }
    return { generatedAt: raw.generatedAt || null, items: raw.items || [] }
  } catch {
    return null
  }
}

/** index.json 内存过滤 + 切片（格式 / 关键词 / 分页），与 DB 模式同构 */
function pagedFromIndex(items: IndexItem[], q: { format?: string; q?: string; page?: number; size?: number }) {
  let list = items
  if (q.format === 'ITC' || q.format === 'OCM') list = list.filter((it) => it.format === q.format)
  const kw = (q.q || '').trim().toLowerCase()
  if (kw) {
    list = list.filter((it) => {
      const name = String(it.name || '').toLowerCase()
      const norad = String(it.norad || '')
      return name.includes(kw) || norad.includes(kw) || String(it.format || '').toLowerCase().includes(kw)
    })
  }
  const total = list.length
  const size = Math.min(Math.max(q.size || 20, 1), 500)
  const totalPages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(q.page || 1, 1), totalPages)
  const slice = list.slice((page - 1) * size, page * size)
  return { total, page, size, totalPages, slice }
}

/** GET /cgi/ephemerides — 星历列表（支持分页 / 格式 / 关键词；DB 不可用回退 index.json） */
router.get('/ephemerides', async (req: Request, res: Response) => {
  const q = {
    format: req.query.format ? String(req.query.format) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    page: req.query.page != null ? Number(req.query.page) || 1 : undefined,
    size: req.query.size != null ? Number(req.query.size) || 20 : 20
  }
  const paged = q.page != null
  const wantKeys = req.query.keys === '1'

  if (await ephemDbUp()) {
    try {
      if (paged) {
        const { total, rows } = await listRowsDb(q)
        const size = Math.min(Math.max(q.size || 20, 1), 500)
        const data: Record<string, unknown> = {
          root: 'data/ephemerides',
          resolvedRoot: EPH_ROOT,
          generatedAt: new Date().toISOString(),
          source: 'db',
          items: rows.map(toListItem),
          total,
          page: Math.min(Math.max(q.page || 1, 1), Math.max(1, Math.ceil(total / size))),
          size,
          totalPages: Math.max(1, Math.ceil(total / size))
        }
        if (wantKeys) data.allKeys = await listAllKeysDb()
        res.json(ok(data))
        return
      }
      // legacy 全量模式（态势页内置样本通道）：上限 5000 防超大响应
      const rows = await listAllRowsDb(5000)
      res.json(
        ok({
          root: 'data/ephemerides',
          resolvedRoot: EPH_ROOT,
          generatedAt: new Date().toISOString(),
          source: 'db',
          items: rows.map(toListItem),
          truncated: rows.length >= 5000
        })
      )
      return
    } catch (e) {
      console.error('[ephem] db list failed, fallback to index.json:', (e as Error).message)
    }
  }

  const idx = readIndexFile()
  if (!idx) {
    res.status(404).json(fail(404, `星历目录未初始化：${EPH_ROOT}`))
    return
  }
  if (paged) {
    const p = pagedFromIndex(idx.items, q)
    res.json(
      ok({
        root: 'data/ephemerides',
        resolvedRoot: EPH_ROOT,
        generatedAt: idx.generatedAt,
        source: 'file',
        items: p.slice,
        total: p.total,
        page: p.page,
        size: p.size,
        totalPages: p.totalPages,
        ...(wantKeys ? { allKeys: idx.items.map((it) => `${it.norad}|${it.format}`) } : {})
      })
    )
    return
  }
  res.json(
    ok({
      root: 'data/ephemerides',
      resolvedRoot: EPH_ROOT,
      generatedAt: idx.generatedAt,
      source: 'file',
      items: idx.items
    })
  )
})

/**
 * GET /cgi/ephemerides/file?path=itc/FOO.txt.gz
 * Returns gunzipped text (Content-Type: text/plain) for preview / situation ingest.
 * Optional ?download=1 keeps Content-Disposition attachment of the .gz.
 */
router.get('/ephemerides/file', (req: Request, res: Response) => {
  const rel = String(req.query.path || '')
  const full = safeResolve(rel)
  if (!full || !fs.existsSync(full)) {
    res.status(404).json(fail(404, '文件不存在'))
    return
  }
  try {
    const buf = fs.readFileSync(full)
    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`)
      res.send(buf)
      return
    }
    const text = full.toLowerCase().endsWith('.gz')
      ? zlib.gunzipSync(buf).toString('utf8')
      : buf.toString('utf8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Ephemeris-Path', rel.replace(/\\/g, '/'))
    res.send(text)
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取星历文件失败'))
  }
})

/** GET /cgi/ephemerides/meta/:id — one row by id（DB 优先，回退 index.json） */
router.get('/ephemerides/meta/:id', async (req: Request, res: Response) => {
  if (await ephemDbUp()) {
    try {
      const row = await getRowDb(req.params.id)
      if (row) {
        res.json(ok(toListItem(row)))
        return
      }
    } catch {
      /* 回退 index.json */
    }
  }
  const idx = readIndexFile()
  const hit = idx?.items.find((it) => it.id === req.params.id)
  if (!hit) {
    res.status(404).json(fail(404, '未找到该星历'))
    return
  }
  res.json(ok(hit))
})

/**
 * POST /cgi/ephemerides/upload?name=<原始文件名>
 * 单文件原始字节流上传（前端逐文件顺序上传以展示进度），服务端识别格式 → 分片落盘 → 解析入库。
 */
router.post(
  '/ephemerides/upload',
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  expressRaw12mb,
  async (req: Request, res: Response) => {
    const name = String(req.query.name || '')
    const buf = req.body as Buffer
    if (!name || !buf?.length) {
      res.status(400).json(fail(400, '缺少文件名或文件内容'))
      return
    }
    // Epic I 计量全量：登录组织受 ephem_upload_day 生效限额约束（匿名上传不计量，保持历史行为）
    const authOrgId = tryAuthOrgId(req)
    if (authOrgId !== null) {
      const org = await findOrgById(authOrgId)
      if (org) {
        const exceeded = await quotaExceeded('ephem_upload_day', org)
        if (exceeded) {
          res.status(exceeded.status).json(exceeded.body)
          return
        }
      }
    }
    try {
      const r = await ingestUploadFile(name, buf, tryAuthName(req))
      res.json(ok(r))
    } catch (e) {
      res.status(400).json(fail(400, (e as Error).message || '上传入库失败'))
    }
  }
)

/** POST /cgi/ephemerides/rebuild?force=1 — 扫描 data/ephemerides 入库并导出 index.json；force 清表全量重解析 */
router.post('/ephemerides/rebuild', async (req: Request, res: Response) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true'
    const r = await scanAndIngest({ exportJson: true, force })
    res.json(ok(r))
  } catch (e) {
    res.status(503).json(fail(503, (e as Error).message || '扫描入库失败'))
  }
})

/* --------------------- G1 星历版本归档 --------------------- */

/**
 * GET /cgi/ephemerides/versions?norad=&format=&page=&size=&includeDeleted=1
 * 版本历史分页（append 账本；默认只列未软删，includeDeleted=1 连同软删行一并返回）
 */
router.get('/ephemerides/versions', async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const size = Math.min(Math.max(Number(req.query.size) || 20, 1), 200)
    const page = Math.max(Number(req.query.page) || 1, 1)
    const { total, rows } = await listVersionsDb({
      norad: req.query.norad ? String(req.query.norad) : undefined,
      format: req.query.format ? String(req.query.format) : undefined,
      page,
      size,
      includeDeleted: req.query.includeDeleted === '1' || req.query.includeDeleted === 'true'
    })
    res.json(
      ok({
        items: rows,
        total,
        page,
        size,
        totalPages: Math.max(1, Math.ceil(total / size))
      })
    )
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '查询版本历史失败'))
  }
})

/** GET /cgi/ephemerides/versions/:id/content — 按版本回放星历全文（gunzip 文本，审计/比对用） */
router.get('/ephemerides/versions/:id/content', async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const ver = await getEphemerisVersionDb(Number(req.params.id) || 0)
    if (!ver) {
      res.status(404).json(fail(404, '版本不存在'))
      return
    }
    const full = safeResolve(ver.file)
    if (!full || !fs.existsSync(full)) {
      res.status(404).json(fail(404, '版本文件缺失'))
      return
    }
    const buf = fs.readFileSync(full)
    const text = full.toLowerCase().endsWith('.gz')
      ? zlib.gunzipSync(buf).toString('utf8')
      : buf.toString('utf8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Ephem-Version-Sha', ver.sha256)
    res.send(text)
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取版本文件失败'))
  }
})

/** DELETE /cgi/ephemerides/versions/:id — 软删版本（行与文件均保留，仅标记 deleted_at；需登录） */
router.delete('/ephemerides/versions/:id', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const id = Number(req.params.id) || 0
    const done = await softDeleteVersionDb(id)
    if (!done) {
      res.status(404).json(fail(404, '版本不存在或已删除'))
      return
    }
    res.json(ok({ id, deletedAt: Date.now() }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '软删版本失败'))
  }
})

/* --------------------- G2 精度对比 --------------------- */

/**
 * GET /cgi/ephemerides/accuracy/sources?norad=38117
 * 列出该 NORAD 可参与精度对比的源：OCM 星历（ephemeris）+ 系统 TLE + AOE 历算。
 */
router.get('/ephemerides/accuracy/sources', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：精度对比需要 MySQL'))
    return
  }
  try {
    const sources = await listAccuracySources(String(req.query.norad || ''))
    res.json(ok({ norad: String(req.query.norad || ''), sources }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '查询对比源失败'))
  }
})

/**
 * POST /cgi/ephemerides/accuracy/compare
 * body: { norad, a: {kind:'ocm'|'tle'|'aoe', id?}, b: {...}, maxPoints? }
 * 重叠时段 RTN 残差：radial/along/cross RMS + 总 RMS + 最大/平均偏差 + 抽稀残差点列。
 */
router.post('/ephemerides/accuracy/compare', requireAuth, async (req: Request, res: Response) => {
  // Epic I 功能开关：accuracy_compare_enabled 关闭的组织拒绝使用精度对比
  const authOrg = (req as import('express').Request & { auth?: { org?: { id: number } | null } }).auth?.org
  if (!(await isOrgFlagEnabled(authOrg?.id ?? null, 'accuracy_compare_enabled'))) {
    res.status(403).json(fail(403, '该功能未对您的组织开放（精度对比）'))
    return
  }
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：精度对比需要 MySQL'))
    return
  }
  const body = req.body as {
    norad?: string | number
    a?: { kind?: string; id?: string }
    b?: { kind?: string; id?: string }
    maxPoints?: number
  }
  const norad = String(body.norad || '')
  if (!/^\d{1,6}$/.test(norad)) {
    res.status(400).json(fail(400, '缺少有效的 NORAD 编号'))
    return
  }
  const kinds = ['ocm', 'tle', 'aoe']
  const descOf = (d?: { kind?: string; id?: string }) => {
    const kind = kinds.includes(String(d?.kind)) ? (d!.kind as 'ocm' | 'tle' | 'aoe') : null
    return kind ? { kind, id: d?.id } : null
  }
  const a = descOf(body.a)
  const b = descOf(body.b)
  if (!a || !b) {
    res.status(400).json(fail(400, '请选择两个对比源（kind = ocm | tle | aoe）'))
    return
  }
  try {
    const r = await compareSources(norad, a, b, Number(body.maxPoints) || 240)
    res.json(ok(r))
  } catch (e) {
    res.status(422).json(fail(422, (e as Error).message || '精度对比计算失败'))
  }
})

/** express.raw 中间件（12MB 与前端单文件上限一致） */
function expressRaw12mb(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: '*/*', limit: '12mb', inflate: true })(req, res, next)
}

export default router
