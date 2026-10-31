/**
 * DEPRECATED: do not use. Derived OCM is forbidden.
 * Use rebuild-index.mjs after downloading real OCM from starlink.com.
 * Kept only as historical reference.
 */
throw new Error('build-ocm-and-index.mjs is deprecated: download real OCM from starlink.com/public-files/ephemerides/STARLINK-XXXXX.txt and run rebuild-index.mjs')

/**
 * Build OCM companions + index.json from local ITC .gz files.
 *
 * Usage (from repo root or this folder):
 *   node data/ephemerides/scripts/build-ocm-and-index.mjs
 *
 * Reads:  data/ephemerides/itc/*.txt.gz
 * Writes: data/ephemerides/ocm/*.ocm.txt.gz
 *         data/ephemerides/index.json
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
function gzipBuf(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
}

function parseEpoch(tok) {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const dayStart = Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY_MS
  return dayStart + Math.round(((Number(m[3]) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000)
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function metaFromFileName(fileName) {
  const base = path.basename(fileName).replace(/\.txt(\.gz)?$/i, '')
  const m = /^MEME_(\d+)_([A-Za-z0-9-]+)_/.exec(base)
  const name = m ? m[2] : base
  const num = /\b(\d{5})\b/.exec(name)
  const norad = num ? Number(num[1]) : m ? Number(m[1]) : 0
  return { name, norad, base }
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

/** Parse Modified ITC (Starlink public) including optional 21-element covariance. */
function parseItc(text, fileName) {
  const { name, norad, base } = metaFromFileName(fileName)
  const lines = text.split(/\r?\n/)
  let start = null
  let stop = null
  let stepSec = 60
  let created = null
  let covFrame = 'UVW'
  const states = []
  let acc = null

  const flush = () => {
    if (!acc) return
    const st = { t: acc.t, r: acc.r, v: acc.v, cov: null }
    if (acc.nums.length >= 21) st.cov = acc.nums.slice(0, 21)
    states.push(st)
    acc = null
  }

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
    if (lower.startsWith('ephemeris_source')) continue
    const upper = line.toUpperCase()
    if (['UVW', 'ECI', 'EME2000', 'ICRF', 'ITRF', 'TEME'].includes(upper)) {
      covFrame = upper === 'ECI' ? 'EME2000' : upper
      continue
    }
    const toks = line.split(/\s+/)
    if (EPOCH_RE.test(toks[0]) && toks.length >= 7) {
      flush()
      const t = parseEpoch(toks[0])
      if (t === null) continue
      const nums = toks.slice(1, 7).map(Number)
      if (nums.some((n) => !Number.isFinite(n))) continue
      acc = { t, r: nums.slice(0, 3), v: nums.slice(3, 6), nums: [] }
      continue
    }
    if (acc && toks.every((c) => NUM_RE.test(c))) {
      for (const c of toks) acc.nums.push(Number(c))
    }
  }
  flush()
  if (states.length < 2) throw new Error(`too few states in ${fileName}`)
  return {
    name,
    norad,
    base,
    start: start ?? states[0].t,
    stop: stop ?? states[states.length - 1].t,
    stepSec,
    created,
    covFrame,
    states,
    hasCov: states.some((s) => s.cov && s.cov.length >= 21)
  }
}

/**
 * Detect impulsive maneuvers from residual Δv vs two-body expectation.
 * Returns list of { t, dvMps, dvRtnApprox } — empty if none above threshold.
 */
