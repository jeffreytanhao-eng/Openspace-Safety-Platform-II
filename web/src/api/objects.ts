/**
 * 目标 API（Epic D1）：组织认领 NORAD 目标 + 档案维护 + 星历绑定。
 * 全部走 /cgi/objects/*，由后端 requireAuth + requireOrg 把关。
 */
import { cgiCall } from './auth'

function headers(): Record<string, string> {
  try {
    const t = localStorage.getItem('osp-token')
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

/** 认领前预览：编目最新轨道要素 */
export interface SatTlePreview {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  epoch: string | null
  incl: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
}

/** 认领类型：normal=普通（学习/教学/模拟科研，可多组织重复）/ owner=授权（卫星业主，全局唯一） */
export type ClaimType = 'normal' | 'owner'

/** 本组织目标行 */
export interface ManagedObject {
  id: number
  org_id: number
  norad_id: number
  name: string
  mass_kg: number | null
  cross_section_m2: number | null
  propulsion: string
  accepted_pc: number | null
  accepted_miss_km: number | null
  claim_status: string
  claim_type: ClaimType
  created_at: string
  updated_at: string
  /** 绑定的星历数（列表接口附带） */
  bound_ephemerides?: number
}

/** 目标详情：档案 + 最新轨道要素 + 绑定星历 */
export interface ObjectDetail extends ManagedObject {
  sat: SatTlePreview | null
  ephemerides: Array<{
    id: string
    name: string
    norad: string
    format: string
    points: number
    published_at: number
    status: string
  }>
}

export interface LookupResult {
  sat: SatTlePreview
  /** 该 NORAD 的授权认领（卫星业主，全局唯一） */
  owner_claim: { id: number; orgId: number; isMine: boolean } | null
  /** 本组织对该 NORAD 的认领（normal/owner，最多一条） */
  my_claim: { id: number; claimType: ClaimType } | null
}

export function lookupObject(norad: number | string): Promise<LookupResult> {
  return cgiCall<LookupResult>({ method: 'GET', url: `/objects/lookup/${norad}`, headers: headers() })
}

export function listObjects(): Promise<ManagedObject[]> {
  return cgiCall<ManagedObject[]>({ method: 'GET', url: '/objects', headers: headers() })
}

/** R2-2：批量认领结果（冲突/配额逐条裁剪） */
export interface BatchClaimResult {
  created: Array<{ id: number; norad_id: number; name: string }>
  skipped: Array<{ norad: number; reason: 'not_found' | 'already_mine' | 'quota' | 'error' }>
  quota: { plan: string; usage: number; limit: number | null; remaining: number | null }
}

export function batchClaimObjects(norads: number[]): Promise<BatchClaimResult> {
  return cgiCall<BatchClaimResult>({
    method: 'POST',
    url: '/objects/batch-claim',
    data: { norads },
    headers: headers()
  })
}

/** 档位配额（R2-3：用量/限额展示） */
export interface OrgQuotaItem {
  key: string
  label: string
  unit: 'count' | 'days' | 'bitmap' | 'scope'
  limit: number | null
  usage: number
  overridden: boolean
}

export function getOrgQuota(): Promise<{ plan: string; items: OrgQuotaItem[] }> {
  return cgiCall<{ plan: string; items: OrgQuotaItem[] }>({
    method: 'GET',
    url: '/org/quota',
    headers: headers()
  })
}

/** R2-2：编目轻量检索（名称 / NORAD / 标签式前缀；只取关键列用于发现列表） */
export interface CatalogLiteRow {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  epoch: string | null
}

export function searchCatalogLite(q: string, limit = 50): Promise<{ total: number; items: CatalogLiteRow[] }> {
  const qs = new URLSearchParams({ q, limit: String(limit) })
  return cgiCall<{ total: number; items: CatalogLiteRow[] }>({
    method: 'GET',
    url: `/catalog/tles?${qs}`,
    headers: headers()
  })
}

export function claimObject(payload: {
  noradId: number
  claimType?: ClaimType
  name?: string
  massKg?: number | null
  crossSectionM2?: number | null
  propulsion?: string
}): Promise<ObjectDetail> {
  return cgiCall<ObjectDetail>({ method: 'POST', url: '/objects', data: payload, headers: headers() })
}

export function getObject(id: number): Promise<ObjectDetail> {
  return cgiCall<ObjectDetail>({ method: 'GET', url: `/objects/${id}`, headers: headers() })
}

export function updateObject(
  id: number,
  patch: {
    name?: string
    massKg?: number | null
    crossSectionM2?: number | null
    propulsion?: string
    acceptedPc?: number | null
    acceptedMissKm?: number | null
  }
): Promise<ObjectDetail> {
  return cgiCall<ObjectDetail>({ method: 'PATCH', url: `/objects/${id}`, data: patch, headers: headers() })
}

export function releaseObject(id: number): Promise<{ released: number }> {
  return cgiCall<{ released: number }>({ method: 'DELETE', url: `/objects/${id}`, headers: headers() })
}

export function bindEphem(id: number, ephemId: string): Promise<{ bound: string; to: number }> {
  return cgiCall({ method: 'POST', url: `/objects/${id}/bind-ephem`, data: { ephemId }, headers: headers() })
}

export function unbindEphem(id: number, ephemId: string): Promise<{ unbound: string }> {
  return cgiCall({ method: 'POST', url: `/objects/${id}/unbind-ephem`, data: { ephemId }, headers: headers() })
}

/** R0-2：目标根数同步自检（系统池 TLE 可用性/龄期） */
export interface SyncTleResult {
  total: number
  with_tle: number
  missing: number
  missing_norads: number[]
  stale_7d: number
  oldest_epoch_ms: number | null
  newest_epoch_ms: number | null
  items: Array<{
    id: number
    norad_id: number
    name: string
    has_tle: boolean
    epoch_ms: number | null
    age_days: number | null
  }>
}

export function syncTle(): Promise<SyncTleResult> {
  return cgiCall<SyncTleResult>({ method: 'POST', url: '/objects/sync-tle', headers: headers() })
}
