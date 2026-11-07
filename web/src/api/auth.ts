/**
 * 认证 API（Epic A3）：register / login / me。
 * httpCgi 对 code!==0 抛 Error，但对 HTTP 4xx/5xx 会先被 axios reject ——
 * 这里统一转成带业务码的 AuthError（msg 取后端 body.msg）。
 */
import axios from 'axios'
import { httpCgi, type ApiResult } from '@/utils/request'

export const TOKEN_KEY = 'osp-token'

export interface AuthUser {
  id: number
  orgId: number | null
  email: string
  displayName: string
  role: 'platform_super_admin' | 'platform_ops' | 'org_admin' | 'org_member'
  status: string
  /** R2-28：用户级 VIP（升级申请通过） */
  isVip?: boolean
  /** 账号简介（≤20 字） */
  bio?: string
}

export interface AuthOrg {
  id: number
  name: string
  plan: 'free' | 'normal' | 'vip'
  status: 'active' | 'suspended' | 'closed'
  trialEndsAt: string | null
}

export interface LoginResp {
  token: string
  user: AuthUser
  org: AuthOrg | null
}

/** 带业务码的认证错误（msg 为用户可读文案） */
export class AuthError extends Error {
  code: number
  httpStatus?: number
  constructor(msg: string, code: number, httpStatus?: number) {
    super(msg)
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** 统一调用：HTTP 4xx/5xx 转带业务码的 AuthError（管理接口复用） */
export async function cgiCall<T>(cfg: Parameters<typeof httpCgi<T>>[0]): Promise<T> {
  try {
    return await httpCgi<T>(cfg)
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined
    const body = axios.isAxiosError(e) ? (e.response?.data as ApiResult | undefined) : undefined
    if (body?.msg) throw new AuthError(body.msg, body.code, status)
    throw new AuthError('网络异常，请稍后重试', -1, status)
  }
}

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

export function authLogin(email: string, password: string): Promise<LoginResp> {
  return cgiCall<LoginResp>({ method: 'POST', url: '/auth/login', data: { email, password } })
}

/** R2-28：注册只建普通账号，不再提交组织名 */
export function authRegister(payload: {
  email: string
  password: string
  displayName?: string
}): Promise<LoginResp> {
  return cgiCall<LoginResp>({ method: 'POST', url: '/auth/register', data: payload })
}

export function authMe(): Promise<{ user: AuthUser; org: AuthOrg | null }> {
  return cgiCall({ method: 'GET', url: '/auth/me', headers: authHeaders() })
}

/** R2-21：自助修改当前账号密码（仅本人） */
export function authChangePassword(oldPassword: string, newPassword: string): Promise<{ changed: boolean }> {
  return cgiCall({
    method: 'POST',
    url: '/auth/password',
    data: { oldPassword, newPassword },
    headers: authHeaders()
  })
}

export function authUpdateOrg(name: string): Promise<AuthOrg> {
  return cgiCall({ method: 'PATCH', url: '/org', data: { name }, headers: authHeaders() })
}

/** 更新本人账号简介（≤20 字） */
export function authUpdateBio(bio: string): Promise<{ bio: string }> {
  return cgiCall({
    method: 'PATCH',
    url: '/auth/profile',
    data: { bio },
    headers: authHeaders()
  })
}

export interface QuotaItem {
  key: string
  label: string
  unit: 'count' | 'days' | 'bitmap' | 'scope'
  limit: number | null
  usage: number
  overridden: boolean
}

export function authOrgQuota(): Promise<{ plan: string; items: QuotaItem[] }> {
  return cgiCall({ method: 'GET', url: '/org/quota', headers: authHeaders() })
}

/* ---------------- R2-28：VIP 升级申请 ---------------- */

export interface UpgradeRequest {
  id: number
  user_id: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  review_note: string
  reviewed_at: string | null
  created_at: string
}

export interface MyUpgradeRequest {
  isVip: boolean
  status: 'none' | 'pending' | 'approved' | 'rejected'
  request: UpgradeRequest | null
}

export function authGetUpgradeRequest(): Promise<MyUpgradeRequest> {
  return cgiCall({ method: 'GET', url: '/auth/upgrade-request', headers: authHeaders() })
}

export function authSubmitUpgradeRequest(reason: string): Promise<UpgradeRequest> {
  return cgiCall({
    method: 'POST',
    url: '/auth/upgrade-request',
    data: { reason },
    headers: authHeaders()
  })
}

/* ---------------- R2-30：组织管理员管理成员 ---------------- */

export interface OrgMember {
  id: number
  email: string
  display_name: string
  status: string
  created_at: string
}

export function authListOrgMembers(): Promise<{
  items: OrgMember[]
  usage: number
  max: number
  can_manage: boolean
}> {
  return cgiCall({ method: 'GET', url: '/org/members', headers: authHeaders() })
}

export function authCreateOrgMember(payload: {
  email: string
  password: string
  displayName?: string
}): Promise<{ id: number; email: string; role: string }> {
  return cgiCall({ method: 'POST', url: '/org/members', data: payload, headers: authHeaders() })
}

export function authRemoveOrgMember(id: number): Promise<{ id: number; removed: boolean }> {
  return cgiCall({ method: 'DELETE', url: `/org/members/${id}`, headers: authHeaders() })
}
