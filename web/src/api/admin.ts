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
}> {
  return cgiCall({ method: 'GET', url: `/admin/orgs/${id}`, headers: headers() })
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
