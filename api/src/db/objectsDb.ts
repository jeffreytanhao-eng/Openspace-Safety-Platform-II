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
/** 认领状态：授权认领需超管审核；普通认领创建即 claimed */
export type ClaimStatus = 'pending' | 'claimed' | 'rejected'

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
  claim_status: ClaimStatus
  claim_type: ClaimType
  /** 发起认领申请的用户（授权认领审核通过后，该用户即唯一业主） */
  requested_by_user_id: number | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
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
  \`claim_status\`    varchar(20) NOT NULL DEFAULT 'claimed' COMMENT 'pending=待审核 / claimed=已生效 / rejected=已驳回',
  \`claim_type\`      enum('normal','owner') NOT NULL DEFAULT 'normal' COMMENT '认领类型：normal=普通（可多次）/ owner=授权（卫星业主，全局唯一）',
  \`requested_by_user_id\` bigint unsigned NULL COMMENT '发起认领申请的用户（授权认领通过后即唯一业主）',
  \`reviewed_by\`     varchar(190) NULL COMMENT '审核人（超管邮箱）',
  \`reviewed_at\`     datetime(3) NULL COMMENT '审核时间',
  \`review_note\`     varchar(255) NULL COMMENT '审核备注/驳回原因',
  \`owner_norad\`     int GENERATED ALWAYS AS (CASE WHEN \`claim_type\` = 'owner' AND \`claim_status\` = 'claimed' THEN \`norad_id\` ELSE NULL END) STORED COMMENT '已生效授权认领 NORAD（待审/普通认领为 NULL，唯一键保证全局仅一个生效授权认领）',
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

/** 旧库迁移（幂等）：认领审核字段 + 全局唯一生成列（仅已生效授权认领占用） */
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
  // 认领审核字段（第 5 项：授权认领需超管审核）
  if (!colNames.has('requested_by_user_id')) {
    await pool.query(
      `ALTER TABLE objects ADD COLUMN requested_by_user_id bigint unsigned NULL
        COMMENT '发起认领申请的用户（授权认领通过后即唯一业主）' AFTER claim_type`
    )
  }
  if (!colNames.has('reviewed_by')) {
    await pool.query(`ALTER TABLE objects ADD COLUMN reviewed_by varchar(190) NULL COMMENT '审核人（超管邮箱）' AFTER requested_by_user_id`)
  }
  if (!colNames.has('reviewed_at')) {
    await pool.query(`ALTER TABLE objects ADD COLUMN reviewed_at datetime(3) NULL COMMENT '审核时间' AFTER reviewed_by`)
  }
  if (!colNames.has('review_note')) {
    await pool.query(`ALTER TABLE objects ADD COLUMN review_note varchar(255) NULL COMMENT '审核备注/驳回原因' AFTER reviewed_at`)
  }
  if (idxNames.has('uk_norad')) {
    await pool.query('ALTER TABLE objects DROP INDEX uk_norad')
  }
  if (!idxNames.has('uk_org_norad')) {
    await pool.query('ALTER TABLE objects ADD UNIQUE KEY uk_org_norad (org_id, norad_id)')
  }
  const OWNER_COL = `ADD COLUMN owner_norad int GENERATED ALWAYS AS
      (CASE WHEN claim_type = 'owner' AND claim_status = 'claimed' THEN norad_id ELSE NULL END) STORED
      COMMENT '已生效授权认领 NORAD（待审/普通认领为 NULL，唯一键保证全局仅一个生效授权认领）',
    ADD UNIQUE KEY uk_owner_norad (owner_norad)`
  if (!colNames.has('owner_norad')) {
    await pool.query(`ALTER TABLE objects ${OWNER_COL}`)
  } else {
    const [g] = await pool.query<RowDataPacket[]>(
      `SELECT GENERATION_EXPRESSION AS expr FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'objects' AND column_name = 'owner_norad'`
    )
    const expr = String((g[0] as { expr?: string } | undefined)?.expr ?? '')
    if (!expr.includes('claim_status')) {
      // 旧表达式只判断 claim_type → 待审核申请也会占用唯一键，改为仅「已生效」占用
      if (idxNames.has('uk_owner_norad')) {
        await pool.query('ALTER TABLE objects DROP INDEX uk_owner_norad')
      }
      await pool.query('ALTER TABLE objects DROP COLUMN owner_norad')
      await pool.query(`ALTER TABLE objects ${OWNER_COL}`)
    } else if (!idxNames.has('uk_owner_norad')) {
      await pool.query('ALTER TABLE objects ADD UNIQUE KEY uk_owner_norad (owner_norad)')
    }
  }
}

interface RawObject extends RowDataPacket, ObjectRow {}

const COLS = 'id, org_id, norad_id, name, mass_kg, cross_section_m2, propulsion, accepted_pc, accepted_miss_km, claim_status, claim_type, requested_by_user_id, reviewed_by, reviewed_at, review_note, created_at, updated_at'

export async function listObjectsByOrg(orgId: number, opts?: { includePending?: boolean }): Promise<ObjectRow[]> {
  const statusFilter = opts?.includePending ? "claim_status IN ('claimed','pending')" : "claim_status = 'claimed'"
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects WHERE org_id = ? AND ${statusFilter} ORDER BY id DESC`,
    [orgId]
  )
  return rows as ObjectRow[]
}

