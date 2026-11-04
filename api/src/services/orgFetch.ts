/**
 * 组织队列拉取（Epic C2）：用客户自配凭证拉取**本组织托管目标范围**的数据，
 * 写 org_snapshots（组织私有 + append 版本化），绝不写 system_pool 的
 * orbital_snapshots / sat_tle / sat_tle_history / sat_cdm / sat_aoe。
 *  - GP：Space-Track GP 按 NORAD_CAT_ID 多值查询（谓词多值用 '--' 连接）；
 *  - CDM：公开 CDM（TCA > now-1d）拉回后本地按双方 NORAD ∈ 托管目标过滤；
 *  - AOE：channel list 拉回后按目标 NORAD 过滤。
 * 计数口径：total=源返回条数；inserted=新内容条数；skipped=重复内容/缺关键字段。
 */
import crypto from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'
import { config } from '../config.js'
import { SpaceTrackClient, type SpaceTrackCreds } from './spaceTrackClient.js'
import { fetchJson } from '../utils/httpFetch.js'
import { parseUtc } from '../utils/time.js'
import type { IngestCounts } from './ingestSpaceTrack.js'

/** GP 查询多值谓词分隔（Space-Track 约定 '--'）；并限制规模防超长 URL */
function noradPredicate(norads: number[]): string {
  return norads.slice(0, 500).join('--')
}

interface HashRow extends RowDataPacket {
  content_hash: string
}

/** 本组织该 provider+kind 已见内容哈希（幂等计数用） */
async function seenHashes(orgId: number, provider: string, kind: string): Promise<Set<string>> {
  const [rows] = await pool.query<HashRow[]>(
    'SELECT content_hash FROM org_snapshots WHERE org_id = ? AND provider = ? AND kind = ?',
    [orgId, provider, kind]
  )
  return new Set(rows.map((r) => r.content_hash))
}

/** 追加写入组织私有快照（INSERT IGNORE 幂等） */
async function insertSnapshots(
  rows: Array<[number, string, string, number, string, Date | null, string, string, string, string]>,
  orgId: number
): Promise<void> {
  if (!rows.length) return
  await pool.query(
    `INSERT IGNORE INTO org_snapshots
     (org_id, provider, kind, norad_id, object_name, epoch, tle_line1, tle_line2, content_hash, raw_json)
     VALUES ?`,
    [rows.map((r) => [orgId, ...r])]
  )
}

/* ------------------------------- GP ------------------------------- */

interface OrgGpRow {
  NORAD_CAT_ID?: unknown
  OBJECT_NAME?: unknown
  OBJECT_TYPE?: unknown
  EPOCH?: unknown
  TLE_LINE1?: unknown
  TLE_LINE2?: unknown
}

