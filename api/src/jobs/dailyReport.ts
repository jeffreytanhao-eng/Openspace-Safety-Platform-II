/**
 * 日报 job（Epic H2）：
 *  - buildDailyReport：按组织汇总 observe/critical 事件（黄/橙/红）、分级变化（对比上一份
 *    报告的等级快照）、数据源健康（orbital_fetch_batches 最近批次）；
 *  - runDailyReportForOrg：出报 → upsert daily_reports（同日覆盖）→ 投递启用的渠道
 *    （daily 订阅收日报；changes 订阅在有升级变化时收分级变化通知，按 min_level 过滤）；
 *  - 调度：DAILY_REPORT_CRON（'M H * * *'，UTC，默认 06:30 在日更之后），复用日更的
 *    每日对表模式；手动触发走 POST /cgi/notify/report/run。
 */
import { pool } from '../db/pool.js'
import {
  ensureNotifySchema,
  upsertReport,
  getPrevReport,
  listChannels,
  listActiveOrgIds,
  recordDelivery,
  markChannelOk,
  markChannelError,
  type NotifyChannel,
  type DeliveryKind,
  type MinLevel
} from '../db/notifyDb.js'
import { getDailyFetchStatus } from '../db/fetchDb.js'
import { listObjectsByOrg } from '../db/objectsDb.js'
import { aggregateEvents, type ConjunctionEvent, type EventLevel } from '../routes/events.js'
import { deliverWebhook, deliverEmail, smtpConfigured } from '../services/notify.js'
import { isOrgFlagEnabled } from '../db/planDb.js'

export type { EventLevel }

const LEVEL_RANK: Record<EventLevel, number> = { red: 3, orange: 2, yellow: 1, low: 0 }
export const LEVEL_RANK_H2 = LEVEL_RANK

/** 事件窗口与交会列表默认口径一致：[now-1d, now+3d] */
function eventWindow(): { from: Date; to: Date } {
  const now = Date.now()
  return { from: new Date(now - 24 * 3600e3), to: new Date(now + 3 * 24 * 3600e3) }
}

interface ReportEventItem {
  key: string
  noradA: number
  nameA: string
  noradB: number
  nameB: string
  tca: string
  level: EventLevel
  pc: number | null
  missKm: number | null
  cdmCount: number
}

export interface DailyReportPayload {
  date: string
  generated_at: string
  scope: 'managed' | 'global'
  events: {
    window: { from: string; to: string }
    counts: Record<EventLevel, number>
    /** 最高危优先，最多 30 条 */
    top: ReportEventItem[]
  }
  /** 全事件等级快照（key → level），供次日分级变化对比 */
  levels: Record<string, EventLevel>
  level_changes: Array<{
    key: string
    names: string
    tca: string
    from: EventLevel | null
    to: EventLevel
    change: 'upgrade' | 'downgrade' | 'new' | 'resolved'
  }>
  data_sources: Record<string, { status: string; last_success: string | null; total: number; inserted: number }>
}

/** 取组织窗口内 CDM 行（managed=托管 NORAD 相关 + 本组织上传；global=系统池全量） */
async function loadEvents(orgId: number, scope: 'managed' | 'global'): Promise<ConjunctionEvent[]> {
  const { from, to } = eventWindow()
  const COLS = `id, cdm_id, creation_date, originator, tca, norad_a, name_a, norad_b, name_b,
    miss_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, source, org_id`
  let rows: unknown[] = []
  if (scope === 'managed') {
    const objs = await listObjectsByOrg(orgId)
    const norads = [...new Set(objs.map((o) => Number(o.norad_id)).filter((n) => Number.isInteger(n) && n > 0))]
    if (norads.length) {
      const inA = norads.map(() => '?').join(',')
      const [r] = await pool.query(
        `SELECT ${COLS} FROM sat_cdm
         WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
           AND (norad_a IN (${inA}) OR norad_b IN (${inA}) OR (source = 'customer' AND org_id = ?))
         ORDER BY tca ASC LIMIT 5000`,
        [from, to, ...norads, ...norads, orgId]
      )
      rows = r as unknown[]
    } else {
      rows = []
    }
  } else {
    const [r] = await pool.query(
      `SELECT ${COLS} FROM sat_cdm
       WHERE tca IS NOT NULL AND tca >= ? AND tca <= ?
       ORDER BY tca ASC LIMIT 5000`,
      [from, to]
    )
    rows = r as unknown[]
  }
  return aggregateEvents(rows as Parameters<typeof aggregateEvents>[0])
}

