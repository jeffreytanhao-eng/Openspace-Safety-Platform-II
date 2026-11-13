/**
 * OCM COV_ parse + sparse position-uncertainty payload for the situation globe.
 *
 * Units: COV blocks are km / km/s (CARTPV). Position 3×3 is km²; σ = sqrt(eval) in km.
 * ITRF CARTPV covariances are rotated with the same GMST Rz used for states
 * (position block exact; velocity omits Earth-rate coupling).
 * Age fallback reuses tleSigmaT from screen/covariance.ts — empirical, not file cov.
 * Screening jobs are not changed here.
 */
import { tleSigmaT } from '../screen/covariance.js'
import { uvwCovToEci } from '../screen/frames.js'

export type UncSource = 'file' | 'age'

export interface UncertaintySampleDto {
  t: number
  r: [number, number, number]
  /** 1σ principal-axis lengths, km */
  sigmaKm: [number, number, number]
  /** ECI unit axes matching sigmaKm */
  axesEci: [[number, number, number], [number, number, number], [number, number, number]]
  source: UncSource
  ageHours?: number
}

export interface UncertaintyPayload {
  source: UncSource
  epochMs: number
  covFrame: string
  covOrdering: string
  covType: string
  stateCount: number
  covCount: number
  maxSigmaKm: number
  samples: UncertaintySampleDto[]
  /** Human-readable notes (frame rotation, fallback, units) */
  notes: string[]
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function parseIso(tok: string): number | null {
  const s = tok.trim()
  if (!s) return null
  const ms = Date.parse(s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z')
  return Number.isFinite(ms) ? ms : null
}

function julianDate(epochMs: number): number {
  return epochMs / 86400000 + 2440587.5
}

function gmstRad(epochMs: number): number {
  const jd = julianDate(epochMs)
  const tu = (jd - 2451545.0) / 36525
  const secOfDay =
    67310.54841 + (876600 * 3600 + 8640184.812866) * tu + 0.093104 * tu * tu - 6.2e-6 * tu * tu * tu
  const rad = (secOfDay * Math.PI) / 43200
  const twoPi = Math.PI * 2
  return ((rad % twoPi) + twoPi) % twoPi
}

function itrfRotate(r: [number, number, number], v: [number, number, number], t: number): { r: [number, number, number]; v: [number, number, number] } {
  const th = gmstRad(t)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const re: [number, number, number] = [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]]
  const EARTH_OMEGA = 7.292115e-5
  const ve: [number, number, number] = [
    c * v[0] - s * v[1] - EARTH_OMEGA * re[1],
    s * v[0] + c * v[1] + EARTH_OMEGA * re[0],
    v[2]
  ]
  return { r: re, v: ve }
}

function itrfRotateCov(cov: Float64Array, t: number): Float64Array {
  const th = gmstRad(t)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const m = [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1]
  ]
  const out = new Float64Array(36)
  for (let bi = 0; bi < 2; bi++) {
    for (let bj = 0; bj < 2; bj++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let acc = 0
          for (let k = 0; k < 3; k++) {
            for (let l = 0; l < 3; l++) {
              acc += m[i][k] * cov[(bi * 3 + k) * 6 + (bj * 3 + l)] * m[j][l]
            }
          }
          out[(bi * 3 + i) * 6 + (bj * 3 + j)] = acc
        }
      }
    }
  }
  return out
}

function lowerTriangleToCov(nums: number[]): Float64Array {
  const cov = new Float64Array(36)
  let k = 0
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j <= i; j++) {
      const v = nums[k++]
      cov[i * 6 + j] = v
      cov[j * 6 + i] = v
    }
  }
  return cov
}

function fullMatrixToCov(nums: number[]): Float64Array {
  const cov = new Float64Array(36)
  for (let i = 0; i < 36; i++) cov[i] = nums[i]
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < i; j++) {
      const a = cov[i * 6 + j]
      const b = cov[j * 6 + i]
      const v = Number.isFinite(a) && Number.isFinite(b) ? 0.5 * (a + b) : Number.isFinite(a) ? a : b
      cov[i * 6 + j] = v
      cov[j * 6 + i] = v
    }
  }
  return cov
}

