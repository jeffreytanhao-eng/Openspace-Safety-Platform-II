/**
 * 总览驾驶舱汇总 API（Epic D2）：真实数据聚合。
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

export interface OwnedCdmItem {
  cdm_id: string
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number | null
  collision_probability: number | null
}

export interface OverviewSummary {
  org: { id: number; name: string; plan: string } | null
  owned: number
  ephem: { total: number; fresh: number }
  cdm: {
    total: number
    next24h: number
    next7d: number
    involvingOwned: number
    ownedCdm: OwnedCdmItem[]
  }
  screensToday: number
  running: boolean
  sources: Array<{
    source: 'spacetrack_gp' | 'spacetrack_cdm' | 'aoe'
    state: 'running' | 'success' | 'failed' | 'idle'
    last_success: string | null
    duration_ms: number | null
  }>
}

export function getOverviewSummary(): Promise<OverviewSummary> {
  return cgiCall<OverviewSummary>({ method: 'GET', url: '/overview/summary', headers: headers() })
}