/** 平台账号只读视图：全平台已生效目标（带所属组织名） */
export async function listAllObjects(): Promise<Array<ObjectRow & { org_name: string }>> {
  const [rows] = await pool.query<Array<RawObject & { org_name: string | null }>>(
    `SELECT o.id, o.org_id, o.norad_id, o.name, o.mass_kg, o.cross_section_m2, o.propulsion,
            o.accepted_pc, o.accepted_miss_km, o.claim_status, o.claim_type,
            o.requested_by_user_id, o.reviewed_by, o.reviewed_at, o.review_note,
            o.created_at, o.updated_at, g.name AS org_name
       FROM objects o LEFT JOIN organizations g ON g.id = o.org_id
      WHERE o.claim_status = 'claimed'
      ORDER BY o.id DESC`
  )
  return rows.map((r) => ({ ...(r as ObjectRow), org_name: String(r.org_name ?? '') }))
}

/** 平台账号只读：目标所属组织名 */
export async function getObjectOrgName(orgId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT name FROM organizations WHERE id = ? LIMIT 1',
    [orgId]
  )
  return String(rows[0]?.name ?? '')
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

/** 某 NORAD 已生效的授权认领（卫星业主；全局最多一条） */
export async function getOwnerClaim(noradId: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects
      WHERE norad_id = ? AND claim_type = 'owner' AND claim_status = 'claimed'`,
    [noradId]
  )
  return (rows[0] as ObjectRow) ?? null
}

/** 某用户在某 NORAD 上已生效的授权认领（星历上传/参数维护的权限依据） */
export async function getOwnerClaimByUser(userId: number, noradId: number): Promise<ObjectRow | null> {
  const [rows] = await pool.query<RawObject[]>(
    `SELECT ${COLS} FROM objects
      WHERE requested_by_user_id = ? AND norad_id = ? AND claim_type = 'owner' AND claim_status = 'claimed'`,
    [userId, noradId]
  )
  return (rows[0] as ObjectRow) ?? null
}

export interface CreateObjectInput {
  orgId: number
  noradId: number
  name: string
  claimType?: ClaimType
  claimStatus?: ClaimStatus
  requestedByUserId?: number | null
  massKg?: number | null
  crossSectionM2?: number | null
  propulsion?: string
}

export async function createObject(input: CreateObjectInput): Promise<ObjectRow> {
  const [r] = await pool.query(
    `INSERT INTO objects
       (org_id, norad_id, name, claim_type, claim_status, requested_by_user_id, mass_kg, cross_section_m2, propulsion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.orgId,
      input.noradId,
      input.name,
      input.claimType ?? 'normal',
      input.claimStatus ?? 'claimed',
      input.requestedByUserId ?? null,
      input.massKg ?? null,
      input.crossSectionM2 ?? null,
      input.propulsion ?? ''
    ]
  )
  const id = Number((r as { insertId: number }).insertId)
  return (await getObjectById(id)) as ObjectRow
}

/**
 * 被驳回后重新申请：仅允许对被驳回的本组织原有记录重置状态（owner → pending / normal → claimed）。
 * 返回 false 表示该记录不存在或不是 rejected 态。
 */
export async function resubmitObjectClaim(
  id: number,
  input: {
    claimType: ClaimType
    requestedByUserId: number
    massKg?: number | null
    crossSectionM2?: number | null
    propulsion?: string
  }
): Promise<boolean> {
  const [r] = await pool.query(
    `UPDATE objects
        SET claim_type = ?, claim_status = ?, requested_by_user_id = ?,
            review_note = NULL, reviewed_by = '', reviewed_at = NULL,
            mass_kg = ?, cross_section_m2 = ?, propulsion = ?,
            created_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND claim_status = 'rejected'`,
    [
      input.claimType,
      input.claimType === 'owner' ? 'pending' : 'claimed',
      input.requestedByUserId,
      input.massKg ?? null,
      input.crossSectionM2 ?? null,
      input.propulsion ?? '',
      id
    ]
  )
  return Number((r as { affectedRows?: number }).affectedRows || 0) > 0
}

/**
 * R2-27：同一组织已「关注」的目标再发起业主认领时，原地升级为 owner+pending，
 * 不插入第二行（uk_org_norad 保证一行）；仅允许 claimed+normal 的现有行。
 */
