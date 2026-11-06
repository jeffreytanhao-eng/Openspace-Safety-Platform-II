/**
 * 星历入库服务：文件系统（原始 .txt.gz）→ MySQL 元数据。
 *
 * 两条入库通道：
 * - scanAndIngest：递归扫描 data/ephemerides/{itc,ocm} 下 .txt.gz，按 mtime+size 增量解析入库
 *   （万级目录重复扫描只处理新/变文件，秒级完成）；结束后导出 index.json 快照兜底；
 * - ingestUploadFile：管理页上传单文件 → 内容识别格式（OCM/ITC）→ 按 NORAD 千位分片落盘 → 解析入库。
 *
 * 数据库不可用时抛错，由路由层回退 index.json 模式。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  ephemDbUp,
  getRowByFileDb,
  getRowBySourceNameDb,
  getRowDb,
  upsertRowDb,
  deleteRowsByFilesDb,
  clearRowsDb,
  listAllRowsDb,
  countRowsDb,
  toListItem,
  insertEphemerisVersionDb,
  findVersionByShaSourceDb,
  type EphemRow,
  type EphemVersionRow
} from './ephemDb.js'
import { gunzipText, parseMetaAuto, parseItcMeta, parseOcmMeta, rangeLabel, formatSize } from './parseMeta.js'
import type { EphemManeuverEpoch } from './parseMeta.js'
import { fmtLocalDateTime } from '../utils/time.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 兼容本地仓库与 Docker (/app/data) 的星历根目录解析（与路由层一致） */
export function resolveEphRoot(): string {
  const candidates = [
    process.env.EPH_DATA_DIR,
    path.resolve(process.cwd(), 'data/ephemerides'),
    path.resolve(process.cwd(), '../data/ephemerides'),
    // api/dist/ephem → ../../data = /app/data (Docker) or api/../data
    path.resolve(__dirname, '../../data/ephemerides'),
    // api/src/ephem → ../../../data = repo/data
    path.resolve(__dirname, '../../../data/ephemerides')
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[candidates.length - 1] || path.resolve(process.cwd(), 'data/ephemerides')
}

export const EPH_ROOT = resolveEphRoot()

export interface ScanResult {
  added: number
  updated: number
  skipped: number
  removed: number
  total: number
  db: 'up' | 'down'
}

function updatedAtOf(created: number | null): string {
  const ms = created && Number.isFinite(created) ? created : Date.now()
  // 与数据库 DATETIME 口径一致（会话本地时间）；旧表为 varchar，新 schema 为 datetime(3)
  return fmtLocalDateTime(new Date(ms)) || ''
}

/** 列表展示串（UTC，'YYYY-MM-DD HH:mm[:ss]'）→ 数据库本地时间 'YYYY-MM-DD HH:mm:ss' */
function displayToLocalDb(v: string | null | undefined): string | null {
  if (!v) return null
  const d = new Date(`${v.replace(' ', 'T').slice(0, 19)}Z`)
  return Number.isNaN(d.getTime()) ? null : fmtLocalDateTime(d)
}

function buildRow(args: {
  format: 'ITC' | 'OCM'
  meta: { name: string; norad: string; start: number; stop: number; stepSec: number; created: number | null; covFrame: string; points: number; hasCov: boolean; maneuvers: EphemManeuverEpoch[]; originator: string }
  file: string
  mtimeMs: number
  sizeBytes: number
  /** 解压后原始字节数（列表 size 展示用） */
  rawSizeBytes: number
  sourceName: string
}): EphemRow {
  const { format, meta, file, mtimeMs, sizeBytes, rawSizeBytes, sourceName } = args
  const mans = meta.maneuvers || []
  // 发布时间：解析出的 CREATION_DATE 优先，无则用文件 mtime 兜底
  const publishedMs =
    meta.created && Number.isFinite(meta.created) ? meta.created : Math.round(mtimeMs)
  return {
    id: format === 'OCM' ? `ocm-${meta.norad}` : `itc-${meta.norad}`,
    name: meta.name,
    norad: meta.norad,
    objectId: `sl-${meta.norad}`,
    format,
    file,
    fileMtime: Math.round(mtimeMs),
    fileSize: sizeBytes,
    rawSize: Math.round(rawSizeBytes) || 0,
    points: meta.points,
    stepSec: Math.round(meta.stepSec) || 60,
    startMs: meta.start,
    stopMs: meta.stop,
    publishedMs,
    covariance: !!meta.hasCov,
    covFrame: meta.covFrame || '',
    maneuvers: mans.length,
    maneuverSummary:
      mans.length === 0
        ? '无'
        : `${mans.length} 处 · max Δv ${Math.max(...mans.map((m) => m.dvMps)).toFixed(4)} m/s`,
    maneuverEpochs: mans.map((m) => ({ t: m.t, dvMps: m.dvMps, duraSec: m.duraSec, id: m.id })),
    status: 'local',
    updatedAt: updatedAtOf(meta.created),
    originator: meta.originator,
    sourceName,
    // 归属/可见性由上传路由写入；扫描入库一律视为平台公共星历
    uploadedBy: '',
    ownerUserId: null,
    ownerOrgId: null,
    visibility: 'public'
  }
}

/** 递归列出目录下所有 .txt.gz（相对路径，正斜杠） */
function listGzFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listGzFiles(path.join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt.gz')) out.push(rel)
  }
  return out
}

