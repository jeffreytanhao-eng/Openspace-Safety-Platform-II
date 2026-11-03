/**
 * AOE（spacemapper）采集（Epic C1）：channel=KY，format=json。
 *  - 版本化写 orbital_snapshots（provider='aoe'）；
 *  - 刷新 sat_aoe 当前态（upsert by norad_id）；
 *  - 未配置 AOE_TOKEN 时抛 SkipError，由 dailyFetch 记批次 failed 并给出明确原因。
 */
import crypto from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { config } from '../config.js'
import { fetchJson } from '../utils/httpFetch.js'
import { buildTle, num, periodMinutes, regimeOf, semiMajorAxisKm, apsisKm } from '../utils/orbit.js'
import { parseUtc } from '../utils/time.js'
import type { IngestCounts } from './ingestSpaceTrack.js'

export class SkipError extends Error {}

const COLS = [
  'norad_id', 'object_name', 'object_type', 'intl_desig', 'regime', 'epoch',
  'mean_motion', 'mean_motion_dot', 'ecc', 'incl', 'raan', 'arg_perigee', 'mean_anomaly',
  'bstar', 'rev_num', 'period', 'semimajor_axis', 'apogee', 'perigee',
  'tle_line1', 'tle_line2', 'channel', 'constellation_id', 'raw_json', 'is_active', 'source', 'updated_at'
] as const

interface AoeSatRow extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
  regime: string
  epoch: Date | null
  mean_motion: number | null
  mean_motion_dot: number | null
  ecc: number | null
  incl: number | null
  raan: number | null
  arg_perigee: number | null
  mean_anomaly: number | null
  bstar: number | null
  rev_num: number | null
  period: number | null
  semimajor_axis: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
  channel: string
  constellation_id: string | null
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  }
  return null
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

/** 兼容多种包装：根数组 / data 数组 / data.list / result.records … */
function extractList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const direct = ['data', 'list', 'records', 'rows', 'items', 'result']
  for (const k of direct) {
    const v = obj[k]
    if (Array.isArray(v)) return v as Record<string, unknown>[]
    if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>
      for (const k2 of direct) {
        const v2 = inner[k2]
        if (Array.isArray(v2)) return v2 as Record<string, unknown>[]
      }
    }
  }
  return []
}

