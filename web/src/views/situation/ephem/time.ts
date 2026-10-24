import type { Vec3 } from './types'

const MS_PER_DAY = 86400000
/** Unix 纪元对应的儒略日 */
const UNIX_EPOCH_JD = 2440587.5
/** WGS84 椭球参数（km） */
const WGS84_A = 6378.137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
/** 地球自转角速度 rad/s */
export const EARTH_OMEGA = 7.292115e-5

/**
 * 解析 ITC 时间戳：`YYYYDDDHHMMSS.sss`（年 4 位 + 年积日 3 位 + 时分秒）。
 * 例：2026294100442.000 → 2026 年第 294 天 10:04:42 UTC。
 */
export function parseItcEpoch(tok: string): number | null {
  if (!tok) return null
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const year = Number(m[1])
  const doy = Number(m[2])
  const hh = Number(m[3])
  const mm = Number(m[4])
  const ss = Number(m[5])
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || !(ss < 61)) return null
  const dayStart = Date.UTC(year, 0, 1) + (doy - 1) * MS_PER_DAY
  return dayStart + Math.round(((hh * 60 + mm) * 60 + ss) * 1000)
}

/**
 * 解析 ISO 风格时间，兼容：
 * `2023-11-06T02:09:42.000000Z`、`2023-11-06 02:09:42`、末尾无 Z、带 ±hh:mm 偏移。
 */
export function parseIso(tok: string): number | null {
  if (!tok) return null
  const s = tok.trim().replace(/\s+/g, ' ')
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      s
    )
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hh = Number(m[4])
  const mm = Number(m[5])
  const ss = m[6] ? Number(m[6]) : 0
  const frac = m[7] ? Number('0.' + m[7]) : 0
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 60) return null
  let ms = Date.UTC(year, month - 1, day, hh, mm, ss, Math.round(frac * 1000))
  const tz = m[8]
  if (tz && tz !== 'Z' && tz !== 'z') {
    const sign = tz[0] === '-' ? -1 : 1
    const body = tz.slice(1).replace(':', '')
    const offMin = Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4))
    ms -= sign * offMin * 60000
  }
  return Number.isFinite(ms) ? ms : null
}

/** 儒略日（UTC） */
export function julianDate(epochMs: number): number {
  return epochMs / MS_PER_DAY + UNIX_EPOCH_JD
}

/**
 * IAU-82 GMST（格林尼治平恒星时），返回弧度，范围 [0, 2π)。
 */
export function gmstRad(epochMs: number): number {
  const jd = julianDate(epochMs)
  const tu = (jd - 2451545.0) / 36525
  // 以「秒」为单位的 GMST（0h UT1 起算的公式 + 日内秒）
  const secOfDay =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * tu +
    0.093104 * tu * tu -
    6.2e-6 * tu * tu * tu
  const twoPi = Math.PI * 2
  // 1 秒时间 = 2π/86400 rad
  const rad = (secOfDay * Math.PI) / 43200
  return ((rad % twoPi) + twoPi) % twoPi
}

/** ECI → ECEF（仅绕 Z 轴旋转 GMST，忽略极移与章动） */
export function eciToEcef(r: Vec3, epochMs: number): Vec3 {
  const th = gmstRad(epochMs)
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]]
}

/**
 * ECEF → 大地坐标（WGS84）。lat/lon 单位为度，alt 单位为 km。
 */
export function ecefToGeodetic(r: Vec3): { lat: number; lon: number; alt: number } {
  const x = r[0]
  const y = r[1]
  const z = r[2]
  const p = Math.hypot(x, y)
  const lon = (Math.atan2(y, x) * 180) / Math.PI
  if (p < 1e-9) {
    // 极点附近：纬度取 ±90°
    const lat = z >= 0 ? 90 : -90
    const alt = Math.abs(z) - WGS84_A * (1 - WGS84_F)
    return { lat, lon: 0, alt }
  }
  let lat = Math.atan2(z, p * (1 - WGS84_E2))
  let alt = 0
  for (let i = 0; i < 8; i++) {
    const sinLat = Math.sin(lat)
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
    alt = p / Math.cos(lat) - n
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + alt)))
  }
  const sinLat = Math.sin(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  alt = p / Math.cos(lat) - n
  return { lat: (lat * 180) / Math.PI, lon, alt }
}
