/**
 * OCM file-MAN display helpers (ephemerides table, situation cards, globe label).
 * UI Δv vector is always written in UVW (U radial, V along-track, W cross-track).
 * File-frame components are converted: ECI Δv from accToEci is projected onto Û, V̂, Ŵ
 * at the burn epoch. Do not print NTW (N,T,W) numbers under the letters U,V,W.
 */
import type { EphemManSegment, Vec3 } from './types'
import { uvwBasis } from './frames'

export type ManEpochLike = {
  t: number
  dvMps?: number
  duraSec?: number
  id?: string
  accX?: number
  accY?: number
  accZ?: number
  acc?: [number, number, number]
  refFrame?: string
  basis?: string
  dcType?: string
  purpose?: string
  deviceId?: string
  extras?: Record<string, string>
}

type TFn = (key: string, params?: Record<string, string | number>) => string

/** Along-track energy sign from acc·v. Null when the sign is essentially zero or unknown. */
export type ManSpeedSense = 'accel' | 'decel' | null

/** |cosθ| below this is treated as no along-track energy change (do not guess 加速/减速). */
const SENSE_COS_MIN = 0.15

/** Axis is "significant" for globe 「>」 orientation when |component| / |acc| >= this. Not used to hide text components. */
export const AXIS_SIGNIFICANT = 0.15

/** Δv in m/s: 3 decimals, or scientific when |Δv| < 0.001 (and non-zero). */
export function fmtDvMps(mps: number | undefined | null): string {
  if (mps == null || !Number.isFinite(mps)) return '—'
  const a = Math.abs(mps)
  if (a === 0) return '0 m/s'
  if (a < 0.001) return `${mps.toExponential(2)} m/s`
  return `${mps.toFixed(3)} m/s`
}

/** |x| below this is treated as 0 (floating-point residue, e.g. 6.94e-18). */
const DV_COMP_ABS_ZERO = 1e-6
/** |x| below this fraction of the maneuver |Δv| is written 0.000 (0.1%). */
const DV_COMP_REL_ZERO = 0.001

/**
 * One signed component: 0 and near-zero as 0.000; scientific when 0 < |x| < 0.001. No unit.
 * Near-zero: |x| < 1e-6, or |x| < 0.1% of that maneuver's |Δv| (pass magMps = hypot of UVW).
 */
export function fmtDvComponent(mps: number, magMps?: number): string {
  if (!Number.isFinite(mps)) return '—'
  const a = Math.abs(mps)
  const mag = magMps != null && Number.isFinite(magMps) ? Math.abs(magMps) : 0
  if (a === 0 || a < DV_COMP_ABS_ZERO || (mag > 0 && a < DV_COMP_REL_ZERO * mag)) return '0.000'
  if (a < 0.001) return mps.toExponential(2)
  return mps.toFixed(3)
}

function accOf(man: { acc?: [number, number, number]; accX?: number; accY?: number; accZ?: number }): [number, number, number] | null {
  if (man.acc && man.acc.length >= 3 && man.acc.every((n) => Number.isFinite(n))) {
    return [man.acc[0], man.acc[1], man.acc[2]]
  }
  if (man.accX != null && man.accY != null && man.accZ != null) {
    const a: [number, number, number] = [man.accX, man.accY, man.accZ]
    if (a.every((n) => Number.isFinite(n))) return a
  }
  return null
}

function isRtnFamily(frame?: string): boolean {
  const f = (frame || '').toUpperCase()
  return /RTN|RSW|UVW/.test(f) && !/NTW/.test(f)
}

function isInertialFrame(frame?: string): boolean {
  const f = (frame || '').toUpperCase()
  return /EME2000|ICRF|J2000|ECI|TEME/.test(f) && !/NTW/.test(f)
}

type ManDirInput = {
  acc?: [number, number, number]
  accX?: number
  accY?: number
  accZ?: number
  refFrame?: string
  dvMps?: number
  duraSec?: number
  t0?: number
  t1?: number
}

export type FrameAxes = {
  short: string
  letters: [string, string, string]
}

/** Short frame name and axis letters. NTW is not relabeled as RTN. */
export function manFrameAxes(frame?: string): FrameAxes {
  const f = (frame || '').toUpperCase()
  if (isRtnFamily(f)) {
    const short = /RTN/.test(f) ? 'RTN' : /RSW/.test(f) ? 'RSW' : 'UVW'
    return { short, letters: ['R', 'T', 'N'] }
  }
  if (isInertialFrame(f)) {
    const short = f.split(/[_\s]/)[0] || 'ECI'
    return { short, letters: ['X', 'Y', 'Z'] }
  }
  return { short: 'NTW', letters: ['N', 'T', 'W'] }
}

