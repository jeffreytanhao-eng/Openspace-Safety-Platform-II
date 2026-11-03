/**
 * 筛查任务 API（Epic E1）：发起异步筛查 / 任务列表 / 任务详情 + 交会事件。
 * 全部走 /cgi/screens*，由后端 requireAuth + requireOrg 把关。
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

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed'

/** 筛查任务行 */
export interface ScreenJob {
  id: number
  org_id: number
  triggered_by: string
  status: ScreenJobStatus
  params_json: string | null
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

/** 筛查产出的交会事件 */
export interface ScreenEvent {
  id: number
  job_id: number
  org_id: number
  primary_object_id: number | null
  primary_norad: number
  primary_name: string
  secondary_norad: number
  secondary_name: string
  tca: string
  miss_km: number
  miss_r_km: number | null
  miss_t_km: number | null
  miss_n_km: number | null
  rel_speed_kms: number | null
  pc: number | null
  pc_max: number | null
  pc_method: string
  hbr_m: number | null
  sigma_p_src: string | null
  sigma_p_t_km: number | null
  sigma_s_src: string | null
  sigma_s_t_km: number | null
  sec_epoch: string | null
  sec_age_h: number | null
  level: 'red' | 'orange' | 'yellow'
  diluted: number
  cdm_id: string | null
  cdm_pc: number | null
  pc_source: 'core' | 'cdm'
  created_at: string
}

export function createScreen(payload: {
  windowH?: number
  missMaxKm?: number
  hbrM?: number
}): Promise<ScreenJob> {
  return cgiCall<ScreenJob>({ method: 'POST', url: '/screens', data: payload, headers: headers() })
}

export function listScreens(): Promise<ScreenJob[]> {
  return cgiCall<ScreenJob[]>({ method: 'GET', url: '/screens', headers: headers() })
}

export function getScreen(id: number): Promise<{ job: ScreenJob; events: ScreenEvent[] }> {
  return cgiCall<{ job: ScreenJob; events: ScreenEvent[] }>({
    method: 'GET',
    url: `/screens/${id}`,
    headers: headers()
  })
}