export async function upgradeNormalToOwner(
  id: number,
  input: {
    requestedByUserId: number
    massKg?: number | null
    crossSectionM2?: number | null
    propulsion?: string
  }
): Promise<boolean> {
  const [r] = await pool.query(
    `UPDATE objects
        SET claim_type = 'owner', claim_status = 'pending', requested_by_user_id = ?,
            review_note = NULL, reviewed_by = '', reviewed_at = NULL,
            mass_kg = ?, cross_section_m2 = ?, propulsion = ?,
            created_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND claim_type = 'normal' AND claim_status = 'claimed'`,
    [
      input.requestedByUserId,
      input.massKg ?? null,
      input.crossSectionM2 ?? null,
      input.propulsion ?? '',
      id
    ]
  )
  return Number((r as { affectedRows?: number }).affectedRows || 0) > 0
}

export interface OwnerClaimReviewRow {
  id: number
  norad_id: number
  claim_status: ClaimStatus
  created_at: string
  review_note: string | null
  org_id: number
  org_name: string
  user_id: number | null
  user_email: string
  reviewed_by: string | null
  reviewed_at: string | null
}

/** 超管审核列表：授权认领申请（默认只看待审） */
export async function listOwnerClaims(
  status: 'pending' | 'claimed' | 'rejected' | 'all' = 'pending'
): Promise<OwnerClaimReviewRow[]> {
  const where = status === 'all' ? '' : 'AND o.claim_status = ?'
  const args = status === 'all' ? [] : [status]
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT o.id, o.norad_id, o.claim_status, o.created_at, o.review_note,
            o.org_id, COALESCE(g.name, '') AS org_name,
            o.requested_by_user_id AS user_id, COALESCE(u.email, '') AS user_email,
            o.reviewed_by, o.reviewed_at
       FROM objects o
       LEFT JOIN organizations g ON g.id = o.org_id
       LEFT JOIN users u ON u.id = o.requested_by_user_id
      WHERE o.claim_type = 'owner' ${where}
      ORDER BY o.created_at DESC LIMIT 500`,
    args
  )
  return rows as unknown as OwnerClaimReviewRow[]
}

/**
 * 审核通过：目标仅归该申请用户所有。
 * 事务内校验无其它已生效授权认领；同时驳回该目标其余待审申请。
 */
export async function approveOwnerClaim(
  id: number,
  reviewerEmail: string,
  note = ''
): Promise<{ ok: boolean; error?: string; row?: ObjectRow }> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, norad_id, claim_type, claim_status FROM objects WHERE id = ? FOR UPDATE`,
      [id]
    )
    if (!rows.length) {
      await conn.rollback()
      return { ok: false, error: '认领申请不存在' }
    }
    const r = rows[0] as { id: number; norad_id: number; claim_type: ClaimType; claim_status: ClaimStatus }
    if (r.claim_type !== 'owner') {
      await conn.rollback()
      return { ok: false, error: '该记录不是授权认领申请' }
    }
    if (r.claim_status !== 'pending') {
      await conn.rollback()
      return { ok: false, error: '该申请已处理' }
    }
    const [dup] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM objects
        WHERE norad_id = ? AND claim_type = 'owner' AND claim_status = 'claimed' AND id <> ? LIMIT 1`,
      [r.norad_id, id]
    )
    if (dup.length) {
      await conn.rollback()
      return { ok: false, error: '该目标已被其他用户认领' }
    }
    await conn.query(
      `UPDATE objects SET claim_status = 'claimed', reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?`,
      [reviewerEmail, note.slice(0, 255), id]
    )
    await conn.query(
      `UPDATE objects SET claim_status = 'rejected', reviewed_by = ?, reviewed_at = NOW(3),
              review_note = '目标已被其他用户认领'
        WHERE norad_id = ? AND claim_type = 'owner' AND claim_status = 'pending' AND id <> ?`,
      [reviewerEmail, r.norad_id, id]
    )
    await conn.commit()
    return { ok: true, row: (await getObjectById(id)) ?? undefined }
  } catch (e) {
    try {
      await conn.rollback()
    } catch {
      /* ignore */
    }
    const msg = (e as Error).message || ''
    if (msg.includes('uk_owner_norad') || msg.includes('Duplicate entry')) {
      return { ok: false, error: '该目标已被其他用户认领' }
    }
    return { ok: false, error: msg }
  } finally {
    conn.release()
  }
}

/** 审核驳回 */
export async function rejectOwnerClaim(
  id: number,
  reviewerEmail: string,
  note = ''
): Promise<{ ok: boolean; error?: string }> {
  const [r] = await pool.query(
    `UPDATE objects SET claim_status = 'rejected', reviewed_by = ?, reviewed_at = NOW(3), review_note = ?
      WHERE id = ? AND claim_type = 'owner' AND claim_status = 'pending'`,
    [reviewerEmail, note.slice(0, 255), id]
  )
  const affected = Number((r as { affectedRows?: number }).affectedRows ?? 0)
  return affected ? { ok: true } : { ok: false, error: '申请不存在或已处理' }
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
