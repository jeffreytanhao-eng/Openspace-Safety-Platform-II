/**
 * 目标库层（Epic D1）：
 *  - objects：组织认领的 NORAD 目标档案（质量/截面/推进/验收碰撞参数）；
 *  - 认领分两类：claim_type=normal 普通认领（学习/教学/模拟科研，可多组织重复认领）、
 *    claim_type=owner 授权认领（卫星业主，同一 NORAD 全局仅一个）；
 *    唯一键 uk_org_norad(org_id, norad_id) 禁止同组织重复认领，
 *    uk_owner_norad(owner_norad) 由生成列兜底「一目标一授权」；
 *  - 仅授权认领可维护档案参数与绑定星历（路由层校验）；
 *  - 星历绑定挂在 ephemeris.bound_object_id（见 ephemDb.ensureEphemSchema 增列）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type ClaimType = 'normal' | 'owner'

export interface ObjectRow {
  id: number
  org_id: number
  norad_id: number
  name: string
  mass_kg: number | null
  cross_section_m2: number | null
  propulsion: string
  accepted_pc: number | null
  accepted_miss_km: number | null
  claim_status: 'claimed'
  claim_type: ClaimType
  created_at: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`objects\` (
  \`id\`              bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`          bigint unsigned NOT NULL,
  \`norad_id\`        int NOT NULL,
  \`name\`            varchar(100) NOT NULL DEFAULT '',
  \`mass_kg\`         double NULL,
  \`cross_section_m2\` double NULL,
  \`propulsion\`      varchar(60) NOT NULL DEFAULT '',
  \`accepted_pc\`     double NULL COMMENT '组织验收碰撞概率阈值',
  \`accepted_miss_km\` double NULL COMMENT '组织验收最小距离阈值(km)',
  \`claim_status\`    varchar(20) NOT NULL DEFAULT 'claimed',
  \`claim_type\`      enum('normal','owner') NOT NULL DEFAULT 'normal' COMMENT '认领类型：normal=普通（可多次）/ owner=授权（卫星业主，全局唯一）',
  \`owner_norad\`     int GENERATED ALWAYS AS (CASE WHEN \`claim_type\` = 'owner' THEN \`norad_id\` ELSE NULL END) STORED COMMENT '授权认领 NORAD（普通认领为 NULL，唯一键保证全局仅一个授权认领）',
  \`created_at\`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_org_norad\` (\`org_id\`, \`norad_id\`),
  UNIQUE KEY \`uk_owner_norad\` (\`owner_norad\`),
  KEY \`idx_norad\` (\`norad_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='目标（组织认领的 NORAD 档案）'`

let schemaReady: Promise<boolean> | null = null

/**
 * C1 业主授权范围：VIP 组织仅能对「已授权范围」内的目标做 owner 认领。
 * - scope_type=norad              按 NORAD 白名单；
 * - scope_type=constellation_key  按编目星座编码（sat_constellation.code）；
 * - scope_type=tag                按目标名/星座名/星座关键词的通用包含匹配；
 * 未配置任何范围的 VIP 组织 = 拒绝全部 owner（安全默认），不做任何品牌硬编码。
 */
const SCOPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`org_claim_scopes\` (
  \`id\`          bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`      bigint unsigned NOT NULL,
  \`scope_type\`  enum('norad','tag','constellation_key') NOT NULL,
  \`scope_value\` varchar(64) NOT NULL,
  \`note\`        varchar(128) NOT NULL DEFAULT '',
  \`created_at\`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_org_scope\` (\`org_id\`, \`scope_type\`, \`scope_value\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='业主认领授权范围（超管配置；空 = 不允许 owner）'`

export type ClaimScopeType = 'norad' | 'tag' | 'constellation_key'

export interface ClaimScope {
  id: number
  org_id: number
  scope_type: ClaimScopeType
  scope_value: string
  note: string
  created_at: string
}

