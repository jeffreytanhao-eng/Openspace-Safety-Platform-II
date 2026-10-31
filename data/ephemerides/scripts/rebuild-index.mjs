/**
 * Rebuild index.json from local real ITC + real Starlink OCM downloads.
 * Does NOT synthesize/derive OCM from ITC.
 *
 * Usage: node data/ephemerides/scripts/rebuild-index.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ITC_DIR = path.join(ROOT, 'itc')
const OCM_DIR = path.join(ROOT, 'ocm')

const DAY_MS = 86400000
const EPOCH_RE = /^\d{13}(?:\.\d+)?$/
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function gunzipText(buf) {
  return zlib.gunzipSync(buf).toString('utf8')
}
function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}
function parseEpoch(tok) {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const dayStart = Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY_MS
  return dayStart + Math.round(((Number(m[3]) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000)
}
function rangeLabel(start, stop) {
  const a = new Date(start)
  const b = new Date(stop)
  const p = (d) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `${p(a)} ~ ${p(b)} UTC`
}
function nameFromStarlink(name) {
  const m = /STARLINK-(\d+)/i.exec(name || '')
  return m ? m[1] : null
}
function metaFromItcFileName(fileName) {
  const base = path.basename(fileName).replace(/\.txt(\.gz)?$/i, '')
  const m = /^MEME_(\d+)_([A-Za-z0-9-]+)_/.exec(base)
  const name = m ? m[2] : base
  const num = nameFromStarlink(name)
  const norad = num || (m ? m[1] : '0')
  return { name, norad, base }
}

function parseItcMeta(text, fileName) {
  const { name, norad } = metaFromItcFileName(fileName)
  const lines = text.split(/\r?\n/)
  let start = null
  let stop = null
  let stepSec = 60
  let created = null
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

/** Parse real Starlink CCSDS OCM KVN (META/TRAJ/COV/MAN). */
function parseOcmMeta(text, fileName) {
  const lines = text.split(/\r?\n/)
  let name = ''
  let objectDesignator = ''
  let originator = 'SPACEX/USA'
  let created = null
  let start = null
  let stop = null
  let stepSec = 60
  let points = 0
  let hasCov = false
  let covFrame = 'ITRF'
  let section = 'none'
  let prevTrajT = null
  const maneuvers = []
  let manAcc = null

  const parseIso = (s) => {
    const ms = Date.parse(s.replace(/ Z$/, 'Z'))
    return Number.isFinite(ms) ? ms : null
  }

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
          id: manAcc.id
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
  const norad = nameFromStarlink(name) || objectDesignator || '0'
  if (!(start && stop) || points < 2) throw new Error(`OCM meta incomplete in ${fileName}`)

  // Median step from START/STOP/points if available
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

function toIndexRow(meta, { id, format, file, sizeBytes }) {
  const mans = meta.maneuvers || []
  const updatedAt = meta.created
    ? new Date(meta.created).toISOString().slice(0, 16).replace('T', ' ')
    : new Date().toISOString().slice(0, 16).replace('T', ' ')
  return {
    name: meta.name,
    norad: meta.norad,
    objectId: `sl-${meta.norad}`,
    points: meta.points,
    step: `${meta.stepSec} s`,
    stepSec: meta.stepSec,
    range: rangeLabel(meta.start, meta.stop),
    startMs: meta.start,
    stopMs: meta.stop,
    covariance: !!meta.hasCov,
    covFrame: meta.covFrame,
    maneuvers: mans.length,
    maneuverSummary:
      mans.length === 0
        ? '无'
        : `${mans.length} 处 · max Δv ${Math.max(...mans.map((m) => m.dvMps)).toFixed(4)} m/s`,
    maneuverEpochs: mans.map((m) => ({
      t: m.t,
      dvMps: m.dvMps,
      duraSec: m.duraSec,
      id: m.id
    })),
    status: 'local',
    updatedAt,
    originator: meta.originator,
    id,
    format,
    file,
    size: formatSize(sizeBytes)
  }
}

function main() {
  const items = []

  // ITC
  if (fs.existsSync(ITC_DIR)) {
    const files = fs.readdirSync(ITC_DIR).filter((f) => f.toLowerCase().endsWith('.txt.gz')).sort()
    for (const f of files) {
      const full = path.join(ITC_DIR, f)
      const raw = fs.readFileSync(full)
      const text = gunzipText(raw)
      const meta = parseItcMeta(text, f)
      items.push(
        toIndexRow(meta, {
          id: `itc-${meta.norad}`,
          format: 'ITC',
          file: `itc/${f}`,
          sizeBytes: raw.length
        })
      )
      console.log(`ITC ${meta.name} pts=${meta.points} cov=${meta.hasCov}`)
    }
  }

  // Real OCM only (STARLINK-*.ocm.txt.gz)
  if (fs.existsSync(OCM_DIR)) {
    const files = fs
      .readdirSync(OCM_DIR)
      .filter((f) => /^STARLINK-\d+\.ocm\.txt\.gz$/i.test(f))
      .sort()
    // Remove any leftover derived MEME_*.ocm.txt.gz
    for (const f of fs.readdirSync(OCM_DIR)) {
      if (/^MEME_/i.test(f) || (f.toLowerCase().endsWith('.ocm.txt.gz') && !/^STARLINK-/i.test(f))) {
        fs.unlinkSync(path.join(OCM_DIR, f))
        console.log(`deleted leftover derived ${f}`)
      }
    }
    for (const f of files) {
      const full = path.join(OCM_DIR, f)
      const raw = fs.readFileSync(full)
      const text = gunzipText(raw)
      if (!/^CCSDS_OCM_VERS/m.test(text)) {
        console.warn(`! skip ${f}: not CCSDS OCM`)
        continue
      }
      const meta = parseOcmMeta(text, f)
      items.push(
        toIndexRow(meta, {
          id: `ocm-${meta.norad}`,
          format: 'OCM',
          file: `ocm/${f}`,
          sizeBytes: raw.length
        })
      )
      console.log(
        `OCM ${meta.name} pts=${meta.points} cov=${meta.hasCov} man=${meta.maneuvers.length} step=${meta.stepSec}`
      )
    }
  }

  // Stable order: by norad then ITC before OCM
  items.sort((a, b) => {
    const n = String(a.norad).localeCompare(String(b.norad), undefined, { numeric: true })
    if (n !== 0) return n
    return a.format.localeCompare(b.format)
  })

  const indexPath = path.join(ROOT, 'index.json')
  fs.writeFileSync(
    indexPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2),
    'utf8'
  )
  console.log(`\nindex: ${indexPath} (${items.length} entries; OCM=${items.filter((i) => i.format === 'OCM').length})`)
}

main()
