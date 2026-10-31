import { ref } from 'vue'

/** Same 4-bucket normalize as old satTypes.normalizeObjectType / scene.ts */
function normalizeObjectType(t: string | null | undefined): string {
  const s = String(t ?? '').trim().toUpperCase().replace(/_/g, ' ')
  if (s === 'PAYLOAD' || s === 'DEBRIS' || s === 'ROCKET BODY') return s
  if (s === 'ROCKET' || s === 'R/B' || s === 'RB') return 'ROCKET BODY'
  return 'UNKNOWN'
}

export interface CatalogTle {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  epoch: string | null
  incl: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
  is_active: number
  source: string
  updated_at: string | null
  owner_code?: string
}

export interface CatalogCdm {
  cdm_id: string
  creation_date: string | null
  tca: string | null
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number | null
  rel_speed_km_per_s: number | null
  collision_probability: number | null
}

export interface CatalogStats {
  db: string
  tle: number
  cdm: number
  lastGpSync?: unknown
  lastCdmSync?: unknown
}

/** Old `/cgi/sat_tle/constellation` compact snapshot (reconstructed contract). */
export interface ConstellationSnapshot {
  total: number
  skipped: number
  t: number
  typeIndex: string[]
  regimeIndex: string[]
  nameIndex: string[]
  countryIndex?: string[]
  list: [
    number, number, number, number, number, number, number, number, number, number,
    number | null, string[], number, number | null, number | null, number | null
  ][]
}