function duraSecOf(man: ManDirInput): number | null {
  if (man.duraSec != null && Number.isFinite(man.duraSec) && man.duraSec > 0) return man.duraSec
  if (man.t0 != null && man.t1 != null && Number.isFinite(man.t0) && Number.isFinite(man.t1) && man.t1 > man.t0) {
    return (man.t1 - man.t0) / 1000
  }
  return null
}

/**
 * Component Δv in m/s: acc (km/s²) × duration (s) × 1000.
 * If duration is missing but |Δv| is known, scale acc so hypot(components) = |Δv|.
 */
export function manDvComponents(man: ManDirInput): [number, number, number] | null {
  const acc = accOf(man)
  if (!acc) return null
  const dura = duraSecOf(man)
  if (dura != null && dura > 0) {
    return [acc[0] * dura * 1000, acc[1] * dura * 1000, acc[2] * dura * 1000]
  }
  if (man.dvMps != null && Number.isFinite(man.dvMps)) {
    const mag = Math.hypot(acc[0], acc[1], acc[2])
    if (!(mag > 0)) return null
    const s = man.dvMps / mag
    return [acc[0] * s, acc[1] * s, acc[2] * s]
  }
  return null
}

type AxisPick = { axis: string; val: number; key: string; index: 0 | 1 | 2 }

function axisKey(letter: string, frame?: string): string {
  if (letter === 'N') return isRtnFamily(frame) ? 'eph.dirOutN' : 'eph.dirN'
  if (letter === 'T') return 'eph.dirT'
  if (letter === 'W') return 'eph.dirW'
  if (letter === 'R') return 'eph.dirR'
  return ''
}

function allAxes(man: ManDirInput): AxisPick[] | null {
  const acc = accOf(man)
  if (!acc) return null
  const { letters } = manFrameAxes(man.refFrame)
  return letters.map((axis, i) => ({
    axis,
    val: acc[i],
    key: axisKey(axis, man.refFrame),
    index: i as 0 | 1 | 2
  }))
}

function significantAxes(man: ManDirInput): AxisPick[] | null {
  const axes = allAxes(man)
  if (!axes) return null
  const mag = Math.hypot(axes[0].val, axes[1].val, axes[2].val)
  if (!(mag > 0)) return null
  const significant = axes.filter((c) => Math.abs(c.val) / mag >= AXIS_SIGNIFICANT)
  return significant.length ? significant : [axes.reduce((b, c) => (Math.abs(c.val) > Math.abs(b.val) ? c : b))]
}

function manDvValue(man: ManDirInput): number | null {
  if (man.dvMps != null && Number.isFinite(man.dvMps)) return man.dvMps
  const comps = manDvComponents(man)
  if (!comps) return null
  const mag = Math.hypot(comps[0], comps[1], comps[2])
  return mag > 0 ? mag : null
}

/**
 * Inertial acc·v sign: + = speeding up (加速), − = slowing down (减速).
 * Uses file-frame acc transformed by accToEci (NTW T along v; no silent RTN relabel).
 */
