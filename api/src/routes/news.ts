/**
 * 太空安全资讯 API（docs/public-api.md 第 6 节）。
 * - 列表/详情读本地 news 表，由 UTC 00:00 日切任务维护，最多 8 条倒序；
 * - 详情缺失「对中国的影响分析」时按单条回源 LLM 生成并回写；
 * - 首次部署/库被清空时后台触发一次日切，本次先返回空列表。
 */
import { Router, type Response as ExpressResponse } from 'express'
import { config } from '../config.js'
import { ok, fail } from '../utils/response.js'
import { generateNewsInsight, SUMMARY_MIN } from '../services/newsAnalysis.js'
import { getNewsListMeta, getNewsRow, listNews, updateNewsInsight } from '../db/newsDb.js'
import { runNewsRefresh, isNewsRefreshRunning } from '../jobs/newsRefresh.js'

const router = Router()

/** 资讯 id 为上游 UUID；限制字符集，避免拼接出越权路径 */
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/

function notConfigured(res: ExpressResponse): void {
  res.status(503).json(fail(503, '资讯数据源未配置'))
}

router.get('/', async (req, res) => {
  if (!config.launchApi.key) return notConfigured(res)
  const raw = Number(req.query.limit)
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 20) : 8
  try {
    const [rows, meta] = await Promise.all([listNews(limit), getNewsListMeta()])
    if (!rows.length && !isNewsRefreshRunning()) {
      void runNewsRefresh('on-demand').catch((e) => {
        console.error('[news] on-demand refresh failed:', (e as Error).message)
      })
    }
    const items = rows.map((r) => JSON.parse(r.data) as Record<string, unknown>)
    res.json(
      ok({
        generated_at: meta?.generated_at ?? null,
        plan_date: meta?.plan_date ?? '',
        window_days: meta?.window_days ?? 0,
        count: items.length,
        items
      })
    )
  } catch (e) {
    console.error('[news] list failed:', e)
    res.status(500).json(fail(500, '资讯数据读取失败'))
  }
})

router.get('/:id', async (req, res) => {
  if (!config.launchApi.key) return notConfigured(res)
  const id = String(req.params.id || '').trim()
  if (!ID_RE.test(id)) {
    res.status(400).json(fail(400, '资讯 ID 不合法'))
    return
  }
  try {
    const row = await getNewsRow(id)
    if (!row) {
      res.status(404).json(fail(404, '未找到该资讯'))
      return
    }
    const item = JSON.parse(row.data) as {
      title?: { en?: string; zh?: string }
      summary?: { en?: string; zh?: string }
      media?: { en?: string; zh?: string }
    }
    let impact = row.impact_zh
    const summaryZh = item.summary?.zh?.trim() || ''
    // 影响分析缺失或摘要仍是旧版短句时，按需补生成一次
    if (!impact || [...summaryZh].length < SUMMARY_MIN) {
      const pick = (p?: { en?: string; zh?: string }) => p?.zh?.trim() || p?.en?.trim() || ''
      try {
        const insight = await generateNewsInsight({
          title: pick(item.title),
          summary: summaryZh || pick(item.summary),
          media: pick(item.media)
        })
        if (insight) {
          if (insight.summary) item.summary = { ...(item.summary || {}), zh: insight.summary }
          impact = insight.analysis || impact
          await updateNewsInsight(id, JSON.stringify(item), impact)
        }
      } catch (e) {
        console.warn('[news] insight generation failed:', (e as Error).message)
      }
    }
    res.json(ok({ ...item, impact_zh: impact }))
  } catch (e) {
    console.error('[news] detail failed:', e)
    res.status(500).json(fail(500, '资讯数据读取失败'))
  }
})

export default router
