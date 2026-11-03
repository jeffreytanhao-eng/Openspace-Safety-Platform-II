/**
 * 档位与配额数据库层（Epic A2）。
 *
 * 设计口径：
 * - plan_defaults：每档位 × 功能键的默认限额（服务端 seed，可运营调整）；
 * - org_quota_overrides：组织级覆盖（超管在 B1 配置），effective = override ?? default；
 * - limit_value 统一整数语义：数值型键为数量上限；
 *   枚举/位图型键按约定编码（见 FEATURE_KEYS 注释）；
 * - 用量计算器按功能键注册，业务表未建的键返回 0（E1/D1 接入后自动生效）。
 */
import { pool } from './pool.js'
import type { RowDataPacket } from 'mysql2'

/** 功能键：label 展示用；unit = count(数量) | days(天数窗口) | bitmap(位图) | scope(范围档) */
export interface FeatureMeta {
  key: string
  label: string
  unit: 'count' | 'days' | 'bitmap' | 'scope'
}

/**
 * 功能键语义：
 * - objects_max        托管目标数量上限（count）
 * - ephem_upload_day   每日星历上传次数（count/天）
 * - screen_day         每日筛查任务数（count/天）
 * - recompute_day      每日重算次数（count/天）
 * - system_tle_scope   系统池 TLE 可见范围（scope：0=不开放 1=平台公开池）
 * - system_cdm_days    系统 CDM 历史可查天数（days）
 * - pc_methods         可用 Pc 算法位图（bitmap：1=Foster 2=Chan 4=Alfano 8=官方CDM）
 * - api_keys_max       API Key 数量上限（count）
 * - members_max        组织成员数上限（count）
 */
export const FEATURE_KEYS: FeatureMeta[] = [
  { key: 'objects_max', label: '托管目标数', unit: 'count' },
  { key: 'ephem_upload_day', label: '每日星历上传', unit: 'count' },
  { key: 'screen_day', label: '每日筛查任务', unit: 'count' },
  { key: 'recompute_day', label: '每日重算次数', unit: 'count' },
  { key: 'system_tle_scope', label: '系统池可见范围', unit: 'scope' },
  { key: 'system_cdm_days', label: '系统CDM可查天数', unit: 'days' },
  { key: 'pc_methods', label: 'Pc 算法集', unit: 'bitmap' },
  { key: 'api_keys_max', label: 'API Key 数', unit: 'count' },
  { key: 'members_max', label: '组织成员数', unit: 'count' }
]

/** Pc 算法位图位 */
export const PC_BIT = { Foster: 1, Chan: 2, Alfano: 4, OfficialCDM: 8 } as const

/**
 * 档位默认限额（首次 seed 后可运营在库内调整，代码不再强约束）。
 * bitmap/scope 语义见 FEATURE_KEYS。
 */