export function ensureObjectsSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        await pool.query(SCOPES_SCHEMA)
        await migrateObjectsSchema()
        return true
      } catch (e) {
        console.error('[objects] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

/** 旧库迁移（幂等）：全局唯一 uk_norad → uk_org_norad + 唯一授权认领生成列 */
async function migrateObjectsSchema(): Promise<void> {
  const [cols] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'objects'`
  )
  const colNames = new Set(cols.map((c) => String(c.COLUMN_NAME)))
  const [idxRows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'objects'`
  )
  const idxNames = new Set(idxRows.map((r) => String(r.INDEX_NAME)))
  if (!colNames.has('claim_type')) {
    await pool.query(
      `ALTER TABLE objects ADD COLUMN claim_type enum('normal','owner') NOT NULL DEFAULT 'normal'
        COMMENT '认领类型：normal=普通（可多次）/ owner=授权（卫星业主，全局唯一）' AFTER claim_status`
    )
  }
  if (idxNames.has('uk_norad')) {
    await pool.query('ALTER TABLE objects DROP INDEX uk_norad')
  }
  if (!idxNames.has('uk_org_norad')) {
    await pool.query('ALTER TABLE objects ADD UNIQUE KEY uk_org_norad (org_id, norad_id)')
  }
  if (!colNames.has('owner_norad')) {
    await pool.query(
      `ALTER TABLE objects
         ADD COLUMN owner_norad int GENERATED ALWAYS AS (CASE WHEN claim_type = 'owner' THEN norad_id ELSE NULL END) STORED
           COMMENT '授权认领 NORAD（普通认领为 NULL，唯一键保证全局仅一个授权认领）',
         ADD UNIQUE KEY uk_owner_norad (owner_norad)`
    )
  } else if (!idxNames.has('uk_owner_norad')) {
    await pool.query('ALTER TABLE objects ADD UNIQUE KEY uk_owner_norad (owner_norad)')
  }
}

interface RawObject extends RowDataPacket, ObjectRow {}

const COLS = 'id, org_id, norad_id, name, mass_kg, cross_section_m2, propulsion, accepted_pc, accepted_miss_km, claim_status, claim_type, created_at, updated_at'

export async function listObjectsByOrg(orgId: number): Promise<ObjectRow[]> {
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects WHERE org_id = ? AND claim_status = 'claimed' ORDER BY id DESC`,
    [orgId]
  )
  return rows as ObjectRow[]
}

export async function getObjectById(id: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(`SELECT ${COLS} FROM objects WHERE id = ?`, [id])
  return (rows[0] as ObjectRow) ?? null
}

/** 本组织在某 NORAD 上的认领（normal 或 owner，最多一条：uk_org_norad） */
export async function getObjectByOrgNorad(orgId: number, noradId: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects WHERE org_id = ? AND norad_id = ?`,
    [orgId, noradId]
  )
  return (rows[0] as ObjectRow) ?? null
}

/** 某 NORAD 的授权认领（卫星业主；全局最多一条） */
export async function getOwnerClaim(noradId: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects WHERE norad_id = ? AND claim_type = 'owner'`,
    [noradId]
  )
  return (rows[0] as ObjectRow) ?? null
}

export interface CreateObjectInput {
  orgId: number
  noradId: number
  name: string
  claimType?: ClaimType
  massKg?: number | null
  crossSectionM2?: number | null
  propulsion?: string
}

export async function createObject(input: CreateObjectInput): Promise<ObjectRow> {
  const [r] = await pool.query(
    `INSERT INTO objects (org_id, norad_id, name, claim_type, mass_kg, cross_section_m2, propulsion)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.orgId,
      input.noradId,
      input.name,
      input.claimType ?? 'normal',
      input.massKg ?? null,
      input.crossSectionM2 ?? null,
      input.propulsion ?? ''
    ]
  )
  const id = Number((r as { insertId: number }).insertId)
  return (await getObjectById(id)) as ObjectRow
}

export interface UpdateObjectInput {
  name?: string
  massKg?: number | null
  crossSectionM2?: number | null
  propulsion?: string
  acceptedPc?: number | null
  acceptedMissKm?: number | null
}

export async function updateObject(id: number, patch: UpdateObjectInput): Promise<void> {
  await pool.query(
    `UPDATE objects SET
       name = COALESCE(?, name),
       mass_kg = ?, cross_section_m2 = ?, propulsion = COALESCE(?, propulsion),
       accepted_pc = ?, accepted_miss_km = ?
     WHERE id = ?`,
    [
      patch.name ?? null,
      patch.massKg === undefined ? null : patch.massKg,
      patch.crossSectionM2 === undefined ? null : patch.crossSectionM2,
      patch.propulsion ?? null,
      patch.acceptedPc === undefined ? null : patch.acceptedPc,
      patch.acceptedMissKm === undefined ? null : patch.acceptedMissKm,
      id
    ]
  )
}

/** 释放认领（删除行；历史操作可在后续审计/版本化中留痕） */
export async function deleteObject(id: number): Promise<void> {
  await pool.query('DELETE FROM objects WHERE id = ?', [id])
}

