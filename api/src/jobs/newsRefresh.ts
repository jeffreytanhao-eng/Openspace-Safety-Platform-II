/**
 * 太空安全资讯日切任务（UTC 02:00，上游约 01:30 生成当日热点）：
 *  - 每天从外部接口 /api/v1/open/hotspots 拉取当日热点资讯，增量并入本地库；
 *  - 上游当日无数据时，每小时重试，最多 3 次（应对上游发布延迟）；
 *  - 新资讯按发布时间排在上层，历史资讯保留并顺延，始终只保留最新 8 条；
 *  - 无中文的标题/摘要/媒体用与发射相同的 LLM 翻译；
 *  - 新条目用 LLM 生成 100-150 字摘要与约 100 字影响分析并落库，页面只读库。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { translateTexts } from '../services/launchTranslate.js'
import { generateNewsInsights, SUMMARY_MIN, type NewsBrief } from '../services/newsAnalysis.js'
import {
  ensureNewsSchema,
  getNewsHashes,
  getNewsListMeta,
  upsertNews,
  pruneNews,
  saveNewsListMeta
} from '../db/newsDb.js'

/** 上游取数上限（去重/过期过滤由上游完成） */
const FETCH_LIMIT = 20
/** 总览卡片最多展示 8 条，库内也只保留最新 8 条（更早的顺延淘汰） */
const KEEP_LIMIT = 8
const TIMEOUT_MS = 20_000
/** 缺数据时启动补抓的时效阈值（避免每次重启都重复抓） */
const STALE_MS = 20 * 60 * 60 * 1000
/** 日切时刻（UTC）：晚于上游约 01:30 的当日热点生成时间 */
const CRON_HOUR_UTC = 2
/** 上游当日暂无数据时的小时级重试间隔与次数 */
const RETRY_MS = 60 * 60 * 1000
const MAX_RETRY = 3
const CJK_RE = /[\u4e00-\u9fa5]/

let running = false
let timer: ReturnType<typeof setInterval> | null = null
let lastRunDate = ''

export function isNewsRefreshRunning(): boolean {
  return running
}

interface RawNewsText {
  en?: string
  zh?: string
}

interface RawNewsItem {
  id?: unknown
  title?: RawNewsText
  published_at?: unknown
  published_date?: unknown
  media?: RawNewsText
  summary?: RawNewsText
  url?: unknown
}

interface UpstreamNewsList {
  plan_date?: unknown
  window_days?: unknown
  generated_at?: unknown
  items?: RawNewsItem[]
}

interface NormalizedNews {
  id: string
  /** 规范化后的 ISO UTC（如 2026-11-19T06:41:35Z） */
  publishedAt: string
  ts: number
  raw: RawNewsItem
}

export interface NewsRefreshResult {
  added: number
  updated: number
  unchanged: number
  /** 超出 8 条而被淘汰的旧资讯数 */
  removed: number
  /** 本次上游返回条数 */
  fetched: number
  /** 库内保留上限 */
  kept: number
}