export interface CloudPoint {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  alt: number | null
  cons: string[]
  owner_code: string
  perigee: number | null
  period: number | null
  incl: number | null
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


const CLOUD_IDB_KEY = 'osp:cloud:v1'

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('openspace-safety', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await idbOpen()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readonly')
      const rq = tx.objectStore('kv').get(key)
      rq.onsuccess = () => resolve((rq.result as T) ?? null)
      rq.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idbOpen()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}


const DEFAULT_TYPE_KEYS = ['UNKNOWN', 'PAYLOAD', 'ROCKET_BODY', 'DEBRIS']
const DEFAULT_REGIME_KEYS = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']

/** Mirror old satTypes.decodeConstellation */
export function decodeConstellation(res: ConstellationSnapshot | null | undefined): CloudPoint[] {
  const list = res?.list
  if (!Array.isArray(list)) return []
  const types = res?.typeIndex?.length ? res.typeIndex : DEFAULT_TYPE_KEYS
  const regimes = res?.regimeIndex?.length ? res.regimeIndex : DEFAULT_REGIME_KEYS
  const names = res?.nameIndex || []
  const countries = res?.countryIndex || []
  return list.map((r) => ({
    norad_id: r[0],
    object_name: names[r[1]] || '',
    object_type: normalizeObjectType(types[r[2]]),
    regime: regimes[r[3]] || 'OTHER',
    x: r[4], y: r[5], z: r[6],
    vx: r[7], vy: r[8], vz: r[9],
    alt: r[10],
    cons: r[11] || [],
    owner_code: countries[r[12]] || '--',
    perigee: r[13] ?? null,
    period: r[14] ?? null,
    incl: r[15] ?? null
  }))
}

const stats = ref<CatalogStats | null>(null)
const tles = ref<CatalogTle[]>([])
const tlesTotal = ref(0)
const cdms = ref<CatalogCdm[]>([])
const loading = ref(false)
const error = ref('')

/** Old g.cloudList equivalent — loaded on enter, visibility gated by type chips. */
const cloudList = ref<CloudPoint[]>([])
const cloudSnapT = ref(0)
const cloudLoading = ref(false)
const cloudError = ref('')
/** norad → [line1, line2] from /cgi/sat_tle/tle_lines (lazy). */
const tleLineMap = ref<Map<number, [string, string]>>(new Map())
const tleLinesLoading = ref(false)

export type LoadTlesOpts = {
  q?: string
  type?: string
  limit?: number
  offset?: number
}

export function useCatalog() {
  async function loadStats() {
    stats.value = await getJson<CatalogStats>('/cgi/catalog/stats')
    return stats.value
  }

  async function loadTles(opts: LoadTlesOpts = {}) {
    loading.value = true
    error.value = ''
    try {
      const qs = new URLSearchParams()
      if (opts.q) qs.set('q', opts.q)
      if (opts.type) qs.set('type', opts.type)
      qs.set('limit', String(opts.limit ?? 200))
      qs.set('offset', String(opts.offset ?? 0))
      const data = await getJson<{ total: number; items: CatalogTle[] }>(`/cgi/catalog/tles?${qs}`)
      tles.value = data.items
      tlesTotal.value = data.total
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function loadAllTles(
    opts: { q?: string; type?: string; pageSize?: number; maxPages?: number } = {}
  ) {
    loading.value = true
    error.value = ''
    const pageSize = Math.min(Math.max(opts.pageSize ?? 2000, 100), 12000)
    const maxPages = opts.maxPages ?? 20
    const all: CatalogTle[] = []
    let total = 0
    try {
      for (let page = 0; page < maxPages; page++) {
        const qs = new URLSearchParams()
        if (opts.q) qs.set('q', opts.q)
        if (opts.type) qs.set('type', opts.type)
        qs.set('limit', String(pageSize))
        qs.set('offset', String(page * pageSize))
        const data = await getJson<{ total: number; items: CatalogTle[] }>(`/cgi/catalog/tles?${qs}`)
        total = data.total
        all.push(...data.items)
        if (all.length >= total || data.items.length === 0) break
      }
      tles.value = all
      tlesTotal.value = total
      return { total, items: all }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function fetchTleByNorad(norad: number): Promise<CatalogTle | null> {
    // Prefer detail endpoint (old /cgi/sat_tle/detail/:id)
    try {
      const row = await getJson<CatalogTle>(`/cgi/sat_tle/detail/${norad}`)
      return row
    } catch {
      const qs = new URLSearchParams({ q: String(norad), limit: '5' })
      const data = await getJson<{ total: number; items: CatalogTle[] }>(`/cgi/catalog/tles?${qs}`)
      return data.items.find((x) => x.norad_id === norad) ?? data.items[0] ?? null
    }
  }

  async function loadCdms(limit = 50) {
    const data = await getJson<{ total: number; items: CatalogCdm[] }>(`/cgi/catalog/cdms?limit=${limit}`)
    cdms.value = data.items
    return data
  }

  /**
   * Old BaseScene.loadConstellation — fetch compact point cloud once.
   * Does NOT imply 3D visibility; type chips (typeF) gate rendering.
   */
  async function loadConstellation(force = false) {
    if (cloudList.value.length && !force) return cloudList.value
    cloudLoading.value = true
    cloudError.value = ''
    try {
      if (!force) {
        const cached = await idbGet<ConstellationSnapshot>(CLOUD_IDB_KEY)
        if (cached?.list?.length) {
          cloudList.value = decodeConstellation(cached)
          cloudSnapT.value = cached.t || Date.now()
          tlesTotal.value = cached.total
          console.info('[catalog] constellation IDB', cached.total)
          // Background refresh — do not block first paint / chip-on
          void (async () => {
            try {
              const snap = await getJson<ConstellationSnapshot>('/cgi/sat_tle/constellation')
              cloudList.value = decodeConstellation(snap)
              cloudSnapT.value = snap.t || Date.now()
              tlesTotal.value = snap.total
              void idbSet(CLOUD_IDB_KEY, snap)
            } catch { /* keep IDB */ }
          })()
          return cloudList.value
        }
      }
      const qs = force ? '?refresh=1' : ''
      const snap = await getJson<ConstellationSnapshot>(`/cgi/sat_tle/constellation${qs}`)
      cloudList.value = decodeConstellation(snap)
      cloudSnapT.value = snap.t || Date.now()
      tlesTotal.value = snap.total
      void idbSet(CLOUD_IDB_KEY, snap)
      console.info('[catalog] constellation', snap.total, 'skipped', snap.skipped)
      return cloudList.value
    } catch (e) {
      cloudError.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      cloudLoading.value = false
    }
  }

  /** Old listTleLinesPublic — OPTIONAL full map (heavy). Prefer catalog/tles samples; do not prefetch on enter. */
  async function loadTleLines(force = false) {
    if (tleLineMap.value.size && !force) return tleLineMap.value
    tleLinesLoading.value = true
    try {
      const data = await getJson<{ total: number; list: [number, string, string][] }>(
        '/cgi/sat_tle/tle_lines'
      )
      const m = new Map<number, [string, string]>()
      for (const row of data.list) m.set(row[0], [row[1], row[2]])
      tleLineMap.value = m
      console.info('[catalog] tle_lines', m.size)
      return m
    } finally {
      tleLinesLoading.value = false
    }
  }

  /**
   * Sample cloud → CatalogTle for Three overlay (progressive cap; see docs/cesium-three.md).
   * Does NOT dump full constellation (e.g. 11k Starlink) into the scene.
   * Prefer /catalog/tles?limit=cap when tle_lines not yet loaded (avoids 35k string map).
   */
  async function materializeTlesForTypes(
    types: string[],
    opts: { cap?: number; preferNorad?: number | null } = {}
  ): Promise<CatalogTle[]> {
    if (!types.length) {
      tles.value = []
      return []
    }
    const cap = Math.max(50, Math.min(opts.cap ?? 400, 12000))
    const want = types.map((t) => normalizeObjectType(t))
    const typeParam = want.length === 4 ? undefined : want.join(',')

    // Fast path: paginated catalog already returns TLE lines — one page = hard cap
    try {
      const data = await loadAllTles({
        type: typeParam,
        pageSize: cap,
        maxPages: 1
      })
      // Stride-sample if API returned more than cap (shouldn't with pageSize=cap)
      let items = data.items
      if (items.length > cap) {
        const stride = Math.max(1, Math.floor(items.length / cap))
        items = items.filter((_, i) => i % stride === 0).slice(0, cap)
      }
      if (opts.preferNorad != null) {
        const hit = data.items.find((x) => x.norad_id === opts.preferNorad)
        if (hit && !items.some((x) => x.norad_id === hit.norad_id)) {
          items = [hit, ...items.slice(0, cap - 1)]
        }
      }
      tles.value = items
      console.info('[catalog] materialize sample', items.length, 'cap', cap, 'cloudTotal', data.total)
      return items
    } catch (e) {
      console.warn('[catalog] materialize via catalog/tles failed, cloud fallback', e)
    }

    // Fallback: cloud metadata + optional tle_lines (only if already warm)
    const cloud = cloudList.value.length ? cloudList.value : await loadConstellation()
    const matched = cloud.filter((p) => want.includes(normalizeObjectType(p.object_type)))
    const stride = Math.max(1, Math.floor(matched.length / cap))
    const sampled = matched.filter((_, i) => i % stride === 0).slice(0, cap)
    if (!tleLineMap.value.size) {
      // Do not pull 35k lines — fetch by norad via detail for sample only is too chatty;
      // leave empty and let caller use loadAllTles. Return stub-less empty.
      tles.value = []
      return []
    }
    const out: CatalogTle[] = []
    for (const p of sampled) {
      const tl = tleLineMap.value.get(p.norad_id)
      if (!tl) continue
      out.push({
        norad_id: p.norad_id,
        object_name: p.object_name,
        object_type: p.object_type,
        regime: p.regime,
        epoch: null,
        incl: p.incl,
        apogee: null,
        perigee: p.perigee,
        tle_line1: tl[0],
        tle_line2: tl[1],
        is_active: 1,
        source: 'tle',
        updated_at: null,
        owner_code: p.owner_code
      })
    }
    tles.value = out
    return out
  }

  return {
    stats, tles, tlesTotal, cdms, loading, error,
    cloudList, cloudSnapT, cloudLoading, cloudError,
    tleLineMap, tleLinesLoading,
    loadStats, loadTles, loadAllTles, fetchTleByNorad, loadCdms,
    loadConstellation, loadTleLines, materializeTlesForTypes
  }
}

export async function loadModelManifest(): Promise<{
  defaultSatellite?: string
  defaultDebris?: string
  byNorad?: Record<string, string>
} | null> {
  try {
    const res = await fetch('/models/manifest.json', { cache: 'no-cache' })
    if (!res.ok) return null
    return (await res.json()) as {
      defaultSatellite?: string
      defaultDebris?: string
      byNorad?: Record<string, string>
    }
  } catch {
    return null
  }
}
