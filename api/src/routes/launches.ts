/**
 * 发射预报 API（docs/public-api.md）。
 * - 列表/详情读本地 launches 表，由 UTC 00:00 日切任务维护，页面打开不再触发抓取；
 * - 详情本地缺失时回源补取一次并落库（兼容旧链接 / 窗口外任务）；
 * - 仿真图 SVG 仍走代理，服务端注入 X-API-Key 并透传 Content-Type / ETag。
 */
import crypto from 'node:crypto'
import { Router, type Response as ExpressResponse } from 'express'
import { config } from '../config.js'
import { ok, fail } from '../utils/response.js'
import { translateLaunchItem } from '../services/launchTranslate.js'
import {
  listLaunches,
  getLaunchRow,
  upsertLaunch,
  getLaunchListMeta
} from '../db/launchDb.js'
import {
  fetchLaunchItem,
  runLaunchRefresh,
  isLaunchRefreshRunning,
  UpstreamError
} from '../jobs/launchRefresh.js'

const router = Router()

const SVG_TTL = 86_400_000
const TIMEOUT_MS = 12_000
/** ll2_id 形如 ll2-abc123；限制字符集，避免拼接出越权路径 */
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/

/** 仿真图按 id 缓存（图片体积大，且不随日切变化） */
const svgCache = new Map<string, { at: number; body: string; etag: string }>()

function readSvgCache(id: string): { body: string; etag: string } | null {
  const hit = svgCache.get(id)
  if (!hit) return null
  if (Date.now() - hit.at > SVG_TTL) {
    svgCache.delete(id)
    return null
  }
  return hit
}

function writeSvgCache(id: string, body: string, etag: string): void {
  if (svgCache.size > 50) svgCache.clear()
  svgCache.set(id, { at: Date.now(), body, etag })
}

async function callUpstream(path: string): Promise<Response> {
  const base = config.launchApi.baseUrl.replace(/\/+$/, '')
  return fetch(`${base}/api/v1/open${path}`, {
    headers: { 'X-API-Key': config.launchApi.key, Accept: 'image/svg+xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
}

function failUpstream(res: ExpressResponse, status: number): void {
  if (status === 429) res.status(429).json(fail(429, '发射数据源限流，请稍后重试'))
  else if (status === 404) res.status(404).json(fail(404, '未找到该发射任务'))
  else if (status === 401 || status === 403) res.status(503).json(fail(503, '发射数据源鉴权失败'))
  else res.status(502).json(fail(502, '发射数据源暂不可用'))
}

function notConfigured(res: ExpressResponse): void {
  res.status(503).json(fail(503, '发射数据源未配置'))
}

function parseId(raw: string): string | null {
  const id = String(raw || '').trim()
  return ID_RE.test(id) ? id : null
}

/** 上游 SVG 会附带「落区」多边形（琥珀色虚线），产品要求不展示，代理时剔除 */
const DROP_ZONE_RE = /<polygon[^>]*fill="#F59E0B"[^>]*\/>\s*/g

function stripDropZone(svg: string): string {
  return svg.replace(DROP_ZONE_RE, '')
}

/** 5 日窗口发射列表：直接读日切结果 */
router.get('/', async (_req, res) => {
  if (!config.launchApi.key) return notConfigured(res)
  try {
    const [rows, meta] = await Promise.all([listLaunches(), getLaunchListMeta()])
    // 首次部署/库被清空时的兜底：后台补一次，本次先返回空列表
    if (!rows.length && !isLaunchRefreshRunning()) {
      void runLaunchRefresh('on-demand').catch((e) => {
        console.error('[launches] on-demand refresh failed:', (e as Error).message)
      })
    }
    const items = rows.map((r) => JSON.parse(r.data) as Record<string, unknown>)
    res.json(
      ok({
        generated_at: meta?.generated_at ?? null,
        window: meta?.window ?? null,
        count: items.length,
        disclaimer: meta?.disclaimer ?? '',
        items
      })
    )
  } catch (e) {
    console.error('[launches] list failed:', e)
    res.status(500).json(fail(500, '发射数据读取失败'))
  }
})

/** 2D 轨迹仿真图（SVG 透传，浏览器 <img> 可直接引用） */
router.get('/:id/map.svg', async (req, res) => {
  if (!config.launchApi.key) return notConfigured(res)
  const id = parseId(req.params.id)
  if (!id) {
    res.status(400).json(fail(400, '发射任务 ID 不合法'))
    return
  }
  const hit = readSvgCache(id)
  if (hit) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    if (hit.etag) res.setHeader('ETag', hit.etag)
    if (hit.etag && req.headers['if-none-match'] === hit.etag) {
      res.status(304).end()
      return
    }
    res.send(hit.body)
    return
  }
  try {
    const r = await callUpstream(`/launches/${encodeURIComponent(id)}/map.svg`)
    if (!r.ok) return failUpstream(res, r.status)
    const svg = stripDropZone(await r.text())
    const etag = r.headers.get('etag') || ''
    writeSvgCache(id, svg, etag)
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    if (etag) res.setHeader('ETag', etag)
    res.send(svg)
  } catch (e) {
    console.error('[launches] map.svg failed:', e)
    res.status(502).json(fail(502, '发射数据源暂不可用'))
  }
})

/** 单条发射详情：本地优先，缺失时回源补取并落库 */
router.get('/:id', async (req, res) => {
  if (!config.launchApi.key) return notConfigured(res)
  const id = parseId(req.params.id)
  if (!id) {
    res.status(400).json(fail(400, '发射任务 ID 不合法'))
    return
  }
  try {
    const row = await getLaunchRow(id)
    if (row) {
      res.json(ok(JSON.parse(row.data)))
      return
    }
    const data = await fetchLaunchItem(id)
    await translateLaunchItem(data)
    const net = typeof data.net === 'string' ? data.net : ''
    const hash = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex')
    await upsertLaunch({ id, net, hash, data: JSON.stringify(data) })
    res.json(ok(data))
  } catch (e) {
    if (e instanceof UpstreamError) return failUpstream(res, e.status)
    console.error('[launches] detail failed:', e)
    res.status(502).json(fail(502, '发射数据源暂不可用'))
  }
})

export default router