/** 生成日报 payload（含与上一份报告的分级变化对比） */
export async function buildDailyReport(orgId: number, date: string, scope: 'managed' | 'global'): Promise<DailyReportPayload> {
  const events = await loadEvents(orgId, scope)
  const counts: Record<EventLevel, number> = { red: 0, orange: 0, yellow: 0, low: 0 }
  const levels: Record<string, EventLevel> = {}
  for (const ev of events) {
    counts[ev.level]++
    levels[ev.key] = ev.level
  }
  const top: ReportEventItem[] = events
    .filter((e) => e.level !== 'low')
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.tca.localeCompare(b.tca))
    .slice(0, 30)
    .map((e) => ({
      key: e.key,
      noradA: e.noradA,
      nameA: e.nameA,
      noradB: e.noradB,
      nameB: e.nameB,
      tca: e.tca,
      level: e.level,
      pc: e.pc,
      missKm: e.missKm,
      cdmCount: e.cdmCount
    }))

  // 分级变化：与上一份报告的等级快照对比
  const prev = await getPrevReport(orgId, date)
  const prevLevels = prev ? safeLevels(prev.payload_json) : {}
  const changes: DailyReportPayload['level_changes'] = []
  for (const [key, to] of Object.entries(levels)) {
    const from = prevLevels[key] ?? null
    if (from === to) continue
    if (!from && LEVEL_RANK[to] >= LEVEL_RANK.yellow) {
      changes.push({ key, names: changeNames(events, key), tca: tcaOf(events, key), from: null, to, change: 'new' })
    } else if (from && LEVEL_RANK[to] > LEVEL_RANK[from]) {
      changes.push({ key, names: changeNames(events, key), tca: tcaOf(events, key), from, to, change: 'upgrade' })
    } else if (from && LEVEL_RANK[to] < LEVEL_RANK[from]) {
      changes.push({ key, names: changeNames(events, key), tca: tcaOf(events, key), from, to, change: 'downgrade' })
    }
  }
  for (const [key, from] of Object.entries(prevLevels)) {
    if (!levels[key] && LEVEL_RANK[from] >= LEVEL_RANK.yellow) {
      changes.push({ key, names: prevNames(prev, key), tca: '', from, to: 'low', change: 'resolved' })
    }
  }
  changes.sort((a, b) => LEVEL_RANK[b.to] - LEVEL_RANK[a.to])

  const st = await getDailyFetchStatus()
  const data_sources: DailyReportPayload['data_sources'] = {}
  for (const [src, b] of Object.entries(st.last_batch)) {
    // last_success 运行时可能是 Date（mysql2 DATETIME），统一转 ISO 字符串
    const ls = st.last_success[src]
    data_sources[src] = {
      status: b?.status ?? 'none',
      last_success: ls ? new Date(ls as unknown as string | Date).toISOString() : null,
      total: b?.total ?? 0,
      inserted: b?.inserted ?? 0
    }
  }

  return {
    date,
    generated_at: new Date().toISOString(),
    scope,
    events: { window: { from: eventWindow().from.toISOString(), to: eventWindow().to.toISOString() }, counts, top },
    levels,
    level_changes: changes,
    data_sources
  }
}

function safeLevels(json: string): Record<string, EventLevel> {
  try {
    const p = JSON.parse(json) as { levels?: Record<string, EventLevel> }
    return p.levels ?? {}
  } catch {
    return {}
  }
}

function tcaOf(events: ConjunctionEvent[], key: string): string {
  return events.find((e) => e.key === key)?.tca ?? ''
}

function changeNames(events: ConjunctionEvent[], key: string): string {
  const e = events.find((x) => x.key === key)
  if (!e) return key
  const na = e.nameA || String(e.noradA)
  const nb = e.nameB || String(e.noradB)
  return `${na} × ${nb}`
}

function prevNames(prev: { payload_json: string } | null, key: string): string {
  if (!prev) return key
  try {
    const p = JSON.parse(prev.payload_json) as { events?: { top?: Array<{ key: string; nameA: string; nameB: string; noradA: number; noradB: number }> } }
    const e = p.events?.top?.find((x) => x.key === key)
    if (!e) return key
    return `${e.nameA || String(e.noradA)} × ${e.nameB || String(e.noradB)}`
  } catch {
    return key
  }
}

/* ------------------------------ 投递 ------------------------------ */

