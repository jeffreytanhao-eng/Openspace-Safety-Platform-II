/**
 * GCAT catalog refresh for super-admin data-ops:
 *  - status (row count, last ingest, source stamp, next Monday 00:00 Asia/Shanghai)
 *  - in-process mutex + last-run snapshot for the DataOps page
 *  - weekly scheduler: Monday 00:00 Asia/Shanghai, re-download then ingest
 *
 * Not part of the Space-Track / AOE daily-fetch cron.
 */
import { pool } from '../db/pool.js'
import { ensureCatalogProfileSchema } from '../db/catalogProfileDb.js'
import { gcatFilesPresent, resolveGcatDataDir, runGcatIngest, type GcatIngestResult } from './ingestGcat.js'

const TZ = 'Asia/Shanghai'
export const GCAT_RECOMMENDED_DAYS = 7

export interface GcatLastRun {
  running: boolean
  triggeredBy: string
  download: boolean
  startedAt: string
  finishedAt: string | null
  written: number | null
  total: number | null
  sourceUpdated: string | null
  elapsedMs: number | null
  error: string | null
}

export interface GcatStatus {
  rows: number
  lastIngestAt: string | null
  sourceUpdated: string | null
  recommendedIntervalDays: number
  schedule: string
  scheduleNote: string
  nextRunAt: string
  overdue: boolean
  running: boolean
  lastRun: GcatLastRun | null
  filesPresent: boolean
  filesMissing: string[]
  dataDir: string
}

let running = false
let lastRun: GcatLastRun | null = null
/** Shanghai calendar date (YYYY-MM-DD) of the Monday already triggered in-process. */
let lastCronMonday: string | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function isGcatIngestRunning(): boolean {
  return running
}

export function getGcatLastRun(): GcatLastRun | null {
  return lastRun
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Calendar parts in Asia/Shanghai. weekday: 0 = Sunday, 1 = Monday, … */
export function shanghaiParts(at: Date = new Date()): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at)
  const g = (t: string) => parts.find((p) => p.type === t)?.value || ''
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(g('year')),
    month: Number(g('month')),
    day: Number(g('day')),
    hour: Number(g('hour')),
    minute: Number(g('minute')),
    weekday: wd[g('weekday')] ?? 0
  }
}

