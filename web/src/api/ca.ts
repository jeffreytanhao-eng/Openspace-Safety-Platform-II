/**
 * 碰撞参数 API（Epic F1）：组织默认 CA 参数 + 事件参数重算（run 化）。
 * defaults/runs 需登录组织账号；重算计入 recompute_day 配额。
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

/* ------------------------- 组织默认参数 ------------------------- */

export type HbrMode = 'single' | 'both'
export type CovMode = 'tle-age' | 'cdm'
export type Propagator = 'sgp4' | 'numeric'
export type PcMethodName = 'official' | 'foster' | 'chan' | 'alfano'

/** 组织默认 CA 参数（ca_org_defaults 行） */
export interface CaDefaults {
  org_id: number
  hbr_mode: HbrMode
  hbr_m: number
  hbr_a_m: number | null
  hbr_b_m: number | null
  accepted_pc: number
  accepted_miss_km: number
  screen_distance_km: number
  covariance_mode: CovMode
  propagator: Propagator
  window_h: number
  step_s: number
  pc_methods: string
  updated_by: string
  updated_at: string
}

/** 系统建议值（服务端权威口径，reason 双语由前端按 locale 取） */
export interface CaSuggestion {
  field: string
  value: number | string
  reason: { zh: string; en: string }
}

export interface CaDefaultsPatch {
  hbr_mode?: HbrMode
  hbr_m?: number
  hbr_a_m?: number | null
  hbr_b_m?: number | null
  accepted_pc?: number
  accepted_miss_km?: number
  screen_distance_km?: number
  covariance_mode?: CovMode
  propagator?: Propagator
  window_h?: number
  step_s?: number
  pc_methods?: string
}

export function getCaDefaults(): Promise<{ defaults: CaDefaults | null; suggestions: CaSuggestion[] }> {
  return cgiCall({ method: 'GET', url: '/ca/defaults', headers: authHeaders() })
}

export function putCaDefaults(patch: CaDefaultsPatch): Promise<{ defaults: CaDefaults }> {
  return cgiCall({ method: 'PUT', url: '/ca/defaults', data: patch, headers: authHeaders() })
}

/* ------------------------- 参数档案（第 3/4 项） ------------------------- */

/** 完整 CA 参数集（组织默认 / 用户两组 / 目标自定义 同构） */
export interface CaParams {
  hbr_mode: HbrMode
  hbr_m: number
  hbr_a_m: number | null
  hbr_b_m: number | null
  accepted_pc: number
  accepted_miss_km: number
  screen_distance_km: number
  covariance_mode: CovMode
  propagator: Propagator
  window_h: number
  step_s: number
  pc_methods: string
}

export interface UserCaSlot {
  slot: number
  params: CaParams | null
  updated_at: string | null
}

export interface CaProfiles {
  org_defaults: CaParams
  suggestions: CaSuggestion[]
  mine: UserCaSlot[]
}

/** 我的参数档案：组织默认 + 系统建议 + 本人 2 组 */
export function getCaProfiles(): Promise<CaProfiles> {
  return cgiCall({ method: 'GET', url: '/ca/profiles', headers: authHeaders() })
}

/** 保存本人第 slot 组参数（在组织默认上覆盖传入字段） */
export function putCaProfile(slot: number, patch: CaDefaultsPatch): Promise<{ slot: number; params: CaParams }> {
  return cgiCall({ method: 'PUT', url: `/ca/profiles/${slot}`, data: patch, headers: authHeaders() })
}

/** 删除本人第 slot 组参数（回到使用默认参数） */
export function deleteCaProfile(slot: number): Promise<{ slot: number; deleted: boolean }> {
  return cgiCall({ method: 'DELETE', url: `/ca/profiles/${slot}`, headers: authHeaders() })
}

/* ------------------------- 参数重算 run ------------------------- */

export interface PcCompareRow {
  method: PcMethodName
  pc: number | null
  missKm: number | null
  tca: string
  hbrM: number
  covSource: string
  ms: number
  disabled: boolean
  note: string
}

export type PcAgreement = 'green' | 'yellow' | 'red'

/** 重算 run 解析后的生效参数 */
export interface RecomputeParams {
  hbr_mode: HbrMode
  hbr_m: number
  hbr_a_m: number | null
  hbr_b_m: number | null
  accepted_pc: number
  accepted_miss_km: number
  screen_distance_km: number
  covariance_mode: CovMode
  propagator: Propagator
  window_h: number
  step_s: number
  methods: Array<'foster' | 'chan' | 'alfano'>
  engine_notes: string[]
}

export interface RecomputeResult {
  run: { id: number; created_at: string; params: RecomputeParams }
  rows: PcCompareRow[]
  agreement: PcAgreement
  plane: { missKm: number; inPlaneKm: number; relSpeedKms: number } | null
  cov: { sigmaT: [number, number]; ageHours: [number, number] } | null
  disableNote: string | null
  notes: string[]
}

export interface RecomputeInput {
  /** 第 3/4 项：参数来源 default（组织默认）| mine1 | mine2（个人参数组）| target（目标自定义，需业主） */
  paramsSource?: 'default' | 'mine1' | 'mine2' | 'target'
  hbrMode?: HbrMode
  hbrM?: number
  hbrAM?: number
  hbrBM?: number
  acceptedPc?: number
  acceptedMissKm?: number
  screenDistanceKm?: number
  covarianceMode?: CovMode
  propagator?: Propagator
  windowH?: number
  stepS?: number
  methods?: Array<'foster' | 'chan' | 'alfano'>
  officialPc?: number | null
  officialMissKm?: number | null
  officialRelSpeedKms?: number | null
}

/** 按此配置重算（新 run_id；参数缺省时回落组织默认/系统缺省） */
export function recomputeEvent(eventKey: string, input: RecomputeInput): Promise<RecomputeResult> {
  return cgiCall({
    method: 'POST',
    url: `/events/${encodeURIComponent(eventKey)}/recompute`,
    data: input,
    headers: authHeaders()
  })
}

/** 重算 run（历史对比用） */
export interface PcRun {
  id: number
  event_key: string
  tca: string
  params: RecomputeParams | null
  rows: PcCompareRow[]
  agreement: PcAgreement | null
  plane: { plane: RecomputeResult['plane']; cov: RecomputeResult['cov'] } | null
  triggered_by: string
  created_at: string
}

/** 本事件 run 历史（本组织，最新在前） */
export function listRecomputeRuns(eventKey: string): Promise<{ runs: PcRun[] }> {
  return cgiCall({
    method: 'GET',
    url: `/events/${encodeURIComponent(eventKey)}/recompute`,
    headers: authHeaders()
  })
}
