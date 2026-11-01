import express, { Router, type Request, type Response, type NextFunction } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ok, fail } from '../utils/response.js'
import {
  ephemDbUp,
  listRowsDb,
  listAllRowsDb,
  getRowDb,
  listAllKeysDb,
  toListItem
} from '../ephem/ephemDb.js'
import { EPH_ROOT, scanAndIngest, ingestUploadFile } from '../ephem/ingest.js'

const router = Router()

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
    try {
      const r = await ingestUploadFile(name, buf)
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

/** express.raw 中间件（12MB 与前端单文件上限一致） */
function expressRaw12mb(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: '*/*', limit: '12mb', inflate: true })(req, res, next)
}

export default router
