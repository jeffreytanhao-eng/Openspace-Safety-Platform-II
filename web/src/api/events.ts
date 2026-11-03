/**
 * 交会事件 API（Epic E2）：列表 / 详情 / CDM 原文（公开只读）+ CDM 导入（需登录组织）。
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

export type EventLevel = 'red' | 'orange' | 'yellow' | 'low'

/** 聚合事件（同一主/副星对 + 近 TCA 的 CDM 岛） */
export interface ConjunctionEvent {
  key: string
  noradA: number
  noradB: number
  nameA: string
  nameB: string
  tca: string
  tcaSpanH: number
  cdmCount: number
  level: EventLevel
  pc: number | null
  pcSource: string
  missKm: number | null
  relSpeedKmS: number | null
  sources: string[]
}

/** 成员 CDM（不含原文） */
export interface CdmMember {
  id: number
  cdm_id: string | null
  creation_date: string
  originator: string | null
  tca: string
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
  hard_body_radius_m: number | null
  source: string
}

/** sat_tle 档案摘要 */
export interface TleProfile {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
  regime: string
  epoch: string | null
  incl: number | null
  ecc: number | null
  apogee: number | null
  perigee: number | null
  period: number | null
  tle_line1: string
  tle_line2: string
  is_active: number
  updated_at: string | null
}

export function listEvents(window: '24h' | '3d' | '7d' | 'all'): Promise<{ events: ConjunctionEvent[] }> {
  return cgiCall<{ events: ConjunctionEvent[] }>({
    method: 'GET',
    url: `/events?window=${encodeURIComponent(window)}`
  })
}

export function getEvent(key: string): Promise<{
  event: ConjunctionEvent
  cdms: CdmMember[]
  primary: TleProfile | null
  secondary: TleProfile | null
}> {
  return cgiCall({ method: 'GET', url: `/events/${encodeURIComponent(key)}` })
}

export function getCdmRaw(key: string, cdmId: number): Promise<{ id: number; cdm_id: string | null; raw: string }> {
  return cgiCall({ method: 'GET', url: `/events/${encodeURIComponent(key)}/cdm/${cdmId}/raw` })
}

export function importCdm(text: string): Promise<{ parsed: number; inserted: number; updated: number; skipped: number }> {
  return cgiCall({
    method: 'POST',
    url: '/events/import',
    data: { text },
    headers: authHeaders()
  })
}

/* --------------------- Pc 多算法比对（E3） --------------------------- */

export type PcMethod = 'official' | 'foster' | 'chan' | 'alfano'
export type PcAgreement = 'green' | 'yellow' | 'red'

export interface PcCompareRow {
  method: PcMethod
  pc: number | null
  missKm: number | null
  tca: string
  hbrM: number
  covSource: string
  ms: number
  disabled: boolean
  note: string
}

export interface PcCompareResult {
  rows: PcCompareRow[]
  agreement: PcAgreement
  plane: { missKm: number; inPlaneKm: number; relSpeedKms: number } | null
  cov: { sigmaT: [number, number]; ageHours: [number, number] } | null
}

export interface PcCompareParams {
  noradA: number
  noradB: number
  tcaMs: number
  hbrM?: number
  officialPc?: number
  officialMissKm?: number
  officialRelSpeedKms?: number
}

/** 多算法 Pc 比对：同源输入由服务端统一 TLE 传播，官方 Pc 仅作对照行 */
export function pcCompare(p: PcCompareParams): Promise<PcCompareResult> {
  return cgiCall({ method: 'POST', url: '/events/pc-compare', data: p })
}
