import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { ok, fail } from '../utils/response.js'

const router = Router()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Resolve data/ephemerides for local (repo) and Docker (/app/data). */
function resolveEphRoot(): string {
  const candidates = [
    process.env.EPH_DATA_DIR,
    path.resolve(process.cwd(), 'data/ephemerides'),
    path.resolve(process.cwd(), '../data/ephemerides'),
    // api/dist/routes → ../../data = /app/data (Docker) or api/../data
    path.resolve(__dirname, '../../data/ephemerides'),
    // api/src/routes → ../../../data = repo/data
    path.resolve(__dirname, '../../../data/ephemerides')
  ].filter(Boolean) as string[]

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.json'))) return c
  }
  return candidates[candidates.length - 1] || path.resolve(process.cwd(), 'data/ephemerides')
}

const EPH_ROOT = resolveEphRoot()

function safeResolve(rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) return null
  const full = path.resolve(EPH_ROOT, cleaned)
  if (!full.startsWith(EPH_ROOT)) return null
  return full
}

/** GET /cgi/ephemerides — list local ITC/OCM samples from index.json */
router.get('/ephemerides', (_req, res) => {
  const indexPath = path.join(EPH_ROOT, 'index.json')
  if (!fs.existsSync(indexPath)) {
    res.status(404).json(fail(404, `星历目录未初始化：${EPH_ROOT}`))
    return
  }
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      generatedAt?: string
      items: unknown[]
    }
    res.json(
      ok({
        root: 'data/ephemerides',
        resolvedRoot: EPH_ROOT,
        generatedAt: raw.generatedAt || null,
        items: raw.items || []
      })
    )
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取星历索引失败'))
  }
})

/**
 * GET /cgi/ephemerides/file?path=itc/FOO.txt.gz
 * Returns gunzipped text (Content-Type: text/plain) for preview / situation ingest.
 * Optional ?download=1 keeps Content-Disposition attachment of the .gz.
 */
router.get('/ephemerides/file', (req, res) => {
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

/** GET /cgi/ephemerides/meta/:id — one index row by id */
router.get('/ephemerides/meta/:id', (req, res) => {
  const indexPath = path.join(EPH_ROOT, 'index.json')
  if (!fs.existsSync(indexPath)) {
    res.status(404).json(fail(404, '星历索引不存在'))
    return
  }
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      items: { id: string }[]
    }
    const hit = (raw.items || []).find((it) => it.id === req.params.id)
    if (!hit) {
      res.status(404).json(fail(404, '未找到该星历'))
      return
    }
    res.json(ok(hit))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取失败'))
  }
})

export default router
