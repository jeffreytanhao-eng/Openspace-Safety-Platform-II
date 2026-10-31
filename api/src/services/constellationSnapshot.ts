/**
 * Reconstructs old server.jsc `/cgi/sat_tle/constellation` intent:
 * - Load active sat_tle rows with TLE lines
 * - Propagate once with SGP4 at snap time t
 * - Emit compact ConstellationSnapshot (no TLE in payload)
 * - Process-memory cache (old jsc: "后端已做进程内缓存")
 *
 * Pure Node + satellite.js — Docker/Linux safe, no bytenode/V8 bytecode.
 */
import type { RowDataPacket } from 'mysql2/promise'
import * as satellite from 'satellite.js'
import { pool } from '../db/pool.js'

export const POINT_TYPE_KEYS = ['UNKNOWN', 'PAYLOAD', 'ROCKET_BODY', 'DEBRIS'] as const
export const POINT_REGIME_KEYS = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'] as const

type CompactRow = [
  number, number, number, number,
  number, number, number,
  number, number, number,
  number | null, string[], number,
  number | null, number | null, number | null
]

export interface ConstellationSnapshot {
  total: number
  skipped: number
  t: number
  typeIndex: string[]
  regimeIndex: string[]
  nameIndex: string[]
  countryIndex: string[]
  list: CompactRow[]
}

interface TlePack extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  owner_code: string
  tle_line1: string
  tle_line2: string
  perigee: number | null
  incl: number | null
  mean_motion: number | null
  period: number | null
}

const CACHE_TTL_MS = 300_000  // 5 min — first chip-on / idle warm reuse
let cache: { at: number; snap: ConstellationSnapshot } | null = null
let building: Promise<ConstellationSnapshot> | null = null

function normType(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().toUpperCase().replace(/_/g, ' ')
  if (s === 'PAYLOAD') return 'PAYLOAD'
  if (s === 'DEBRIS') return 'DEBRIS'
  if (s === 'ROCKET BODY' || s === 'ROCKET' || s === 'R/B' || s === 'RB') return 'ROCKET_BODY'
  return 'UNKNOWN'
}

function normRegime(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().toUpperCase()
  if ((POINT_REGIME_KEYS as readonly string[]).includes(s)) return s
  return 'OTHER'
}

function periodMin(meanMotion: number | null | undefined, perigee: number | null): number | null {
  if (meanMotion && meanMotion > 0) return 1440 / meanMotion
  return null
}

async function loadConsMap(): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>()
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.norad_id AS norad_id, c.name AS name
       FROM sat_constellation_sat s
       JOIN sat_constellation c ON c.id = s.constellation_id`
    )
    for (const r of rows) {
      const norad = Number(r.norad_id)
      const name = String(r.name || '')
      if (!norad || !name) continue
      const arr = map.get(norad)
      if (arr) arr.push(name)
      else map.set(norad, [name])
    }
  } catch (e) {
    console.warn('[constellation] cons map skipped', e)
  }
  return map
}

export async function buildConstellationSnapshot(force = false): Promise<ConstellationSnapshot> {
  const now = Date.now()
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.snap
  if (building) return building

  building = (async () => {
    const t = Date.now()
    const consMap = await loadConsMap()
    const [rows] = await pool.query<TlePack[]>(
      `SELECT norad_id, object_name, object_type, regime, IFNULL(owner_code,'--') AS owner_code,
              tle_line1, tle_line2, perigee, incl, mean_motion, period
       FROM sat_tle
       WHERE tle_line1 <> '' AND tle_line2 <> ''
       ORDER BY norad_id ASC`
    )

    const nameIndex: string[] = []
    const nameMap = new Map<string, number>()
    const countryIndex: string[] = ['--']
    const countryMap = new Map<string, number>([['--', 0]])
    const typeIndex = [...POINT_TYPE_KEYS]
    const typeMap = new Map(typeIndex.map((k, i) => [k, i]))
    const regimeIndex = [...POINT_REGIME_KEYS]
    const regimeMap = new Map(regimeIndex.map((k, i) => [k, i]))

    const list: CompactRow[] = []
    let skipped = 0
    const date = new Date(t)

    for (const row of rows) {
      try {
        const satrec = satellite.twoline2satrec(row.tle_line1.trim(), row.tle_line2.trim())
        const pv = satellite.propagate(satrec, date)
        if (!pv.position || typeof pv.position === 'boolean') {
          skipped++
          continue
        }
        const pos = pv.position as { x: number; y: number; z: number }
        const vel =
          pv.velocity && typeof pv.velocity !== 'boolean'
            ? (pv.velocity as { x: number; y: number; z: number })
            : { x: 0, y: 0, z: 0 }

        const name = String(row.object_name || '')
        let nameIdx = nameMap.get(name)
        if (nameIdx == null) {
          nameIdx = nameIndex.length
          nameIndex.push(name)
          nameMap.set(name, nameIdx)
        }

        const typ = normType(row.object_type)
        let typeIdx = typeMap.get(typ)
        if (typeIdx == null) {
          typeIdx = typeIndex.length
          typeIndex.push(typ)
          typeMap.set(typ, typeIdx)
        }

        const reg = normRegime(row.regime)
        let regimeIdx = regimeMap.get(reg) ?? regimeMap.get('OTHER')!

        const owner = String(row.owner_code || '--') || '--'
        let ownerIdx = countryMap.get(owner)
        if (ownerIdx == null) {
          ownerIdx = countryIndex.length
          countryIndex.push(owner)
          countryMap.set(owner, ownerIdx)
        }

        const rKm = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z)
        const alt = Number.isFinite(rKm) ? rKm - 6371 : null
        const period =
          row.period != null ? Number(row.period) : periodMin(row.mean_motion, row.perigee)

        list.push([
          Number(row.norad_id),
          nameIdx,
          typeIdx,
          regimeIdx,
          pos.x, pos.y, pos.z,
          vel.x, vel.y, vel.z,
          alt,
          consMap.get(Number(row.norad_id)) || [],
          ownerIdx,
          row.perigee != null ? Number(row.perigee) : null,
          period,
          row.incl != null ? Number(row.incl) : null
        ])
      } catch {
        skipped++
      }
    }

    const snap: ConstellationSnapshot = {
      total: list.length,
      skipped,
      t,
      typeIndex,
      regimeIndex,
      nameIndex,
      countryIndex,
      list
    }
    cache = { at: Date.now(), snap }
    return snap
  })()

  try {
    return await building
  } finally {
    building = null
  }
}

export async function listTleLines(): Promise<{ total: number; list: [number, string, string][] }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT norad_id, tle_line1, tle_line2 FROM sat_tle
     WHERE tle_line1 <> '' AND tle_line2 <> ''
     ORDER BY norad_id ASC`
  )
  const list: [number, string, string][] = rows.map((r) => [
    Number(r.norad_id),
    String(r.tle_line1),
    String(r.tle_line2)
  ])
  return { total: list.length, list }
}

export function clearConstellationCache() {
  cache = null
}