function shanghaiMidnightUtc(year: number, month: number, day: number): Date {
  return new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00+08:00`)
}

function addDaysYmd(year: number, month: number, day: number, add: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + add))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

/** This week's Monday 00:00 Asia/Shanghai (a Sunday still belongs to the week that started the previous Monday). */
export function thisMondayMidnight(at: Date = new Date()): Date {
  const p = shanghaiParts(at)
  const sinceMon = p.weekday === 0 ? 6 : p.weekday - 1
  const d = addDaysYmd(p.year, p.month, p.day, -sinceMon)
  return shanghaiMidnightUtc(d.year, d.month, d.day)
}

export function nextMondayMidnight(at: Date = new Date()): Date {
  const thisMon = thisMondayMidnight(at)
  if (at.getTime() < thisMon.getTime()) return thisMon
  const p = shanghaiParts(thisMon)
  const n = addDaysYmd(p.year, p.month, p.day, 7)
  return shanghaiMidnightUtc(n.year, n.month, n.day)
}

function mondayKey(monday: Date): string {
  const p = shanghaiParts(monday)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

async function readCatalogMeta(): Promise<{ rows: number; lastIngestAt: string | null; sourceUpdated: string | null }> {
  if (!(await ensureCatalogProfileSchema())) {
    return { rows: 0, lastIngestAt: null, sourceUpdated: null }
  }
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n, MAX(ingested_at) AS last_ingest, MAX(source_updated) AS source_updated FROM sat_catalog_profile'
  )
  const r = (rows as Array<{ n: number; last_ingest: Date | string | null; source_updated: string | null }>)[0]
  if (!r) return { rows: 0, lastIngestAt: null, sourceUpdated: null }
  let last: string | null = null
  if (r.last_ingest instanceof Date) last = r.last_ingest.toISOString()
  else if (r.last_ingest) last = new Date(r.last_ingest).toISOString()
  return { rows: Number(r.n) || 0, lastIngestAt: last, sourceUpdated: r.source_updated || null }
}

export async function getGcatStatus(): Promise<GcatStatus> {
  const meta = await readCatalogMeta()
  const now = new Date()
  const thisMon = thisMondayMidnight(now)
  const next = nextMondayMidnight(now)
  const files = gcatFilesPresent()
  const overdue = !meta.lastIngestAt || new Date(meta.lastIngestAt).getTime() < thisMon.getTime()
  return {
    rows: meta.rows,
    lastIngestAt: meta.lastIngestAt,
    sourceUpdated: meta.sourceUpdated,
    recommendedIntervalDays: GCAT_RECOMMENDED_DAYS,
    schedule: '每周一 00:00（北京时间）',
    scheduleNote:
      '日常每周更新即可；仅在需要当天发射信息时改为每天。到点会重新下载官方文件再入库，不走 Space-Track，也不并入系统日更。',
    nextRunAt: next.toISOString(),
    overdue: overdue && now.getTime() >= thisMon.getTime(),
    running,
    lastRun,
    filesPresent: files.missing.length === 0,
    filesMissing: files.missing,
    dataDir: resolveGcatDataDir()
  }
}

/** Start an ingest if idle. Returns false when one is already running. */
export function startGcatIngest(opts: { download: boolean; triggeredBy: string }): boolean {
  if (running) return false
  running = true
  lastRun = {
    running: true,
    triggeredBy: opts.triggeredBy,
    download: opts.download,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    written: null,
    total: null,
    sourceUpdated: null,
    elapsedMs: null,
    error: null
  }
  void runGcatIngest({ download: opts.download })
    .then((r: GcatIngestResult) => {
      lastRun = {
        running: false,
        triggeredBy: opts.triggeredBy,
        download: opts.download,
        startedAt: lastRun?.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        written: r.written,
        total: r.total,
        sourceUpdated: r.sourceUpdated,
        elapsedMs: r.elapsedMs,
        error: null
      }
      console.log(
        `[gcat] ingest done (${opts.triggeredBy}): written=${r.written} total=${r.total} ${r.elapsedMs}ms`
      )
    })
    .catch((e) => {
      lastRun = {
        running: false,
        triggeredBy: opts.triggeredBy,
        download: opts.download,
        startedAt: lastRun?.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        written: null,
        total: null,
        sourceUpdated: null,
        elapsedMs: lastRun?.startedAt ? Date.now() - new Date(lastRun.startedAt).getTime() : null,
        error: e instanceof Error ? e.message : String(e)
      }
      console.error('[gcat] ingest failed:', lastRun.error)
    })
    .finally(() => {
      running = false
      if (lastRun) lastRun.running = false
    })
  return true
}

async function maybeCatchUp(): Promise<void> {
  if (running) return
  try {
    const now = new Date()
    const thisMon = thisMondayMidnight(now)
    if (now.getTime() < thisMon.getTime()) return
    const key = mondayKey(thisMon)
    if (lastCronMonday === key) return
    const meta = await readCatalogMeta()
    if (meta.lastIngestAt && new Date(meta.lastIngestAt).getTime() >= thisMon.getTime()) {
      lastCronMonday = key
      return
    }
    lastCronMonday = key
    console.log(`[gcat] weekly catch-up (missed Monday 00:00 Asia/Shanghai, week of ${key})`)
    startGcatIngest({ download: true, triggeredBy: 'cron:weekly-catchup' })
  } catch (e) {
    console.error('[gcat] catch-up check failed:', e instanceof Error ? e.message : e)
  }
}

function tick(): void {
  const p = shanghaiParts()
  if (p.weekday !== 1 || p.hour !== 0 || p.minute !== 0) return
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  if (lastCronMonday === key) return
  lastCronMonday = key
  if (running) {
    console.warn('[gcat] weekly cron skipped: ingest already running')
    return
  }
  console.log('[gcat] weekly cron trigger (Monday 00:00 Asia/Shanghai)')
  startGcatIngest({ download: true, triggeredBy: 'cron:weekly' })
}

export function startGcatWeeklyScheduler(): void {
  if (timer) return
  timer = setInterval(tick, 30_000)
  console.log('[gcat] weekly scheduler started (Monday 00:00 Asia/Shanghai)')
  setTimeout(() => {
    void maybeCatchUp()
  }, 8_000)
}
