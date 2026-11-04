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

export type ChannelKind = 'webhook' | 'email'
export type MinLevel = 'yellow' | 'orange' | 'red'
export type DeliveryKind = 'daily_report' | 'level_change' | 'test'
export type DeliveryStatus = 'success' | 'failed' | 'skipped'

/** 渠道视图（webhook URL 已掩码，密钥只回 has_secret） */
export interface NotifyChannel {
  id: number
  kind: ChannelKind
  target: string
  min_level: MinLevel
  subscribe: string // 'daily,changes'
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
  /** 缺省 = 保持不变；空串 = 清除（webhook 签名密钥） */
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
  data_sources: Record<string, { status: string; last_success: string | null; total: number; inserted: number }>
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

export function runReport(): Promise<{ date: string; scope: string; upgrades: number; delivered: number; failed: number; skipped: number }> {
  return cgiCall({ method: 'POST', url: '/notify/report/run', headers: authHeaders() })
}
