/**
 * 火箭发射预报（docs/public-api.md）：由后端 /cgi/launches 代理外部接口并注入 Key。
 */
import { cgiCall } from './auth'

export interface LaunchText {
  en: string
  zh?: string
}

export interface LaunchOrbitType {
  value: string
  confirmed: boolean
  label: LaunchText
}

export interface LaunchStatus {
  value: string
  code: string
  label: LaunchText
  probability: number | null
}

export interface LaunchSite {
  launch_site: LaunchText
  pad: LaunchText
  country: { code: string; name: LaunchText }
  latitude: number | null
  longitude: number | null
}

export interface LaunchEstimate {
  azimuth_deg: number | null
  azimuth_source: string
  inclination_deg: number | null
  inclination_basis: string
  orbit_family_inferred: string | null
  altitude_km: number | null
  apogee_km: number | null
  confidence: number | null
  notes: string[]
}

export interface LaunchOrbitElements {
  a_km: number
  ecc: number
  inc_deg: number
  raan_deg: number
  argp_deg: number
  mean_anomaly_deg: number
  n_rev_day: number
  period_min: number
  alt_km: number
  apogee_km: number
  perigee_km: number
}

export interface LaunchInitialOrbit {
  model: string
  epoch: string
  elements: LaunchOrbitElements
  tle: string[]
  liftoff_error_km: number | null
  assumptions: Record<string, string | number>
  notes: string[]
}

export interface LaunchPayloadObject {
  name?: string
  norad_id?: string | number
}

export interface LaunchPayload {
  status: 'named' | 'unknown' | 'classified'
  status_zh?: string
  summary: LaunchText
  objects: LaunchPayloadObject[]
  truncated: boolean
}

export interface LaunchSimulation {
  image: { url: string; width: number; height: number; format: string } | null
  layers: string[]
}

export interface LaunchItem {
  id: string
  name: LaunchText
  rocket: string
  launch_service_provider: string
  summary: LaunchText
  mission_type: LaunchText | null
  net: string
  window: { start: string; end: string } | null
  status: LaunchStatus
  orbit_type: LaunchOrbitType
  payload: LaunchPayload
  site: LaunchSite
  estimate: LaunchEstimate | null
  initial_orbit: LaunchInitialOrbit | null
  simulation: LaunchSimulation | null
  source_url?: string
  data_source?: string
}

export interface LaunchList {
  generated_at: string
  window: { days: number; basis: string; from: string; to: string }
  count: number
  disclaimer: string
  items: LaunchItem[]
}

export function getLaunches(windowDays = 5): Promise<LaunchList> {
  return cgiCall<LaunchList>({ method: 'GET', url: '/launches', params: { window_days: windowDays } })
}

export function getLaunch(id: string): Promise<LaunchItem> {
  return cgiCall<LaunchItem>({ method: 'GET', url: `/launches/${encodeURIComponent(id)}` })
}

/**
 * 同源代理地址：服务端带 Key 拉取 SVG（<img> 无法附加自定义请求头）。
 * 版本号在仿真图内容调整后递增，用于绕过浏览器 24h 图片缓存。
 */
const MAP_VERSION = '2'

export function launchMapUrl(id: string): string {
  return `/cgi/launches/${encodeURIComponent(id)}/map.svg?v=${MAP_VERSION}`
}