function dailyText(p: DailyReportPayload, orgName: string): string {
  const zhLevel: Record<EventLevel, string> = { red: '红(高危)', orange: '橙(警告)', yellow: '黄(关注)', low: '灰(低)' }
  const lines: string[] = []
  lines.push(`[Openspace Safety] 日报 ${p.date} · ${orgName}`)
  lines.push(`范围：${p.scope === 'managed' ? '目标相关' : '系统池全量'} · 窗口 ${p.events.window.from.slice(0, 16)} ~ ${p.events.window.to.slice(0, 16)} UTC`)
  lines.push('')
  lines.push(`事件概览：红 ${p.events.counts.red} · 橙 ${p.events.counts.orange} · 黄 ${p.events.counts.yellow} · 灰 ${p.events.counts.low}`)
  if (p.level_changes.length) {
    lines.push(`分级变化：${p.level_changes.length} 项`)
    for (const c of p.level_changes.slice(0, 10)) {
      const label = c.change === 'new' ? '新增高危' : c.change === 'upgrade' ? '升级' : c.change === 'downgrade' ? '降级' : '已消除'
      lines.push(`  - [${label}] ${c.names} ${c.from ? `${c.from}→` : ''}${c.to} · TCA ${c.tca.slice(0, 16)}`)
    }
  } else {
    lines.push('分级变化：无')
  }
  if (p.events.top.length) {
    lines.push('')
    lines.push('Top 事件：')
    for (const e of p.events.top.slice(0, 10)) {
      lines.push(`  - [${zhLevel[e.level]}] ${e.nameA || e.noradA} × ${e.nameB || e.noradB} · TCA ${e.tca.slice(0, 16)} · Pc ${e.pc?.toExponential(2) ?? '—'} · miss ${e.missKm?.toFixed(2) ?? '—'} km`)
    }
  }
  lines.push('')
  lines.push('数据源健康：')
  for (const [src, s] of Object.entries(p.data_sources)) {
    lines.push(`  - ${src}: ${s.status} · 上次成功 ${s.last_success ? s.last_success.slice(0, 16) : '—'} · 批次 ${s.total} 条（新 ${s.inserted}）`)
  }
  lines.push('')
  lines.push('免责声明：本报告由 Openspace Safety 平台自动生成，作业辅助非认证 CARA，数据可能存在误差，不作为唯一决策依据。')
  return lines.join('\n')
}

/** 渠道是否订阅某类通知 */
function subscribed(ch: NotifyChannel, kind: DeliveryKind): boolean {
  const subs = ch.subscribe.split(',').map((s) => s.trim())
  return kind === 'daily_report' ? subs.includes('daily') : subs.includes('changes')
}

/** 分级变化通知的等级门槛（changes 专用，daily 不受限） */
function levelGateOk(ch: NotifyChannel, payload: DailyReportPayload): boolean {
  const minRank = LEVEL_RANK[ch.min_level as MinLevel] ?? LEVEL_RANK.yellow
  return payload.level_changes.some(
    (c) => (c.change === 'upgrade' || c.change === 'new') && LEVEL_RANK[c.to] >= minRank
  )
}

/** 对单渠道投递一类通知，结果落审计；返回投递结果状态 */
async function deliverOne(
  ch: NotifyChannel,
  orgName: string,
  kind: DeliveryKind,
  payload: DailyReportPayload
): Promise<'success' | 'skipped' | 'failed'> {
  // Epic I 功能开关：webhook_enabled 关闭的组织，Webhook 渠道跳过投递（留审计不算失败）
  if (ch.kind === 'webhook' && !(await isOrgFlagEnabled(ch.org_id, 'webhook_enabled'))) {
    await recordDelivery({
      org_id: ch.org_id,
      channel_id: ch.id,
      kind,
      status: 'skipped',
      attempts: 0,
      status_code: null,
      error: '组织已禁用 Webhook 投递（webhook_enabled=false）',
      payload_json: ''
    })
    return 'skipped'
  }
  const payloadJson = JSON.stringify({ event: kind, org: orgName, report: payload })
  let result
  if (ch.kind === 'webhook') {
    result = await deliverWebhook(ch, kind, { event: kind, org: orgName, report: payload })
  } else {
    const isDaily = kind === 'daily_report'
    const subject = `[Openspace Safety] ${isDaily ? '日报' : '分级变化提醒'} ${payload.date} · ${orgName}`
    result = await deliverEmail(ch, subject, dailyText(payload, orgName))
  }
  await recordDelivery({
    org_id: ch.org_id,
    channel_id: ch.id,
    kind,
    status: result.status,
    attempts: result.attempts,
    status_code: result.statusCode,
    error: result.error,
    payload_json: payloadJson.slice(0, 1_000_000)
  })
  if (result.status === 'success') {
    await markChannelOk(ch.id)
    return 'success'
  }
  // skipped（SMTP 未配置）不算渠道错误也不算失败，但留因
  await markChannelError(ch.id, result.error ?? (result.status === 'skipped' ? 'skipped' : 'failed'))
  return result.status === 'skipped' ? 'skipped' : 'failed'
}

