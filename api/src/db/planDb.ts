/**
 * 档位与配额数据库层（Epic A2）。
 *
 * 设计口径：
 * - plan_defaults：每档位 × 功能键的默认限额（服务端 seed，可运营调整）；
 * - org_quota_overrides：组织级覆盖（超管在 B1 配置），effective = override ?? default；
 * - limit_value 统一整数语义：数值型键为数量上限；
 *   枚举/位图型键按约定编码（见 FEATURE_KEYS 注释）；
 * - 用量计算器按功能键注册，业务表未建的键返回 0（E1/D1 接入后自动生效）；
 * - C3 起 system_tle_scope 语义升级为四档（见 TLE_SCOPE 注释），
 *   首次启动检测到旧三档签名时自动重播 seed（幂等，不覆盖运营后续调整）。
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
 * - objects_max        目标数量上限（count）
 * - ephem_upload_day   每日星历上传次数（count/天）
 * - screen_day         每日筛查任务数（count/天）
 * - recompute_day      每日重算次数（count/天）
 * - system_tle_scope   系统池 TLE 可见范围（scope 四档，见 TLE_SCOPE）
 * - system_cdm_days    系统 CDM 历史可查天数（days）
 * - pc_methods         可用 Pc 算法位图（bitmap：1=Foster 2=Chan 4=Alfano 8=官方CDM）
 * - api_keys_max       API Key 数量上限（count）
 * - members_max        组织成员数上限（count）
 */
export const FEATURE_KEYS: FeatureMeta[] = [
  { key: 'objects_max', label: '目标数', unit: 'count' },
  { key: 'ephem_upload_day', label: '每日星历上传', unit: 'count' },
  { key: 'screen_day', label: '每日筛查任务', unit: 'count' },
  { key: 'recompute_day', label: '每日重算次数', unit: 'count' },
  { key: 'system_tle_scope', label: '系统目录可见范围', unit: 'scope' },
  { key: 'system_cdm_days', label: '系统CDM可查天数', unit: 'days' },
  { key: 'pc_methods', label: 'Pc 算法集', unit: 'bitmap' },
  { key: 'api_keys_max', label: 'API Key 数', unit: 'count' },
  { key: 'members_max', label: '单位成员数', unit: 'count' }
]

/** Pc 算法位图位 */
export const PC_BIT = { Foster: 1, Chan: 2, Alfano: 4, OfficialCDM: 8 } as const

/**
 * system_tle_scope 四档编码（C3 按档位裁剪系统池）：
 * - 0 = 不开放系统池
 * - 1 = 样例窗：公共小子集（按更新时间最新 TLE_SAMPLE_LIMIT 条）
 * - 2 = 托管相关：仅本组织托管 NORAD 的 TLE
 * - 3 = 全量公开池
 */
export const TLE_SCOPE = { NONE: 0, SAMPLE: 1, MANAGED: 2, FULL: 3 } as const

/** 样例窗大小（scope=1 时的公共小子集条数） */
export const TLE_SAMPLE_LIMIT = 500

/**
 * 档位默认限额（首次 seed 后可运营在库内调整，代码不再强约束）。
 * bitmap/scope 语义见 FEATURE_KEYS / TLE_SCOPE。
 * C3 口径：免费=样例窗+3 天 CDM 样例；普通=全库可搜+30 天；VIP=全量+365 天。
 */