function normIsoUtc(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 只保留卡片/详情需要的字段，脏数据（缺 id/时间/标题/链接）直接丢弃 */
function normalize(item: RawNewsItem): NormalizedNews | null {
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  const publishedAt = normIsoUtc(item.published_at)
  const url = typeof item.url === 'string' ? item.url.trim() : ''
  const titleEn = typeof item.title?.en === 'string' ? item.title.en.trim() : ''
  const titleZh = typeof item.title?.zh === 'string' ? item.title.zh.trim() : ''
  if (!id || !publishedAt || !url || (!titleEn && !titleZh)) return null
  return { id, publishedAt, ts: Date.parse(publishedAt), raw: item }
}

function pairText(pair: RawNewsText | undefined, lang: 'en' | 'zh'): string {
  const v = pair ? pair[lang] : ''
  return typeof v === 'string' ? v.trim() : ''
}

/** 标题/摘要/媒体任一英文有值且中文缺失（或中文里没有汉字）时需要翻译 */
function needsZh(pair: RawNewsText | undefined): boolean {
  if (!pair) return false
  const en = pairText(pair, 'en')
  if (!en) return false
  const zh = pairText(pair, 'zh')
  return !zh || !CJK_RE.test(zh)
}

function applyTranslations(item: RawNewsItem, map: Map<string, string>): void {
  const fields: Array<'title' | 'summary' | 'media'> = ['title', 'summary', 'media']
  for (const field of fields) {
    const pair = item[field]
    if (!pair || !needsZh(pair)) continue
    const en = pairText(pair, 'en')
    const zh = map.get(en)
    if (zh) pair.zh = zh
  }
}

/** 已入库的摘要中文字数：低于 SUMMARY_MIN 说明是旧版短文，需要重新扩写 */
function storedSummaryLength(data: string): number {
  try {
    const parsed = JSON.parse(data) as { summary?: RawNewsText }
    return [...pairText(parsed.summary, 'zh')].length
  } catch {
    return 0
  }
}

async function fetchUpstream(): Promise<UpstreamNewsList> {
  const base = config.launchApi.baseUrl.replace(/\/+$/, '')
  let r: Response
  try {
    r = await fetch(`${base}/api/v1/open/hotspots?limit=${FETCH_LIMIT}`, {
      headers: { 'X-API-Key': config.launchApi.key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`资讯数据源连接失败：${(e as Error).message}`)
  }
  if (r.status === 403) throw new Error('资讯数据源拒绝访问（服务器出口 IP 未加入白名单）')
  if (r.status === 401) throw new Error('资讯数据源鉴权失败')
  if (!r.ok) throw new Error(`资讯数据源暂不可用（HTTP ${r.status}）`)
  return (await r.json()) as UpstreamNewsList
}

export async function runNewsRefresh(triggeredBy = 'cron'): Promise<NewsRefreshResult> {
  if (running) throw new Error('资讯日切任务正在运行中')
  if (!config.launchApi.key) throw new Error('资讯数据源未配置')
  if (!(await ensureNewsSchema())) throw new Error('数据库不可用')

  running = true
  try {
    const data = await fetchUpstream()
    const items = (Array.isArray(data.items) ? data.items : [])
      .map(normalize)
      .filter((x): x is NormalizedNews => !!x)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, FETCH_LIMIT)

    const prev = await getNewsHashes()
    const pending: Array<{ item: NormalizedNews; hash: string }> = []
    let unchanged = 0
    let added = 0
    let updated = 0

    for (const item of items) {
      // 哈希基于上游原始内容：换模型/措辞变化不算业务变动
      const hash = crypto.createHash('sha1').update(JSON.stringify(item.raw)).digest('hex')
      const old = prev.get(item.id)
      if (
        old &&
        old.hash === hash &&
        old.impact_zh.trim() &&
        storedSummaryLength(old.data) >= SUMMARY_MIN
      ) {
        unchanged++
        continue
      }
      pending.push({ item, hash })
      if (old) updated++
      else added++
    }

    // 1) 批量补齐中文（同一份 LLM 配置与缓存）
    const texts: string[] = []
    for (const { item } of pending) {
      for (const field of ['title', 'summary', 'media'] as const) {
        const pair = item.raw[field]
        if (pair && needsZh(pair)) {
          const en = pairText(pair, 'en')
          if (en) texts.push(en)
        }
      }
    }
    if (texts.length) {
      const map = await translateTexts(texts)
      for (const { item } of pending) applyTranslations(item.raw, map)
    }

    // 2) 批量生成 100-150 字摘要与约 100 字影响分析
    const briefs: NewsBrief[] = pending.map(({ item }) => ({
      title: pairText(item.raw.title, 'zh') || pairText(item.raw.title, 'en'),
      summary: pairText(item.raw.summary, 'zh') || pairText(item.raw.summary, 'en'),
      media: pairText(item.raw.media, 'zh') || pairText(item.raw.media, 'en')
    }))
    const insights = briefs.length
      ? await generateNewsInsights(briefs)
      : new Map<number, { summary: string; analysis: string }>()

    // 3) 落库（翻译、摘要扩写与分析均已就绪）
    for (let i = 0; i < pending.length; i++) {
      const { item, hash } = pending[i]
      const insight = insights.get(i)
      if (insight?.summary) {
        // 扩写后的摘要覆盖机器直译的短句（卡片单行省略，详情展示全文）
        item.raw.summary = { ...(item.raw.summary || {}), zh: insight.summary }
      }
      await upsertNews({
        id: item.id,
        publishedAt: item.publishedAt,
        hash,
        data: JSON.stringify(item.raw),
        impactZh: insight?.analysis || prev.get(item.id)?.impact_zh || ''
      })
    }

    // 增量合并：历史资讯保留，仅淘汰排序后第 8 条以外的旧条目
    const removed = await pruneNews(KEEP_LIMIT)
    await saveNewsListMeta({
      generated_at: new Date().toISOString(),
      plan_date: typeof data.plan_date === 'string' ? data.plan_date : '',
      window_days: Number(data.window_days) || 0
    })
    const result = { added, updated, unchanged, removed, fetched: items.length, kept: KEEP_LIMIT }
    console.log(`[news-refresh] ${triggeredBy} done:`, JSON.stringify(result))
    return result
  } finally {
    running = false
  }
}

/** 启动时若本地库为空或已超过 20 小时未更新，后台补一次 */
export async function refreshNewsIfStale(): Promise<void> {
  if (!config.launchApi.key || running) return
  if (!(await ensureNewsSchema())) return
  const meta = await getNewsListMeta()
  const at = meta ? Date.parse(meta.generated_at) : NaN
  if (Number.isFinite(at) && Date.now() - at < STALE_MS) return
  await runNewsRefresh('startup')
}

/** 上游当日无数据时，每小时重试，最多 MAX_RETRY 次 */
function scheduleNewsRetry(attempt: number): void {
  if (attempt > MAX_RETRY) return
  setTimeout(() => {
    if (running) return
    console.log(`[news-refresh] retry ${attempt}/${MAX_RETRY}`)
    void runNewsRefresh(`retry-${attempt}`)
      .then((r) => {
        if (r.fetched === 0) scheduleNewsRetry(attempt + 1)
      })
      .catch((e) => {
        console.error('[news-refresh] retry failed:', (e as Error).message)
        scheduleNewsRetry(attempt + 1)
      })
  }, RETRY_MS)
}

/** 每天 UTC 02:00 触发一次（30s 轮询，按日期去重）；当日无数据则小时级重试 */
export function startNewsRefreshScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    const now = new Date()
    const key = now.toISOString().slice(0, 10)
    if (now.getUTCHours() === CRON_HOUR_UTC && now.getUTCMinutes() === 0 && lastRunDate !== key) {
      lastRunDate = key
      console.log(`[news-refresh] cron 触发（UTC 0${CRON_HOUR_UTC}:00）`)
      void runNewsRefresh('cron')
        .then((r) => {
          if (r.fetched === 0) scheduleNewsRetry(1)
        })
        .catch((e) => {
          console.error('[news-refresh] cron run failed:', (e as Error).message)
          scheduleNewsRetry(1)
        })
    }
  }, 30_000)
  console.log(`[news-refresh] scheduler started (UTC 0${CRON_HOUR_UTC}:00 daily)`)
}
