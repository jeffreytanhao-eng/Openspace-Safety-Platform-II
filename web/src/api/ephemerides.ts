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
  // 带 token 调用（/cgi/ephemerides 要求登录态；公开访问场景带 token 亦无副作用）
  let headers: Record<string, string> = {}
  try {
    const t = localStorage.getItem('osp-token')
    if (t) headers = { Authorization: `Bearer ${t}` }
  } catch { /* ignore */ }
  const res = await fetch(url, { headers })
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
  // 运维级接口：仅平台超管可调用（后端 requireAuth + requireSuperAdmin）
  const token = localStorage.getItem('osp-token')
  const res = await fetch('/cgi/ephemerides/rebuild', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
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

/* --------------------- G1 星历版本归档 --------------------- */

export interface EphVersion {
  id: number
  norad: string
  format: 'ITC' | 'OCM'
  /** upload=管理页上传 / scan=rebuild 扫描 */
  source: string
  /** 版本文件相对路径（versions/…/<sha前16>.txt.gz） */
  file: string
  sha256: string
  bytes: number
  rawBytes: number
  publishedMs: number
  uploadedBy: string
  /** 软删时间戳 ms；null=未删 */
  deletedAt: number | null
  createdAt: string
}

export interface EphVersionListData {
  items: EphVersion[]
  total: number
  page: number
  size: number
  totalPages: number
}

/** 版本历史分页（append 账本；默认只列未软删，includeDeleted 连同软删行返回） */
export function listEphemerisVersions(params?: {
  norad?: string
  format?: 'ITC' | 'OCM'
  page?: number
  size?: number
  includeDeleted?: boolean
}) {
  const qs = new URLSearchParams()
  if (params?.norad) qs.set('norad', params.norad)
  if (params?.format) qs.set('format', params.format)
  if (params?.page != null) qs.set('page', String(params.page))
  if (params?.size != null) qs.set('size', String(params.size))
  if (params?.includeDeleted) qs.set('includeDeleted', '1')
  const qsStr = qs.toString()
  return getJson<EphVersionListData>(`/cgi/ephemerides/versions${qsStr ? '?' + qsStr : ''}`)
}

/** 按版本回放星历全文（gunzip 文本，审计/比对用） */
export async function fetchEphemerisVersionContent(id: number): Promise<string> {
  const res = await fetch(`/cgi/ephemerides/versions/${id}/content`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const body = (await res.json()) as ApiWrap<never>
    throw new Error(body.msg || '读取版本失败')
  }
  return await res.text()
}

/** 软删版本（需登录；行与文件均保留，仅标记 deleted_at） */
export async function softDeleteEphemerisVersion(id: number): Promise<void> {
  const headers: Record<string, string> = {}
  try {
    const t = localStorage.getItem('osp-token')
    if (t) headers.Authorization = `Bearer ${t}`
  } catch { /* ignore */ }
  const res = await fetch(`/cgi/ephemerides/versions/${id}`, { method: 'DELETE', headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiWrap<never> | null
    throw new Error(body?.msg || `HTTP ${res.status}`)
  }
}

/* --------------------- G2 精度对比 --------------------- */

export type AccuracyKind = 'ocm' | 'tle' | 'aoe'

export interface AccuracySourceItem {
  kind: AccuracyKind
  id: string
  name: string
  label: string
  epochMs: number
  startMs: number
  stopMs: number
  points: number
  stepSec: number
}

export interface AccuracyPoint {
  tMs: number
  radialKm: number
  alongKm: number
  crossKm: number
  distKm: number
}

export interface AccuracyCompareResult {
  norad: string
  a: { kind: AccuracyKind; id: string; label: string; epochMs: number }
  b: { kind: AccuracyKind; id: string; label: string; epochMs: number }
  overlap: { startMs: number; stopMs: number }
  samples: number
  rms: {
    radialKm: number
    alongKm: number
    crossKm: number
    totalKm: number
    maxKm: number
    meanKm: number
  }
  points: AccuracyPoint[]
  warnings: string[]
}

/** 某 NORAD 可参与精度对比的源（OCM 星历 + 系统 TLE + AOE），需登录 */
export async function fetchAccuracySources(norad: string): Promise<AccuracySourceItem[]> {
  const headers: Record<string, string> = {}
  try {
    const t = localStorage.getItem('osp-token')
    if (t) headers.Authorization = `Bearer ${t}`
  } catch { /* ignore */ }
  const res = await fetch(`/cgi/ephemerides/accuracy/sources?norad=${encodeURIComponent(norad)}`, { headers })
  const body = (await res.json().catch(() => null)) as ApiWrap<{ sources: AccuracySourceItem[] }> | null
  if (!res.ok || !body || body.code !== 0 || !body.data) throw new Error(body?.msg || `HTTP ${res.status}`)
  return body.data.sources
}

/** 两源 RTN 残差对比（需登录），无重叠时段 / 数据不足时抛业务错误 */
export async function postAccuracyCompare(payload: {
  norad: string
  a: { kind: AccuracyKind; id?: string }
  b: { kind: AccuracyKind; id?: string }
  maxPoints?: number
}): Promise<AccuracyCompareResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const t = localStorage.getItem('osp-token')
    if (t) headers.Authorization = `Bearer ${t}`
  } catch { /* ignore */ }
  const res = await fetch('/cgi/ephemerides/accuracy/compare', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
  const body = (await res.json().catch(() => null)) as ApiWrap<AccuracyCompareResult> | null
  if (!res.ok || !body || body.code !== 0 || !body.data) throw new Error(body?.msg || `HTTP ${res.status}`)
  return body.data
}
