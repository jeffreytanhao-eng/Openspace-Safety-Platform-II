/**
 * 发射预报本地库（日切任务写入，页面只读）。
 * - launches：一条发射一行，data 为翻译后的完整 JSON；
 * - system_settings 的 launch.list.meta：最近一次日切的时间/窗口/免责声明。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { pool } from './pool.js'

export interface LaunchRow {
  id: string
  net: string
  data: string
}

export interface LaunchListMeta {
  generated_at: string
  window: unknown
  disclaimer: string
}

const META_KEY = 'launch.list.meta'
let schemaReady = false

export async function ensureLaunchSchema(): Promise<boolean> {
  if (schemaReady) return true
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS launches (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        net VARCHAR(32) NOT NULL,
        content_hash CHAR(40) NOT NULL,
        data MEDIUMTEXT NOT NULL,
        fetched_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_net (net)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
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
    console.error('[launch-db] ensure schema failed:', (e as Error).message)
    return false
  }
}

/** 按 net 升序返回全部发射（数量为 5 日窗口级别，可直接全量读出） */
export async function listLaunches(): Promise<LaunchRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, net, data FROM launches ORDER BY net ASC'
  )
  return rows.map((r) => ({ id: String(r.id), net: String(r.net), data: String(r.data) }))
}

export async function getLaunchRow(id: string): Promise<LaunchRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, net, data FROM launches WHERE id = ? LIMIT 1',
    [id]
  )
  if (!rows.length) return null
  return { id: String(rows[0].id), net: String(rows[0].net), data: String(rows[0].data) }
}

/** 读取已有内容哈希（用于判断是否有变动） */
export async function getLaunchHashes(): Promise<Map<string, string>> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id, content_hash FROM launches')
  const map = new Map<string, string>()
  for (const r of rows) map.set(String(r.id), String(r.content_hash))
  return map
}

export async function upsertLaunch(params: {
  id: string
  net: string
  hash: string
  data: string
}): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO launches (id, net, content_hash, data, fetched_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE net = VALUES(net), content_hash = VALUES(content_hash),
       data = VALUES(data), fetched_at = CURRENT_TIMESTAMP(3)`,
    [params.id, params.net, params.hash, params.data]
  )
}

/** 删除本次日切未出现的记录（已完成 / 取消 / 移出窗口） */
export async function deleteLaunchesNotIn(ids: string[]): Promise<number> {
  if (!ids.length) {
    const [res] = await pool.query<ResultSetHeader>('DELETE FROM launches')
    return res.affectedRows
  }
  const marks = ids.map(() => '?').join(',')
  const [res] = await pool.query<ResultSetHeader>(
    `DELETE FROM launches WHERE id NOT IN (${marks})`,
    ids
  )
  return res.affectedRows
}

export async function getLaunchListMeta(): Promise<LaunchListMeta | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT v FROM system_settings WHERE k = ?', [META_KEY])
  if (!rows.length) return null
  try {
    return JSON.parse(String(rows[0].v)) as LaunchListMeta
  } catch {
    return null
  }
}

export async function saveLaunchListMeta(meta: LaunchListMeta): Promise<void> {
  await pool.query(
    'INSERT INTO system_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [META_KEY, JSON.stringify(meta)]
  )
}
