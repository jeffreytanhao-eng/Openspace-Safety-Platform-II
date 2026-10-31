/**
 * Space-Track TLE → Cesium 点 + 轨道折线（性能约束版）
 *
 * LEGACY Cesium PointPrimitive path (kept for fallback). Preferred: catalogCloudThree.ts (docs/cesium-three.md). Caps:
 *  - POINT_CAP 2000 overview / 800 constellation sample
 *  - ORBIT_CAP default 8, hard max 16
 *  - ORBIT_SAMPLES 36 (was 72)
 *  - updateCatalogPoints throttled (~8 Hz when many points)
 *  - empty type filter → purge (unchanged)
 */
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong
} from 'satellite.js'
import type { CatalogTle } from '@/composables/useCatalog'
import { loadModelManifest } from '@/composables/useCatalog'
import { TYPE_COLOR, normalizeObjectType } from './scene'

type CesiumNs = typeof import('cesium')

/** Overview hard cap — never put more PointPrimitives in the scene. */
export const POINT_CAP = 2000
/** Constellation / search sample into Cesium (Starlink etc.). */
export const POINT_CAP_CONS = 800
const ORBIT_SAMPLES = 36
const DEFAULT_ORBIT_CAP = 8
const ORBIT_CAP_HARD = 16
const MIN_RADIUS_M = 6_400_000
const OWNER_TAG = '_ospCatalog'
/** Propagate at most this often when point count is high (ms). */
const UPDATE_MIN_MS_HEAVY = 125
const UPDATE_MIN_MS_LIGHT = 50
const HEAVY_POINT_THRESHOLD = 600

let collection: import('cesium').PointPrimitiveCollection | null = null
let orbitLines: import('cesium').PolylineCollection | null = null
let satrecs: {
  norad: number
  rec: ReturnType<typeof twoline2satrec>
  type: string
  item: CatalogTle
}[] = []
let focusRec: {
  norad: number
  rec: ReturnType<typeof twoline2satrec>
  type: string
  item: CatalogTle
} | null = null
let modelManifest: Awaited<ReturnType<typeof loadModelManifest>> = null
let CesiumRef: CesiumNs | null = null
let sceneRef: import('cesium').Scene | null = null
let selectedNorad: number | null = null
let activeTypes: string[] = []
let orbitCap = DEFAULT_ORBIT_CAP
let lastOrbitBuildMs = 0
let catalogGen = 0
let lastUpdateMs = 0

function colorFor(Cesium: CesiumNs, type?: string, alpha = 0.9) {
  const key = normalizeObjectType(type)
  const n = TYPE_COLOR[key] ?? 0x90a4ae
  const hex = `#${n.toString(16).padStart(6, '0')}`
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha)
}

function typesActive(): boolean {
  return activeTypes.length > 0
}

function visibleOf(type: string) {
  if (!activeTypes.length) return false
  return activeTypes.includes(normalizeObjectType(type))
}

function makeRec(item: CatalogTle) {
  const rec = twoline2satrec(item.tle_line1.trim(), item.tle_line2.trim())
  return {
    norad: item.norad_id,
    rec,
    type: normalizeObjectType(item.object_type),
    item
  }
}

function eciToFixedCartesian(
  Cesium: CesiumNs,
  position: { x: number; y: number; z: number },
  gmstFixed: number
) {
  const geo = eciToGeodetic(position as never, gmstFixed)
  const lon = degreesLong(geo.longitude)
  const lat = degreesLat(geo.latitude)
  const height = geo.height * 1000
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) return null
  if (height < -500_000) return null
  const cart = Cesium.Cartesian3.fromDegrees(lon, lat, height)
  const r = Cesium.Cartesian3.magnitude(cart)
  if (!Number.isFinite(r) || r < MIN_RADIUS_M) return null
  return cart
}

