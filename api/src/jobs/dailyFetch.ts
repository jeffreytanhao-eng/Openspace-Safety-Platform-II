/**
 * 系统日更 job（Epic C1）：按顺序采集 Space-Track GP / CDM / AOE 三个源，
 * 每源独立批次（orbital_fetch_batches），失败不阻断后续源。
 *
 * 调度：DAILY_FETCH_CRON（形如 'M H * * *'，UTC，默认 '0 6 * * *' 每日 06:00）。
 * 手动触发：POST /cgi/jobs/daily-fetch（超管）。
 */
import { config } from '../config.js'
import { ensureFetchSchema, startBatch, finishBatch, type FetchSource } from '../db/fetchDb.js'
import { runGpIngest, runCdmIngest } from '../services/ingestSpaceTrack.js'
import { runAoeIngest } from '../services/ingestAoe.js'
import type { IngestCounts } from '../services/ingestSpaceTrack.js'

let running = false
export function isDailyFetchRunning(): boolean {
  return running
}

/** 跑一轮日更（串行三源）；返回每源的批次结果 */
export async function runDailyFetch(triggeredBy = 'cron'): Promise<{
  results: Record<string, { batchId: number; status: 'success' | 'failed'; message: string } & Partial<IngestCounts>>
}> {
  if (running) throw new Error('日更任务正在运行中')
  if (!(await ensureFetchSchema())) throw new Error('数据库不可用（批次表未就绪）')

  running = true
  const results: Record<
    string,
    { batchId: number; status: 'success' | 'failed'; message: string } & Partial<IngestCounts>
  > = {}
  try {
    const jobs: Array<{ source: FetchSource; run: (batchId: number) => Promise<IngestCounts> }> = [
      { source: 'spacetrack_gp', run: runGpIngest },
      { source: 'spacetrack_cdm', run: runCdmIngest },
      { source: 'aoe', run: runAoeIngest }
    ]
    for (const job of jobs) {
      const batchId = await startBatch(job.source, triggeredBy)
      try {
        const counts = await job.run(batchId)
        await finishBatch(batchId, 'success', counts)
        results[job.source] = { batchId, status: 'success', message: 'ok', ...counts }
        console.log(
          `[daily-fetch] ${job.source}: total=${counts.total} inserted=${counts.inserted} updated=${counts.updated} skipped=${counts.skipped}`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await finishBatch(batchId, 'failed', { total: 0, inserted: 0, updated: 0, skipped: 0 }, msg)
        results[job.source] = { batchId, status: 'failed', message: msg }
        console.error(`[daily-fetch] ${job.source} failed: ${msg}`)
      }
    }
    return { results }
  } finally {
    running = false
  }
}

/* ------------------------------ 简单每日调度 ------------------------------ */

let lastRunDate = '' // 'YYYY-MM-DD'（UTC），防同日重复触发
let timer: ReturnType<typeof setInterval> | null = null

/** 解析 'M H * * *'（仅支持每日固定时刻）；非法回退默认值 */
export function parseDailyCron(expr: string): { minute: number; hour: number } | null {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expr.trim())
  if (!m) return null
  const minute = Number(m[1])
  const hour = Number(m[2])
  if (minute > 59 || hour > 23) return null
  return { minute, hour }
}

/** 启动每日调度器（每 30s 对表一次 UTC 时刻） */
export function startDailyFetchScheduler(): void {
  if (timer) return
  const cron = config.dailyFetchCron
  const at = parseDailyCron(cron)
  if (!at) {
    console.warn(`[daily-fetch] DAILY_FETCH_CRON '${cron}' 无法解析（仅支持 'M H * * *'），调度器未启动；仍可手动触发`)
    return
  }
  if (!config.spaceTrack.user || !config.spaceTrack.pass) {
    console.warn('[daily-fetch] SPACETRACK_USER/PASS 未配置，到点后 GP/CDM 将失败（AOE 不受影响）')
  }
  timer = setInterval(() => {
    const now = new Date()
    const key = now.toISOString().slice(0, 10)
    if (now.getUTCHours() === at.hour && now.getUTCMinutes() === at.minute && lastRunDate !== key) {
      lastRunDate = key
      console.log(`[daily-fetch] cron 触发（UTC ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}）`)
      void runDailyFetch('cron').catch((e) => {
        console.error('[daily-fetch] cron run failed:', (e as Error).message)
      })
    }
  }, 30_000)
  console.log(`[daily-fetch] scheduler started (UTC ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')} daily)`)
}