/** 解析单个 .txt.gz → 行 + 解压全文（全文供 G1 版本归档做 sha256） */
function parseGzFile(rel: string): { row: EphemRow; text: string } | { skip: string } {
  const full = path.join(EPH_ROOT, rel)
  const raw = fs.readFileSync(full)
  const text = gunzipText(raw)
  const dirTop = rel.split('/')[0].toLowerCase()
  if (dirTop === 'ocm' || /^CCSDS_OCM_VERS/m.test(text)) {
    if (!/^CCSDS_OCM_VERS/m.test(text)) return { skip: `not CCSDS OCM: ${rel}` }
    const meta = parseOcmMeta(text, rel)
    return { text, row: buildRow({ format: 'OCM', meta, file: rel, mtimeMs: fs.statSync(full).mtimeMs, sizeBytes: raw.length, rawSizeBytes: Buffer.byteLength(text, 'utf8'), sourceName: path.basename(rel) }) }
  }
  const meta = parseItcMeta(text, rel)
  return { text, row: buildRow({ format: 'ITC', meta, file: rel, mtimeMs: fs.statSync(full).mtimeMs, sizeBytes: raw.length, rawSizeBytes: Buffer.byteLength(text, 'utf8'), sourceName: path.basename(rel) }) }
}

/** 导出 index.json 快照（无 DB / 静态部署的兜底数据源） */
export async function exportIndexJson(): Promise<number> {
  const rows = await listAllRowsDb()
  const items = rows.map(toListItem)
  fs.writeFileSync(
    path.join(EPH_ROOT, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2),
    'utf8'
  )
  return items.length
}

/**
 * 增量扫描入库（mtime+size 未变的文件直接跳过）。
 * force=true 时清空表全量重解析（解析口径变更后使用，如 NORAD 取值修正）。
 */
