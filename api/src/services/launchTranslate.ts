/**
 * 发射简报 LLM 翻译（火山方舟 Ark，OpenAI 兼容接口）。
 * - 配置存 system_settings（超管后台可改），环境变量提供初始默认值；
 * - 每次从外部接口拉取列表/详情后，补齐缺失的中文（name/summary/场站等）；
 * - 原文→译文内存缓存，避免重复计费；翻译失败时保留原文，不影响主流程。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/pool.js'

export interface LaunchTranslateConfig {
  enabled: boolean
  base_url: string
  model: string
  api_key: string
}

const CONFIG_KEY = 'launch_translate_config'
/** 环境变量默认值（惰性读取，确保 dotenv 已加载） */
const envBaseUrl = () => process.env.LAUNCH_TRANSLATE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const envModel = () => process.env.LAUNCH_TRANSLATE_MODEL || 'ep-20261013164531-qjk82'
const envKey = () => process.env.LAUNCH_TRANSLATE_API_KEY || ''
const TIMEOUT_MS = 20_000
/** Ark 接入点为推理模型，批量过大会把 token 预算耗在推理上，控制在 10 条/次 */
const BATCH_SIZE = 10
const MEMO_LIMIT = 5000

let schemaReady = false
let configCache: { at: number; value: LaunchTranslateConfig } | null = null
const memo = new Map<string, string>()

async function ensureSchema(): Promise<boolean> {
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
    console.error('[launch-translate] ensure schema failed:', (e as Error).message)
    return false
  }
}

async function readStored(): Promise<Partial<LaunchTranslateConfig> | null> {
  if (!(await ensureSchema())) return null
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT v FROM system_settings WHERE k = ?', [CONFIG_KEY])
    if (!rows.length) return null
    return JSON.parse(String(rows[0].v)) as Partial<LaunchTranslateConfig>
  } catch {
    return null
  }
}

/** 读取生效配置：DB 覆盖环境变量默认值 */
export async function getLaunchTranslateConfig(): Promise<LaunchTranslateConfig> {
  if (configCache && Date.now() - configCache.at < 30_000) return configCache.value
  const stored = (await readStored()) || {}
  const apiKey = typeof stored.api_key === 'string' ? stored.api_key : envKey()
  const value: LaunchTranslateConfig = {
    enabled: stored.enabled !== undefined ? stored.enabled === true : !!apiKey,
    base_url: (typeof stored.base_url === 'string' && stored.base_url.trim()) || envBaseUrl(),
    model: (typeof stored.model === 'string' && stored.model.trim()) || envModel(),
    api_key: apiKey
  }
  configCache = { at: Date.now(), value }
  return value
}

