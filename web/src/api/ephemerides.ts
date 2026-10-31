/** 本地星历样本 API（data/ephemerides，由 /cgi/ephemerides 提供） */
export interface EphManeuverEpoch {
  t: number
  dvMps: number
  /** OCM MAN_DURA（秒）；缺省时按瞬时机动处理 */
  duraSec?: number
  id?: string
}

export interface EphListItem {
  id: string
  objectId: string
  name: string
  norad: string
  format: 'ITC' | 'OCM' | 'OEM' | 'TLE'
  points: number
  step: string
  stepSec: number
  range: string
  startMs: number
  stopMs: number
  status: 'synced' | 'local' | 'stale' | 'uploading' | 'error'
  size: string
  covariance: boolean
  covFrame?: string
  maneuvers: number
  maneuverSummary: string
  maneuverEpochs: EphManeuverEpoch[]
  updatedAt: string
  originator?: string
  file: string
}

export interface EphListData {
  root: string
  generatedAt: string | null
  items: EphListItem[]
}

interface ApiWrap<T> {
  code: number
  msg: string
  data: T | null
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as ApiWrap<T>
  if (body.code !== 0 || body.data == null) throw new Error(body.msg || 'api error')
  return body.data
}

export function listLocalEphemerides() {
  return getJson<EphListData>('/cgi/ephemerides')
}

export function getEphemerisMeta(id: string) {
  return getJson<EphListItem>(`/cgi/ephemerides/meta/${encodeURIComponent(id)}`)
}

/** 拉取解压后的星历文本（ITC / OCM） */
export async function fetchEphemerisText(filePath: string): Promise<string> {
  const res = await fetch(`/cgi/ephemerides/file?path=${encodeURIComponent(filePath)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const body = (await res.json()) as ApiWrap<never>
    throw new Error(body.msg || '读取星历失败')
  }
  return await res.text()
}
