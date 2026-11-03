/** 轨道要素换算与 TLE 构造（AOE 只给 OMM 字段时，用它补出两行根数） */

export const EARTH_MU = 398600.4418 // km^3/s^2
export const EARTH_EQ_RADIUS_KM = 6378.137

/** 平均运动（rev/day）→ 周期（分钟） */
export function periodMinutes(meanMotionRevPerDay: number): number {
  return meanMotionRevPerDay > 0 ? 1440 / meanMotionRevPerDay : 0
}

/** 平均运动（rev/day）→ 半长轴（km） */
export function semiMajorAxisKm(meanMotionRevPerDay: number): number {
  if (!(meanMotionRevPerDay > 0)) return 0
  const n = (meanMotionRevPerDay * Math.PI * 2) / 86400 // rad/s
  return Math.cbrt(EARTH_MU / (n * n))
}

/** 近/远地点高度（km，相对赤道半径） */
export function apsisKm(smaKm: number, ecc: number): { apogee: number; perigee: number } {
  return {
    apogee: smaKm * (1 + ecc) - EARTH_EQ_RADIUS_KM,
    perigee: smaKm * (1 - ecc) - EARTH_EQ_RADIUS_KM
  }
}

/** 轨道类型（与现有 sat_tle.regime 口径一致：LEO / MEO / GEO / HEO） */
export function regimeOf(smaKm: number, ecc: number): string {
  if (!(smaKm > 0)) return ''
  if (ecc > 0.25) return 'HEO'
  if (smaKm < 8000) return 'LEO'
  if (smaKm < 40000) return 'MEO'
  if (smaKm < 50000) return 'GEO'
  return 'HEO'
}

/** 归一化处理：'0.0001234' / 1.234e-4 / number 都可 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 角度归一到 [0, 360)（GP 源会给 >360 的累积角） */
function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function checksum(line: string): number {
  let s = 0
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') s += Number(ch)
    else if (ch === '-') s += 1
  }
  return s % 10
}

/** TLE 指数记数法字段（8 字符），如 8.0392e-5 → ' 80392-4' */
function formatExp(v: number): string {
  const sign = v < 0 ? '-' : ' '
  const a = Math.abs(v)
  if (!(a > 0)) return `${sign}00000+0`
  let exp = Math.floor(Math.log10(a)) + 1
  let mant = Math.round((a / 10 ** exp) * 100000)
  if (mant >= 100000) {
    mant = Math.round(mant / 10)
    exp += 1
  }
  const m = String(mant).padStart(5, '0')
  return `${sign}${m}${exp < 0 ? '-' : '+'}${Math.abs(exp)}`
}

/** 一阶导数（10 字符），如 -1.2345e-5 → '-.00001235' */
function formatNdot(v: number): string {
  const a = Math.abs(v)
  const body = a.toFixed(8).slice(1)
  return `${v < 0 ? '-' : ' '}${body}`.slice(0, 10).padEnd(10, '0')
}

export interface TleElements {
  noradId: number
  intlDesig?: string
  /** UTC */
  epoch: Date
  meanMotion: number
  eccentricity: number
  inclination: number
  raan: number
  argPerigee: number
  meanAnomaly: number
  bstar?: number
  meanMotionDot?: number
  revNum?: number
  classification?: string
}

/** 由根数生成两行 TLE（用于 AOE 只返回 OMM 字段的场景） */
export function buildTle(el: TleElements): { line1: string; line2: string } {
  const norad = String(Math.trunc(el.noradId)).padStart(5, '0')
  const yy = String(el.epoch.getUTCFullYear() % 100).padStart(2, '0')
  const startOfYear = Date.UTC(el.epoch.getUTCFullYear(), 0, 1)
  const doy = (el.epoch.getTime() - startOfYear) / 86_400_000 + 1
  const doyInt = Math.floor(doy)
  const frac = String((doy - doyInt).toFixed(8)).slice(2)
  const epochField = `${yy}${String(doyInt).padStart(3, '0')}.${frac}`

  const intl = String(el.intlDesig ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .padEnd(8, ' ')
    .slice(0, 8)
  const cls = (el.classification || 'U').slice(0, 1)

  const l1Body =
    `1 ${norad}${cls} ${intl} ${epochField} ` +
    `${formatNdot(el.meanMotionDot ?? 0)} ` +
    `${formatExp(0)} ` +
    `${formatExp(el.bstar ?? 0)} ` +
    `0 ` +
    `${String((el.revNum ?? 0) % 10000).padStart(4, '0')}`
  const line1 = l1Body + String(checksum(l1Body))

  const eccField = String(Math.round(Math.max(0, Math.min(0.9999999, el.eccentricity)) * 1e7))
    .padStart(7, '0')
    .slice(0, 7)
  const l2Body =
    `2 ${norad} ` +
    `${el.inclination.toFixed(4).padStart(8, ' ')} ` +
    `${norm360(el.raan).toFixed(4).padStart(8, ' ')} ` +
    `${eccField} ` +
    `${norm360(el.argPerigee).toFixed(4).padStart(8, ' ')} ` +
    `${norm360(el.meanAnomaly).toFixed(4).padStart(8, ' ')} ` +
    `${el.meanMotion.toFixed(8).padStart(11, ' ')}` +
    `${String((el.revNum ?? 0) % 100000).padStart(5, '0')}`
  const line2 = l2Body + String(checksum(l2Body))

  return { line1, line2 }
}