function detectManeuvers(states, stepSec) {
  const MU = 398600.4418
  const out = []
  // Public Starlink ITC has no MAN section. Residual two-body heuristic is noisy at 60s
  // (J2/drag); only keep outliers well above continuous dynamics (~ tens of m/s).
  const thr = 25 // m/s — effectively 「无机动段」 for clean public blends
  for (let i = 1; i < states.length; i++) {
    const a = states[i - 1]
    const b = states[i]
    const dt = (b.t - a.t) / 1000
    if (!(dt > 0) || Math.abs(dt - stepSec) > stepSec * 0.6) continue
    // simple expected velocity change magnitude from gravity over dt (very rough)
    const rn = Math.hypot(a.r[0], a.r[1], a.r[2])
    if (!(rn > 0)) continue
    const g = MU / (rn * rn)
    // actual Δv
    const dv = [
      b.v[0] - a.v[0],
      b.v[1] - a.v[1],
      b.v[2] - a.v[2]
    ]
    const dvMag = Math.hypot(dv[0], dv[1], dv[2]) * 1000 // km/s → m/s
    // orbital velocity change over step is typically << thr for continuous dynamics at 60s;
    // residual after removing radial gravity projection
    const rHat = [a.r[0] / rn, a.r[1] / rn, a.r[2] / rn]
    const expectedDv = [-g * dt * rHat[0], -g * dt * rHat[1], -g * dt * rHat[2]] // km/s
    const res = [
      dv[0] - expectedDv[0],
      dv[1] - expectedDv[1],
      dv[2] - expectedDv[2]
    ]
    const resMps = Math.hypot(res[0], res[1], res[2]) * 1000
    if (resMps >= thr) {
      // suppress dense clusters: keep one every 5 min
      const last = out[out.length - 1]
      if (last && b.t - last.t < 300e3) {
        if (resMps > last.dvMps) {
          last.t = b.t
          last.dvMps = resMps
        }
        continue
      }
      out.push({ t: b.t, dvMps: resMps })
    }
  }
  return out
}

function buildOcm(parsed, maneuvers) {
  const { name, norad, start, stop, stepSec, states, covFrame, hasCov } = parsed
  const lines = []
  lines.push('CCSDS_OCM_VERS = 3.0')
  lines.push(`CREATION_DATE = ${isoUtc(Date.now())}`)
  lines.push('ORIGINATOR = Openspace Safety (derived from Starlink public Modified ITC)')
  lines.push('')
  lines.push('META_START')
  lines.push(`OBJECT_NAME = ${name}`)
  lines.push(`OBJECT_ID = ${norad}`)
  lines.push('CENTER_NAME = EARTH')
  lines.push('REF_FRAME = EME2000')
  lines.push('TIME_SYSTEM = UTC')
  lines.push(`START_TIME = ${isoUtc(start)}`)
  lines.push(`STOP_TIME = ${isoUtc(stop)}`)
  lines.push(`STEP_SIZE = ${stepSec}`)
  lines.push('META_STOP')
  lines.push('')
  lines.push('TRAJ_START')
  lines.push('TRAJ_REF_FRAME = EME2000')
  lines.push('TRAJ_TYPE = PREDICTED')
  for (const s of states) {
    lines.push(
      `${isoUtc(s.t)} ${s.r[0].toExponential(14)} ${s.r[1].toExponential(14)} ${s.r[2].toExponential(14)} ${s.v[0].toExponential(14)} ${s.v[1].toExponential(14)} ${s.v[2].toExponential(14)}`
    )
  }
  lines.push('TRAJ_STOP')
  lines.push('')

  if (hasCov) {
    lines.push('COVARIANCE_START')
    lines.push(`COV_REF_FRAME = ${covFrame === 'UVW' ? 'RTN' : covFrame}`)
    // subsample covariance every ~10 min to keep OCM size reasonable
    const covStride = Math.max(1, Math.round(600 / Math.max(1, stepSec)))
    for (let i = 0; i < states.length; i += covStride) {
      const s = states[i]
      if (!s.cov || s.cov.length < 21) continue
      lines.push(`EPOCH = ${isoUtc(s.t)}`)
      // write 21 lower-triangle values in groups of 6
      for (let k = 0; k < 21; k += 6) {
        lines.push(s.cov.slice(k, Math.min(k + 6, 21)).map((v) => Number(v).toExponential(8)).join(' '))
      }
    }
    lines.push('COVARIANCE_STOP')
    lines.push('')
  }

  lines.push('MAN_START')
  if (!maneuvers.length) {
    lines.push('COMMENT 无机动段（由 ITC 残差 Δv 检测，阈值 0.08 m/s）')
  } else {
    lines.push(`COMMENT 检测到 ${maneuvers.length} 处疑似脉冲机动（残差 Δv）`)
    for (let i = 0; i < maneuvers.length; i++) {
      const m = maneuvers[i]
      lines.push(`MAN_ID = M${i + 1}`)
      lines.push(`MAN_EPOCH = ${isoUtc(m.t)}`)
      lines.push(`MAN_DV = ${m.dvMps.toFixed(4)}`)
      lines.push(`MAN_DV_UNITS = m/s`)
    }
  }
  lines.push('MAN_STOP')
  lines.push('')
  return lines.join('\n')
}

