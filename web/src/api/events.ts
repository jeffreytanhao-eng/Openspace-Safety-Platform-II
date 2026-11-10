/**
 * 交会事件 API（Epic E2）：列表 / 详情 / CDM 原文（R0-1 需登录）+ CDM 导入（需登录组织）。
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
  /** R1-1：等级依据（pc = Pc 分档；miss = 无 Pc 时按脱靶距离兜底） */
  levelBasis?: 'pc' | 'miss' | 'none'
  pc: number | null
  pcSource: string
  missKm: number | null
  relSpeedKmS: number | null
  sources: string[]
  /** C3：含客户上传成员 → org_credential，否则 system_pool */
  dataSource?: 'system_pool' | 'org_credential'
  /** 筛查事件：产出该事件的 screening_jobs.id；详情跳转到 /screens/{jobId} */
  jobId?: number
}

/** 交会列表数据源：CDM 走 sat_cdm；tle/ephem/aoe 走本组织已完成筛查任务 */
export type EventSource = 'cdm' | 'tle' | 'ephem' | 'aoe'

/** 关注阈值（与 api/src/screen/levels.ts PC_YELLOW 一致）；低于此且非稀释关注档的事件不进总览 */
export const PC_WATCH = 1e-7

export function isBelowWatchPc(e: Pick<ConjunctionEvent, 'pc' | 'level' | 'levelBasis'>): boolean {
  if (e.pc === null || !Number.isFinite(e.pc)) return false
  if (e.pc >= PC_WATCH) return false
  // 稀释关注：中心 Pc 低于 1e-7 但已按 Pc 口径标为黄/橙/红，保留
  if (e.levelBasis === 'pc' && (e.level === 'yellow' || e.level === 'orange' || e.level === 'red')) {
    return false
  }
  return true
}

export function eventDetailPath(e: Pick<ConjunctionEvent, 'key' | 'jobId'>): string {
  if (e.jobId != null && Number.isFinite(e.jobId) && e.jobId > 0) {
    return `/screens/${e.jobId}`
  }
  return `/conjunctions/${encodeURIComponent(e.key)}`
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

/** scope=all 全部交会；mine 仅本组织关注/认领目标参与的星对 */
export function listEvents(
  window: '24h' | '3d' | '7d' | 'all',
  scope: 'all' | 'mine' = 'all',
  eventSource: EventSource = 'cdm'
): Promise<{ events: ConjunctionEvent[]; hasScreenJobs?: boolean }> {
  return cgiCall<{ events: ConjunctionEvent[]; hasScreenJobs?: boolean }>({
    method: 'GET',
    url: `/events?window=${encodeURIComponent(window)}&scope=${encodeURIComponent(scope)}&eventSource=${encodeURIComponent(eventSource)}`,
    headers: authHeaders()
  })
}

export function getEvent(key: string): Promise<{
  event: ConjunctionEvent
  cdms: CdmMember[]
  primary: TleProfile | null
  secondary: TleProfile | null
}> {
  return cgiCall({ method: 'GET', url: `/events/${encodeURIComponent(key)}`, headers: authHeaders() })
}

export function getCdmRaw(key: string, cdmId: number): Promise<{ id: number; cdm_id: string | null; raw: string }> {
  return cgiCall({
    method: 'GET',
    url: `/events/${encodeURIComponent(key)}/cdm/${cdmId}/raw`,
    headers: authHeaders()
  })
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

/** 多算法 Pc 比对：同源输入由服务端统一 TLE 传播，官方 Pc 仅作对照行（R0-1 需登录） */
export function pcCompare(p: PcCompareParams): Promise<PcCompareResult> {
  return cgiCall({ method: 'POST', url: '/events/pc-compare', data: p, headers: authHeaders() })
}

/** R2-20：近期 CDM 报文（系统池，由后端按档位历史窗隔离；前端按 NORAD 过滤） */
export interface RecentCdm {
  cdm_id: string | null
  creation_date: string | null
  tca: string | null
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
}

/** R2-20：近端 CDM 列表（只读聚合，不做本地缓存） */
export function listRecentCdms(limit = 500): Promise<{ total: number; items: RecentCdm[] }> {
  return cgiCall({
    method: 'GET',
    url: '/catalog/cdms',
    params: { limit },
    headers: authHeaders()
  })
}

/** R2-16：TCA 附近相对运动采样点（R/I/C 为相对位置在主星 UVW 基上的分量，单位 km） */
export interface RelMotionSample {
  tMs: number
  dR: number
  dI: number
  dC: number
  dist: number
}

export interface RelMotionResult {
  noradA: number
  noradB: number
  tcaMs: number
  minutes: number
  stepS: number
  source: string
  names: { a: string; b: string }
  samples: RelMotionSample[]
}

/** R2-16：相对运动时间序列（服务端 TLE/SGP4 传播 + 主星 UVW 投影） */
export function getRelativeMotion(key: string, minutes = 30, stepS = 30): Promise<RelMotionResult> {
  return cgiCall({
    method: 'GET',
    url: `/events/${encodeURIComponent(key)}/relative-motion`,
    params: { minutes, stepS },
    headers: authHeaders()
  })
}
