/**
 * 星历元数据解析（与 data/ephemerides/scripts/rebuild-index.mjs 同口径的 TS 移植）。
 *
 * 支持两种真实公开格式：
 * - Modified ITC（Starlink MEME）：文件名 MEME_<satnum>_<NAME>_…，正文 CREATED / EPHEMERIS_START 行；
 * - CCSDS OCM（KVN）：META_START…TRAJ_START…COV_START…MAN_START 段结构。
 *
 * 入库 / 上传 / 目录扫描共用本模块，保证三处元数据一致。
 */
import path from 'node:path'
import zlib from 'node:zlib'

const DAY_MS = 86400000
const EPOCH_RE = /^\d{13}(?:\.\d+)?$/
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

export interface EphemManeuverEpoch {
  t: number
  dvMps: number
  duraSec: number
  id?: string
}

export interface EphemMetaParsed {
  name: string
  norad: string
  start: number
  stop: number
  stepSec: number
  created: number | null
  covFrame: string
  points: number
  hasCov: boolean
  maneuvers: EphemManeuverEpoch[]
  originator: string
}

export function gunzipText(buf: Buffer): string {
  return zlib.gunzipSync(buf).toString('utf8')
}

export function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

export function rangeLabel(start: number, stop: number): string {
  const a = new Date(start)
  const b = new Date(stop)
  const p = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `${p(a)} ~ ${p(b)} UTC`
}

function nameFromStarlink(name: string): string | null {
  const m = /STARLINK-(\d+)/i.exec(name || '')
  return m ? m[1] : null
}

function metaFromItcFileName(fileName: string): { name: string; norad: string } {
  const base = path.basename(fileName).replace(/\.txt(\.gz)?$/i, '')
  // MEME_<norad>_<NAME>_…：MEME_ 后的编号即 NORAD 目录号（已与 TLE 编目库交叉验证；
  // NAME 中的数字是 Starlink 内部序列名，不是 NORAD，不可作为 norad）
  const m = /^MEME_(\d+)_([A-Za-z0-9-]+)_/.exec(base)
  const name = m ? m[2] : base
  const norad = (m && /^\d+$/.test(m[1]) && m[1] !== '0' ? m[1] : '') || nameFromStarlink(name) || '0'
  return { name, norad }
}

/** Modified ITC（Starlink MEME）正文 → 元数据 */
export function parseItcMeta(text: string, fileName: string): EphemMetaParsed {
  const { name, norad } = metaFromItcFileName(fileName)
  const lines = text.split(/\r?\n/)
  let start: number | null = null
  let stop: number | null = null
  let stepSec = 60
  let created: number | null = null
  let covFrame = 'UVW'
  let points = 0
  let hasCov = false
  let acc = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()
    if (lower.startsWith('created')) {
      const t = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/)
      if (t) created = Date.parse(t[0].replace(' ', 'T') + 'Z')
      continue
    }
    if (lower.startsWith('ephemeris_start')) {
      const times = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g) || []
      start = times[0] ? Date.parse(times[0].replace(' ', 'T') + 'Z') : null
      stop = times[1] ? Date.parse(times[1].replace(' ', 'T') + 'Z') : null
      const sm = /step_size\s*:\s*([\d.]+)/i.exec(line)
      if (sm) stepSec = Number(sm[1])
      continue
    }
    const upper = line.toUpperCase()
    if (['UVW', 'ECI', 'EME2000', 'ICRF', 'ITRF', 'TEME'].includes(upper)) {
      covFrame = upper === 'ECI' ? 'EME2000' : upper
      continue
    }
    const toks = line.split(/\s+/)
    if (EPOCH_RE.test(toks[0]) && toks.length >= 7) {
      points++
      acc = true
      continue
    }
    if (acc && toks.every((c) => NUM_RE.test(c))) {
      if (toks.length >= 21 || toks.length >= 6) hasCov = true
    }
  }
  if (!(start && stop) || points < 2) throw new Error(`ITC meta incomplete in ${fileName}`)
  return {
    name,
    norad: String(norad),
    start,
    stop,
    stepSec,
    created,
    covFrame,
    points,
    hasCov,
    maneuvers: [],
    originator: 'Starlink public Modified ITC (api.starlink.com MANIFEST)'
  }
}