export async function scanAndIngest(opts: { exportJson?: boolean; force?: boolean } = {}): Promise<ScanResult> {
  if (!(await ephemDbUp())) throw new Error('数据库不可用：星历入库需要 MySQL（/cgi/health 查看 db 状态）')
  const rels = [...listGzFiles(path.join(EPH_ROOT, 'itc'), 'itc'), ...listGzFiles(path.join(EPH_ROOT, 'ocm'), 'ocm')]
  let added = 0
  let updated = 0
  let skipped = 0
  const seenFiles = new Set<string>()
  if (opts.force) {
    await clearRowsDb()
    console.log('[ephem] force rebuild: table truncated')
  }
  for (const rel of rels) {
    seenFiles.add(rel)
    const full = path.join(EPH_ROOT, rel)
    const st = fs.statSync(full)
    let existing: EphemRow | null = null
    if (!opts.force) {
      existing = await getRowByFileDb(rel)
      if (existing && existing.fileMtime === Math.round(st.mtimeMs) && existing.fileSize === st.size) {
        skipped++
        continue
      }
    }
    try {
      const parsed = parseGzFile(rel)
      if ('skip' in parsed) {
        console.warn(`[ephem] ! ${parsed.skip}`)
        skipped++
        continue
      }
      await upsertRowDb(parsed.row)
      // G1 版本归档：文件新入库或内容变化时 append 一条（账本按 sha+source+操作者去重）
      await appendEphemVersion({
        format: parsed.row.format,
        norad: parsed.row.norad,
        text: parsed.text,
        publishedMs: parsed.row.publishedMs,
        source: 'scan',
        uploadedBy: 'system'
      })
      if (existing) updated++
      else added++
      console.log(`[ephem] ${existing ? 'updated' : 'added'} ${parsed.row.id} pts=${parsed.row.points} cov=${parsed.row.covariance} man=${parsed.row.maneuvers}`)
    } catch (e) {
      console.warn(`[ephem] ! parse failed ${rel}: ${(e as Error).message}`)
      skipped++
    }
  }
  // 清理文件已不存在的脏行
  const allRows = await listAllRowsDb(Number.MAX_SAFE_INTEGER)
  const gone = allRows.filter((r) => !seenFiles.has(r.file)).map((r) => r.file)
  const removed = await deleteRowsByFilesDb(gone)
  let total = await countRowsDb()
  if (opts.exportJson !== false) await exportIndexJson()
  return { added, updated, skipped, removed, total, db: 'up' }
}

/** index.json → 数据库（首次启用 MySQL 的一次性迁移；带 stat 信息避免重复解析） */
export async function importFromIndexJson(): Promise<{ imported: number }> {
  const indexPath = path.join(EPH_ROOT, 'index.json')
  if (!fs.existsSync(indexPath)) return { imported: 0 }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    items: {
      id: string; name: string; norad: string; objectId?: string; format: string; file: string;
      points: number; stepSec: number; startMs: number; stopMs: number; covariance?: boolean;
      covFrame?: string; maneuvers: number; maneuverSummary: string; maneuverEpochs?: EphemManeuverEpoch[];
      status?: string; updatedAt: string; originator?: string; size?: string
    }[]
  }
  let imported = 0
  for (const it of raw.items || []) {
    if (!it.file || !it.startMs || !it.stopMs) continue
    const full = path.join(EPH_ROOT, it.file)
    if (!fs.existsSync(full)) continue
    const st = fs.statSync(full)
    const existing = await getRowByFileDb(it.file)
    if (existing && existing.fileMtime === Math.round(st.mtimeMs) && existing.fileSize === st.size) continue
    const sizeBytes = st.size
    // 解压后原大小（.gz 读出解压计数，明文直接用文件大小）
    let rawSizeBytes = sizeBytes
    try {
      if (it.file.toLowerCase().endsWith('.gz')) {
        rawSizeBytes = Buffer.byteLength(gunzipText(fs.readFileSync(full)), 'utf8')
      }
    } catch {
      /* 解压失败回退压缩大小 */
    }
    await upsertRowDb({
      id: it.id,
      name: it.name,
      norad: String(it.norad),
      objectId: it.objectId || `sl-${it.norad}`,
      format: it.format === 'OCM' ? 'OCM' : 'ITC',
      file: it.file,
      fileMtime: Math.round(st.mtimeMs),
      fileSize: sizeBytes,
      rawSize: Math.round(rawSizeBytes) || 0,
      sourceName: path.basename(it.file),
      points: Number(it.points) || 0,
      stepSec: Number(it.stepSec) || 60,
      startMs: it.startMs,
      stopMs: it.stopMs,
      publishedMs: st.mtimeMs,
      covariance: !!it.covariance,
      covFrame: it.covFrame || '',
      maneuvers: Number(it.maneuvers) || 0,
      maneuverSummary: it.maneuverSummary || '无',
      maneuverEpochs: it.maneuverEpochs || [],
      status: it.status || 'local',
      // 列表里的 updatedAt 是 UTC 展示串（'YYYY-MM-DD HH:mm'），写回 datetime 列前转本地时间
      updatedAt: displayToLocalDb(it.updatedAt) || updatedAtOf(null),
      originator: it.originator || '',
      uploadedBy: '',
      ownerUserId: null,
      ownerOrgId: null,
      visibility: 'public'
    })
    imported++
  }
  return { imported }
}