/** 目标的绑定星历数（列表展示） */
export async function countBoundEphem(objectIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (!objectIds.length) return map
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT bound_object_id AS oid, COUNT(*) AS n FROM ephemeris
     WHERE bound_object_id IN (?) GROUP BY bound_object_id`,
    [objectIds]
  )
  for (const r of rows) map.set(Number(r.oid), Number(r.n))
  return map
}

/* ---------------------------------------------------------------------------
 * C1 业主授权范围（org_claim_scopes）
 * ------------------------------------------------------------------------- */

export async function listClaimScopes(orgId: number): Promise<ClaimScope[]> {
  const [rows] = await pool.query<Array<RowDataPacket & ClaimScope>>(
    `SELECT id, org_id, scope_type, scope_value, note, created_at
       FROM org_claim_scopes WHERE org_id = ? ORDER BY scope_type, scope_value`,
    [orgId]
  )
  return rows as ClaimScope[]
}

/** 全量替换某组织的授权范围（先删后插，去重，最多 200 条） */
export async function replaceClaimScopes(
  orgId: number,
  scopes: Array<{ type: ClaimScopeType; value: string; note?: string }>
): Promise<ClaimScope[]> {
  const seen = new Set<string>()
  const rows = scopes
    .map((s) => ({ type: s.type, value: String(s.value ?? '').trim(), note: String(s.note ?? '').slice(0, 128) }))
    .filter((s) => s.value && !seen.has(`${s.type}:${s.value.toLowerCase()}`) && seen.add(`${s.type}:${s.value.toLowerCase()}`))
    .slice(0, 200)
  await pool.query('DELETE FROM org_claim_scopes WHERE org_id = ?', [orgId])
  for (const s of rows) {
    await pool.query(
      'INSERT INTO org_claim_scopes (org_id, scope_type, scope_value, note) VALUES (?, ?, ?, ?)',
      [orgId, s.type, s.value, s.note]
    )
  }
  return listClaimScopes(orgId)
}

export interface ClaimScopeCheck {
  /** 是否配置过授权范围（空 = 未配置，安全默认拒绝 owner） */
  configured: boolean
  allowed: boolean
  /** 命中的范围（便于返回原因/审计） */
  matched: { scope_type: ClaimScopeType; scope_value: string } | null
}

/**
 * 判断某 NORAD 是否落在组织授权范围内。
 * tag 命中口径：目标名包含关键词，或所属星座的名称/编码/关键词包含该词（通用匹配，无品牌硬编码）。
 */
export async function checkClaimScope(orgId: number, noradId: number): Promise<ClaimScopeCheck> {
  const [cnt] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM org_claim_scopes WHERE org_id = ?',
    [orgId]
  )
  if (!Number((cnt[0] as { n: number }).n)) return { configured: false, allowed: false, matched: null }
  const [hit] = await pool.query<RowDataPacket[]>(
    `SELECT s.scope_type, s.scope_value
       FROM org_claim_scopes s
      WHERE s.org_id = ?
        AND (
          (s.scope_type = 'norad' AND s.scope_value = ?)
          OR (s.scope_type = 'constellation_key' AND EXISTS (
                SELECT 1 FROM sat_constellation_sat cs
                  JOIN sat_constellation c ON c.id = cs.constellation_id
                 WHERE cs.norad_id = ? AND LOWER(c.code) = LOWER(s.scope_value)))
          OR (s.scope_type = 'tag' AND (
                EXISTS (SELECT 1 FROM sat_tle t
                         WHERE t.norad_id = ?
                           AND LOWER(t.object_name) LIKE CONCAT('%', LOWER(s.scope_value), '%'))
             OR EXISTS (SELECT 1 FROM sat_constellation_sat cs
                          JOIN sat_constellation c ON c.id = cs.constellation_id
                         WHERE cs.norad_id = ?
                           AND (LOWER(c.name) = LOWER(s.scope_value)
                             OR LOWER(IFNULL(c.name_en, '')) = LOWER(s.scope_value)
                             OR LOWER(IFNULL(c.code, '')) = LOWER(s.scope_value)
                             OR LOWER(IFNULL(c.keywords, '')) LIKE CONCAT('%', LOWER(s.scope_value), '%'))))
          )
        )
      LIMIT 1`,
    [orgId, String(noradId), noradId, noradId, noradId]
  )
  if (!hit.length) return { configured: true, allowed: false, matched: null }
  return {
    configured: true,
    allowed: true,
    matched: { scope_type: hit[0].scope_type as ClaimScopeType, scope_value: String(hit[0].scope_value) }
  }
}
