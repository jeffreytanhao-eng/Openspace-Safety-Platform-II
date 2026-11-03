/**
 * 托管目标库层（Epic D1）：
 *  - objects：组织认领的 NORAD 目标档案（质量/截面/推进/验收碰撞参数）；
 *  - 同一 NORAD 同时只允许一个组织认领（uk_norad 唯一键兜底，应用层预查给出友好 409）；
 *  - 星历绑定挂在 ephemeris.bound_object_id（见 ephemDb.ensureEphemSchema 增列）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

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
  \`created_at\`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_norad\` (\`norad_id\`),
  KEY \`idx_org\` (\`org_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='托管目标（组织认领的 NORAD 档案）'`

let schemaReady: Promise<boolean> | null = null

export function ensureObjectsSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = pool
      .query(SCHEMA)
      .then(() => true)
      .catch((e) => {
        console.error('[objects] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      })
  }
  return schemaReady
}

interface RawObject extends RowDataPacket, ObjectRow {}

const COLS = 'id, org_id, norad_id, name, mass_kg, cross_section_m2, propulsion, accepted_pc, accepted_miss_km, claim_status, created_at, updated_at'

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

export async function getObjectByNorad(noradId: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(`SELECT ${COLS} FROM objects WHERE norad_id = ?`, [noradId])
  return (rows[0] as ObjectRow) ?? null
}

export interface CreateObjectInput {
  orgId: number
  noradId: number
  name: string
  massKg?: number | null
  crossSectionM2?: number | null
  propulsion?: string
}

export async function createObject(input: CreateObjectInput): Promise<ObjectRow> {
  const [r] = await pool.query(
    `INSERT INTO objects (org_id, norad_id, name, mass_kg, cross_section_m2, propulsion)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.orgId, input.noradId, input.name, input.massKg ?? null, input.crossSectionM2 ?? null, input.propulsion ?? '']
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
