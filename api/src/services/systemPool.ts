/**
 * 系统池按档裁剪策略（Epic C3）。
 *
 * 口径（对齐计划书 C3 表）：
 * - 匿名 / 免费档 = 样例窗：公共小子集（最新 TLE_SAMPLE_LIMIT 条）+ 近 3 天 CDM 样例；
 * - 普通档 = 托管相关：仅本组织托管 NORAD 的 TLE + 有限天（30）CDM；
 * - VIP = 全量公开池 + 更深历史（365 天）+ 筛查优先队列；
 * - 具体限额来自 plan_defaults（可被 org_quota_overrides 覆盖），匿名按免费档样例放行。
 *
 * 所有系统池出站接口（catalog/tles、catalog/cdms、sat_tle/constellation、
 * sat_tle/tle_lines、sat_tle/detail、events）统一经由本模块解析可见范围；
 * 响应携带 data_source='system_pool' 与 pool 徽标信息。
 */
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import {
  ensurePlanSchema,
  getEffectiveLimits,
  TLE_SCOPE,
  TLE_SAMPLE_LIMIT
} from '../db/planDb.js'
import type { SafeOrg } from '../routes/auth.js'

export type PoolMode = 'none' | 'sample' | 'managed' | 'full'

export interface PoolPolicy {
  scope: number
  mode: PoolMode
  /** 样例窗大小（scope=sample 生效） */
  sampleLimit: number
  /** 系统 CDM 历史可查天数（0 = 不开放） */
  cdmDays: number
  /** 托管 NORAD 集合（scope=managed 生效；null = 非托管档） */
  managedNorads: number[] | null
  /** 筛查队列优先级（vip=0 / normal=1 / free·匿名=2，小者先跑） */
  priority: number
}

/** 匿名/平台账号按免费档样例窗放行（公共小子集） */
const ANON_PRIORITY = 2

export async function resolvePoolPolicy(org: SafeOrg | null): Promise<PoolPolicy> {
  if (!org) {
    return {
      scope: TLE_SCOPE.SAMPLE,
      mode: 'sample',
      sampleLimit: TLE_SAMPLE_LIMIT,
      cdmDays: 3,
      managedNorads: null,
      priority: ANON_PRIORITY
    }
  }
  let scope: number = TLE_SCOPE.SAMPLE
  let cdmDays = 3
  if (await ensurePlanSchema()) {
    const limits = await getEffectiveLimits(org.id, org.plan)
    const s = limits.find((l) => l.feature === 'system_tle_scope')?.limit
    const d = limits.find((l) => l.feature === 'system_cdm_days')?.limit
    if (typeof s === 'number') scope = s
    if (typeof d === 'number') cdmDays = d
  }
  const mode: PoolMode =
    scope === TLE_SCOPE.FULL ? 'full' : scope === TLE_SCOPE.MANAGED ? 'managed' : scope === TLE_SCOPE.SAMPLE ? 'sample' : 'none'
  const priority = org.plan === 'vip' ? 0 : org.plan === 'normal' ? 1 : ANON_PRIORITY
  let managedNorads: number[] | null = null
  if (mode === 'managed') {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT norad_id FROM objects WHERE org_id = ? AND claim_status = 'claimed' AND norad_id IS NOT NULL`,
      [org.id]
    )
    managedNorads = [...new Set(rows.map((r) => Number(r.norad_id)).filter((n) => Number.isFinite(n) && n > 0))]
  }
  return { scope, mode, sampleLimit: TLE_SAMPLE_LIMIT, cdmDays, managedNorads, priority }
}

/** 样例窗：按更新时间最新的 N 个 NORAD（公共小子集，匿名/免费档可见范围） */
export async function getSampleNoradIds(limit = TLE_SAMPLE_LIMIT): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT norad_id FROM sat_tle
      WHERE tle_line1 <> '' AND tle_line2 <> ''
      ORDER BY updated_at DESC, norad_id DESC
      LIMIT ?`,
    [limit]
  )
  return rows.map((r) => Number(r.norad_id))
}

/**
 * 可见 NORAD 集合（样例窗 / 托管相关档）：返回 null = 不限制（全量/不开放由调用方短路）。
 * scope=none 时返回空数组（调用方应直接返回空集）。
 */
export async function getVisibleNorads(policy: PoolPolicy): Promise<number[] | null> {
  if (policy.mode === 'full') return null
  if (policy.mode === 'none') return []
  if (policy.mode === 'managed') return policy.managedNorads ?? []
  return getSampleNoradIds(policy.sampleLimit)
}

/**
 * C4 客户 CDM 组织隔离：追加到 WHERE 的片段（params 需接在调用方现有参数之后）。
 * - 系统池行（source='system'）对所有登录方可读；
 * - 客户上传行（source='customer'）仅上传组织可读；
 * - 平台账号（无 org）只见系统池。
 */
export function cdmIsolation(orgId: number | null | undefined): { sql: string; params: unknown[] } {
  if (!orgId) return { sql: `AND source <> 'customer'`, params: [] }
  return { sql: `AND (source <> 'customer' OR org_id = ?)`, params: [Number(orgId)] }
}

/** pool 徽标（响应附带，前端按档位展示数据源与升级提示） */
export function poolBadge(policy: PoolPolicy): { scope: number; mode: PoolMode; sampleLimit: number; cdmDays: number } {
  return { scope: policy.scope, mode: policy.mode, sampleLimit: policy.sampleLimit, cdmDays: policy.cdmDays }
}