function orbitPath(
  Cesium: CesiumNs,
  rec: ReturnType<typeof twoline2satrec>,
  whenMs: number
): import('cesium').Cartesian3[] {
  const n = rec.no
  if (!n || !Number.isFinite(n) || n <= 0) return []
  const periodMin = (2 * Math.PI) / n
  if (!Number.isFinite(periodMin) || periodMin < 5 || periodMin > 3000) return []
  const stepMs = (periodMin * 60 * 1000) / ORBIT_SAMPLES
  const gmstFixed = gstime(new Date(whenMs))
  const out: import('cesium').Cartesian3[] = []
  for (let i = 0; i <= ORBIT_SAMPLES; i++) {
    const t = new Date(whenMs + i * stepMs)
    try {
      const pv = propagate(rec, t)
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue
      const p = eciToFixedCartesian(
        Cesium,
        pv.position as { x: number; y: number; z: number },
        gmstFixed
      )
      if (p) out.push(p)
    } catch {
      /* skip */
    }
  }
  if (out.length < ORBIT_SAMPLES * 0.55) return []
  return out
}

function purgeOwnedPrimitives(scene?: import('cesium').Scene | null) {
  const sc = scene || sceneRef
  if (collection) {
    try { collection.removeAll() } catch { /* */ }
  }
  if (orbitLines) {
    try { orbitLines.removeAll() } catch { /* */ }
  }
  if (sc) {
    try {
      for (let i = sc.primitives.length - 1; i >= 0; i--) {
        const p = sc.primitives.get(i) as { [OWNER_TAG]?: boolean } | undefined
        if (p && (p as Record<string, unknown>)[OWNER_TAG]) {
          sc.primitives.remove(p as never)
        }
      }
    } catch { /* */ }
  }
  if (collection && sc) {
    try { sc.primitives.remove(collection) } catch { /* */ }
  }
  if (orbitLines && sc) {
    try { sc.primitives.remove(orbitLines) } catch { /* */ }
  }
  collection = null
  orbitLines = null
  satrecs = []
  focusRec = null
  selectedNorad = null
  lastOrbitBuildMs = 0
  sc?.requestRender?.()
}

function clearAllVisuals() {
  if (collection) {
    try { collection.removeAll() } catch { /* */ }
  }
  if (orbitLines) {
    try { orbitLines.removeAll() } catch { /* */ }
  }
  satrecs = []
  focusRec = null
  selectedNorad = null
  lastOrbitBuildMs = 0
  sceneRef?.requestRender?.()
}

function rebuildOrbits(whenMs: number) {
  if (!orbitLines || !CesiumRef) return
  if (!typesActive()) {
    clearAllVisuals()
    return
  }
  const Cesium = CesiumRef
  orbitLines.removeAll()
  type Entry = NonNullable<typeof focusRec>
  const budget: Entry[] = []
  const sel =
    (focusRec && focusRec.norad === selectedNorad ? focusRec : null) ||
    satrecs.find((s) => s.norad === selectedNorad) ||
    null
  if (sel && visibleOf(sel.type)) budget.push(sel)
  for (const s of satrecs) {
    if (budget.length >= orbitCap) break
    if (!visibleOf(s.type)) continue
    if (budget.some((b) => b.norad === s.norad)) continue
    budget.push(s)
  }
  for (const s of budget) {
    const path = orbitPath(Cesium, s.rec, whenMs)
    if (path.length < 3) continue
    const isSel = s.norad === selectedNorad
    orbitLines.add({
      positions: path,
      width: isSel ? 2.2 : 1.05,
      material: Cesium.Material.fromType('Color', {
        color: colorFor(Cesium, s.type, isSel ? 0.85 : 0.32)
      })
    })
  }
  lastOrbitBuildMs = whenMs
  sceneRef?.requestRender?.()
}

/**
 * Stratified sample: keep selection + round-robin across types so one chip
 * cannot dump 11k Starlinks into Cesium.
 */
