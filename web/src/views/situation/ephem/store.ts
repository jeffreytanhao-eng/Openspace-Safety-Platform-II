/**
 * 用户星历的本地持久化（IndexedDB，纯前端，不上传服务器）。
 *
 * 三个对象仓库：
 * - `meta`  ：列表用的轻量元数据（不含量历状态点，打开面板即可秒列）；
 * - `states`：完整状态序列（含可选的 6×6 协方差 Float64Array，结构化克隆原生支持）；
 * - `threatEvents`：每份星历最近一次威胁筛选的结果（刷新后可恢复事件列表与热力页签）。
 *
 * IndexedDB 不可用时（隐私模式 / 受限 WebView）降级为内存 Map，功能仍可用，只是刷新后丢失。
 */
import type { EphemFormat, EphemFrame, EphemSet, EphemState, ThreatEvent } from './types'

const DB_NAME = 'openspace-ephem'
const DB_VERSION = 2
const META = 'meta'
const STATES = 'states'
/** 威胁筛选结果（按星历 id 一行，刷新页面后可恢复列表与热力页签） */
const EVENTS = 'threatEvents'

/** 列表项元数据 */
export interface EphemMeta {
  id: string
  norad: number
  name: string
  format: EphemFormat
  frame: EphemFrame
  source: 'upload' | 'builtin'
  createdAt: number
  start: number
  stop: number
  stepSec: number
  points: number
  hasCov: boolean
  warnings: string[]
}

interface StatesRow {
  id: string
  states: EphemState[]
}

/** 一次筛选结果（按 setId 一行覆盖写；selfName 供热力面板「我的星历」页签展示） */
export interface ThreatEventRow {
  setId: string
  selfName: string
  selfNorad: number
  savedAt: number
  events: ThreatEvent[]
}

let dbPromise: Promise<IDBDatabase | null> | null = null
/** IndexedDB 不可用时的内存兜底 */
const memMeta = new Map<string, EphemMeta>()
const memStates = new Map<string, EphemState[]>()
const memEvents = new Map<string, ThreatEventRow>()

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STATES)) db.createObjectStore(STATES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: 'setId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(store, mode)
          const req = fn(t.objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}

/** EphemSet → 元数据 */
export function toMeta(set: EphemSet): EphemMeta {
  return {
    id: set.id,
    norad: set.norad,
    name: set.name,
    format: set.format,
    frame: set.frame,
    source: set.source,
    createdAt: set.createdAt,
    start: set.start,
    stop: set.stop,
    stepSec: set.stepSec,
    points: set.states.length,
    hasCov: set.states.some((s) => !!s.cov),
    warnings: set.warnings
  }
}

/** 写入（同 id 覆盖） */
export async function putSet(set: EphemSet): Promise<void> {
  const meta = toMeta(set)
  const db = await openDb()
  if (!db) {
    memMeta.set(meta.id, meta)
    memStates.set(meta.id, set.states)
    return
  }
  await Promise.all([
    tx(META, 'readwrite', (s) => s.put(meta)),
    tx(STATES, 'readwrite', (s) => s.put({ id: set.id, states: set.states } as StatesRow))
  ])
}

/** 全部元数据，按创建时间倒序 */
export async function listMetas(): Promise<EphemMeta[]> {
  const db = await openDb()
  if (!db) return [...memMeta.values()].sort((a, b) => b.createdAt - a.createdAt)
  const all = (await tx<EphemMeta[]>(META, 'readonly', (s) => s.getAll())) || []
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

/** 读取完整星历；不存在返回 null */
export async function getSet(id: string): Promise<EphemSet | null> {
  const meta = await getMeta(id)
  if (!meta) return null
  const db = await openDb()
  let states: EphemState[] | undefined
  if (!db) states = memStates.get(id)
  else {
    const row = await tx<StatesRow>(STATES, 'readonly', (s) => s.get(id))
    states = row?.states
  }
  if (!states?.length) return null
  return {
    id: meta.id,
    norad: meta.norad,
    name: meta.name,
    format: meta.format,
    frame: meta.frame,
    source: meta.source,
    createdAt: meta.createdAt,
    start: meta.start,
    stop: meta.stop,
    stepSec: meta.stepSec,
    states,
    warnings: meta.warnings
  }
}

async function getMeta(id: string): Promise<EphemMeta | null> {
  const db = await openDb()
  if (!db) return memMeta.get(id) || null
  return (await tx<EphemMeta>(META, 'readonly', (s) => s.get(id))) || null
}

/** 删除一份星历（元数据 + 状态点） */
export async function deleteSet(id: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    memMeta.delete(id)
    memStates.delete(id)
    return
  }
  await Promise.all([
    tx(META, 'readwrite', (s) => s.delete(id)),
    tx(STATES, 'readwrite', (s) => s.delete(id))
  ])
}

/** 删除一份星历的威胁事件（随星历一起清理，避免孤儿行） */
export async function deleteThreatEvents(setId: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    memEvents.delete(setId)
    return
  }
  await tx(EVENTS, 'readwrite', (s) => s.delete(setId))
}

/** 写入某份星历的筛选结果（同 setId 覆盖；events 需为普通对象，不能是 Vue 响应式 Proxy） */
export async function putThreatEvents(row: ThreatEventRow): Promise<void> {
  const db = await openDb()
  if (!db) {
    memEvents.set(row.setId, row)
    return
  }
  await tx(EVENTS, 'readwrite', (s) => s.put(row))
}

/** 读取某份星历上次的筛选结果；没有则返回 null */
export async function getThreatEvents(setId: string): Promise<ThreatEventRow | null> {
  const db = await openDb()
  if (!db) return memEvents.get(setId) || null
  return (await tx<ThreatEventRow>(EVENTS, 'readonly', (s) => s.get(setId))) || null
}

/** 全部筛选结果（热力面板「我的星历」页签用），按保存时间倒序 */
export async function listThreatEventRows(): Promise<ThreatEventRow[]> {
  const db = await openDb()
  if (!db) return [...memEvents.values()].sort((a, b) => b.savedAt - a.savedAt)
  const all = (await tx<ThreatEventRow[]>(EVENTS, 'readonly', (s) => s.getAll())) || []
  return all.sort((a, b) => b.savedAt - a.savedAt)
}

/** 存储占用估算（字节），用于面板上提示本机缓存用量 */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage || 0, quota: e.quota || 0 }
}
