/**
 * 机动候选 API（Epic J 占位任务）：机动候选管理 + 机动后 10 天防新交会再筛查。
 * 全部走 /cgi/objects/:id/maneuvers 与 /cgi/maneuvers/:id，由后端 requireAuth + 组织隔离把关。
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

export type ManeuverStatus = 'proposed' | 'approved' | 'executed' | 'cancelled'

/** 机动方向（与后端枚举一致） */
export type ManeuverDirection = 'prograde' | 'retrograde' | 'radial' | 'cross_track' | 'other'

/** 机动候选行（后端已把时间序列转为 ISO 串） */
export interface ManeuverPlan {
  id: number
  org_id: number
  object_id: number
  norad_id: number
  object_name: string
  event_key: string | null
  event_tca: string | null
  event_level: string | null
  window_start: string
  window_end: string
  dv_m_s: number | null
  direction: ManeuverDirection
  status: ManeuverStatus
  rescreen_job_id: number | null
  rescreen_at: string | null
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ManeuverInput {
  windowStart: string
  windowEnd: string
  dvMs?: number | null
  direction?: string
  eventKey?: string | null
  eventTca?: string | null
  eventLevel?: string | null
  notes?: string | null
}

/** 再筛查任务（screening_jobs 行的子集） */
export interface RescreenJob {
  id: number
  status: 'queued' | 'running' | 'done' | 'failed'
  window_h: number
  miss_max_km: number
  hbr_m: number
  n_primary: number
  n_secondary: number
  n_candidates: number
  n_events: number
  error_message: string | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number
}

/** 再筛查产出的交会事件（conjunction_events 行的子集） */
export interface RescreenEvent {
  id: number
  primary_norad: number
  secondary_norad: number
  secondary_name: string
  tca: string
  miss_km: number
  pc: number | null
  pc_source: string
  level: 'red' | 'orange' | 'yellow'
  diluted: number
}

export interface RescreenResult {
  job: RescreenJob
  events: RescreenEvent[]
  summary: { n_events: number; worst_level: 'red' | 'orange' | 'yellow' | null; max_pc: number | null }
  maneuver: ManeuverPlan | null
}

export function listManeuvers(objectId: number): Promise<{ items: ManeuverPlan[] }> {
  return cgiCall({ method: 'GET', url: `/objects/${objectId}/maneuvers`, headers: headers() })
}

export function createManeuver(objectId: number, payload: ManeuverInput): Promise<ManeuverPlan> {
  return cgiCall({ method: 'POST', url: `/objects/${objectId}/maneuvers`, data: payload, headers: headers() })
}

export function updateManeuver(
  id: number,
  patch: Partial<{ status: ManeuverStatus; windowStart: string; windowEnd: string; dvMs: number | null; direction: string; notes: string | null }>
): Promise<ManeuverPlan> {
  return cgiCall({ method: 'PATCH', url: `/maneuvers/${id}`, data: patch, headers: headers() })
}

export function deleteManeuver(id: number): Promise<{ deleted: number }> {
  return cgiCall({ method: 'DELETE', url: `/maneuvers/${id}`, headers: headers() })
}

export function startRescreen(id: number): Promise<{ job: RescreenJob; maneuver: ManeuverPlan | null }> {
  return cgiCall({ method: 'POST', url: `/maneuvers/${id}/rescreen`, data: {}, headers: headers() })
}

export function getRescreen(id: number): Promise<RescreenResult> {
  return cgiCall({ method: 'GET', url: `/maneuvers/${id}/rescreen`, headers: headers() })
}