export interface UploadResult {
  action: 'added' | 'updated' | 'skipped'
  id: string
  file: string
  name: string
  norad: string
  format: 'ITC' | 'OCM'
  range: string
  size: string
}

/** 文件名净化（保留 MEME_/STARLINK_ 命名口径，去掉路径成分与危险字符） */
function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, '_')
  return base || `upload_${Date.now()}.txt.gz`
}

/**
 * 上传单文件入库：
 * - 内容识别格式（CCSDS OCM → ocm/，否则 ITC 口径）；
 * - 落盘按 NORAD 千位分片（如 norad 37711 → itc/037/xxx.txt.gz），避免单目录万文件；
 * - 同名文件已入库 → skipped；同 NORAD+格式 已有旧版 → updated（新版替换元数据，旧文件保留在磁盘）；
 * - G1：无论 added/updated/skipped 均按内容 sha256 append 版本归档（同名跳过也留痕）。
 */
export async function ingestUploadFile(
  originalName: string,
  buf: Buffer,
  uploadedBy = 'anonymous'
): Promise<UploadResult> {
  if (!(await ephemDbUp())) throw new Error('数据库不可用：星历上传入库需要 MySQL')
  const name = sanitizeName(originalName)
  if (!/\.(txt|gz|itc|ocm|oem|e)$/i.test(name)) throw new Error('仅支持 .txt / .txt.gz / .itc / .ocm 星历文件')
  const isGz = name.toLowerCase().endsWith('.gz')
  let text: string
  try {
    text = isGz ? gunzipText(buf) : buf.toString('utf8')
  } catch {
    throw new Error('gzip 解压失败（文件损坏或非 gzip 格式）')
  }
  if (!text.trim()) throw new Error('文件内容为空')
  const { format, meta } = parseMetaAuto(text, name)
  if (!/^\d+$/.test(meta.norad) || meta.norad === '0') throw new Error('无法从文件识别 NORAD 编号')

  // 同名文件去重
  const sameSource = await getRowBySourceNameDb(name)
  if (sameSource) {
    // G1：同名跳过也留版本痕（内容不同会新增版本，同内容由账本去重）
    await appendEphemVersion({
      format,
      norad: meta.norad,
      text,
      publishedMs: meta.created || Date.now(),
      source: 'upload',
      uploadedBy
    })
    return {
      action: 'skipped', id: sameSource.id, file: sameSource.file, name: sameSource.name,
      norad: sameSource.norad, format: sameSource.format,
      range: rangeLabel(sameSource.startMs, sameSource.stopMs), size: formatSize(sameSource.fileSize)
    }
  }

  // 落盘（分片）
  const shard = String(Math.floor(Number(meta.norad) / 1000)).padStart(3, '0')
  const dir = path.join(EPH_ROOT, format.toLowerCase(), shard)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = isGz ? name : `${name}.gz`
  const full = path.join(dir, fileName)
  fs.writeFileSync(full, isGz ? buf : zlib.gzipSync(text, { level: 9 }))
  const st = fs.statSync(full)
  const rel = `${format.toLowerCase()}/${shard}/${fileName}`.replace(/\\/g, '/')

  const row = buildRow({ format, meta, file: rel, mtimeMs: st.mtimeMs, sizeBytes: st.size, rawSizeBytes: isGz ? Buffer.byteLength(text, 'utf8') : buf.length, sourceName: name })
  const existed = await getRowDb(row.id)
  await upsertRowDb(row)
  // G1 版本归档：同内容重复上传由账本去重，不重复记账
  await appendEphemVersion({
    format,
    norad: row.norad,
    text,
    publishedMs: row.publishedMs,
    source: 'upload',
    uploadedBy
  })
  return {
    action: existed ? 'updated' : 'added',
    id: row.id, file: rel, name: row.name, norad: row.norad, format,
    range: rangeLabel(row.startMs, row.stopMs), size: formatSize(row.fileSize)
  }
}

