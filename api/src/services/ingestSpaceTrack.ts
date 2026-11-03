/**
 * Space-Track 采集（Epic C1）：
 *  - GP（两行根数/OMM）：版本化写 orbital_snapshots（追加不覆盖），同时刷新 sat_tle 当前态
 *    （旧历元归档 sat_tle_history），保证 3D 态势 / 编目链路继续工作；
 *  - CDM（公开交会报文）：整表覆盖 sat_cdm（与旧平台行为一致），hs_cdm_history 留档 90 天。
 */
import crypto from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { SpaceTrackClient } from './spaceTrackClient.js'
import { num, regimeOf, semiMajorAxisKm } from '../utils/orbit.js'
import { parseUtc } from '../utils/time.js'

export interface IngestCounts {
  total: number
  inserted: number
  updated: number
  skipped: number
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

function dateOrNull(v: unknown): Date | null {
  const s = str(v)
  if (!s || /^null$/i.test(s)) return null
  return parseUtc(s)
}

/* ---------------------------------- GP ---------------------------------- */

interface GpRow {
  NORAD_CAT_ID?: unknown
  OBJECT_NAME?: unknown
  OBJECT_TYPE?: unknown
  INTLDES?: unknown
  /** 新版 gp 接口按 CCSDS OMM 命名下发国际编号（旧版为 INTLDES），两者都兼容 */
  OBJECT_ID?: unknown
  LAUNCH_DATE?: unknown
  EPOCH?: unknown
  MEAN_MOTION?: unknown
  MEAN_MOTION_DOT?: unknown
  ECCENTRICITY?: unknown
  INCLINATION?: unknown
  RA_OF_ASC_NODE?: unknown
  ARG_OF_PERICENTER?: unknown
  MEAN_ANOMALY?: unknown
  BSTAR?: unknown
  REV_AT_EPOCH?: unknown
  DECAY_DATE?: unknown
  TLE_LINE1?: unknown
  TLE_LINE2?: unknown
  PERIOD?: unknown
  SEMIMAJOR_AXIS?: unknown
  APOGEE?: unknown
  PERIGEE?: unknown
}

interface SatTleRow extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
  launch_date: Date | null
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
  decay_date: Date | null
  owner_code: string
}

/** sat_tle 允许写入的列（顺序即 INSERT 列顺序） */
const TLE_COLS = [
  'norad_id', 'object_name', 'object_type', 'intl_desig', 'launch_date', 'regime', 'epoch',
  'mean_motion', 'mean_motion_dot', 'ecc', 'incl', 'raan', 'arg_perigee', 'mean_anomaly',
  'bstar', 'rev_num', 'period', 'semimajor_axis', 'apogee', 'perigee',
  'tle_line1', 'tle_line2', 'decay_date', 'is_active', 'source', 'updated_at'
] as const

/** sat_tle_history 归档列 */
const HISTORY_COLS = [
  'norad_id', 'object_name', 'object_type', 'intl_desig', 'regime', 'epoch',
  'mean_motion', 'mean_motion_dot', 'ecc', 'incl', 'raan', 'arg_perigee', 'mean_anomaly',
  'bstar', 'rev_num', 'period', 'semimajor_axis', 'apogee', 'perigee',
  'tle_line1', 'tle_line2', 'decay_date', 'owner_code'
] as const

