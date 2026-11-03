/**
 * 托管目标 API（Epic D1）：组织认领 NORAD 目标 + 档案维护 + 星历绑定。
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

/** 本组织托管目标行 */
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
  claimed_by: { orgId: number; id: number } | null
}

export function lookupObject(norad: number | string): Promise<LookupResult> {
  return cgiCall<LookupResult>({ method: 'GET', url: `/objects/lookup/${norad}`, headers: headers() })
}

export function listObjects(): Promise<ManagedObject[]> {
  return cgiCall<ManagedObject[]>({ method: 'GET', url: '/objects', headers: headers() })
}

export function claimObject(payload: {
  noradId: number
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
