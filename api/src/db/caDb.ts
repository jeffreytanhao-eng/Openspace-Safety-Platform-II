/**
 * 碰撞参数库层（Epic F1）：
 *  - ca_org_defaults：组织默认碰撞规避（CA）参数（每组织一行，upsert）；
 *  - conjunction_pc_runs：参数重算 run（生成新 run_id，旧 run 可对比，计入 recompute_day 配额）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

export type HbrMode = 'single' | 'both'
export type CovMode = 'tle-age' | 'cdm'
export type Propagator = 'sgp4' | 'numeric'

/** 组织默认 CA 参数（与 ca_org_defaults 列一一对应） */
export interface CaDefaults {
  org_id: number
  hbr_mode: HbrMode
  hbr_m: number
  hbr_a_m: number | null
  hbr_b_m: number | null
  accepted_pc: number
  accepted_miss_km: number
  screen_distance_km: number
  covariance_mode: CovMode
  propagator: Propagator
  window_h: number
  step_s: number
  pc_methods: string // 逗号分隔：foster,chan,alfano
  updated_by: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`ca_org_defaults\` (
  \`org_id\`            bigint unsigned NOT NULL,
  \`hbr_mode\`          varchar(10) NOT NULL DEFAULT 'single' COMMENT 'single=单侧合并 | both=双侧分设',
  \`hbr_m\`             double NOT NULL DEFAULT 15 COMMENT '单侧硬体/等效半径 (m)',
  \`hbr_a_m\`           double NULL COMMENT '双侧：A 侧半径 (m)',
  \`hbr_b_m\`           double NULL COMMENT '双侧：B 侧半径 (m)',
  \`accepted_pc\`       double NOT NULL DEFAULT 0.0001 COMMENT '接受 Pc 阈值',
  \`accepted_miss_km\`  double NOT NULL DEFAULT 1 COMMENT '接受最小脱靶 (km)',
  \`screen_distance_km\` double NOT NULL DEFAULT 10 COMMENT '筛查距离阈值 (km)',
  \`covariance_mode\`   varchar(12) NOT NULL DEFAULT 'tle-age' COMMENT 'tle-age | cdm',
  \`propagator\`        varchar(12) NOT NULL DEFAULT 'sgp4' COMMENT 'sgp4 | numeric',
  \`window_h\`          int NOT NULL DEFAULT 72 COMMENT '筛查时间窗 (h)',
  \`step_s\`            int NOT NULL DEFAULT 30 COMMENT '时间步长 (s)',
  \`pc_methods\`        varchar(64) NOT NULL DEFAULT 'foster,chan' COMMENT '勾选的 Pc 方法',
  \`updated_by\`        varchar(128) NOT NULL DEFAULT '',
  \`updated_at\`        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`org_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织默认碰撞参数（Epic F1）';

CREATE TABLE IF NOT EXISTS \`ca_user_params\` (
  \`user_id\`     bigint unsigned NOT NULL,
  \`slot\`        tinyint unsigned NOT NULL COMMENT '1/2：每个用户两组自有参数',
  \`params_json\` mediumtext NOT NULL COMMENT '完整参数集（见 CaParams）',
  \`updated_at\`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`user_id\`, \`slot\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='用户自有 CA 参数（两组；仅本人可见可用，不影响组织默认与其它用户）';

CREATE TABLE IF NOT EXISTS \`object_ca_params\` (
  \`object_id\`   bigint NOT NULL,
  \`org_id\`      bigint unsigned NOT NULL,
  \`params_json\` mediumtext NOT NULL COMMENT '完整参数集（见 CaParams）',
  \`updated_by\`  varchar(190) NOT NULL DEFAULT '',
  \`updated_at\`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`object_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='目标级自定义参数（仅授权认领业主生效，不影响关注/检索到该目标的其它用户）';

CREATE TABLE IF NOT EXISTS \`conjunction_pc_runs\` (
  \`id\`           bigint NOT NULL AUTO_INCREMENT,
  \`org_id\`       bigint unsigned NOT NULL,
  \`event_key\`    varchar(64) NOT NULL COMMENT '事件 key（a:b:firstTcaMs）',
  \`norad_a\`      int NOT NULL,
  \`norad_b\`      int NOT NULL,
  \`tca\`          datetime(3) NOT NULL,
  \`params_json\`  mediumtext COMMENT '本次 run 解析后的参数（含来源标记）',
  \`rows_json\`    mediumtext COMMENT 'Pc 比对行（方法/Pc/miss/TCA/HBR/协方差/耗时）',
  \`agreement\`    varchar(8) NULL COMMENT 'green|yellow|red',
  \`plane_json\`   mediumtext COMMENT '交会平面 + 协方差附加信息',
  \`triggered_by\` varchar(128) NOT NULL DEFAULT '',
  \`created_at\`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_run_org_event\` (\`org_id\`, \`event_key\`, \`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='参数重算 run（Epic F1，旧 run 可对比）'`

let schemaReady: Promise<boolean> | null = null

export function ensureCaSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
          await pool.query(ddl)
        }
        return true
      } catch (e) {
        console.error('[ca] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

type RawDefaults = RowDataPacket & CaDefaults

/** 读组织默认参数；未设置过返回 null（调用方回落系统建议值） */
export async function getCaDefaults(orgId: number): Promise<CaDefaults | null> {
  const [rows] = await pool.query<RawDefaults[]>(`SELECT * FROM ca_org_defaults WHERE org_id = ?`, [orgId])
  return rows[0] ?? null
}

/** 参数补丁（仅传需要修改的字段；数值范围在路由层已钳制） */
export interface CaDefaultsPatch {
  hbr_mode?: HbrMode
  hbr_m?: number
  hbr_a_m?: number | null
  hbr_b_m?: number | null
  accepted_pc?: number
  accepted_miss_km?: number
  screen_distance_km?: number
  covariance_mode?: CovMode
  propagator?: Propagator
  window_h?: number
  step_s?: number
  pc_methods?: string
}

/** upsert 组织默认参数（存在则改，不存在则建），返回最新行 */
export async function upsertCaDefaults(orgId: number, patch: CaDefaultsPatch, updatedBy: string): Promise<CaDefaults> {
  const cols = ['org_id', 'updated_by']
  const vals: unknown[] = [orgId, updatedBy]
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    cols.push(k)
    vals.push(v)
  }
  // 首次插入时补全所有 NOT NULL 列的默认值（列缺省依赖表默认值即可，无需显式给）
  const placeholders = cols.map(() => '?').join(', ')
  // 数值字段显式 NULL 也会经 VALUES() 落 NULL（hbr_a_m/hbr_b_m 双侧切回单侧时清空）
  const updates = cols
    .filter((c) => c !== 'org_id')
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  await pool.query(
    `INSERT INTO ca_org_defaults (${cols.join(', ')}) VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
    vals
  )
  const row = await getCaDefaults(orgId)
  if (!row) throw new Error('ca_org_defaults upsert 后读取失败')
  return row
}

/* ------------------- 用户自有 / 目标级自定义参数（两组 + 目标覆盖） ------------------- */

/** 完整 CA 参数集（不含 org_id 与审计字段），用于用户/目标级 JSON 存储 */
export interface CaParams {
  hbr_mode: HbrMode
  hbr_m: number
  hbr_a_m: number | null
  hbr_b_m: number | null
  accepted_pc: number
  accepted_miss_km: number
  screen_distance_km: number
  covariance_mode: CovMode
  propagator: Propagator
  window_h: number
  step_s: number
  pc_methods: string
}

export const CA_SYSTEM_DEFAULTS: CaParams = {
  hbr_mode: 'single',
  hbr_m: 15,
  hbr_a_m: null,
  hbr_b_m: null,
  accepted_pc: 1e-4,
  accepted_miss_km: 1,
  screen_distance_km: 10,
  covariance_mode: 'tle-age',
  propagator: 'sgp4',
  window_h: 72,
  step_s: 30,
  pc_methods: 'foster,chan'
}

/** 组织默认行 → 完整参数集（未设置过用系统建议值） */
export function caDefaultsToParams(d: CaDefaults | null): CaParams {
  if (!d) return { ...CA_SYSTEM_DEFAULTS }
  return {
    hbr_mode: d.hbr_mode,
    hbr_m: Number(d.hbr_m),
    hbr_a_m: d.hbr_a_m == null ? null : Number(d.hbr_a_m),
    hbr_b_m: d.hbr_b_m == null ? null : Number(d.hbr_b_m),
    accepted_pc: Number(d.accepted_pc),
    accepted_miss_km: Number(d.accepted_miss_km),
    screen_distance_km: Number(d.screen_distance_km),
    covariance_mode: d.covariance_mode,
    propagator: d.propagator,
    window_h: Number(d.window_h),
    step_s: Number(d.step_s),
    pc_methods: String(d.pc_methods || CA_SYSTEM_DEFAULTS.pc_methods)
  }
}

/** 在基准参数上应用补丁（未传字段保持不变） */
export function mergeCaParams(base: CaParams, patch: CaDefaultsPatch): CaParams {
  const out: CaParams = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    ;(out as unknown as Record<string, unknown>)[k] = v
  }
  return out
}

function parseParamsJson(raw: string | null): CaParams | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<CaParams>
    return { ...CA_SYSTEM_DEFAULTS, ...o }
  } catch {
    return null
  }
}

export interface UserCaSlot {
  slot: number
  params: CaParams | null
  updated_at: string | null
}

/** 某用户的全部自有参数（固定返回 slot 1/2，未配置为 null） */
export async function listUserCaParams(userId: number): Promise<UserCaSlot[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT slot, params_json, updated_at FROM ca_user_params WHERE user_id = ? ORDER BY slot',
    [userId]
  )
  const map = new Map<number, { params: CaParams; updated_at: string }>()
  for (const r of rows) {
    const p = parseParamsJson(r.params_json as string)
    if (p) map.set(Number(r.slot), { params: p, updated_at: String(r.updated_at) })
  }
  return [1, 2].map((slot) => ({
    slot,
    params: map.get(slot)?.params ?? null,
    updated_at: map.get(slot)?.updated_at ?? null
  }))
}

export async function saveUserCaParams(userId: number, slot: number, params: CaParams): Promise<void> {
  await pool.query(
    `INSERT INTO ca_user_params (user_id, slot, params_json) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE params_json = VALUES(params_json)`,
    [userId, slot, JSON.stringify(params)]
  )
}

export async function deleteUserCaParams(userId: number, slot: number): Promise<void> {
  await pool.query('DELETE FROM ca_user_params WHERE user_id = ? AND slot = ?', [userId, slot])
}

/** 目标级自定义参数（仅业主维护；不存在返回 null） */
export async function getObjectCaParams(objectId: number): Promise<CaParams | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT params_json FROM object_ca_params WHERE object_id = ?',
    [objectId]
  )
  return rows.length ? parseParamsJson(rows[0].params_json as string) : null
}

export async function saveObjectCaParams(
  objectId: number,
  orgId: number,
  params: CaParams,
  updatedBy: string
): Promise<void> {
  await pool.query(
    `INSERT INTO object_ca_params (object_id, org_id, params_json, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE params_json = VALUES(params_json), updated_by = VALUES(updated_by)`,
    [objectId, orgId, JSON.stringify(params), updatedBy]
  )
}

export async function deleteObjectCaParams(objectId: number): Promise<void> {
  await pool.query('DELETE FROM object_ca_params WHERE object_id = ?', [objectId])
}

/* ------------------------ 重算 run（F1） ------------------------ */

export interface PcRunRow {
  id: number
  org_id: number
  event_key: string
  norad_a: number
  norad_b: number
  tca: string
  params_json: string | null
  rows_json: string | null
  agreement: string | null
  plane_json: string | null
  triggered_by: string
  created_at: string
}

type RawRun = RowDataPacket & PcRunRow

export async function createPcRun(input: {
  orgId: number
  eventKey: string
  noradA: number
  noradB: number
  tca: Date
  paramsJson: string
  rowsJson: string
  agreement: string | null
  planeJson: string | null
  triggeredBy: string
}): Promise<number> {
  const [r] = await pool.query(
    `INSERT INTO conjunction_pc_runs
       (org_id, event_key, norad_a, norad_b, tca, params_json, rows_json, agreement, plane_json, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.orgId,
      input.eventKey,
      input.noradA,
      input.noradB,
      input.tca,
      input.paramsJson,
      input.rowsJson,
      input.agreement,
      input.planeJson,
      input.triggeredBy
    ]
  )
  return Number((r as { insertId: number }).insertId)
}

/** 本事件的 run 历史（本组织隔离，最新在前，上限 20） */
export async function listPcRuns(orgId: number, eventKey: string, limit = 20): Promise<PcRunRow[]> {
  const [rows] = await pool.query<RawRun[]>(
    `SELECT * FROM conjunction_pc_runs WHERE org_id = ? AND event_key = ? ORDER BY id DESC LIMIT ?`,
    [orgId, eventKey, Math.min(50, Math.max(1, limit))]
  )
  return rows
}

/** recompute_day 配额用量：今日发起的重算 run 数 */
export async function countRecomputeToday(orgId: number): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
    `SELECT COUNT(*) AS n FROM conjunction_pc_runs WHERE org_id = ? AND created_at >= CURDATE()`,
    [orgId]
  )
  return Number(rows[0]?.n) || 0
}