function parseEpoch(tok: string): number | null {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const dayStart = Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY_MS
  return dayStart + Math.round(((Number(m[3]) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000)
}

/** 解析 ISO 时间（OCM 正文）；非法返回 null */
function parseIso(s: string): number | null {
  const ms = Date.parse(s.replace(/ Z$/, 'Z'))
  return Number.isFinite(ms) ? ms : null
}

/** CCSDS OCM KVN（META/TRAJ/COV/MAN）正文 → 元数据 */
export function parseOcmMeta(text: string, fileName: string): EphemMetaParsed {
  const lines = text.split(/\r?\n/)
  let name = ''
  let objectDesignator = ''
  let originator = 'SPACEX/USA'
  let created: number | null = null
  let start: number | null = null
  let stop: number | null = null
  let stepSec = 60
  let points = 0
  let hasCov = false
  let covFrame = 'ITRF'
  let section = 'none'
  let prevTrajT: number | null = null
  const maneuvers: EphemManeuverEpoch[] = []
  let manAcc: { id: string | null; dura: number | null; acc: number[] | null; t: number | null } | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const upper = line.toUpperCase()

    if (upper === 'META_START') { section = 'meta'; continue }
    if (upper === 'META_STOP') { section = 'none'; continue }
    if (upper.startsWith('TRAJ_START')) { section = 'traj'; continue }
    if (upper.startsWith('TRAJ_STOP')) { section = 'none'; continue }
    if (upper.startsWith('COV_START') || upper.startsWith('COVARIANCE_START')) {
      section = 'cov'
      hasCov = true
      continue
    }
    if (upper.startsWith('COV_STOP') || upper.startsWith('COVARIANCE_STOP')) {
      section = 'none'
      continue
    }
    if (upper.startsWith('MAN_START')) {
      section = 'man'
      manAcc = { id: null, dura: null, acc: null, t: null }
      continue
    }
    if (upper.startsWith('MAN_STOP')) {
      if (manAcc && manAcc.t != null) {
        const ax = manAcc.acc ? Math.hypot(manAcc.acc[0], manAcc.acc[1], manAcc.acc[2]) : 0
        const dvMps = (manAcc.dura || 0) * ax * 1000 // km/s^2 * s → m/s
        maneuvers.push({
          t: manAcc.t,
          dvMps: Number(dvMps.toFixed(6)),
          duraSec: manAcc.dura || 0,
          id: manAcc.id ?? undefined
        })
      }
      manAcc = null
      section = 'none'
      continue
    }

    const eq = line.indexOf('=')
    if (eq > 0) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()
      if (key === 'CREATION_DATE') created = parseIso(value)
      else if (key === 'ORIGINATOR') originator = value
      else if (key === 'OBJECT_NAME') name = value
      else if (key === 'OBJECT_DESIGNATOR' || key === 'OBJECT_ID') objectDesignator = value
      else if (key === 'START_TIME') start = parseIso(value)
      else if (key === 'STOP_TIME') stop = parseIso(value)
      else if (key === 'STEP_SIZE') stepSec = Number(value) || stepSec
      else if (key === 'COV_REF_FRAME') covFrame = value
      else if (key === 'MAN_ID' && manAcc) manAcc.id = value
      continue
    }

    if (section === 'traj') {
      const toks = line.split(/\s+/)
      const t = parseIso(toks[0])
      if (t == null || toks.length < 7) continue
      points++
      if (prevTrajT != null) {
        const dt = (t - prevTrajT) / 1000
        if (dt > 0 && dt < 3600) stepSec = dt
      }
      prevTrajT = t
      continue
    }

    if (section === 'man' && manAcc) {
      const toks = line.split(/\s+/)
      const t = parseIso(toks[0])
      if (t == null || toks.length < 5) continue
      // TIME_ABSOLUTE, MAN_DURA, ACC_X, ACC_Y, ACC_Z
      manAcc.t = t
      manAcc.dura = Number(toks[1])
      manAcc.acc = [Number(toks[2]), Number(toks[3]), Number(toks[4])]
    }
  }

  if (!name) {
    const m = /STARLINK-(\d+)/i.exec(fileName)
    name = m ? `STARLINK-${m[1]}` : path.basename(fileName)
  }
  // NORAD 取 OBJECT_DESIGNATOR（SpaceX OCM 该字段即 NORAD 目录号，已与 TLE 编目库交叉验证；
  // OBJECT_NAME 后缀是 Starlink 内部序列名，不是 NORAD，仅作兜底）
  const norad =
    (/^\d+$/.test(objectDesignator) && objectDesignator !== '0' ? objectDesignator : '') ||
    nameFromStarlink(name) ||
    '0'
  if (!(start && stop) || points < 2) throw new Error(`OCM meta incomplete in ${fileName}`)

  // 中位步长兜底：START/STOP/points 估算
  if (points > 1 && start && stop) {
    const est = (stop - start) / 1000 / (points - 1)
    if (est > 0 && est < 3600) stepSec = Math.round(est)
  }

  return {
    name,
    norad: String(norad),
    start,
    stop,
    stepSec,
    created,
    covFrame: /ITRF/i.test(covFrame) ? 'ITRF' : covFrame,
    points,
    hasCov,
    maneuvers,
    originator: `${originator} (starlink.com public OCM)`
  }
}

/** 按正文自动识别格式并解析（CCSDS_OCM_VERS → OCM，否则按 ITC 文件名口径） */
export function parseMetaAuto(text: string, fileName: string): { format: 'ITC' | 'OCM'; meta: EphemMetaParsed } {
  if (/^CCSDS_OCM_VERS/m.test(text)) {
    return { format: 'OCM', meta: parseOcmMeta(text, fileName) }
  }
  return { format: 'ITC', meta: parseItcMeta(text, fileName) }
}