const PLAN_SEED: Record<'free' | 'normal' | 'vip', Record<string, number>> = {
  free: {
    objects_max: 3,
    ephem_upload_day: 5,
    screen_day: 5,
    recompute_day: 20,
    system_tle_scope: TLE_SCOPE.SAMPLE,
    system_cdm_days: 3,
    pc_methods: PC_BIT.Foster | PC_BIT.Chan,
    api_keys_max: 0,
    members_max: 2
  },
  normal: {
    objects_max: 50,
    ephem_upload_day: 100,
    screen_day: 100,
    recompute_day: 500,
    // C3：普通档编目检索与托管列表解耦，全库可搜；用量仍受 objects_max / screen_day 约束
    system_tle_scope: TLE_SCOPE.FULL,
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
    system_tle_scope: TLE_SCOPE.FULL,
    system_cdm_days: 365,
    pc_methods: PC_BIT.Foster | PC_BIT.Chan | PC_BIT.Alfano | PC_BIT.OfficialCDM,
    api_keys_max: 20,
    // R2-30：组织管理员最多 3 名成员（不含管理员本人），VIP 档位默认同口径
    members_max: 3
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
  COMMENT='组织级限额覆盖（effective = override ?? plan default）';

CREATE TABLE IF NOT EXISTS \`org_feature_flags\` (
  \`org_id\`   bigint unsigned NOT NULL,
  \`flag_key\` varchar(64) NOT NULL,
  \`enabled\`  tinyint NOT NULL DEFAULT 1,
  \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`org_id\`, \`flag_key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织级功能开关覆盖（enabled = override ?? catalog default）'`

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
          await seedPlanDefaults()
        } else {
          await migrateScopeSemantics()
          // C3 一次性：普通档「托管相关(2)」→「全库可搜(3)」；改成 3 后不再命中，不会反复覆盖
          await pool.query(
            "UPDATE plan_defaults SET limit_value = ? WHERE plan = 'normal' AND feature_key = 'system_tle_scope' AND limit_value = ?",
            [TLE_SCOPE.FULL, TLE_SCOPE.MANAGED]
          )
          // R2-30 一次性：VIP 档成员上限 50 → 3（改成 3 后不再命中）
          await pool.query(
            "UPDATE plan_defaults SET limit_value = 3 WHERE plan = 'vip' AND feature_key = 'members_max' AND limit_value = 50"
          )
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

function seedPlanDefaults(): Promise<void> {
  return (async () => {
    for (const [plan, limits] of Object.entries(PLAN_SEED)) {
      for (const [key, value] of Object.entries(limits)) {
        await pool.query(
          'INSERT IGNORE INTO plan_defaults (plan, feature_key, limit_value) VALUES (?, ?, ?)',
          [plan, key, value]
        )
      }
    }
    console.log('[plan] seeded plan_defaults (free/normal/vip)')
  })()
}

/**
 * C3 一次性迁移：system_tle_scope 旧三档签名（free=0 & normal=1 & vip=1）
 * → 删除两个范围键行后按新四档语义重播；迁移后签名不再命中，不会重复重置。
 */
async function migrateScopeSemantics(): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT plan, limit_value FROM plan_defaults WHERE feature_key = 'system_tle_scope'`
  )
  const byPlan = new Map(rows.map((r) => [String(r.plan), Number(r.limit_value)]))
  if (byPlan.get('free') !== 0 || byPlan.get('normal') !== 1 || byPlan.get('vip') !== 1) return
  await pool.query(
    `DELETE FROM plan_defaults WHERE feature_key IN ('system_tle_scope','system_cdm_days')`
  )
  await seedPlanDefaults()
  console.log('[plan] migrated system_tle_scope semantics: free=sample(1) normal=managed(2) vip=full(3)')
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
  // 组织成员数（R2-30：只统计 org_member，不含管理员本人）
  members_max: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'org_member'",
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
  },
  // F1 重算 run 表接入后生效（口径 = 当日发起的参数重算次数）
  recompute_day: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM conjunction_pc_runs WHERE org_id = ? AND created_at >= CURDATE()',
      [orgId]
    )
    return Number((rows[0] as { n: number }).n)
  },
  // Epic I 计量全量：当日星历上传次数（版本账本 source=upload，created_at 为 ISO 字符串，按日期前缀比较）
  ephem_upload_day: async (orgId) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ephemeris_versions v
        JOIN users u ON u.email = v.uploaded_by
       WHERE u.org_id = ? AND v.source = 'upload' AND v.created_at >= DATE_FORMAT(NOW(), '%Y-%m-%d')`,
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

/* ==================== Epic I：功能开关与超管 override 管理 ==================== */

/** 功能开关目录（enabled 默认值即未覆盖时的生效值；均须有真实执行点，不做无行为开关） */
export interface FeatureFlagMeta {
  key: string
  label: string
  description: string
  defaultValue: boolean
}

export const FLAG_CATALOG: FeatureFlagMeta[] = [
  {
    key: 'daily_report_enabled',
    label: '日报生成',
    description: '关闭后该组织不再生成每日分级快照日报（cron 与手动出报均被冻结）',
    defaultValue: true
  },
  {
    key: 'webhook_enabled',
    label: 'Webhook 投递',
    description: '关闭后该组织的 Webhook 渠道不再投递（日报/分级变化/测试均跳过并留审计）',
    defaultValue: true
  },
  {
    key: 'accuracy_compare_enabled',
    label: '精度对比（G2）',
    description: '关闭后该组织无法使用 OCM/TLE/AOE 三源 RTN 精度对比',
    defaultValue: true
  }
]

export interface QuotaRow {
  feature: string
  label: string
  unit: FeatureMeta['unit']
  /** 档位默认 */
  default: number
  /** 组织覆盖值（null = 未覆盖） */
  override: number | null
  /** 生效值 = override ?? default */
  effective: number
  overridden: boolean
  /** 当前用量（无计算器 = 0） */
  usage: number
}

/** 组织配额全量行（超管 UI 数据源：默认 / 覆盖 / 生效 / 用量） */
export async function getOrgQuotaRows(orgId: number, plan: string): Promise<QuotaRow[]> {
  await ensurePlanSchema()
  const [defaults] = await pool.query<RowDataPacket[]>(
    'SELECT feature_key, limit_value FROM plan_defaults WHERE plan = ?',
    [plan]
  )
  const [overrideRows] = await pool.query<RowDataPacket[]>(
    'SELECT feature_key, limit_value FROM org_quota_overrides WHERE org_id = ?',
    [orgId]
  )
  const dMap = new Map(defaults.map((r) => [r.feature_key, Number(r.limit_value)]))
  const oMap = new Map(overrideRows.map((r) => [r.feature_key, Number(r.limit_value)]))
  const out: QuotaRow[] = []
  for (const meta of FEATURE_KEYS) {
    const def = dMap.get(meta.key)
    const override = oMap.has(meta.key) ? oMap.get(meta.key)! : null
    if (def === undefined && override === null) continue // 档位无默认行且无覆盖 → 跳过
    const usage = await getUsage(orgId, meta.key)
    out.push({
      feature: meta.key,
      label: meta.label,
      unit: meta.unit,
      default: def ?? 0,
      override,
      effective: override ?? def ?? 0,
      overridden: override !== null,
      usage
    })
  }
  return out
}

export interface FlagRow {
  key: string
  label: string
  description: string
  /** 目录默认值 */
  default: boolean
  /** 组织覆盖值（null = 未覆盖） */
  override: boolean | null
  /** 生效值 = override ?? default */
  enabled: boolean
  overridden: boolean
}

/** 组织功能开关全量行（超管 UI 数据源） */
export async function getOrgFlagRows(orgId: number): Promise<FlagRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT flag_key, enabled FROM org_feature_flags WHERE org_id = ?',
    [orgId]
  )
  const oMap = new Map(rows.map((r) => [r.flag_key, Number(r.enabled) !== 0]))
  return FLAG_CATALOG.map((m) => {
    const override = oMap.has(m.key) ? oMap.get(m.key)! : null
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      default: m.defaultValue,
      override,
      enabled: override ?? m.defaultValue,
      overridden: override !== null
    }
  })
}

