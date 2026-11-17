/**
 * 通知 API（Epic H2 日报与 Webhook）：
 *  - 渠道 CRUD + 测试投递 + 投递审计（org_admin 写，组织成员可读）；
 *  - 日报预览（最新 / 指定日期）+ 手动生成今日日报。
 */
import { cgiCall } from './auth'

function authHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem('osp-token')
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

export type ChannelKind = 'webhook' | 'email' | 'dingtalk'
export type MinLevel = 'yellow' | 'orange' | 'red'
export type DeliveryKind = 'daily_report' | 'level_change' | 'test'
export type DeliveryStatus = 'success' | 'failed' | 'skipped'
export type ContentKey = 'counts' | 'changes' | 'top'

/** 渠道视图（webhook URL 已掩码，密钥只回 has_secret） */
export interface NotifyChannel {
  id: number
  kind: ChannelKind
  target: string
  min_level: MinLevel
  subscribe: string // 'daily,changes'
  content: string // 'counts,changes,top'
  has_secret: boolean
  enabled: boolean
  last_ok_at: string | null
  last_error: string | null
  created_by: string
  updated_at: string
}

export interface ChannelInput {
  kind: ChannelKind
  target: string
  min_level: MinLevel
  subscribe: string[]
  content: ContentKey[]
  /** 缺省 = 保持不变；空串 = 清除（Webhook / 钉钉加签密钥） */
  secret?: string
  enabled?: boolean
}

export interface DeliveryRow {
  id: number
  org_id: number
  channel_id: number
  kind: DeliveryKind
  status: DeliveryStatus
  attempts: number
  status_code: number | null
  error: string | null
  created_at: string
}

export interface ReportEventItem {
  key: string
  noradA: number
  nameA: string
  noradB: number
  nameB: string
  tca: string
  level: 'red' | 'orange' | 'yellow' | 'low'
  pc: number | null
  missKm: number | null
  cdmCount: number
}

export interface LevelChangeItem {
  key: string
  names: string
  tca: string
  from: string | null
  to: string
  change: 'upgrade' | 'downgrade' | 'new' | 'resolved'
}

/** 日报 payload（daily_reports.payload_json） */
export interface DailyReportPayload {
  date: string
  generated_at: string
  scope: 'managed' | 'global'
  events: {
    window: { from: string; to: string }
    counts: Record<'red' | 'orange' | 'yellow' | 'low', number>
    top: ReportEventItem[]
  }
  level_changes: LevelChangeItem[]
}

/** 报告历史条目（列表页只回概览） */
export interface ReportSummary {
  report_date: string
  scope: string
  created_at: string
  counts: Record<string, number>
  changes: number
}

export function listChannels(): Promise<{ items: NotifyChannel[]; smtp_configured: boolean }> {
  return cgiCall({ method: 'GET', url: '/notify/channels', headers: authHeaders() })
}

export function createChannel(input: ChannelInput): Promise<{ channel: NotifyChannel }> {
  return cgiCall({ method: 'POST', url: '/notify/channels', data: input, headers: authHeaders() })
}

export function updateChannel(id: number, input: ChannelInput): Promise<{ channel: NotifyChannel }> {
  return cgiCall({ method: 'PUT', url: `/notify/channels/${id}`, data: input, headers: authHeaders() })
}

export function deleteChannel(id: number): Promise<{ deleted: number }> {
  return cgiCall({ method: 'DELETE', url: `/notify/channels/${id}`, headers: authHeaders() })
}

export function testChannel(id: number): Promise<{ status: DeliveryStatus; attempts: number; status_code: number | null; error: string | null }> {
  return cgiCall({ method: 'POST', url: `/notify/channels/${id}/test`, headers: authHeaders() })
}

export function listDeliveries(limit = 20): Promise<{ deliveries: DeliveryRow[] }> {
  return cgiCall({ method: 'GET', url: `/notify/deliveries?limit=${limit}`, headers: authHeaders() })
}

export function getLatestReport(): Promise<{ report_date: string; scope: string; created_at: string; payload: DailyReportPayload | null }> {
  return cgiCall({ method: 'GET', url: '/notify/report/latest', headers: authHeaders() })
}

export function listReports(limit = 30): Promise<{ items: ReportSummary[] }> {
  return cgiCall({ method: 'GET', url: `/notify/reports?limit=${limit}`, headers: authHeaders() })
}

export function getReportByDate(date: string): Promise<{ report_date: string; scope: string; created_at: string; payload: DailyReportPayload | null }> {
  return cgiCall({ method: 'GET', url: `/notify/report/${date}`, headers: authHeaders() })
}

/** 下载指定日期报告（Markdown，服务端按日期命名） */
export async function downloadReport(date: string): Promise<void> {
  const res = await fetch(`/cgi/notify/report/${date}/file`, { headers: authHeaders() })
  if (!res.ok) {
    let msg = '下载失败'
    try {
      const j = (await res.json()) as { msg?: string }
      if (j?.msg) msg = j.msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `通知日报-${date}.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function resendReport(date: string): Promise<{ date: string; delivered: number; failed: number; skipped: number }> {
  return cgiCall({ method: 'POST', url: `/notify/report/${date}/resend`, headers: authHeaders() })
}

export function runReport(): Promise<{ date: string; scope: string; upgrades: number; delivered: number; failed: number; skipped: number }> {
  return cgiCall({ method: 'POST', url: '/notify/report/run', headers: authHeaders() })
}