export function sampleCatalogItems(
  items: CatalogTle[],
  cap: number,
  preferNorad?: number | null
): CatalogTle[] {
  if (items.length <= cap) return items.slice()
  const byType = new Map<string, CatalogTle[]>()
  for (const it of items) {
    const k = normalizeObjectType(it.object_type)
    const arr = byType.get(k)
    if (arr) arr.push(it)
    else byType.set(k, [it])
  }
  const out: CatalogTle[] = []
  const seen = new Set<number>()
  if (preferNorad != null) {
    const hit = items.find((x) => x.norad_id === preferNorad)
    if (hit) {
      out.push(hit)
      seen.add(hit.norad_id)
    }
  }
  const buckets = [...byType.values()]
  let bi = 0
  while (out.length < cap && buckets.some((b) => b.length)) {
    const b = buckets[bi % buckets.length]
    bi++
    if (!b.length) continue
    // stride sample inside bucket (stable, not random thrash)
    const stride = Math.max(1, Math.floor(b.length / Math.max(1, Math.ceil(cap / buckets.length))))
    const idx = Math.min(b.length - 1, (out.length * stride) % b.length)
    const it = b.splice(idx, 1)[0]
    if (seen.has(it.norad_id)) continue
    seen.add(it.norad_id)
    out.push(it)
  }
  return out
}

export async function initCatalogPoints(
  Cesium: CesiumNs,
  scene: import('cesium').Scene,
  items: CatalogTle[],
  cap = POINT_CAP
) {
  const gen = ++catalogGen
  const keepTypes = [...activeTypes]
  const keepCap = orbitCap
  const keepSel = selectedNorad
  purgeOwnedPrimitives(scene)
  if (gen !== catalogGen) return { plotted: 0, orbits: 0, manifest: modelManifest, capped: 0 }
  activeTypes = keepTypes
  orbitCap = keepCap
  CesiumRef = Cesium
  sceneRef = scene
  modelManifest = await loadModelManifest()
  if (gen !== catalogGen) return { plotted: 0, orbits: 0, manifest: modelManifest, capped: 0 }

  if (!items.length || !typesActive()) {
    clearAllVisuals()
    console.info('[situation] catalog cleared', { items: items.length, types: activeTypes.slice() })
    return { plotted: 0, orbits: 0, manifest: modelManifest, capped: 0 }
  }

  const hardCap = Math.min(cap, POINT_CAP)
  const sampled = sampleCatalogItems(items, hardCap, keepSel)
  collection = scene.primitives.add(new Cesium.PointPrimitiveCollection())
  ;(collection as unknown as Record<string, boolean>)[OWNER_TAG] = true
  orbitLines = scene.primitives.add(new Cesium.PolylineCollection())
  ;(orbitLines as unknown as Record<string, boolean>)[OWNER_TAG] = true
  satrecs = []

  for (const it of sampled) {
    if (gen !== catalogGen) break
    try {
      const entry = makeRec(it)
      if (!visibleOf(entry.type)) continue
      satrecs.push(entry)
      collection.add({
        id: it.norad_id,
        position: Cesium.Cartesian3.ZERO,
        pixelSize: 3.5,
        color: colorFor(Cesium, entry.type, 0.9),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.3),
        outlineWidth: 1,
        show: true
      })
    } catch {
      /* skip */
    }
  }
  if (gen !== catalogGen) {
    purgeOwnedPrimitives(scene)
    return { plotted: 0, orbits: 0, manifest: modelManifest, capped: hardCap }
  }
  selectedNorad = keepSel
  // Orbits: only selection (+ tiny budget) — never all points
  rebuildOrbits(Date.now())
  console.info('[situation] catalog points', satrecs.length, '/', items.length, 'cap', hardCap, 'orbits≤', orbitCap)
  return {
    plotted: satrecs.length,
    orbits: Math.min(orbitCap, satrecs.length),
    manifest: modelManifest,
    capped: hardCap
  }
}

