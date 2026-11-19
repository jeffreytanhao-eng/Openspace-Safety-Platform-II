/**
 * 发射预报日切任务（UTC 00:00）：
 *  - 每天从外部接口拉取一次 5 日窗口，写入 launches 表；
 *  - 次日只处理有变动的部分：新增、改期（内容哈希变化）、已完成/取消（本次未出现则删除）；
 *  - 变动记录先补齐中文（LLM 翻译）再落库，页面直接读库，不再随打开触发抓取。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { translateLaunchItems } from '../services/launchTranslate.js'
import {
  ensureLaunchSchema,
  getLaunchHashes,
  getLaunchListMeta,
  upsertLaunch,
  deleteLaunchesNotIn,
  saveLaunchListMeta
} from '../db/launchDb.js'

const WINDOW_DAYS = 5
const TIMEOUT_MS = 20_000
/** 缺数据时启动补抓的时效阈值（避免每次重启都重复抓） */
const STALE_MS = 20 * 60 * 60 * 1000

let running = false
let timer: ReturnType<typeof setInterval> | null = null
let lastRunDate = ''

export function isLaunchRefreshRunning(): boolean {
  return running
}

/** 上游返回非 2xx 时携带状态码，便于路由层映射错误文案 */
export class UpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`)
  }
}

async function fetchUpstream<T>(path: string): Promise<T> {
  const base = config.launchApi.baseUrl.replace(/\/+$/, '')
  const r = await fetch(`${base}/api/v1/open${path}`, {
    headers: { 'X-API-Key': config.launchApi.key, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!r.ok) throw new UpstreamError(r.status)
  return (await r.json()) as T
}

interface UpstreamList {
  window?: unknown
  disclaimer?: string
  items?: Array<Record<string, unknown>>
}

export interface LaunchRefreshResult {
  added: number
  updated: number
  unchanged: number
  removed: number
  total: number
}

/** 单条发射回源（详情页兜底：本地没有时按 id 现取） */
export async function fetchLaunchItem(id: string): Promise<Record<string, unknown>> {
  return fetchUpstream<Record<string, unknown>>(`/launches/${encodeURIComponent(id)}`)
}

export async function runLaunchRefresh(triggeredBy = 'cron'): Promise<LaunchRefreshResult> {
  if (running) throw new Error('发射预报日切任务正在运行中')
  if (!config.launchApi.key) throw new Error('发射数据源未配置')
  if (!(await ensureLaunchSchema())) throw new Error('数据库不可用')

  running = true
  try {
    const data = await fetchUpstream<UpstreamList>(`/launches?window_days=${WINDOW_DAYS}`)
    const items = Array.isArray(data.items) ? data.items : []
    const prev = await getLaunchHashes()
    const keep: string[] = []
    let added = 0
    let updated = 0
    let unchanged = 0

    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : ''
      if (!id) continue
      // 哈希基于上游原始内容：翻译措辞变化不算业务变动
      const hash = crypto.createHash('sha1').update(JSON.stringify(item)).digest('hex')
      keep.push(id)
      if (prev.get(id) === hash) {
        unchanged++
        continue
      }
      await translateLaunchItems([item])
      const net = typeof item.net === 'string' ? item.net : ''
      await upsertLaunch({ id, net, hash, data: JSON.stringify(item) })
      if (prev.has(id)) updated++
      else added++
    }

    const removed = await deleteLaunchesNotIn(keep)
    await saveLaunchListMeta({
      generated_at: new Date().toISOString(),
      window: data.window ?? null,
      disclaimer: data.disclaimer || ''
    })
    const result = { added, updated, unchanged, removed, total: keep.length }
    console.log(`[launch-refresh] ${triggeredBy} done:`, JSON.stringify(result))
    return result
  } finally {
    running = false
  }
}

/** 启动时若本地库为空或已超过 20 小时未更新，后台补一次 */
export async function refreshLaunchesIfStale(): Promise<void> {
  if (!config.launchApi.key || running) return
  if (!(await ensureLaunchSchema())) return
  const meta = await getLaunchListMeta()
  const at = meta ? Date.parse(meta.generated_at) : NaN
  if (Number.isFinite(at) && Date.now() - at < STALE_MS) return
  await runLaunchRefresh('startup')
}

/** 每天 UTC 00:00 触发一次（30s 轮询，按日期去重） */
export function startLaunchRefreshScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    const now = new Date()
    const key = now.toISOString().slice(0, 10)
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0 && lastRunDate !== key) {
      lastRunDate = key
      console.log('[launch-refresh] cron 触发（UTC 00:00）')
      void runLaunchRefresh('cron').catch((e) => {
        console.error('[launch-refresh] cron run failed:', (e as Error).message)
      })
    }
  }, 30_000)
  console.log('[launch-refresh] scheduler started (UTC 00:00 daily)')
}
