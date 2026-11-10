/**
 * StarLink 星历拉取配置与状态（system_settings 键值表）。
 * - 配置：是否每日自动拉取、每次拉取数量、文件类型（OCM / ITC）
 * - 状态：最近一次拉取的开始/结束时间与新增/更新/跳过/失败计数
 */
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from './pool.js'

export type StarlinkFormat = 'OCM' | 'ITC'

export interface StarlinkPullConfig {
  enabled: boolean
  count: number
  format: StarlinkFormat
}

export interface StarlinkPullStatus {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  triggeredBy: string
  format: StarlinkFormat
  requested: number
  added: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
}

const CONFIG_KEY = 'starlink.pull.config'
const STATUS_KEY = 'starlink.pull.status'

export const DEFAULT_STARLINK_CONFIG: StarlinkPullConfig = {
  enabled: false,
  count: 50,
  format: 'OCM'
}

let schemaReady = false

export async function ensureStarlinkSchema(): Promise<boolean> {
  if (schemaReady) return true
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS system_settings (
        k VARCHAR(64) NOT NULL PRIMARY KEY,
        v MEDIUMTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
    schemaReady = true
    return true
  } catch (e) {
    console.error('[starlink] ensure schema failed:', (e as Error).message)
    return false
  }
}

async function readKey(key: string): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT v FROM system_settings WHERE k = ?', [key])
  return rows.length ? String(rows[0].v) : null
}

async function writeKey(key: string, value: string): Promise<void> {
  await pool.query(
    'INSERT INTO system_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [key, value]
  )
}

/** 读取配置（无记录/字段异常时回退默认值） */
export async function getStarlinkPullConfig(): Promise<StarlinkPullConfig> {
  if (!(await ensureStarlinkSchema())) return { ...DEFAULT_STARLINK_CONFIG }
  const raw = await readKey(CONFIG_KEY)
  if (!raw) return { ...DEFAULT_STARLINK_CONFIG }
  try {
    const o = JSON.parse(raw) as Partial<StarlinkPullConfig>
    const count = Number(o.count)
    return {
      enabled: o.enabled === true,
      count: Number.isFinite(count) ? Math.max(1, Math.min(500, Math.floor(count))) : DEFAULT_STARLINK_CONFIG.count,
      format: o.format === 'ITC' ? 'ITC' : 'OCM'
    }
  } catch {
    return { ...DEFAULT_STARLINK_CONFIG }
  }
}

export async function saveStarlinkPullConfig(cfg: StarlinkPullConfig): Promise<void> {
  if (!(await ensureStarlinkSchema())) throw new Error('数据库不可用')
  await writeKey(CONFIG_KEY, JSON.stringify(cfg))
}

/** 最近一次拉取状态（无记录返回 null） */
export async function getStarlinkPullStatus(): Promise<StarlinkPullStatus | null> {
  if (!(await ensureStarlinkSchema())) return null
  const raw = await readKey(STATUS_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StarlinkPullStatus
  } catch {
    return null
  }
}

export async function saveStarlinkPullStatus(st: StarlinkPullStatus): Promise<void> {
  if (!(await ensureStarlinkSchema())) return
  await writeKey(STATUS_KEY, JSON.stringify(st))
}
