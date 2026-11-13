/**
 * Position-uncertainty helpers for the situation globe.
 *
 * Units: covariance on EphemState.cov is a 6×6 ECI matrix in km / km/s
 * (position block km²). Eigen σ = sqrt(eigenvalue) is in km.
 * Age fallback uses the same TLE-age σ family as api/src/screen/covariance.ts
 * (0h/6h → 1 km, 72h → 11.7, 168h → 38.5, cap 200 km;
 * σ_R = σ_N = max(0.2, 0.1·σ_T)). This is an empirical model, not file covariance.
 */
import type { EphemSet, EphemState, UncertaintyCatalog, UncertaintySample, Vec3 } from './types'
import { uvwBasis } from './frames'

const SIGMA_T_ANCHORS: [number, number][] = [
  [0, 1.0],
  [6, 1.0],
  [72, 11.7],
  [168, 38.5]
]
const SIGMA_T_MAX_KM = 200

/** Along-track σ (km) from age in hours. Same anchors as tleSigmaT. */
export function tleSigmaT(ageHours: number): number {
  const h = Math.max(0, ageHours)
  if (h <= SIGMA_T_ANCHORS[0][0]) return SIGMA_T_ANCHORS[0][1]
  for (let i = 1; i < SIGMA_T_ANCHORS.length; i++) {
    const [h1, s1] = SIGMA_T_ANCHORS[i]
    if (h <= h1) {
      const [h0, s0] = SIGMA_T_ANCHORS[i - 1]
      return s0 + ((s1 - s0) * (h - h0)) / (h1 - h0)
    }
  }
  const [h0, s0] = SIGMA_T_ANCHORS[SIGMA_T_ANCHORS.length - 2]
  const [h1, s1] = SIGMA_T_ANCHORS[SIGMA_T_ANCHORS.length - 1]
  const slope = (s1 - s0) / (h1 - h0)
  return Math.min(SIGMA_T_MAX_KM, s1 + slope * (h - h1))
}

export function ageSigmaUvw(ageHours: number): { sigmaU: number; sigmaV: number; sigmaW: number } {
  const sigmaV = tleSigmaT(ageHours)
  const sigmaU = Math.max(0.2, 0.1 * sigmaV)
  return { sigmaU, sigmaV, sigmaW: sigmaU }
}

/** Top-left 3×3 position block of a row-major 6×6 (km²). */
export function posCov3(cov: Float64Array | number[]): [[number, number, number], [number, number, number], [number, number, number]] {
  const c = cov
  return [
    [c[0], c[1], c[2]],
    [c[6], c[7], c[8]],
    [c[12], c[13], c[14]]
  ]
}

/**
 * Jacobi eigensolver for a real symmetric 3×3.
 * values are not sorted; vectors are orthonormal columns matching values.
 * Negative eigenvalues (numerical) are clamped to 0 when taking σ.
 */
export function eigenSym3(
  aIn: number[][]
): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [aIn[0][0], aIn[0][1], aIn[0][2]],
    [aIn[1][0], aIn[1][1], aIn[1][2]],
    [aIn[2][0], aIn[2][1], aIn[2][2]]
  ]
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ]
  for (let iter = 0; iter < 32; iter++) {
    let p = 0
    let q = 1
    let max = Math.abs(a[0][1])
    const a02 = Math.abs(a[0][2])
    const a12 = Math.abs(a[1][2])
    if (a02 > max) {
      max = a02
      p = 0
      q = 2
    }
    if (a12 > max) {
      max = a12
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
  const vectors: [Vec3, Vec3, Vec3] = [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]]
  ]
  // Orthonormalize in case of drift
  for (let i = 0; i < 3; i++) {
    const n = Math.hypot(vectors[i][0], vectors[i][1], vectors[i][2]) || 1
    vectors[i] = [vectors[i][0] / n, vectors[i][1] / n, vectors[i][2] / n]
  }
  return { values, vectors }
}

export function sigmaFromEvals(values: [number, number, number]): [number, number, number] {
  return [
    Math.sqrt(Math.max(0, values[0])),
    Math.sqrt(Math.max(0, values[1])),
    Math.sqrt(Math.max(0, values[2]))
  ]
}

export function sampleFromPosCov(t: number, r: Vec3, cov: Float64Array | number[]): UncertaintySample {
  const eig = eigenSym3(posCov3(cov))
  return {
    t,
    r: [r[0], r[1], r[2]],
    sigmaKm: sigmaFromEvals(eig.values),
    axesEci: eig.vectors,
    source: 'file'
  }
}

