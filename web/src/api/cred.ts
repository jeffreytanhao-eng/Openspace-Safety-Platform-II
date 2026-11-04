/**
 * 客户数据凭证 API（Epic C2）：组织自配 Space-Track / AOE 凭据。
 * 明文永不回传（仅掩码）；探测与拉取结果写回 last_ok_at / last_error；
 * 拉取走组织队列（org_fetch_batches 审计 + org_snapshots 组织私有落库）。
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

export type CredProvider = 'spacetrack' | 'aoe'

/** 凭据状态（不回明文，仅掩码） */
export interface CredStatus {
  provider: CredProvider
  configured: boolean
  masked: string
  last_ok_at: string | null
  last_error: string | null
  updated_by: string
  updated_at: string | null
}

/** 组织拉取批次（审计记条数） */
export interface OrgBatchRow {
  id: number
  org_id: number
  provider: CredProvider
  kind: 'gp' | 'cdm' | 'aoe'
  status: 'running' | 'success' | 'failed'
  triggered_by: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  total: number
  inserted: number
  updated: number
  skipped: number
  error_message: string | null
}

export function listCredentials(): Promise<{ items: CredStatus[] }> {
  return cgiCall({ method: 'GET', url: '/org/credentials', headers: authHeaders() })
}

export function saveCredential(
  provider: CredProvider,
  payload: { username?: string; password?: string; token?: string }
): Promise<{ saved: boolean; provider: CredProvider }> {
  return cgiCall({ method: 'PUT', url: `/org/credentials/${provider}`, data: payload, headers: authHeaders() })
}

export function deleteCredential(provider: CredProvider): Promise<{ deleted: boolean }> {
  return cgiCall({ method: 'DELETE', url: `/org/credentials/${provider}`, headers: authHeaders() })
}

export function testCredential(provider: CredProvider): Promise<{ ok: boolean; error?: string; latency_ms?: number }> {
  return cgiCall({ method: 'POST', url: `/org/credentials/${provider}/test`, headers: authHeaders() })
}

export function fetchNow(
  provider: CredProvider,
  kind?: 'gp' | 'cdm'
): Promise<{ batch_id: number; kind: string; scoped_targets: number; total: number; inserted: number; updated: number; skipped: number }> {
  return cgiCall({
    method: 'POST',
    url: `/org/credentials/${provider}/fetch`,
    data: kind ? { kind } : {},
    headers: authHeaders()
  })
}

export function listBatches(limit = 20): Promise<{ batches: OrgBatchRow[] }> {
  return cgiCall({ method: 'GET', url: `/org/credentials/batches?limit=${limit}`, headers: authHeaders() })
}