function eigenSym3(aIn: number[][]): { values: [number, number, number]; vectors: [[number, number, number], [number, number, number], [number, number, number]] } {
  const a = [aIn[0].slice(), aIn[1].slice(), aIn[2].slice()]
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ]
  for (let iter = 0; iter < 32; iter++) {
    let p = 0
    let q = 1
    let max = Math.abs(a[0][1])
    if (Math.abs(a[0][2]) > max) {
      max = Math.abs(a[0][2])
      p = 0
      q = 2
    }
    if (Math.abs(a[1][2]) > max) {
      max = Math.abs(a[1][2])
      p = 1
      q = 2
    }
    if (max < 1e-18) break
    const app = a[p][p]
    const aqq = a[q][q]
    const apq = a[p][q]
    const tau = (aqq - app) / (2 * apq)
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
    const c = 1 / Math.sqrt(1 + t * t)
    const s = t * c
    a[p][p] = app - t * apq
    a[q][q] = aqq + t * apq
    a[p][q] = 0
    a[q][p] = 0
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue
      const arp = a[r][p]
      const arq = a[r][q]
      a[r][p] = a[p][r] = c * arp - s * arq
      a[r][q] = a[q][r] = s * arp + c * arq
    }
    for (let r = 0; r < 3; r++) {
      const vrp = v[r][p]
      const vrq = v[r][q]
      v[r][p] = c * vrp - s * vrq
      v[r][q] = s * vrp + c * vrq
    }
  }
  const values: [number, number, number] = [a[0][0], a[1][1], a[2][2]]
  const vectors: [[number, number, number], [number, number, number], [number, number, number]] = [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]]
  ]
  for (let i = 0; i < 3; i++) {
    const n = Math.hypot(vectors[i][0], vectors[i][1], vectors[i][2]) || 1
    vectors[i] = [vectors[i][0] / n, vectors[i][1] / n, vectors[i][2] / n]
  }
  return { values, vectors }
}

function posEigen(cov: Float64Array): { sigmaKm: [number, number, number]; axesEci: UncertaintySampleDto['axesEci'] } {
  const P = [
    [cov[0], cov[1], cov[2]],
    [cov[6], cov[7], cov[8]],
    [cov[12], cov[13], cov[14]]
  ]
  const { values, vectors } = eigenSym3(P)
  const sigmaKm: [number, number, number] = [
    Math.sqrt(Math.max(0, values[0])),
    Math.sqrt(Math.max(0, values[1])),
    Math.sqrt(Math.max(0, values[2]))
  ]
  return { sigmaKm, axesEci: vectors }
}

function uvwAxes(r: [number, number, number], v: [number, number, number]): UncertaintySampleDto['axesEci'] {
  const rn = Math.hypot(r[0], r[1], r[2]) || 1
  const u: [number, number, number] = [r[0] / rn, r[1] / rn, r[2] / rn]
  const hx = r[1] * v[2] - r[2] * v[1]
  const hy = r[2] * v[0] - r[0] * v[2]
  const hz = r[0] * v[1] - r[1] * v[0]
  const hn = Math.hypot(hx, hy, hz) || 1
  const w: [number, number, number] = [hx / hn, hy / hn, hz / hn]
  const vv: [number, number, number] = [
    w[1] * u[2] - w[2] * u[1],
    w[2] * u[0] - w[0] * u[2],
    w[0] * u[1] - w[1] * u[0]
  ]
  return [u, vv, w]
}

function ageSample(t: number, r: [number, number, number], v: [number, number, number], epochMs: number): UncertaintySampleDto {
  const ageHours = Math.max(0, (t - epochMs) / 3_600_000)
  const sigmaV = tleSigmaT(ageHours)
  const sigmaU = Math.max(0.2, 0.1 * sigmaV)
  return { t, r, sigmaKm: [sigmaU, sigmaV, sigmaU], axesEci: uvwAxes(r, v), source: 'age', ageHours }
}