export function sampleFromAge(t: number, r: Vec3, v: Vec3, epochMs: number): UncertaintySample {
  const ageHours = Math.max(0, (t - epochMs) / 3_600_000)
  const { sigmaU, sigmaV, sigmaW } = ageSigmaUvw(ageHours)
  const b = uvwBasis(r, v)
  const axes: [Vec3, Vec3, Vec3] = [
    [b[0][0], b[0][1], b[0][2]],
    [b[1][0], b[1][1], b[1][2]],
    [b[2][0], b[2][1], b[2][2]]
  ]
  return {
    t,
    r: [r[0], r[1], r[2]],
    sigmaKm: [sigmaU, sigmaV, sigmaW],
    axesEci: axes,
    source: 'age',
    ageHours
  }
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

export const FILE_BUDGET = 48
export const AGE_BUDGET = 16
/** Low-end visible cap (wire-only in the Three.js layer). */
export const UNC_VISIBLE_LOW_END = 16

/** Build a sparse catalog. Prefer file 6×6 position blocks; otherwise age-model σ in local UVW. */
export function buildUncertaintyCatalog(set: EphemSet): UncertaintyCatalog {
  const states = set.states
  const epochMs = set.start || states[0]?.t || 0
  const withCov = states
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.cov && x.s.cov.length >= 15)
  const samples: UncertaintySample[] = []
  if (withCov.length) {
    const idx = pickIndices(withCov.length, FILE_BUDGET)
    for (const k of idx) {
      const st = withCov[k].s
      samples.push(sampleFromPosCov(st.t, st.r, st.cov as Float64Array))
    }
    // Maneuver midpoints: nearest file-cov state
    for (const man of set.maneuvers || []) {
      const mid = (man.t0 + man.t1) / 2
      let best = withCov[0]
      let bestD = Math.abs(best.s.t - mid)
      for (const x of withCov) {
        const d = Math.abs(x.s.t - mid)
        if (d < bestD) {
          best = x
          bestD = d
        }
      }
      if (bestD <= 600_000 && !samples.some((s) => Math.abs(s.t - best.s.t) < 1)) {
        samples.push(sampleFromPosCov(best.s.t, best.s.r, best.s.cov as Float64Array))
      }
    }
    samples.sort((a, b) => a.t - b.t)
    const maxSigmaKm = samples.reduce((m, s) => Math.max(m, s.sigmaKm[0], s.sigmaKm[1], s.sigmaKm[2]), 0)
    return { source: 'file', epochMs, samples, maxSigmaKm }
  }
  if (states.length) {
    const idx = pickIndices(states.length, AGE_BUDGET)
    for (const i of idx) {
      const st = states[i]
      samples.push(sampleFromAge(st.t, st.r, st.v, epochMs))
    }
  }
  const maxSigmaKm = samples.reduce((m, s) => Math.max(m, s.sigmaKm[0], s.sigmaKm[1], s.sigmaKm[2]), 0)
  return { source: 'age', epochMs, samples, maxSigmaKm }
}

export function enrichSetWithUncertainty(set: EphemSet): EphemSet {
  const had = set.states.some((s) => !!s.cov) || set.hasCov === true
  if (had) set.hasCov = true
  set.uncertainty = buildUncertaintyCatalog(set)
  return set
}

/** Live sample at time t: file catalog interpolates nearest; age is computed exactly. */
export function uncertaintyAt(
  set: EphemSet,
  t: number,
  st: Pick<EphemState, 'r' | 'v'> | null
): UncertaintySample | null {
  const cat = set.uncertainty
  if (!st) return null
  if (!cat || cat.source === 'age' || !cat.samples.length) {
    return sampleFromAge(t, st.r, st.v, cat?.epochMs ?? set.start ?? t)
  }
  const samples = cat.samples
  let lo = 0
  let hi = samples.length - 1
  if (t <= samples[0].t) return { ...samples[0], r: [st.r[0], st.r[1], st.r[2]], t }
  if (t >= samples[hi].t) return { ...samples[hi], r: [st.r[0], st.r[1], st.r[2]], t }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  const w = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
  // Interpolate the covariance tensors, then re-diagonalise. Eigenvectors are only
  // defined up to sign (and spin freely when two σ are nearly equal), so lerping the
  // axis vectors directly can pass through a near-zero, non-orthogonal basis and make
  // the section blow up / flip between stations — the zig-zag tube symptom.
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (const [s, wt] of [
    [a, 1 - w],
    [b, w]
  ] as [UncertaintySample, number][]) {
    for (let k = 0; k < 3; k++) {
      const w2 = s.sigmaKm[k] * s.sigmaKm[k] * wt
      const u = s.axesEci[k]
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) cov[i][j] += w2 * u[i] * u[j]
      }
    }
  }
  const eig = eigenSym3(cov)
  return {
    t,
    r: [st.r[0], st.r[1], st.r[2]],
    sigmaKm: sigmaFromEvals(eig.values),
    axesEci: eig.vectors,
    source: 'file'
  }
}