/** 上传前预解析 NORAD（第 6 项：仅能上传自己认领目标的星历）；解析失败返回 null */
export function peekUploadNorad(originalName: string, buf: Buffer): string | null {
  try {
    const name = sanitizeName(originalName)
    const isGz = name.toLowerCase().endsWith('.gz')
    const text = isGz ? gunzipText(buf) : buf.toString('utf8')
    if (!text.trim()) return null
    const { meta } = parseMetaAuto(text, name)
    return /^\d+$/.test(meta.norad) && meta.norad !== '0' ? meta.norad : null
  } catch {
    return null
  }
}

/* --------------------- G1 版本归档（append-only + 内容 sha256 去重存储） --------------------- */

/** 版本文件目录（独立于活跃文件 {itc,ocm}/；rebuild 清表不触及本目录） */
const VERSIONS_DIR = 'versions'

export interface EphemVersionAppend {
  format: 'ITC' | 'OCM'
  norad: string
  /** 解压后全文（sha256 与版本存储均以它为准） */
  text: string
  publishedMs: number
  /** upload=管理页上传 / scan=rebuild 扫描 */
  source: 'upload' | 'scan'
  /** 操作者标识（上传者邮箱 / system / anonymous） */
  uploadedBy: string
}

/**
 * append 一条星历版本：
 * - 内容寻址落盘 data/ephemerides/versions/<fmt>/<分片>/<sha前16>.txt.gz（同内容只存一份，存在即不重写）；
 * - 账本按 (sha256, source, uploaded_by) 去重 —— 重复上传 / 重复 scan 不重复记账；
 * - 归档失败仅告警不中断主入库流程（版本是旁路增强，主数据优先）。
 * 返回新增版本行；null = 账本已有同内容同来源记录或归档失败。
 */
export async function appendEphemVersion(v: EphemVersionAppend): Promise<EphemVersionRow | null> {
  const sha256 = createHash('sha256').update(v.text, 'utf8').digest('hex')
  try {
    const dup = await findVersionByShaSourceDb(sha256, v.source, v.uploadedBy)
    if (dup) return null
    // 内容寻址落盘（同内容只写一次）
    const shard = String(Math.floor(Number(v.norad) / 1000)).padStart(3, '0')
    const dir = path.join(EPH_ROOT, VERSIONS_DIR, v.format.toLowerCase(), shard)
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `${sha256.slice(0, 16)}.txt.gz`
    const full = path.join(dir, fileName)
    const gzip = zlib.gzipSync(v.text, { level: 9 })
    if (!fs.existsSync(full)) fs.writeFileSync(full, gzip)
    const rel = `${VERSIONS_DIR}/${v.format.toLowerCase()}/${shard}/${fileName}`.replace(/\\/g, '/')
    const row: EphemVersionRow = {
      id: 0,
      norad: v.norad,
      format: v.format,
      source: v.source,
      file: rel,
      sha256,
      bytes: gzip.length,
      rawBytes: Buffer.byteLength(v.text, 'utf8'),
      publishedMs: Math.round(v.publishedMs) || Date.now(),
      uploadedBy: v.uploadedBy,
      deletedAt: null,
      createdAt: fmtLocalDateTime(new Date()) || ''
    }
    const id = await insertEphemerisVersionDb(row)
    return { ...row, id }
  } catch (e) {
    console.warn(`[ephem] version append failed (${v.format} ${v.norad}): ${(e as Error).message}`)
    return null
  }
}