export function updateCatalogPoints(whenMs: number) {
  if (!typesActive()) {
    if (collection || orbitLines || satrecs.length) clearAllVisuals()
    return
  }
  if (!collection || !CesiumRef) return
  const minGap = satrecs.length >= HEAVY_POINT_THRESHOLD ? UPDATE_MIN_MS_HEAVY : UPDATE_MIN_MS_LIGHT
  if (whenMs - lastUpdateMs < minGap) return
  lastUpdateMs = whenMs

  const Cesium = CesiumRef
  const date = new Date(whenMs)
  const gmstLive = gstime(date)
  for (let i = 0; i < satrecs.length; i++) {
    const entry = satrecs[i]
    const pt = collection.get(i)
    if (!pt) continue
    const show = visibleOf(entry.type)
    pt.show = show
    if (!show) continue
    try {
      const pv = propagate(entry.rec, date)
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue
      const cart = eciToFixedCartesian(
        Cesium,
        pv.position as { x: number; y: number; z: number },
        gmstLive
      )
      if (!cart) continue
      pt.position = cart
      const isSel = entry.norad === selectedNorad
      pt.pixelSize = isSel ? 9 : 3.2
      pt.outlineWidth = isSel ? 2 : 1
      pt.outlineColor = Cesium.Color.WHITE.withAlpha(isSel ? 0.9 : 0.28)
      pt.color = colorFor(Cesium, entry.type, isSel ? 1 : 0.85)
    } catch {
      /* ignore */
    }
  }
  // Rebuild orbits rarely — selection-driven path calls rebuildOrbits directly
  if (Math.abs(whenMs - lastOrbitBuildMs) > 60_000) {
    rebuildOrbits(whenMs)
  }
}

export function setCatalogSelection(norad: number | null, whenMs = Date.now()) {
  selectedNorad = norad
  if (norad == null) focusRec = null
  if (!typesActive()) {
    clearAllVisuals()
    return
  }
  rebuildOrbits(whenMs)
}

export function ensureSelectedItem(item: CatalogTle, whenMs = Date.now()) {
  try {
    const entry = makeRec(item)
    selectedNorad = entry.norad
    if (!typesActive() || !visibleOf(entry.type)) {
      focusRec = null
      clearAllVisuals()
      return
    }
    if (!satrecs.some((s) => s.norad === entry.norad)) focusRec = entry
    else focusRec = null
    rebuildOrbits(whenMs)
  } catch (e) {
    console.warn('[catalog] ensureSelectedItem failed', e)
  }
}

export function setCatalogTypeFilter(types: string[] | null, whenMs = Date.now()) {
  catalogGen++
  activeTypes = types && types.length ? [...types] : []
  if (!typesActive()) {
    purgeOwnedPrimitives(sceneRef)
    console.info('[situation] type filter empty → purged')
    return
  }
  if (collection && satrecs.length) {
    for (let i = 0; i < satrecs.length; i++) {
      const pt = collection.get(i)
      if (pt) pt.show = visibleOf(satrecs[i].type)
    }
    rebuildOrbits(whenMs)
  }
}

export function setOrbitCap(n: number, whenMs = Date.now()) {
  orbitCap = Math.max(1, Math.min(n, ORBIT_CAP_HARD))
  if (!typesActive()) {
    clearAllVisuals()
    return
  }
  rebuildOrbits(whenMs)
}

export function clearCatalogPoints(scene?: import('cesium').Scene | null) {
  catalogGen++
  purgeOwnedPrimitives(scene || sceneRef)
}

export function catalogPointCount() {
  return satrecs.length
}

export function getActiveCatalogTypes() {
  return activeTypes.slice()
}

export function getModelUrlForNorad(norad: number): string | null {
  if (!modelManifest) return null
  const by = modelManifest.byNorad?.[String(norad)]
  if (by) return by
  return modelManifest.defaultSatellite || null
}