/**
 * Sparse samples along the ENTIRE ephemeris catalog (no playhead time window).
 * Default draws the full catalog (~48 file samples, or 16 age samples).
 * Also includes a live sample at the playhead when it is more than 30 s from any catalog point.
 */
export function pickVisibleSamples(set: EphemSet, simMs: number, st: Pick<EphemState, 'r' | 'v'> | null, maxN?: number): UncertaintySample[] {
  const cat = set.uncertainty
  const cap = maxN ?? Math.max(FILE_BUDGET, cat?.samples.length ?? 0)
  const out: UncertaintySample[] = []
  if (cat?.samples.length) {
    const idx = pickIndices(cat.samples.length, Math.max(1, cap))
    for (const i of idx) out.push(cat.samples[i])
  }
  const live = uncertaintyAt(set, simMs, st)
  if (live && !out.some((s) => Math.abs(s.t - live.t) < 30_000)) {
    out.push(live)
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * Upper bound on tube cross-sections (not a station budget the way it used to be).
 * One section per file state: the orbit polyline is drawn through exactly those
 * states, so the tube axis is the same polyline and the corridor provably wraps it.
 * Older code kept ~32 slices per revolution (one per 178 s on a 7-day OCM); those
 * chords sank ~33 km inside the 60 s orbit polyline — far more than the 1σ section
 * radius — so the orbit line ran outside the tube and the ribbon looked kinked.
 */
export const TUBE_STATIONS = 20000
/** Low-end: still covers a 7-day 60 s file end to end, only fewer radial points. */
export const TUBE_STATIONS_LOW = 12000
/** Mesh epsilon only — not a visual floor in kilometres. */
export const UNC_MESH_EPS_KM = 1e-6

/** Default display multiplier on the true perpendicular cross-section (user may pick 5× or 20×).
 *  Not camera-distance adaptive, and not a kilometre floor.
 *  3σ is three times the already-scaled 1σ section (i.e. true 1σ × 3 × scale). */
export const UNC_DISPLAY_SCALE = 20

/**
 * True physical semi-axes (km) for 1-sigma or 3-sigma.
 * Fixed 20× display scale on true n-sigma axes. No camera-distance scale and no kilometre visual floor.
 * A tiny epsilon avoids a degenerate zero-size mesh only.
 */
export function displaySemiAxes(
  sigmaKm: [number, number, number],
  nSigma: number,
  scale: number = UNC_DISPLAY_SCALE
): {
  axesKm: [number, number, number]
  exaggerated: boolean
  scale: number
} {
  const n = (nSigma > 0 ? nSigma : 1) * scale
  return {
    axesKm: [
      Math.max(UNC_MESH_EPS_KM, sigmaKm[0] * n),
      Math.max(UNC_MESH_EPS_KM, sigmaKm[1] * n),
      Math.max(UNC_MESH_EPS_KM, sigmaKm[2] * n)
    ],
    exaggerated: true,
    scale
  }
}

function unit3(x: number, y: number, z: number): Vec3 {
  const n = Math.hypot(x, y, z) || 1
  return [x / n, y / n, z / n]
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/**
 * Samples the uncertainty catalog along the ephemeris track so a continuous tube
 * can vary in thickness where file (or age-model) sigma changes.
 *
 * One section per file state (up to the cap) so the tube axis reuses the exact
 * polyline vertices of the drawn orbit: sampling the uncertainty catalog at a
 * coarser stride than the track is what pulled the tube inside the arc and made
 * the orbit line leave the corridor at 1×.
 */
export function samplesAlongTrack(
  set: EphemSet,
  maxN?: number
): { sample: UncertaintySample; tangentEci: Vec3 }[] {
  const states = set.states
  if (!states.length) return []
  const cap = Math.min(states.length, Math.max(2, maxN ?? TUBE_STATIONS))
  const idx = pickIndices(states.length, cap)
  const out: { sample: UncertaintySample; tangentEci: Vec3 }[] = []
  for (const i of idx) {
    const st = states[i]
    // 文件逐历元自带的 6×6 协方差优先：截面直接用该状态的协方差位置块，
    // 不再经过 48 点稀疏样例插值，管道口径才严格等于星历文件里的数据。
    const sample = st.cov && st.cov.length >= 15
      ? sampleFromPosCov(st.t, st.r, st.cov)
      : uncertaintyAt(set, st.t, st)
    if (!sample) continue
    let tx = st.v[0]
    let ty = st.v[1]
    let tz = st.v[2]
    if (Math.hypot(tx, ty, tz) < 1e-12) {
      const j = i < states.length - 1 ? i + 1 : i - 1
      if (j >= 0 && j < states.length) {
        tx = states[j].r[0] - st.r[0]
        ty = states[j].r[1] - st.r[1]
        tz = states[j].r[2] - st.r[2]
      }
    }
    out.push({ sample, tangentEci: unit3(tx, ty, tz) })
  }
  return out
}

/**
 * Cross-section of the n-sigma position ellipsoid in the plane perpendicular to
 * the track, returned as the quadratic form in the (N, B) basis:
 *   r(θ) = 1 / sqrt(cos²θ·m00 + 2·cosθ·sinθ·m01 + sin²θ·m11)   [km]
 *
 * Sampling r(θ) directly is deliberate: near-circular cross-sections have an
 * ill-conditioned principal axis, so per-slice eigenvector orientation used to
 * flip/rotate between stations and draw a zig-zag ribbon. N is parallel
 * transported from the previous slice, so the basis itself never spins.
 * The 5×/20× display scale is already folded into m00/m01/m11.
 */
export function tubeSliceProfile(
  sigmaKm: [number, number, number],
  axesEci: [Vec3, Vec3, Vec3],
  tangentEci: Vec3,
  nSigma: number,
  transportedN?: Vec3 | null,
  scale: number = UNC_DISPLAY_SCALE
): { normal: Vec3; binormal: Vec3; m00: number; m01: number; m11: number } {
  const n = (nSigma > 0 ? nSigma : 1) * scale
  const T = unit3(tangentEci[0], tangentEci[1], tangentEci[2])
  let N: Vec3
  if (transportedN && Math.hypot(transportedN[0], transportedN[1], transportedN[2]) > 1e-12) {
    const proj = dot3(transportedN, T)
    N = unit3(transportedN[0] - T[0] * proj, transportedN[1] - T[1] * proj, transportedN[2] - T[2] * proj)
    if (Math.hypot(N[0], N[1], N[2]) < 1e-8) {
      N = Math.abs(T[2]) < 0.9 ? unit3(-T[1], T[0], 0) : unit3(0, -T[2], T[1])
    }
  } else {
    N = Math.abs(T[2]) < 0.9 ? unit3(-T[1], T[0], 0) : unit3(0, -T[2], T[1])
  }
  let B = cross3(T, N)
  const bLen = Math.hypot(B[0], B[1], B[2]) || 1
  B = [B[0] / bLen, B[1] / bLen, B[2] / bLen]
  N = cross3(B, T)

  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let k = 0; k < 3; k++) {
    const sig = Math.max(UNC_MESH_EPS_KM, sigmaKm[k] * n)
    const invs2 = 1 / (sig * sig)
    const u = axesEci[k]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += invs2 * u[i] * u[j]
    }
  }
  const basis = [N, B]
  const M = [
    [0, 0],
    [0, 0]
  ]
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      let s = 0
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) s += basis[a][i] * A[i][j] * basis[b][j]
      }
      M[a][b] = s
    }
  }
  // Positive-definite by construction; clamp against round-off so the ring radius stays finite.
  const eps = 1e-24
  const m00 = Math.max(eps, M[0][0])
  const m11 = Math.max(eps, M[1][1])
  const m01 = M[0][1]
  return { normal: N, binormal: B, m00, m01, m11 }
}

/** Darker indigo-violet: stays below the orbit #81d4fa and maneuver amber #ffb454 in brightness. */
export const UNC_COLOR = 0x3b1a78
