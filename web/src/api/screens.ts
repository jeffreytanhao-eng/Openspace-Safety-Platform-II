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

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

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
  /** R0-3：执行进度（0-100）与阶段文案 */
  progress_pct: number
  progress_note: string | null
  /** R0-3：已请求取消（running 时等待执行侧终止） */
  cancel_requested: number
  /** R2-8：主星状态源 tle | ephem | aoe */
  primary_source: string
  /** R2-8：副星/对照源 catalog | cdm | aoe */
  secondary_source: string
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
  /** 第 3/4 项：参数来源 default（组织默认）| mine1 | mine2（个人参数组）| target（目标自定义，仅单主星业主） */
  paramsSource?: 'default' | 'mine1' | 'mine2' | 'target'
  /** R0-2：主星子集（本组织托管 NORAD），不传则全部目标 */
  primaryNorads?: number[]
  /** R2-8：主星源 tle（系统池/组织快照）| ephem（已绑定精密星历）| aoe（系统池 AOE 根数） */
  primarySource?: 'tle' | 'ephem' | 'aoe'
  /** R2-8：副星/对照源 catalog（编目 GP）| cdm（已入站 CDM 复核）| aoe（系统池 AOE 编目） */
  secondarySource?: 'catalog' | 'cdm' | 'aoe'
}): Promise<ScreenJob> {
  return cgiCall<ScreenJob>({ method: 'POST', url: '/screens', data: payload, headers: headers() })
}

export function listScreens(): Promise<ScreenJob[]> {
  return cgiCall<ScreenJob[]>({ method: 'GET', url: '/screens', headers: headers() })
}

export interface ScreenJobList {
  items: ScreenJob[]
  total: number
  page: number
  limit: number
  hasActive: boolean
}

/** 筛查任务服务端分页（每页默认 10 条，total 为该可见范围内的全部任务数） */
export function listScreensPage(
  page: number,
  limit = 10,
  around?: number
): Promise<ScreenJobList> {
  const params: Record<string, number> = { page, limit }
  if (around != null && around > 0) params.around = around
  return cgiCall<ScreenJobList>({ method: 'GET', url: '/screens', params, headers: headers() })
}

export function getScreen(id: number): Promise<{ job: ScreenJob; events: ScreenEvent[] }> {
  return cgiCall<{ job: ScreenJob; events: ScreenEvent[] }>({
    method: 'GET',
    url: `/screens/${id}`,
    headers: headers()
  })
}

/** R0-3：取消任务（queued 立即取消；running 置取消请求，执行侧随后终止） */
export function cancelScreen(id: number): Promise<{ cancel: 'cancelled' | 'requested'; job: ScreenJob }> {
  return cgiCall<{ cancel: 'cancelled' | 'requested'; job: ScreenJob }>({
    method: 'POST',
    url: `/screens/${id}/cancel`,
    headers: headers()
  })
}
