/**
 * OCM file-MAN display helpers (ephemerides table, situation cards, globe label).
 * Direction stays in the file MAN_REF_FRAME (typically NTW_ROTATING):
 *   N = in-plane normal (roughly radial for circular), T = along-track, W = out-of-plane.
 * Do not silently relabel NTW as RTN.
 */
import type { EphemManSegment, Vec3 } from './types'

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

/** Δv in m/s: 3 decimals, or scientific when |Δv| < 0.001 (and non-zero). */
export function fmtDvMps(mps: number | undefined | null): string {
  if (mps == null || !Number.isFinite(mps)) return '—'
  const a = Math.abs(mps)
  if (a === 0) return '0 m/s'
  if (a < 0.001) return `${mps.toExponential(2)} m/s`
  return `${mps.toFixed(3)} m/s`
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

type ManDirInput = {
  acc?: [number, number, number]
  accX?: number
  accY?: number
  accZ?: number
  refFrame?: string
  dvMps?: number
}

type AxisPick = { axis: string; val: number; key: string }

function significantAxes(man: ManDirInput): AxisPick[] | null {
  const acc = accOf(man)
  if (!acc) return null
  const mag = Math.hypot(acc[0], acc[1], acc[2])
  if (!(mag > 0)) return null
  const rtn = isRtnFamily(man.refFrame)
  const axes: AxisPick[] = rtn
    ? [
        { axis: 'R', val: acc[0], key: 'eph.dirR' },
        { axis: 'T', val: acc[1], key: 'eph.dirT' },
        { axis: 'N', val: acc[2], key: 'eph.dirOutN' }
      ]
    : [
        { axis: 'N', val: acc[0], key: 'eph.dirN' },
        { axis: 'T', val: acc[1], key: 'eph.dirT' },
        { axis: 'W', val: acc[2], key: 'eph.dirW' }
      ]
  const significant = axes.filter((c) => Math.abs(c.val) / mag >= 0.15)
  return significant.length ? significant : [axes.reduce((b, c) => (Math.abs(c.val) > Math.abs(b.val) ? c : b))]
}

function manDvValue(man: ManDirInput): number | null {
  if (man.dvMps != null && Number.isFinite(man.dvMps)) return man.dvMps
  const acc = accOf(man)
  if (!acc) return null
  const mag = Math.hypot(acc[0], acc[1], acc[2])
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

/** 「加速 0.093 m/s」 / “Accel 0.093 m/s”. Omits the label when the sign is unknown. */
export function fmtDvWithSense(mps: number | undefined | null, sense: ManSpeedSense, t: TFn): string {
  const dv = fmtDvMps(mps)
  const lab = manSenseLabel(sense, t)
  return lab && dv !== '—' ? `${lab} ${dv}` : dv
}

/** Axis only: 「沿迹 (T)」 / “Along-track (T)”. No Δv (avoid duplicating the speed). */
export function manDirectionAxisPhrase(man: ManDirInput, t: TFn): string {
  const shown = significantAxes(man)
  if (!shown) return '—'
  if (shown.length === 1) return t(shown[0].key)
  return shown.map((c) => t(c.key)).join(' / ')
}

/** Card / globe line: 「加速 0.093 m/s · 沿迹 (T)」. */
export function manSpeedLine(man: ManDirInput, t: TFn, sense: ManSpeedSense): string {
  const dv = fmtDvWithSense(manDvValue(man), sense, t)
  const axis = manDirectionAxisPhrase(man, t)
  if (axis && axis !== '—') return `${dv} · ${axis}`
  return dv
}

/** @deprecated Prefer manSpeedLine + manDirectionAxisPhrase. Kept as the combined speed line without a sense. */
export function manDirectionPhrase(man: ManDirInput, t: TFn, sense: ManSpeedSense = null): string {
  return manSpeedLine(man, t, sense)
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
  if (/EME2000|ICRF|J2000|ECI|TEME/.test(f) && !/NTW/.test(f)) {
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