/** 给组织出报并投递（同日重复调用 = 覆盖重投） */
export async function runDailyReportForOrg(orgId: number, orgName: string, triggeredBy: string): Promise<{
  date: string
  scope: 'managed' | 'global'
  upgrades: number
  delivered: number
  failed: number
  skipped: number
}> {
  // Epic I 功能开关：daily_report_enabled 关闭的组织冻结日报作业（不删历史，恢复开关后续出）
  if (!(await isOrgFlagEnabled(orgId, 'daily_report_enabled'))) {
    console.log(`[daily-report] org=${orgId}(${orgName}) skipped: daily_report_enabled=false by=${triggeredBy}`)
    throw new Error('日报功能未对您的组织开放（daily_report_enabled 已关闭）')
  }
  if (!(await ensureNotifySchema())) throw new Error('数据库不可用（通知表未就绪）')
  const date = new Date().toISOString().slice(0, 10)
  const objs = await listObjectsByOrg(orgId)
  const scope: 'managed' | 'global' = objs.length ? 'managed' : 'global'
  const payload = await buildDailyReport(orgId, date, scope)
  await upsertReport(orgId, date, scope, JSON.stringify(payload))

  const channels = (await listChannels(orgId)).filter((c) => c.enabled)
  let delivered = 0
  let failed = 0
  let skipped = 0
  for (const ch of channels) {
    if (subscribed(ch, 'daily_report')) {
      const st = await deliverOne(ch, orgName, 'daily_report', payload)
      if (st === 'success') delivered++
      else if (st === 'skipped') skipped++
      else failed++
    }
    if (payload.level_changes.length && subscribed(ch, 'level_change') && levelGateOk(ch, payload)) {
      const st = await deliverOne(ch, orgName, 'level_change', payload)
      if (st === 'success') delivered++
      else if (st === 'skipped') skipped++
      else failed++
    }
  }
  console.log(
    `[daily-report] org=${orgId}(${orgName}) date=${date} scope=${scope} ` +
      `red=${payload.events.counts.red} orange=${payload.events.counts.orange} yellow=${payload.events.counts.yellow} ` +
      `changes=${payload.level_changes.length} delivered=${delivered} failed=${failed} skipped=${skipped} by=${triggeredBy}`
  )
  return {
    date,
    scope,
    upgrades: payload.level_changes.filter((c) => c.change === 'upgrade' || c.change === 'new').length,
    delivered,
    failed,
    skipped
  }
}

/** 组织名查询（cron 批量用；失败回退 ID 字符串） */
async function orgNameOf(orgId: number): Promise<string> {
  try {
    const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT name FROM organizations WHERE id = ? LIMIT 1`,
      [orgId]
    )
    return String(rows[0]?.name ?? `org-${orgId}`)
  } catch {
    return `org-${orgId}`
  }
}

/** cron 入口：逐活跃组织出报 */
export async function runDailyReportAll(triggeredBy = 'cron'): Promise<void> {
  const orgIds = await listActiveOrgIds()
  for (const id of orgIds) {
    try {
      await runDailyReportForOrg(id, await orgNameOf(id), triggeredBy)
    } catch (e) {
      console.error(`[daily-report] org=${id} failed:`, (e as Error).message)
    }
  }
}

/* ------------------------------ 每日调度 ------------------------------ */

let lastRunDate = ''
let timer: ReturnType<typeof setInterval> | null = null

/** 启动日报调度器（每 30s 对表一次 UTC 时刻；复用日更的 'M H * * *' 解析口径） */
export function startDailyReportScheduler(parseDailyCron: (expr: string) => { minute: number; hour: number } | null, cronExpr: string): void {
  if (timer) return
  const at = parseDailyCron(cronExpr)
  if (!at) {
    console.warn(`[daily-report] DAILY_REPORT_CRON '${cronExpr}' 无法解析（仅支持 'M H * * *'），调度器未启动；仍可手动触发`)
    return
  }
  if (!smtpConfigured()) {
    console.warn('[daily-report] SMTP 未配置：email 渠道将记 skipped（webhook 不受影响）')
  }
  timer = setInterval(() => {
    const now = new Date()
    const key = now.toISOString().slice(0, 10)
    if (now.getUTCHours() === at.hour && now.getUTCMinutes() === at.minute && lastRunDate !== key) {
      lastRunDate = key
      console.log(`[daily-report] cron 触发（UTC ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}）`)
      void runDailyReportAll('cron').catch((e) => {
        console.error('[daily-report] cron run failed:', (e as Error).message)
      })
    }
  }, 30_000)
  console.log(`[daily-report] scheduler started (UTC ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')} daily)`)
}
