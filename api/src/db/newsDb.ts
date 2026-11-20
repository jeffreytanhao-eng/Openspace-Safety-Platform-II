/**
 * 太空安全资讯本地库（UTC 00:00 日切任务写入，总览页只读）。
 * - news：一条资讯一行，data 为翻译后的完整 JSON，impact_zh 为「对中国的影响分析」；
 * - system_settings 的 news.list.meta：最近一次日切的时间与当日计划日期。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { pool } from './pool.js'

export interface NewsRow {
  id: string
  /** ISO 8601 UTC 字符串（如 2026-11-19T06:41:35Z），字符串排序即时间排序 */
  published_at: string
  data: string
  impact_zh: string
}

export interface NewsListMeta {
  generated_at: string
  plan_date: string
  window_days: number
}

export interface NewsHashRow {
  id: string
  hash: string
  impact_zh: string
  data: string
}

const META_KEY = 'news.list.meta'
let schemaReady = false

export async function ensureNewsSchema(): Promise<boolean> {
  if (schemaReady) return true
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS news (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        published_at VARCHAR(32) NOT NULL,
        content_hash CHAR(40) NOT NULL,
        data MEDIUMTEXT NOT NULL,
        impact_zh MEDIUMTEXT NULL,
        fetched_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_published (published_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
    schemaReady = true
    return true
  } catch (e) {
    console.error('[news-db] ensure schema failed:', (e as Error).message)
    return false
  }
}

/** 按发布时间倒序读取前 limit 条（总览卡片最多 8 条） */
export async function listNews(limit: number): Promise<NewsRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 8, 1), 100)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, published_at, data, impact_zh FROM news ORDER BY published_at DESC LIMIT ${n}`
  )
  return rows.map((r) => ({
    id: String(r.id),
    published_at: String(r.published_at),
    data: String(r.data),
    impact_zh: r.impact_zh ? String(r.impact_zh) : ''
  }))
}

export async function getNewsRow(id: string): Promise<NewsRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, published_at, data, impact_zh FROM news WHERE id = ? LIMIT 1',
    [id]
  )
  if (!rows.length) return null
  return {
    id: String(rows[0].id),
    published_at: String(rows[0].published_at),
    data: String(rows[0].data),
    impact_zh: rows[0].impact_zh ? String(rows[0].impact_zh) : ''
  }
}

/** 读取已有内容哈希/影响分析/数据（未变化且摘要达标的条目跳过 LLM） */
export async function getNewsHashes(): Promise<Map<string, NewsHashRow>> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id, content_hash, impact_zh, data FROM news')
  const map = new Map<string, NewsHashRow>()
  for (const r of rows) {
    map.set(String(r.id), {
      id: String(r.id),
      hash: String(r.content_hash),
      impact_zh: r.impact_zh ? String(r.impact_zh) : '',
      data: String(r.data)
    })
  }
  return map
}

export async function upsertNews(params: {
  id: string
  publishedAt: string
  hash: string
  data: string
  impactZh: string
}): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO news (id, published_at, content_hash, data, impact_zh, fetched_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE published_at = VALUES(published_at), content_hash = VALUES(content_hash),
       data = VALUES(data), impact_zh = VALUES(impact_zh), fetched_at = CURRENT_TIMESTAMP(3)`,
    [params.id, params.publishedAt, params.hash, params.data, params.impactZh]
  )
}

/** 详情接口懒生成摘要/影响分析后回写 */
export async function updateNewsInsight(id: string, data: string, impactZh: string): Promise<void> {
  await pool.query<ResultSetHeader>('UPDATE news SET data = ?, impact_zh = ? WHERE id = ?', [
    data,
    impactZh,
    id
  ])
}

/** 增量合并后只保留最新 limit 条，更旧的资讯顺延淘汰 */
export async function pruneNews(limit: number): Promise<number> {
  const n = Math.min(Math.max(Math.trunc(limit) || 8, 1), 100)
  const [res] = await pool.query<ResultSetHeader>(
    `DELETE FROM news
      WHERE id NOT IN (
        SELECT id FROM (SELECT id FROM news ORDER BY published_at DESC LIMIT ${n}) t
      )`
  )
  return res.affectedRows
}

export async function getNewsListMeta(): Promise<NewsListMeta | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT v FROM system_settings WHERE k = ?', [META_KEY])
  if (!rows.length) return null
  try {
    return JSON.parse(String(rows[0].v)) as NewsListMeta
  } catch {
    return null
  }
}

export async function saveNewsListMeta(meta: NewsListMeta): Promise<void> {
  await pool.query(
    'INSERT INTO system_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [META_KEY, JSON.stringify(meta)]
  )
}