const PLAN_SEED: Record<'free' | 'normal' | 'vip', Record<string, number>> = {
  free: {
    objects_max: 3,
    ephem_upload_day: 5,
    screen_day: 5,
    recompute_day: 20,
    system_tle_scope: 0,
    system_cdm_days: 0,
    pc_methods: PC_BIT.Foster | PC_BIT.Chan,
    api_keys_max: 0,
    members_max: 2
  },
  normal: {
    objects_max: 50,
    ephem_upload_day: 100,
    screen_day: 100,
    recompute_day: 500,
    system_tle_scope: 1,
    system_cdm_days: 30,
    pc_methods: PC_BIT.Foster | PC_BIT.Chan | PC_BIT.Alfano | PC_BIT.OfficialCDM,
    api_keys_max: 3,
    members_max: 10
  },
  vip: {
    objects_max: 500,
    ephem_upload_day: 1000,
    screen_day: 1000,
    recompute_day: 5000,
    system_tle_scope: 1,
    system_cdm_days: 365,
    pc_methods: PC_BIT.Foster | PC_BIT.Chan | PC_BIT.Alfano | PC_BIT.OfficialCDM,
    api_keys_max: 20,
    members_max: 50
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`plan_defaults\` (
  \`plan\`        enum('free','normal','vip') NOT NULL,
  \`feature_key\` varchar(64) NOT NULL,
  \`limit_value\` bigint NOT NULL,
  PRIMARY KEY (\`plan\`, \`feature_key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='档位默认限额（plan × feature_key）';

CREATE TABLE IF NOT EXISTS \`org_quota_overrides\` (
  \`org_id\`      bigint unsigned NOT NULL,
  \`feature_key\` varchar(64) NOT NULL,
  \`limit_value\` bigint NOT NULL,
  PRIMARY KEY (\`org_id\`, \`feature_key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织级限额覆盖（effective = override ?? plan default）'`

let schemaReady: Promise<boolean> | null = null

/** 建表（幂等）+ 首次 seed 默认限额（INSERT IGNORE，不覆盖运营改动） */
export function ensurePlanSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const ddl of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
          await pool.query(ddl)
        }
        const [cnt] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM plan_defaults')
        if (Number((cnt[0] as { n: number }).n) === 0) {
          for (const [plan, limits] of Object.entries(PLAN_SEED)) {
            for (const [key, value] of Object.entries(limits)) {
              await pool.query(
                'INSERT IGNORE INTO plan_defaults (plan, feature_key, limit_value) VALUES (?, ?, ?)',
                [plan, key, value]
              )
            }
          }
          console.log('[plan] seeded plan_defaults (free/normal/vip)')
        }
        return true
      } catch (e) {
        console.error('[plan] ensure schema failed:', (e as Error).message)
        return false
      }
    })()
  }
  return schemaReady
}

export interface EffectiveLimit {
  feature: string
  /** 生效限额（override ?? plan default） */
  limit: number
  /** 是否组织级覆盖 */
  overridden: boolean
}

/** 组织的生效限额表（orgId 为空 = 平台账号，返回空表视为不限） */
export async function getEffectiveLimits(orgId: number | null, plan: string | null): Promise<EffectiveLimit[]> {
  if (!orgId || !plan) return []
  const [defaults] = await pool.query<RowDataPacket[]>(
    'SELECT feature_key, limit_value FROM plan_defaults WHERE plan = ?',
    [plan]
  )
  const [overrides] = await pool.query<RowDataPacket[]>(
    'SELECT feature_key, limit_value FROM org_quota_overrides WHERE org_id = ?',
    [orgId]
  )
  const oMap = new Map(overrides.map((r) => [r.feature_key, Number(r.limit_value)]))
  return defaults.map((r) => ({
    feature: r.feature_key,
    limit: Number(r.limit_value),
    overridden: oMap.has(r.feature_key)
  })).map((d) => ({ ...d, limit: oMap.get(d.feature) ?? d.limit }))
}

/** 用量计算器：业务表未建的键抛错 → 统一按 0 处理（后续 Epic 接入） */
const usageComputers: Record<string, (orgId: number) => Promise<number>> = {
  // Epic D1 建 objects 表后生效
  objects_max: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM objects WHERE org_id = ?',
      [orgId]
    )
    return Number((rows[0] as { n: number }).n)
  },
  // 组织成员数（users 表 Epic A1 已建）
  members_max: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM users WHERE org_id = ?',
      [orgId]
    )
    return Number((rows[0] as { n: number }).n)
  },
  // E1 筛查任务表接入后生效（当日 0 点起计数；口径 = 发起的任务数，非事件数）
  screen_day: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM screening_jobs WHERE org_id = ? AND queued_at >= CURDATE()',
      [orgId]
    )
    return Number((rows[0] as { n: number }).n)
  }
}

/** 查询组织某功能键当前用量（无计算器或表未建 → 0） */
export async function getUsage(orgId: number, feature: string): Promise<number> {
  const fn = usageComputers[feature]
  if (!fn) return 0
  try {
    return await fn(orgId)
  } catch {
    return 0
  }
}