function pickIndices(n: number, budget: number): number[] {
  if (n <= budget) return Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  const seen = new Set<number>()
  const add = (i: number) => {
    const k = Math.max(0, Math.min(n - 1, i))
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  add(0)
  add(n - 1)
  add(Math.floor(n / 2))
  const step = (n - 1) / (budget - 1)
  for (let k = 0; k < budget; k++) add(Math.round(k * step))
  out.sort((a, b) => a - b)
  return out
}

interface St {
  t: number
  r: [number, number, number]
  v: [number, number, number]
  cov?: Float64Array
}

/**
 * Parse OCM (and a loose ITC-like 21-term fallback is not handled here) text into a sparse
 * uncertainty payload. Supports COV_START LTM (21) and FULL (36), CARTPV, ITRF/RTN/inertial.
 */
export function buildUncertaintyPayload(text: string, maxPoints = 48): UncertaintyPayload {
  const notes: string[] = []
  const lines = text.split(/\r?\n/)
  let section: 'none' | 'traj' | 'cov' = 'none'
  let trajFrame = ''
  let covFrame = ''
  let covOrdering = ''
  let covType = ''
  const states: St[] = []
  const covs: { t: number; nums: number[] }[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.toUpperCase().startsWith('COMMENT')) continue
    const upper = line.toUpperCase()
    if (upper.startsWith('TRAJ_START') || upper.startsWith('TRAJ_BLK_START')) {
      section = 'traj'
      continue
    }
    if (upper.startsWith('TRAJ_STOP') || upper.startsWith('TRAJ_BLK_STOP')) {
      section = 'none'
      continue
    }
    if (upper.startsWith('COV_START') || upper.startsWith('COVARIANCE_START')) {
      section = 'cov'
      continue
    }
    if (upper.startsWith('COV_STOP') || upper.startsWith('COVARIANCE_STOP')) {
      section = 'none'
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0 && !NUM_RE.test(line.slice(0, eq).trim())) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()
      if (key === 'TRAJ_REF_FRAME') trajFrame = value
      else if (key === 'COV_REF_FRAME') covFrame = value
      else if (key === 'COV_ORDERING') covOrdering = value
      else if (key === 'COV_TYPE') covType = value
      continue
    }
    const tokens = line.split(/\s+/)
    const t = parseIso(tokens[0])
    if (t == null) continue
    if (section === 'traj' && tokens.length >= 7) {
      const nums = tokens.slice(1, 7).map(Number)
      if (nums.every((n) => Number.isFinite(n))) {
        states.push({ t, r: [nums[0], nums[1], nums[2]], v: [nums[3], nums[4], nums[5]] })
      }
      continue
    }
    if (section === 'cov') {
      const nums = tokens.slice(1).filter((c) => NUM_RE.test(c)).map(Number)
      const wantFull = /FULL/i.test(covOrdering) || (!/LTM/i.test(covOrdering) && nums.length >= 36)
      const need = wantFull ? 36 : 21
      if (nums.length >= need) covs.push({ t, nums: nums.slice(0, need) })
    }
  }

  const trajIsItrf = /ITRF/i.test(trajFrame)
  if (trajIsItrf) {
    for (const st of states) {
      const conv = itrfRotate(st.r, st.v, st.t)
      st.r = conv.r
      st.v = conv.v
    }
    notes.push('states rotated ITRF → ECI (GMST Rz)')
  }

  const covIsRtn = /RTN|UVW|RSW/i.test(covFrame)
  const covIsItrf = /ITRF/i.test(covFrame)
  let attached = 0
  for (const c of covs) {
    const raw = c.nums.length >= 36 ? fullMatrixToCov(c.nums) : lowerTriangleToCov(c.nums)
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < states.length; i++) {
      const d = Math.abs(states[i].t - c.t)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0 || bestD > 60_000) continue
    const st = states[best]
    if (covIsRtn) {
      // After states are in ECI, UVW basis is from ECI r,v — matches frontend post-rotation path
      st.cov = uvwCovToEci(raw, st.r, st.v)
    } else if (covIsItrf) {
      st.cov = itrfRotateCov(raw, st.t)
    } else {
      st.cov = raw
    }
    attached++
  }

  const epochMs = states[0]?.t || 0
  const withCov = states.filter((s) => s.cov)
  const samples: UncertaintySampleDto[] = []
  if (withCov.length) {
    const idx = pickIndices(withCov.length, Math.max(4, maxPoints))
    for (const i of idx) {
      const st = withCov[i]
      const eig = posEigen(st.cov as Float64Array)
      samples.push({ t: st.t, r: st.r, ...eig, source: 'file' })
    }
    notes.push(`file covariance: ${attached} of ${covs.length} COV rows aligned to states; σ in km from 3×3 position block`)
    if (covIsItrf) notes.push('covariance rotated ITRF → ECI (position block exact)')
    if (covIsRtn) notes.push('covariance treated as RTN/UVW and rotated to ECI')
  } else if (states.length) {
    const idx = pickIndices(states.length, Math.min(16, Math.max(4, maxPoints)))
    for (const i of idx) samples.push(ageSample(states[i].t, states[i].r, states[i].v, epochMs))
    notes.push('no complete COV_ block aligned to states; using empirical age-model σ (not file covariance)')
  } else {
    notes.push('no trajectory states parsed')
  }

  const maxSigmaKm = samples.reduce((m, s) => Math.max(m, s.sigmaKm[0], s.sigmaKm[1], s.sigmaKm[2]), 0)
  return {
    source: withCov.length ? 'file' : 'age',
    epochMs,
    covFrame: covFrame || (trajFrame || ''),
    covOrdering: covOrdering || (covs[0]?.nums.length >= 36 ? 'FULL' : covs.length ? 'LTM' : ''),
    covType: covType || '',
    stateCount: states.length,
    covCount: attached,
    maxSigmaKm,
    samples,
    notes
  }
}

/** Eigen of a 3×3 position block (km²) → σ km. Exported for tests. */
export function eigenPositionSigma(posCov3: number[][]): { sigmaKm: [number, number, number]; axes: UncertaintySampleDto['axesEci']; values: [number, number, number] } {
  const { values, vectors } = eigenSym3(posCov3)
  return {
    values,
    axes: vectors,
    sigmaKm: [
      Math.sqrt(Math.max(0, values[0])),
      Math.sqrt(Math.max(0, values[1])),
      Math.sqrt(Math.max(0, values[2]))
    ]
  }
}

export { tleSigmaT }
