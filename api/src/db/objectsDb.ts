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

export function ensureObjectsSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
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