export function manSpeedSense(r: Vec3, v: Vec3, acc: [number, number, number], frame?: string): ManSpeedSense {
  const a = accToEci(r, v, acc, frame)
  if (!a) return null
  const am = Math.hypot(a[0], a[1], a[2])
  const vm = Math.hypot(v[0], v[1], v[2])
  if (!(am > 0) || !(vm > 0)) return null
  const cos = (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / (am * vm)
  if (!Number.isFinite(cos) || Math.abs(cos) < SENSE_COS_MIN) return null
  return cos > 0 ? 'accel' : 'decel'
}

export function manSenseLabel(sense: ManSpeedSense, t: TFn): string {
  if (sense === 'accel') return t('eph.accel')
  if (sense === 'decel') return t('eph.decel')
  return ''
}

/** 「0.093 m/s（加速）」 / “0.093 m/s (Accel)”. Omits the tag when the sign is unknown. */
export function fmtDvWithSense(mps: number | undefined | null, sense: ManSpeedSense, t: TFn): string {
  const dv = fmtDvMps(mps)
  const lab = manSenseLabel(sense, t)
  if (lab && dv !== '—') return t('eph.dvWithSense', { dv, sense: lab })
  return dv
}

/** Tight globe first line: 「|Δv| 0.076 m/s（加速）」. */
export function fmtDvAbsWithSense(mps: number | undefined | null, sense: ManSpeedSense, t: TFn): string {
  const dv = fmtDvWithSense(mps, sense, t)
  return dv === '—' ? '—' : `|Δv| ${dv}`
}

/**
 * File-frame Δv (m/s) → UVW at the burn epoch.
 * Projects ECI Δv (via accToEci) onto Û = r̂, Ŵ = r̂×v̂, V̂ = Ŵ×Û.
 * RTN/RSW/UVW file components are (R,T,N) = (U,V,W) and still go through this projector
 * when r,v are available. If r,v are missing, only the RTN family may use file components
 * directly; NTW/inertial without a state cannot be converted and returns null.
 */
export function manDvUvwComponents(
  man: ManDirInput,
  r?: Vec3 | null,
  v?: Vec3 | null
): [number, number, number] | null {
  const comps = manDvComponents(man)
  if (!comps) return null
  if (!r || !v) {
    if (isRtnFamily(man.refFrame)) return comps
    return null
  }
  const eci = accToEci(r, v, comps, man.refFrame)
  if (!eci) return null
  const b = uvwBasis(r, v)
  return [
    b[0][0] * eci[0] + b[0][1] * eci[1] + b[0][2] * eci[2],
    b[1][0] * eci[0] + b[1][1] * eci[1] + b[1][2] * eci[2],
    b[2][0] * eci[0] + b[2][1] * eci[1] + b[2][2] * eci[2]
  ]
}

const UVW_LETTERS = ['U', 'V', 'W'] as const

/** Full table/card/globe vector, zh/en identical: 「Δv = (0.000 U, 0.093 V, 0.000 W) m/s」. All three UVW components, no 15% cutoff. */
export function manDvVectorPhrase(man: ManDirInput, r?: Vec3 | null, v?: Vec3 | null): string {
  const comps = manDvUvwComponents(man, r, v)
  if (!comps) return '—'
  const mag = Math.hypot(comps[0], comps[1], comps[2])
  const parts = comps.map((val, i) => `${fmtDvComponent(val, mag)} ${UVW_LETTERS[i]}`).join(', ')
  return `Δv = (${parts}) m/s`
}

/** Same wording as manDvVectorPhrase (globe second line). */
export function manDvVectorCompact(man: ManDirInput, r?: Vec3 | null, v?: Vec3 | null): string {
  return manDvVectorPhrase(man, r, v)
}

/** @deprecated Axis-name phrase; text surfaces now use manDvVectorPhrase. Kept for any leftover callers. */
export function manDirectionAxisPhrase(man: ManDirInput, t: TFn): string {
  const shown = significantAxes(man)
  if (!shown) return '—'
  if (shown.length === 1) return t(shown[0].key)
  return shown.map((c) => t(c.key)).join(' / ')
}

/** Card body: magnitude（加速/减速） then the three-component vector, on two lines. */
export function manSpeedLine(man: ManDirInput, t: TFn, sense: ManSpeedSense, r?: Vec3 | null, v?: Vec3 | null): string {
  const dv = fmtDvWithSense(manDvValue(man), sense, t)
  const vec = manDvVectorPhrase(man, r, v)
  if (vec && vec !== '—') return `${dv}\n${vec}`
  return dv
}

/** Globe Δv block (two lines when a vector is available). */
export function manGlobeDvLines(man: ManDirInput, t: TFn, sense: ManSpeedSense, r?: Vec3 | null, v?: Vec3 | null): string {
  const line1 = fmtDvAbsWithSense(manDvValue(man), sense, t)
  const line2 = manDvVectorCompact(man, r, v)
  if (line2 && line2 !== '—') return `${line1}\n${line2}`
  return line1
}

/** @deprecated Prefer manSpeedLine. */
export function manDirectionPhrase(man: ManDirInput, t: TFn, sense: ManSpeedSense = null, r?: Vec3 | null, v?: Vec3 | null): string {
  return manSpeedLine(man, t, sense, r, v)
}

/**
 * One-hot, signed file-frame acc for each significant axis (15% cutoff), in file-frame order.
 * Used only to orient globe 「>」 marks. Null when acc is missing (caller should fall back to along-track).
 */
export function manSignificantAxisAccs(man: ManDirInput): [number, number, number][] | null {
  const acc = accOf(man)
  const shown = significantAxes(man)
  if (!acc || !shown) return null
  return shown.map((c) => {
    const one: [number, number, number] = [0, 0, 0]
    one[c.index] = acc[c.index]
    return one
  })
}

/**
 * Globe 「>」 spacing along the selected burn (same acc·v sense as the card label).
 * 加速 8 s (dense), 减速 20 s (2.5× sparser), unknown 14 s so density does not imply a sign.
 * A 354 s burn → ≈44 / 18 / 25 marks. Clamp 3–72 (short burns 1–2 so glyphs do not overlap).
 */
export const MAN_CHEVRON_STEP_MS = {
  accel: 8_000,
  decel: 20_000,
  unknown: 14_000
} as const

const CHEVRON_MIN = 3
const CHEVRON_MAX = 72

export function manChevronCount(durationMs: number, sense: ManSpeedSense): number {
  if (!(durationMs > 0)) return 1
  if (durationMs < 6_000) return durationMs < 3_000 ? 1 : 2
  const step = sense === 'accel' ? MAN_CHEVRON_STEP_MS.accel : sense === 'decel' ? MAN_CHEVRON_STEP_MS.decel : MAN_CHEVRON_STEP_MS.unknown
  return Math.max(CHEVRON_MIN, Math.min(CHEVRON_MAX, Math.round(durationMs / step)))
}

export function manBasisLabel(basis: string | undefined, t: TFn): string {
  if (!basis) return '—'
  if (/^PLANNED$/i.test(basis)) return t('eph.basisPlanned')
  return basis
}

export function manDcTypeLabel(dc: string | undefined, t: TFn): string {
  if (!dc) return '—'
  if (/^CONTINUOUS$/i.test(dc)) return t('eph.dcContinuous')
  return dc
}

export function epochToSegment(m: ManEpochLike): EphemManSegment {
  const dura = m.duraSec && m.duraSec > 0 ? m.duraSec : 1
  const acc = accOf(m)
  return {
    t0: m.t,
    t1: m.t + dura * 1000,
    dvMps: m.dvMps,
    id: m.id,
    ...(acc ? { acc } : {}),
    refFrame: m.refFrame,
    basis: m.basis,
    dcType: m.dcType,
    purpose: m.purpose,
    deviceId: m.deviceId,
    extras: m.extras
  }
}

export function segmentToEpoch(s: EphemManSegment): ManEpochLike & { t: number; dvMps: number } {
  return {
    t: s.t0,
    dvMps: s.dvMps || 0,
    duraSec: Math.max(0, Math.round((s.t1 - s.t0) / 1000)),
    id: s.id,
    accX: s.acc?.[0],
    accY: s.acc?.[1],
    accZ: s.acc?.[2],
    acc: s.acc,
    refFrame: s.refFrame,
    basis: s.basis,
    dcType: s.dcType,
    purpose: s.purpose,
    deviceId: s.deviceId,
    extras: s.extras
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm(a: Vec3): Vec3 | null {
  const n = Math.hypot(a[0], a[1], a[2])
  if (!(n > 1e-12)) return null
  return [a[0] / n, a[1] / n, a[2] / n]
}

/**
 * File-frame acceleration → ECI. NTW: N, T, W as documented (T along v, W = r×v, N = T×W).
 * RTN/RSW/UVW: R = r̂, T = W×R, N = W. Unrecognized inertial names are left as ECI components.
 * Returns null when the vector is zero or the triad cannot be formed.
 */
export function accToEci(r: Vec3, v: Vec3, acc: [number, number, number], frame?: string): Vec3 | null {
  if (!acc.some((x) => x !== 0 && Number.isFinite(x))) return null
  const rHat = norm(r)
  const tHat = norm(v)
  if (!rHat || !tHat) return null
  const wHat = norm(cross(rHat, tHat))
  if (!wHat) return null
  const f = (frame || 'NTW').toUpperCase()
  if (isRtnFamily(f)) {
    const T = cross(wHat, rHat)
    const tN = norm(T) || T
    return [
      rHat[0] * acc[0] + tN[0] * acc[1] + wHat[0] * acc[2],
      rHat[1] * acc[0] + tN[1] * acc[1] + wHat[1] * acc[2],
      rHat[2] * acc[0] + tN[2] * acc[1] + wHat[2] * acc[2]
    ]
  }
  if (isInertialFrame(f)) {
    return [acc[0], acc[1], acc[2]]
  }
  // Default NTW (including missing frame on older index rows, and NTW_ROTATING)
  const nHat = cross(tHat, wHat)
  return [
    nHat[0] * acc[0] + tHat[0] * acc[1] + wHat[0] * acc[2],
    nHat[1] * acc[0] + tHat[1] * acc[1] + wHat[1] * acc[2],
    nHat[2] * acc[0] + tHat[2] * acc[1] + wHat[2] * acc[2]
  ]
}