export async function runGpIngest(batchId: number): Promise<IngestCounts> {
  const client = new SpaceTrackClient()
  await client.login()
  const path = '/basicspacedata/query/class/gp/decay_date/null-val/format/json'
  const raw = await client.getJson<unknown>(path)
  if (!Array.isArray(raw)) {
    throw new Error(`GP 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  const gp = raw as GpRow[]

  // 现有当前态（用于增量计数 + 旧历元归档）
  const [existingRows] = await pool.query<SatTleRow[]>(
    `SELECT ${TLE_COLS.filter((c) => c !== 'is_active' && c !== 'source' && c !== 'updated_at').join(',')}, owner_code FROM sat_tle`
  )
  const existing = new Map<number, SatTleRow>()
  for (const r of existingRows) existing.set(Number(r.norad_id), r)

  const now = new Date()
  const rows: unknown[][] = []
  const history: unknown[][] = []
  const snapshots: unknown[][] = []
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const g of gp) {
    const norad = num(g.NORAD_CAT_ID)
    const line1 = str(g.TLE_LINE1)
    const line2 = str(g.TLE_LINE2)
    if (!norad || norad <= 0 || !line1 || !line2) {
      skipped++
      continue
    }
    const epoch = dateOrNull(g.EPOCH)
    const decay = dateOrNull(g.DECAY_DATE)
    const objType = str(g.OBJECT_TYPE) || 'UNKNOWN'
    const intl = str(g.OBJECT_ID) || str(g.INTLDES)
    const name = str(g.OBJECT_NAME)
    const meanMotion = num(g.MEAN_MOTION)
    const ecc = num(g.ECCENTRICITY) ?? 0
    const sma = num(g.SEMIMAJOR_AXIS) ?? (meanMotion ? semiMajorAxisKm(meanMotion) : 0)
    const hash = crypto.createHash('sha1').update(line1 + line2).digest('hex')
    snapshots.push([
      batchId, 'spacetrack_gp', 'system_pool', Math.trunc(norad), name, objType,
      epoch, line1, line2, hash, JSON.stringify({ epoch: epoch?.toISOString() ?? null })
    ])

    const prev = existing.get(norad)
    if (!prev) inserted++
    else if (prev.tle_line1 !== line1) updated++

    if (prev && prev.epoch && epoch && prev.epoch.getTime() !== epoch.getTime()) {
      history.push(HISTORY_COLS.map((c) => (c === 'owner_code' ? prev.owner_code : prev[c])))
    }

    rows.push([
      Math.trunc(norad), name, objType, intl,
      dateOrNull(g.LAUNCH_DATE),
      regimeOf(sma, ecc),
      epoch,
      meanMotion,
      num(g.MEAN_MOTION_DOT),
      num(g.ECCENTRICITY),
      num(g.INCLINATION),
      num(g.RA_OF_ASC_NODE),
      num(g.ARG_OF_PERICENTER),
      num(g.MEAN_ANOMALY),
      num(g.BSTAR),
      num(g.REV_AT_EPOCH) === null ? 0 : Math.trunc(num(g.REV_AT_EPOCH) as number),
      num(g.PERIOD) ?? (meanMotion ? 1440 / meanMotion : null),
      sma || null,
      num(g.APOGEE),
      num(g.PERIGEE),
      line1, line2, decay,
      decay ? 0 : 1,
      'space-track',
      now
    ])
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // 版本化快照：UNIQUE(provider,norad,hash) 防重，INSERT IGNORE 幂等
    if (snapshots.length) {
      await conn.query(
        `INSERT IGNORE INTO orbital_snapshots
         (batch_id, provider, source, norad_id, object_name, object_type, epoch, tle_line1, tle_line2, content_hash, raw_json)
         VALUES ?`,
        [snapshots]
      )
    }
    // 当前态 upsert
    if (rows.length) {
      await conn.query(
        `INSERT INTO sat_tle (${TLE_COLS.join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ` +
          TLE_COLS.filter((c) => c !== 'norad_id').map((c) => `${c}=VALUES(${c})`).join(','),
        [rows]
      )
    }
    // 旧历元归档（只增不删）
    if (history.length) {
      await conn.query(
        `INSERT IGNORE INTO sat_tle_history (${HISTORY_COLS.join(',')}) VALUES ?`,
        [history]
      )
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  return { total: gp.length, inserted, updated, skipped }
}

/* ---------------------------------- CDM ---------------------------------- */

const CDM_INSERT_SQL =
  'INSERT INTO sat_cdm (cdm_id, creation_date, originator, tca, type, focus_a, norad_a, name_a, norad_b, name_b, ' +
  'miss_distance_km, radial_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, raw_json) VALUES ?'

export async function runCdmIngest(batchId: number): Promise<IngestCounts> {
  const client = new SpaceTrackClient()
  await client.login()
  const path = '/basicspacedata/query/class/cdm_public/TCA/%3Enow-1/orderby/TCA%20asc/format/json'
  const raw = await client.getJson<unknown>(path)
  if (!Array.isArray(raw)) {
    throw new Error(`CDM 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  const list = raw as Record<string, unknown>[]

  const cdmRows: unknown[][] = []
  const historyRows: unknown[][] = []
  const fetchedAt = new Date()
  let skipped = 0

  for (const item of list) {
    const noradA = num(item.SAT_1_ID)
    const noradB = num(item.SAT_2_ID)
    const tca = parseUtc(str(item.TCA))
    if (!noradA || !noradB || !tca) {
      skipped++
      continue
    }
    const minRngM = num(item.MIN_RNG)
    const missKm = minRngM === null ? null : minRngM / 1000 // MIN_RNG 单位为米
    const created = parseUtc(str(item.CREATED))
    const emergency = /^y$/i.test(str(item.EMERGENCY_REPORTABLE))
    const rawJson = JSON.stringify(item)

    cdmRows.push([
      str(item.CDM_ID), created, '', tca, 'SCREENING', 0,
      Math.trunc(noradA), str(item.SAT_1_NAME),
      Math.trunc(noradB), str(item.SAT_2_NAME),
      missKm, null, null, num(item.PC), null, rawJson
    ])
    historyRows.push([
      fetchedAt, str(item.CDM_ID), created, tca,
      Math.trunc(noradA), Math.trunc(noradB), missKm, num(item.PC), emergency ? 1 : 0, rawJson
    ])
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // 整表覆盖（与旧平台行为一致；当前快照 + raw_json 全保留，历史在 hs_cdm_history）
    await conn.query('DELETE FROM sat_cdm')
    if (cdmRows.length) await conn.query(CDM_INSERT_SQL, [cdmRows])
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  // 历史留档不参与主事务（失败不影响主表），保留 90 天
  if (historyRows.length) {
    try {
      await pool.query(
        'INSERT INTO hs_cdm_history (fetched_at, cdm_id, created, tca, norad_a, norad_b, min_rng_km, pc, emergency, raw_json) VALUES ?',
        [historyRows]
      )
      await pool.query('DELETE FROM hs_cdm_history WHERE fetched_at < (UTC_TIMESTAMP() - INTERVAL 90 DAY)')
    } catch (e) {
      console.error('[ingest.cdm] history archive failed:', (e as Error).message)
    }
  }

  void batchId
  return { total: list.length, inserted: cdmRows.length, updated: 0, skipped }
}