export async function runAoeIngest(batchId: number): Promise<IngestCounts> {
  if (!config.aoe.token) {
    throw new SkipError('AOE_TOKEN 未配置，跳过 AOE 同步')
  }
  const base = config.aoe.baseUrl.replace(/\/$/, '')
  const url = `${base}/cgi/orbital/aoe/list?channel=KY&format=json`
  const payload = await fetchJson<unknown>(url, {
    headers: {
      Authorization: `Bearer ${config.aoe.token}`,
      'User-Agent': 'openspace-safety-api/2.0'
    },
    timeoutMs: 180_000,
    retries: 3
  })

  const list = extractList(payload)
  if (!list.length) {
    throw new Error(`AOE 返回 0 条，响应片段：${JSON.stringify(payload).slice(0, 300)}`)
  }
  console.log(`[ingest.aoe] AOE 返回 ${list.length} 条；首条字段：${Object.keys(list[0]).join(',')}`)

  const [existingRows] = await pool.query<AoeSatRow[]>(
    `SELECT ${COLS.filter((c) => c !== 'raw_json' && c !== 'source' && c !== 'updated_at').join(',')} FROM sat_aoe`
  )
  const existing = new Map<number, AoeSatRow>()
  for (const r of existingRows) existing.set(Number(r.norad_id), r)

  // AOE 的 OBJECT_TYPE 常缺失/恒 UNKNOWN：按 NORAD 从 sat_tle 回填真实类型
  const [tleTypeRows] = await pool.query<RowDataPacket[]>(
    'SELECT norad_id, object_type FROM sat_tle WHERE object_type IN (?, ?, ?)',
    ['PAYLOAD', 'DEBRIS', 'ROCKET BODY']
  )
  const tleType = new Map<number, string>()
  for (const r of tleTypeRows) tleType.set(Number(r.norad_id), String(r.object_type))

  const rows: unknown[][] = []
  const snapshots: unknown[][] = []
  let inserted = 0
  let updated = 0
  let skipped = 0
  const now = new Date()

  for (const raw of list) {
    const norad = num(pick(raw, ['NORAD_CAT_ID', 'NORAD_ID', 'noradId', 'norad_id', 'NORAD', 'SSC']))
    const epoch = parseUtc(str(pick(raw, ['EPOCH', 'epoch', 'EPOCH_UTC'])))
    if (!norad || norad <= 0 || !epoch) {
      skipped++
      continue
    }
    const name = str(pick(raw, ['OBJECT_NAME', 'objectName', 'NAME', 'name']))
    const meanMotion = num(pick(raw, ['MEAN_MOTION', 'meanMotion']))
    const ecc = num(pick(raw, ['ECCENTRICITY', 'eccentricity'])) ?? 0
    const incl = num(pick(raw, ['INCLINATION', 'inclination'])) ?? 0
    const raan = num(pick(raw, ['RA_OF_ASC_NODE', 'RAAN', 'raan'])) ?? 0
    const argp = num(pick(raw, ['ARG_OF_PERICENTER', 'ARG_PERIGEE', 'argPerigee'])) ?? 0
    const ma = num(pick(raw, ['MEAN_ANOMALY', 'meanAnomaly'])) ?? 0
    const bstar = num(pick(raw, ['BSTAR', 'bstar'])) ?? 0
    const ndot = num(pick(raw, ['MEAN_MOTION_DOT', 'meanMotionDot'])) ?? 0
    const rev = num(pick(raw, ['REV_AT_EPOCH', 'revAtEpoch'])) ?? 0
    const intl = str(pick(raw, ['INTLDES', 'OBJECT_ID', 'intlDesig']))
    const rawObjType = str(pick(raw, ['OBJECT_TYPE', 'objectType']))
    const objType = rawObjType && rawObjType !== 'UNKNOWN' ? rawObjType : tleType.get(norad) || 'UNKNOWN'
    const channel = str(pick(raw, ['CHANNEL', 'channel'])) || 'KY'
    const constellation = str(pick(raw, ['CONSTELLATION_ID', 'constellationId'])) || null

    let line1 = str(pick(raw, ['TLE_LINE1', 'tle_line1', 'line1', 'tle1']))
    let line2 = str(pick(raw, ['TLE_LINE2', 'tle_line2', 'line2', 'tle2']))
    if ((!line1 || !line2) && meanMotion) {
      const built = buildTle({
        noradId: norad, intlDesig: intl, epoch, meanMotion, eccentricity: ecc,
        inclination: incl, raan, argPerigee: argp, meanAnomaly: ma, bstar,
        meanMotionDot: ndot, revNum: rev
      })
      line1 = built.line1
      line2 = built.line2
    }

    const sma = meanMotion ? semiMajorAxisKm(meanMotion) : 0
    const apsis = sma > 0 ? apsisKm(sma, ecc) : { apogee: null, perigee: null }
    const hash = crypto.createHash('sha1').update(line1 + line2).digest('hex')

    snapshots.push([
      batchId, 'aoe', 'system_pool', Math.trunc(norad), name, objType,
      epoch, line1, line2, hash, JSON.stringify(raw)
    ])

    const prev = existing.get(norad)
    if (!prev) inserted++
    else if (prev.tle_line1 !== line1 || prev.epoch?.getTime() !== epoch.getTime()) updated++

    rows.push([
      Math.trunc(norad), name, objType, intl,
      regimeOf(sma, ecc), epoch,
      meanMotion, ndot, ecc, incl, raan, argp, ma, bstar, Math.trunc(rev),
      meanMotion ? periodMinutes(meanMotion) : null,
      sma || null, apsis.apogee, apsis.perigee,
      line1, line2, channel, constellation,
      JSON.stringify(raw), 1, 'aoe', now
    ])
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (snapshots.length) {
      await conn.query(
        `INSERT IGNORE INTO orbital_snapshots
         (batch_id, provider, source, norad_id, object_name, object_type, epoch, tle_line1, tle_line2, content_hash, raw_json)
         VALUES ?`,
        [snapshots]
      )
    }
    if (rows.length) {
      await conn.query(
        `INSERT INTO sat_aoe (${COLS.join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ` +
          COLS.filter((c) => c !== 'norad_id').map((c) => `${c}=VALUES(${c})`).join(','),
        [rows]
      )
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  return { total: list.length, inserted, updated, skipped }
}
