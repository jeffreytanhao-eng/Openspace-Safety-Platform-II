/**
 * StarLink 公开星历拉取：
 * - 清单：https://api.starlink.com/public-files/ephemerides/MANIFEST.txt（每行一个 ITC/MEME 文件名）
 * - ITC ：同域直接下载清单中的 MEME_…txt
 * - OCM ：按清单中的 STARLINK-<编号> 拼 https://api.starlink.com/public-files/ephemerides/STARLINK-<编号>.txt
 * 下载后统一交给 ingestUploadFile 落盘到 data/ephemerides/{ocm,itc}/<分片>/ 并入库。
 *
 * 手动：POST /cgi/jobs/starlink-pull/run（异步启动，页面轮询状态）
 * 自动：配置 enabled=true 时，UTC 每日 00:00 执行一次
 *
 * 下载：对 GCS gzip 对象分段并行拉取（见 starlinkDownload.ts），再与入库流水线并行。
 */
import { ephemDbUp } from '../ephem/ephemDb.js'
import { ingestUploadFile } from '../ephem/ingest.js'
import {
  ensureStarlinkSchema,
  getStarlinkPullConfig,
  saveStarlinkPullStatus,
  type StarlinkFormat,
  type StarlinkPullStatus
} from '../db/starlinkDb.js'
import {
  FILE_CONCURRENCY,
  downloadPublicFile,
  looksLikeHtml
} from './starlinkDownload.js'

const BASE = 'https://api.starlink.com/public-files/ephemerides'
const MANIFEST_URL = `${BASE}/MANIFEST.txt`

let running = false
export function isStarlinkPullRunning(): boolean {
  return running
}

interface PullTarget {
  /** 下载文件名 */
  file: string
  /** 目标名（STARLINK-xxxxx，仅 OCM 用） */
  name: string
}

/** 从清单挑出本次要拉取的条目：OCM 按目标名去重，ITC 按文件名去重，保持清单顺序 */
function pickTargets(manifest: string, format: StarlinkFormat, count: number): PullTarget[] {
  const lines = manifest
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => /\.txt$/i.test(l))
  const targets: PullTarget[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const m = /STARLINK-(\d+)/i.exec(line)
    const name = m ? `STARLINK-${m[1]}` : ''
    if (format === 'OCM') {
      if (!name || seen.has(name)) continue
      seen.add(name)
      targets.push({ name, file: `${name}.txt` })
    } else {
      if (seen.has(line)) continue
      seen.add(line)
      targets.push({ name, file: line })
    }
    if (targets.length >= count) break
  }
  return targets
}

/** 执行一次拉取（多文件并行；单条失败不中断整批） */
export async function runStarlinkPull(opts: {
  count: number
  format: StarlinkFormat
  triggeredBy: string
}): Promise<StarlinkPullStatus> {
  if (running) throw new Error('StarLink 星历拉取正在运行中')
  if (!(await ensureStarlinkSchema())) throw new Error('数据库不可用')
  if (!(await ephemDbUp())) throw new Error('星历元数据库不可用')

  const count = Math.max(1, Math.min(500, Math.floor(opts.count) || 10))
  const status: StarlinkPullStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    triggeredBy: opts.triggeredBy,
    format: opts.format,
    requested: count,
    processed: 0,
    current: null,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: []
  }
  running = true
  await saveStarlinkPullStatus(status)

  try {
    const manifest = (await downloadPublicFile(MANIFEST_URL, 90_000)).toString('utf8')
    const targets = pickTargets(manifest, opts.format, count)
    if (!targets.length) throw new Error('MANIFEST 中没有可拉取条目')
    console.log(`[starlink] pull start: format=${opts.format} count=${targets.length} by=${opts.triggeredBy}`)

    const persist = async (): Promise<void> => {
      try {
        await saveStarlinkPullStatus(status)
      } catch (e) {
        console.error('[starlink] save progress failed:', (e as Error).message)
      }
    }

    let cursor = 0
    const inflight = new Set<string>()
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const t = targets[cursor++]
        inflight.add(t.file)
        status.current = t.file
        await persist()
        try {
          const buf = await downloadPublicFile(`${BASE}/${encodeURIComponent(t.file)}`)
          if (looksLikeHtml(buf)) throw new Error('返回 HTML（非星历文件）')
          const r = await ingestUploadFile(t.file, buf, opts.triggeredBy, { overwriteSameName: true })
          if (r.action === 'added') status.added++
          else if (r.action === 'updated') status.updated++
          else status.skipped++
        } catch (e) {
          status.failed++
          if (status.errors.length < 20) status.errors.push(`${t.file}: ${(e as Error).message}`)
        }
        inflight.delete(t.file)
        status.current = inflight.size ? Array.from(inflight).pop() ?? null : null
        status.processed++
        await persist()
      }
    }
    const parallel = Math.min(FILE_CONCURRENCY, targets.length)
    await Promise.all(Array.from({ length: parallel }, () => worker()))
  } catch (e) {
    status.failed++
    if (status.errors.length < 20) status.errors.push((e as Error).message)
  } finally {
    running = false
    status.running = false
    status.current = null
    status.finishedAt = new Date().toISOString()
    try {
      await saveStarlinkPullStatus(status)
    } catch (e) {
      console.error('[starlink] save status failed:', (e as Error).message)
    }
  }

  console.log(
    `[starlink] pull done: format=${status.format} total=${status.requested} added=${status.added} updated=${status.updated} skipped=${status.skipped} failed=${status.failed}`
  )
  return status
}

/* ------------------------- UTC 00:00 每日自动拉取 ------------------------- */

let lastRunDate = '' // 'YYYY-MM-DD'（UTC），防同日重复触发
let timer: ReturnType<typeof setInterval> | null = null

export function startStarlinkPullScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    const now = new Date()
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() !== 0) return
    const key = now.toISOString().slice(0, 10)
    if (lastRunDate === key || running) return
    void (async () => {
      try {
        if (!(await ensureStarlinkSchema())) return
        const cfg = await getStarlinkPullConfig()
        if (!cfg.enabled) return
        lastRunDate = key
        console.log('[starlink] cron 触发（UTC 00:00）')
        await runStarlinkPull({ count: cfg.count, format: cfg.format, triggeredBy: 'cron' })
      } catch (e) {
        console.error('[starlink] cron run failed:', (e as Error).message)
      }
    })()
  }, 30_000)
  console.log('[starlink] scheduler started (UTC 00:00 daily, config-gated)')
}