/** 业务路由用：组织某开关生效值（无组织/未知键 → true 放行） */
export async function isOrgFlagEnabled(orgId: number | null, key: string): Promise<boolean> {
  if (!orgId) return true
  const meta = FLAG_CATALOG.find((f) => f.key === key)
  if (!meta) return true
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT enabled FROM org_feature_flags WHERE org_id = ? AND flag_key = ? LIMIT 1',
      [orgId, key]
    )
    if (rows.length) return Number(rows[0].enabled) !== 0
  } catch (e) {
    console.error('[plan] flag lookup failed:', (e as Error).message)
  }
  return meta.defaultValue
}

/** 设置数字 override（超管；upsert 幂等） */
export async function setOrgQuotaOverride(orgId: number, feature: string, limit: number): Promise<void> {
  await pool.query(
    `INSERT INTO org_quota_overrides (org_id, feature_key, limit_value) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE limit_value = VALUES(limit_value)`,
    [orgId, feature, limit]
  )
}

/** 清除数字 override（恢复档位默认） */
export async function clearOrgQuotaOverride(orgId: number, feature: string): Promise<void> {
  await pool.query('DELETE FROM org_quota_overrides WHERE org_id = ? AND feature_key = ?', [orgId, feature])
}

/** 设置开关 override（超管；upsert 幂等） */
export async function setOrgFlagOverride(orgId: number, flagKey: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO org_feature_flags (org_id, flag_key, enabled) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
    [orgId, flagKey, enabled ? 1 : 0]
  )
}

/** 清除开关 override（恢复目录默认） */
export async function clearOrgFlagOverride(orgId: number, flagKey: string): Promise<void> {
  await pool.query('DELETE FROM org_feature_flags WHERE org_id = ? AND flag_key = ?', [orgId, flagKey])
}