/** 保存配置；api_key 传 undefined 表示保持原值 */
export async function saveLaunchTranslateConfig(cfg: {
  enabled: boolean
  base_url: string
  model: string
  api_key?: string
}): Promise<void> {
  if (!(await ensureSchema())) throw new Error('数据库不可用')
  const current = await getLaunchTranslateConfig()
  const value: LaunchTranslateConfig = {
    enabled: cfg.enabled,
    base_url: cfg.base_url,
    model: cfg.model,
    api_key: cfg.api_key && cfg.api_key.trim() ? cfg.api_key.trim() : current.api_key
  }
  await pool.query(
    'INSERT INTO system_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [CONFIG_KEY, JSON.stringify(value)]
  )
  configCache = { at: Date.now(), value }
}

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 6)}****${key.slice(-4)}`
}

/* --------------------------------- 翻译 --------------------------------- */

interface Job {
  text: string
  apply: (zh: string) => void
}
type AnyRec = Record<string, unknown>

function isPair(v: unknown): v is { en?: string; zh?: string } {
  return !!v && typeof v === 'object'
}

const CJK_RE = /[\u4e00-\u9fa5]/
/** 中文里残留的英文单词（≥4 字母，如 March / Group）说明来源的 zh 只是半成品 */
const LATIN_WORD_RE = /[A-Za-z]{4,}/

/** en 有值，且 zh 缺失 / 与 en 相同 / 仍含成段英文时，登记翻译任务 */
function addPair(holder: AnyRec | null | undefined, field: string, jobs: Job[]): void {
  if (!holder) return
  const pair = holder[field]
  if (!isPair(pair)) return
  const en = typeof pair.en === 'string' ? pair.en.trim() : ''
  if (!en) return
  const zh = typeof pair.zh === 'string' ? pair.zh.trim() : ''
  if (zh && zh !== en && CJK_RE.test(zh) && !LATIN_WORD_RE.test(zh)) return
  jobs.push({ text: en, apply: (v) => { pair.zh = v } })
}

function addString(holder: AnyRec | null | undefined, field: string, jobs: Job[]): void {
  if (!holder) return
  const raw = holder[field]
  if (typeof raw !== 'string' || !raw.trim()) return
  const text = raw.trim()
  if (/[\u4e00-\u9fa5]/.test(text)) return
  jobs.push({ text, apply: (v) => { holder[field] = v } })
}

function collectJobs(item: AnyRec): Job[] {
  const jobs: Job[] = []
  addPair(item, 'name', jobs)
  addPair(item, 'summary', jobs)
  addPair(item, 'mission_type', jobs)
  addPair(item.status as AnyRec, 'label', jobs)
  addPair(item.orbit_type as AnyRec, 'label', jobs)
  addPair(item.payload as AnyRec, 'summary', jobs)
  const site = item.site as AnyRec | undefined
  addPair(site, 'launch_site', jobs)
  addPair(site, 'pad', jobs)
  addPair(site?.country as AnyRec, 'name', jobs)
  addString(item, 'rocket', jobs)
  addString(item, 'launch_service_provider', jobs)
  return jobs
}

/** 调用 Ark chat/completions，返回 i → 译文 */
async function requestTranslations(cfg: LaunchTranslateConfig, texts: string[]): Promise<Record<number, string>> {
  const payload = {
    model: cfg.model,
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是航天发射领域的中文翻译。把用户给出的 JSON 文本数组翻译成简体中文。' +
          '火箭/卫星型号用通行中文译名（如 Falcon 9 → 猎鹰9号、Long March → 长征、Ariane 64 → 阿丽亚娜64），' +
          '机构名用通行中文名（如 China Aerospace Science and Technology Corporation → 中国航天科技集团；SpaceX、Starlink 等通用代号保持原样），' +
          '任务编号、缩写（LEO/SSO/GTO/ISS）、数字保持原文；不要解释。' +
          '只输出严格 JSON：{"items":[{"i":0,"zh":"译文"}]}，i 与输入下标一致。'
      },
      { role: 'user', content: JSON.stringify(texts) }
    ]
  }
  const r = await fetch(`${cfg.base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
  let content = body.choices?.[0]?.message?.content || ''
  content = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  if (!content) throw new Error('模型返回空内容')
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON')
  const parsed = JSON.parse(content.slice(start, end + 1)) as { items?: Array<{ i?: number; zh?: string }> }
  const out: Record<number, string> = {}
  for (const it of parsed.items || []) {
    if (typeof it.i === 'number' && typeof it.zh === 'string' && it.zh.trim()) out[it.i] = it.zh.trim()
  }
  return out
}

/** 批量翻译（含缓存），返回 原文 → 译文；资讯日切复用同一模型与缓存 */
export async function translateTexts(texts: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(new Set(texts.filter((s) => !!s && !!s.trim())))
  if (!unique.length) return out
  const cfg = await getLaunchTranslateConfig()
  if (!cfg.enabled || !cfg.api_key) return out

  const missing: string[] = []
  for (const text of unique) {
    const hit = memo.get(text)
    if (hit) out.set(text, hit)
    else missing.push(text)
  }

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    try {
      const result = await requestTranslations(cfg, batch)
      batch.forEach((text, idx) => {
        const zh = result[idx]
        if (!zh) return
        out.set(text, zh)
        if (memo.size >= MEMO_LIMIT) memo.clear()
        memo.set(text, zh)
      })
    } catch (e) {
      console.warn('[launch-translate] request failed:', (e as Error).message)
    }
  }
  return out
}

/** 就地补齐一条发射记录的中文字段；翻译不可用时静默跳过 */
export async function translateLaunchItem(item: AnyRec): Promise<void> {
  const jobs = collectJobs(item)
  if (!jobs.length) return
  const map = await translateTexts(jobs.map((j) => j.text))
  if (!map.size) return
  for (const job of jobs) {
    const zh = map.get(job.text)
    if (zh) job.apply(zh)
  }
}

/** 列表批量翻译：一次收集全部字段，减少请求次数 */
export async function translateLaunchItems(items: AnyRec[]): Promise<void> {
  const jobsByItem = items.map((it) => collectJobs(it))
  const all = jobsByItem.flat().map((j) => j.text)
  if (!all.length) return
  const map = await translateTexts(all)
  if (!map.size) return
  jobsByItem.forEach((jobs) => {
    for (const job of jobs) {
      const zh = map.get(job.text)
      if (zh) job.apply(zh)
    }
  })
}

/** 超管「测试连接」：翻译一条样例 */
export async function testLaunchTranslate(): Promise<string> {
  const cfg = await getLaunchTranslateConfig()
  if (!cfg.enabled) throw new Error('翻译未启用')
  if (!cfg.api_key) throw new Error('未配置 API Key')
  const result = await requestTranslations(cfg, ['Falcon 9 Block 5 | USSF-317'])
  const zh = result[0]
  if (!zh) throw new Error('模型未返回有效译文')
  return zh
}