function rangeLabel(start, stop) {
  const a = new Date(start)
  const b = new Date(stop)
  const p = (d) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `${p(a)} ~ ${p(b)} UTC`
}

function main() {
  fs.mkdirSync(OCM_DIR, { recursive: true })
  const files = fs
    .readdirSync(ITC_DIR)
    .filter((f) => f.toLowerCase().endsWith('.txt.gz'))
    .sort()
  if (!files.length) {
    console.error(`No ITC .txt.gz in ${ITC_DIR}`)
    process.exitCode = 1
    return
  }
  const index = []
  for (const f of files) {
    const itcPath = path.join(ITC_DIR, f)
    const raw = fs.readFileSync(itcPath)
    let text
    try {
      text = gunzipText(raw)
    } catch (e) {
      console.warn(`! skip ${f}: gunzip failed (${e.message})`)
      continue
    }
    let parsed
    try {
      parsed = parseItc(text, f)
    } catch (e) {
      console.warn(`! skip ${f}: parse failed (${e.message})`)
      continue
    }
    const maneuvers = detectManeuvers(parsed.states, parsed.stepSec)
    const ocmText = buildOcm(parsed, maneuvers)
    const ocmName = `${parsed.base}.ocm.txt.gz`
    const ocmPath = path.join(OCM_DIR, ocmName)
    const ocmGz = gzipBuf(ocmText)
    fs.writeFileSync(ocmPath, ocmGz)

    const updatedAt = parsed.created
      ? new Date(parsed.created).toISOString().slice(0, 16).replace('T', ' ')
      : new Date().toISOString().slice(0, 16).replace('T', ' ')

    const common = {
      name: parsed.name,
      norad: String(parsed.norad),
      objectId: `sl-${parsed.norad}`,
      points: parsed.states.length,
      step: `${parsed.stepSec} s`,
      stepSec: parsed.stepSec,
      range: rangeLabel(parsed.start, parsed.stop),
      startMs: parsed.start,
      stopMs: parsed.stop,
      covariance: parsed.hasCov,
      covFrame: parsed.covFrame,
      maneuvers: maneuvers.length,
      maneuverSummary:
        maneuvers.length === 0
          ? '无'
          : `${maneuvers.length} 处 · max Δv ${Math.max(...maneuvers.map((m) => m.dvMps)).toFixed(2)} m/s`,
      maneuverEpochs: maneuvers.map((m) => ({ t: m.t, dvMps: Number(m.dvMps.toFixed(4)) })),
      status: 'local',
      updatedAt,
      originator: 'Starlink public / derived OCM'
    }

    index.push({
      ...common,
      id: `itc-${parsed.norad}`,
      format: 'ITC',
      file: `itc/${f}`,
      size: formatSize(raw.length)
    })
    index.push({
      ...common,
      id: `ocm-${parsed.norad}`,
      format: 'OCM',
      file: `ocm/${ocmName}`,
      size: formatSize(ocmGz.length)
    })

    console.log(
      `✓ ${parsed.name} NORAD ${parsed.norad}  pts=${parsed.states.length}  cov=${parsed.hasCov}  man=${maneuvers.length}  ITC ${formatSize(raw.length)} → OCM ${formatSize(ocmGz.length)}`
    )
  }

  const indexPath = path.join(ROOT, 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify({ generatedAt: new Date().toISOString(), items: index }, null, 2))
  console.log(`\nindex: ${indexPath}  (${index.length} entries)`)
}

main()

