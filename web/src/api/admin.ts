/**
 * 超管 API（Epic B1）：组织开通/变更/详情/成员 + 审计。
 * 全部走 /cgi/admin/*，由后端 requireSuperAdmin 把关。
 */
import { cgiCall, authMe } from './auth'

function headers(): Record<string, string> {
  try {
    const t = localStorage.getItem('osp-token')
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

export interface AdminOrg {
  id: number
  name: string
  plan: 'free' | 'normal' | 'vip'
  status: 'active' | 'suspended' | 'closed'
  trial_ends_at: string | null
  notes: string | null
  created_at: string
  members?: number
}

export interface AdminMember {
  id: number
  email: string
  display_name: string
  role: string
  status: string
  created_at: string
}

export interface AuditItem {
  id: number
  actor_user_id: number | null
  actor_email: string
  org_id: number | null
  action: string
  before_json: string | null
  after_json: string | null
  created_at: string
}

export function adminListOrgs(): Promise<{ items: AdminOrg[] }> {
  return cgiCall({ method: 'GET', url: '/admin/orgs', headers: headers() })
}

export function adminCreateOrg(payload: {
  name: string
  plan: string
  adminEmail: string
  adminPassword: string
  adminDisplayName?: string
}): Promise<{ org: AdminOrg; admin: { id: number; email: string; role: string } }> {
  return cgiCall({ method: 'POST', url: '/admin/orgs', data: payload, headers: headers() })
}

export function adminGetOrg(id: number): Promise<{
  org: AdminOrg
  members: AdminMember[]
  limits: Array<{ feature: string; limit: number; overridden: boolean }>
  quotas: AdminQuotaRow[]
  flags: AdminFlagRow[]
  claim_scopes: AdminClaimScope[]
}> {
  return cgiCall({ method: 'GET', url: `/admin/orgs/${id}`, headers: headers() })
}

/** C1：业主授权范围条目（norad=白名单 / constellation_key=编目星座 / tag=名称关键词包含） */
export type ClaimScopeType = 'norad' | 'tag' | 'constellation_key'

export interface AdminClaimScope {
  id: number
  org_id: number
  scope_type: ClaimScopeType
  scope_value: string
  note: string
  created_at: string
}

export function adminGetClaimScopes(id: number): Promise<{ org_id: number; scopes: AdminClaimScope[] }> {
  return cgiCall({ method: 'GET', url: `/admin/orgs/${id}/claim-scopes`, headers: headers() })
}

/** 全量替换（空数组 = 收回业主认领权限） */
export function adminPutClaimScopes(
  id: number,
  scopes: Array<{ type: ClaimScopeType; value: string; note?: string }>
): Promise<{ org_id: number; scopes: AdminClaimScope[] }> {
  return cgiCall({ method: 'PUT', url: `/admin/orgs/${id}/claim-scopes`, data: { scopes }, headers: headers() })
}

/** C6：按 NORAD 查当前业主认领 / 强制释放 */
export interface AdminOwnerRow {
  id: number
  org_id: number
  norad_id: number
  name: string
  claim_type: string
  created_at: string
  updated_at: string
  org_name: string | null
}

export function adminGetOwner(norad: number): Promise<{ norad: number; owner: AdminOwnerRow | null }> {
  return cgiCall({ method: 'GET', url: `/admin/owner/${norad}`, headers: headers() })
}

export function adminReleaseOwner(norad: number): Promise<{ released: number; norad: number; orgId: number }> {
  return cgiCall({ method: 'DELETE', url: `/admin/owner/${norad}`, headers: headers() })
}

/** Epic I：组织配额行（默认 / 覆盖 / 生效 / 用量） */
export interface AdminQuotaRow {
  feature: string
  label: string
  unit: 'count' | 'days' | 'bitmap' | 'scope'
  default: number
  override: number | null
  effective: number
  overridden: boolean
  usage: number
}

/** Epic I：组织功能开关行 */
export interface AdminFlagRow {
  key: string
  label: string
  description: string
  default: boolean
  override: boolean | null
  enabled: boolean
  overridden: boolean
}

/** 设置数字 override（超管，立即生效） */
export function adminSetQuotaOverride(
  id: number,
  feature: string,
  limit: number
): Promise<AdminQuotaRow> {
  return cgiCall({ method: 'PUT', url: `/admin/orgs/${id}/quotas/${feature}`, data: { limit }, headers: headers() })
}

/** 清除数字 override（恢复档位默认） */
export function adminClearQuotaOverride(id: number, feature: string): Promise<AdminQuotaRow> {
  return cgiCall({ method: 'DELETE', url: `/admin/orgs/${id}/quotas/${feature}`, headers: headers() })
}

/** 设置功能开关 override */
export function adminSetFlagOverride(
  id: number,
  key: string,
  enabled: boolean
): Promise<AdminFlagRow> {
  return cgiCall({ method: 'PUT', url: `/admin/orgs/${id}/flags/${key}`, data: { enabled }, headers: headers() })
}

/** 清除功能开关 override（恢复目录默认） */
export function adminClearFlagOverride(id: number, key: string): Promise<AdminFlagRow> {
  return cgiCall({ method: 'DELETE', url: `/admin/orgs/${id}/flags/${key}`, headers: headers() })
}

export function adminUpdateOrg(
  id: number,
  patch: { plan?: string; status?: string; notes?: string }
): Promise<AdminOrg> {
  return cgiCall({ method: 'PATCH', url: `/admin/orgs/${id}`, data: patch, headers: headers() })
}

export function adminCreateMember(
  id: number,
  payload: { email: string; password: string; displayName?: string; role?: string }
): Promise<{ id: number; email: string; role: string }> {
  return cgiCall({ method: 'POST', url: `/admin/orgs/${id}/members`, data: payload, headers: headers() })
}

export function adminListAudit(page = 1, limit = 50): Promise<{
  items: AuditItem[]
  total: number
  page: number
  limit: number
}> {
  return cgiCall({ method: 'GET', url: `/admin/audit?page=${page}&limit=${limit}`, headers: headers() })
}

/** 当前账号是否平台侧（超管/运维） */
export async function isPlatformUser(): Promise<boolean> {
  try {
    const me = await authMe()
    return me.user.role === 'platform_super_admin' || me.user.role === 'platform_ops'
  } catch {
    return false
  }
}

/* ------------------------- R1-3：日更（GP + CDM）运维 ------------------------- */

export interface FetchBatchRow {
  id: number
  source: string
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

export interface DailyFetchStatus {
  last_success: Record<string, string | null>
  last_batch: Record<string, FetchBatchRow | null>
  running: boolean
}

export function adminDailyFetchStatus(): Promise<DailyFetchStatus> {
  return cgiCall({ method: 'GET', url: '/jobs/daily-fetch/status', headers: headers() })
}

export interface DailyFetchSourceResult {
  batchId: number
  status: 'success' | 'failed'
  message: string
  total?: number
  inserted?: number
  updated?: number
  skipped?: number
}

export function adminTriggerDailyFetch(): Promise<{
  triggered_by: string
  results: Record<string, DailyFetchSourceResult>
}> {
  return cgiCall({ method: 'POST', url: '/jobs/daily-fetch', headers: headers() })
}
