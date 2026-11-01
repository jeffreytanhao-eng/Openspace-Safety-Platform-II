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
  type EphemRow
} from './ephemDb.js'
import { gunzipText, parseMetaAuto, parseItcMeta, parseOcmMeta, rangeLabel, formatSize } from './parseMeta.js'
import type { EphemManeuverEpoch } from './parseMeta.js'

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
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
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
    sourceName
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

/** 解析单个 .txt.gz → 行（目录名优先约定格式；ocm 目录非 OCM 内容跳过） */
function parseGzFile(rel: string): { row: EphemRow } | { skip: string } {
  const full = path.join(EPH_ROOT, rel)
  const raw = fs.readFileSync(full)
  const text = gunzipText(raw)
  const dirTop = rel.split('/')[0].toLowerCase()
  if (dirTop === 'ocm' || /^CCSDS_OCM_VERS/m.test(text)) {
    if (!/^CCSDS_OCM_VERS/m.test(text)) return { skip: `not CCSDS OCM: ${rel}` }
    const meta = parseOcmMeta(text, rel)
    return { row: buildRow({ format: 'OCM', meta, file: rel, mtimeMs: fs.statSync(full).mtimeMs, sizeBytes: raw.length, rawSizeBytes: Buffer.byteLength(text, 'utf8'), sourceName: path.basename(rel) }) }
  }
  const meta = parseItcMeta(text, rel)
  return { row: buildRow({ format: 'ITC', meta, file: rel, mtimeMs: fs.statSync(full).mtimeMs, sizeBytes: raw.length, rawSizeBytes: Buffer.byteLength(text, 'utf8'), sourceName: path.basename(rel) }) }
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
      updatedAt: it.updatedAt || updatedAtOf(null),
      originator: it.originator || ''
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
 * - 同名文件已入库 → skipped；同 NORAD+格式 已有旧版 → updated（新版替换元数据，旧文件保留在磁盘）。
 */
export async function ingestUploadFile(originalName: string, buf: Buffer): Promise<UploadResult> {
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
  return {
    action: existed ? 'updated' : 'added',
    id: row.id, file: rel, name: row.name, norad: row.norad, format,
    range: rangeLabel(row.startMs, row.stopMs), size: formatSize(row.fileSize)
  }
}
