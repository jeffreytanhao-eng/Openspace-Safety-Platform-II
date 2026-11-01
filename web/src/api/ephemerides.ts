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
  /** 发布时间（OCM CREATION_DATE / ITC CREATED，毫秒；0 = 未知） */
  publishedMs?: number
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
  /** 'db' = MySQL 元数据库，'file' = index.json 回退 */
  source?: 'db' | 'file'
  items: EphListItem[]
  /** 仅分页模式返回 */
  total?: number
  page?: number
  size?: number
  totalPages?: number
  /** 可选，供前端 IndexedDB 与服务端行去重（norad|format） */
  allKeys?: string[]
  /** legacy 全量模式返回 */
  truncated?: boolean
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

/** 列出星历（支持分页/筛选/搜索；无参时走 legacy 全量模式） */
export function listLocalEphemerides(params?: {
  page?: number
  size?: number
  format?: 'ITC' | 'OCM'
  q?: string
  keys?: boolean
}) {
  const qs = new URLSearchParams()
  if (params?.page != null) qs.set('page', String(params.page))
  if (params?.size != null) qs.set('size', String(params.size))
  if (params?.format) qs.set('format', params.format)
  if (params?.q) qs.set('q', params.q)
  if (params?.keys) qs.set('keys', '1')
  const qsStr = qs.toString()
  return getJson<EphListData>(`/cgi/ephemerides${qsStr ? '?' + qsStr : ''}`)
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

/** 上传单文件（原始字节流；后端识别格式并入库，返回 added/updated/skipped 与落盘路径） */
export async function uploadEphemerisFile(file: File | Blob, name: string): Promise<{
  action: 'added' | 'updated' | 'skipped'
  id: string
  file: string
  name: string
  norad: string
  format: 'ITC' | 'OCM'
  range: string
  size: string
}> {
  const url = `/cgi/ephemerides/upload?name=${encodeURIComponent(name)}`
  const buf = await file.arrayBuffer()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(buf)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `HTTP ${res.status}`
    try {
      const j = JSON.parse(text) as ApiWrap<never>
      if (j.msg) msg = j.msg
    } catch { /* keep HTTP code */ }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiWrap<{
    action: 'added' | 'updated' | 'skipped'
    id: string
    file: string
    name: string
    norad: string
    format: 'ITC' | 'OCM'
    range: string
    size: string
  }>
  if (body.code !== 0 || !body.data) throw new Error(body.msg || '上传失败')
  return body.data
}

/** 触发后端增量扫描入库（通常在首次部署 / 手动补齐缺失样本时使用） */
export async function rebuildEphemerides(): Promise<{
  added: number
  updated: number
  skipped: number
  removed: number
  total: number
  db: 'up' | 'down'
}> {
  const res = await fetch('/cgi/ephemerides/rebuild', { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as ApiWrap<{
    added: number
    updated: number
    skipped: number
    removed: number
    total: number
    db: 'up' | 'down'
  }>
  if (body.code !== 0 || !body.data) throw new Error(body.msg || '扫描入库失败')
  return body.data
}