export async function runOrgGpFetch(orgId: number, norads: number[], creds: SpaceTrackCreds): Promise<IngestCounts> {
  const client = new SpaceTrackClient(creds)
  await client.login()
  const path = `/basicspacedata/query/class/gp/NORAD_CAT_ID/${encodeURIComponent(
    noradPredicate(norads)
  )}/decay_date/null-val/format/json`
  const raw = await client.getJson<unknown>(path)
  if (!Array.isArray(raw)) {
    throw new Error(`GP 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  const list = raw as OrgGpRow[]
  const seen = await seenHashes(orgId, 'spacetrack', 'gp')
  const rows: Array<[number, string, string, number, string, Date | null, string, string, string, string]> = []
  let inserted = 0
  let skipped = 0

  for (const g of list) {
    const norad = Number(g.NORAD_CAT_ID)
    const line1 = String(g.TLE_LINE1 ?? '').trim()
    const line2 = String(g.TLE_LINE2 ?? '').trim()
    if (!norad || norad <= 0 || !line1 || !line2) {
      skipped++
      continue
    }
    const epoch = g.EPOCH ? parseUtc(String(g.EPOCH).trim()) : null
    const name = String(g.OBJECT_NAME ?? '').trim()
    const objType = String(g.OBJECT_TYPE ?? '').trim() || 'UNKNOWN'
    const hash = crypto.createHash('sha1').update(line1 + line2).digest('hex')
    if (seen.has(hash)) {
      skipped++
      continue
    }
    seen.add(hash)
    inserted++
    rows.push([norad, 'spacetrack', 'gp', Math.trunc(norad), name || `NORAD ${norad}`, epoch, line1, line2, hash, ''])
  }

  await insertSnapshots(rows, orgId)
  return { total: list.length, inserted, updated: 0, skipped }
}

/* ------------------------------- CDM ------------------------------- */

export async function runOrgCdmFetch(orgId: number, norads: number[], creds: SpaceTrackCreds): Promise<IngestCounts> {
  const client = new SpaceTrackClient(creds)
  await client.login()
  const path = '/basicspacedata/query/class/cdm_public/TCA/%3Enow-1/orderby/TCA%20asc/format/json'
  const raw = await client.getJson<unknown>(path)
  if (!Array.isArray(raw)) {
    throw new Error(`CDM 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  const list = raw as Record<string, unknown>[]
  const scoped = new Set(norads)
  const seen = await seenHashes(orgId, 'spacetrack', 'cdm')
  const rows: Array<[number, string, string, number, string, Date | null, string, string, string, string]> = []
  let inserted = 0
  let skipped = 0

  for (const item of list) {
    const a = Number(item.SAT_1_ID)
    const b = Number(item.SAT_2_ID)
    if (!a || !b) {
      skipped++
      continue
    }
    // 组织可见范围：交会任一方属于本组织托管目标
    if (!scoped.has(Math.trunc(a)) && !scoped.has(Math.trunc(b))) {
      skipped++
      continue
    }
    const rawJson = JSON.stringify(item)
    const hash = crypto.createHash('sha1').update(rawJson).digest('hex')
    if (seen.has(hash)) {
      skipped++
      continue
    }
    seen.add(hash)
    inserted++
    const tca = item.TCA ? parseUtc(String(item.TCA).trim()) : null
    rows.push([0, 'spacetrack', 'cdm', 0, `${Math.trunc(a)}-${Math.trunc(b)}`, tca, '', '', hash, rawJson])
  }

  await insertSnapshots(rows, orgId)
  return { total: list.length, inserted, updated: 0, skipped }
}

/* ------------------------------- AOE ------------------------------- */

/** 兼容多种包装：根数组 / data / data.list / records …（与 ingestAoe 同口径） */
export function extractList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const keys = ['data', 'list', 'records', 'rows', 'items', 'result']
  for (const k of keys) {
    const v = obj[k]
    if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

function pickNorad(raw: Record<string, unknown>): number {
  for (const k of ['NORAD_CAT_ID', 'NORAD_ID', 'noradId', 'norad_id', 'NORAD', 'SSC']) {
    const v = raw[k]
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return Math.trunc(n)
    }
  }
  return 0
}

export async function runOrgAoeFetch(orgId: number, norads: number[], token: string): Promise<IngestCounts> {
  const base = config.aoe.baseUrl.replace(/\/$/, '')
  const url = `${base}/cgi/orbital/aoe/list?channel=KY&format=json`
  const payload = await fetchJson<unknown>(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'openspace-safety-api/2.0' },
    timeoutMs: 120_000,
    retries: 2
  })
  const list = extractList(payload)
  // AOE 对无效 Token 也返回 HTTP 200 + {code:1, data:null}：必须校验列表非空
  if (!list.length) {
    throw new Error(`AOE 未返回数据（Token 可能无效）：${JSON.stringify(payload).slice(0, 200)}`)
  }
  const scoped = new Set(norads)
  const seen = await seenHashes(orgId, 'aoe', 'aoe')
  const rows: Array<[number, string, string, number, string, Date | null, string, string, string, string]> = []
  let inserted = 0
  let skipped = 0

  for (const item of list) {
    const norad = pickNorad(item)
    if (!norad) {
      skipped++
      continue
    }
    if (!scoped.has(norad)) {
      skipped++
      continue
    }
    const rawJson = JSON.stringify(item)
    const hash = crypto.createHash('sha1').update(rawJson).digest('hex')
    if (seen.has(hash)) {
      skipped++
      continue
    }
    seen.add(hash)
    inserted++
    const epochStr = [item.EPOCH, item.epoch, item.EPOCH_UTC].find((v) => v) as string | undefined
    const epoch = epochStr ? parseUtc(String(epochStr).trim()) : null
    const name = String(item.OBJECT_NAME ?? item.objectName ?? item.NAME ?? item.name ?? '').trim()
    const line1 = String(item.TLE_LINE1 ?? item.tle_line1 ?? item.line1 ?? item.tle1 ?? '').trim()
    const line2 = String(item.TLE_LINE2 ?? item.tle_line2 ?? item.line2 ?? item.tle2 ?? '').trim()
    rows.push([norad, 'aoe', 'aoe', norad, name || `NORAD ${norad}`, epoch, line1, line2, hash, rawJson])
  }

  await insertSnapshots(rows, orgId)
  return { total: list.length, inserted, updated: 0, skipped }
}
