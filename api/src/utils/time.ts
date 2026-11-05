/** 时间工具：Space-Track 报文按 UTC 解析；入库 DATETIME 沿用数据库会话本地时间（生产 +08） */

const MS_PER_DAY = 86_400_000

/** Date → 'YYYY-MM-DD HH:mm:ss.SSS'（UTC，毫秒精度） */
export function fmtUtcMs(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 23).replace('T', ' ')
}

/**
 * Date → 'YYYY-MM-DD HH:mm:ss'（数据库会话本地时间）。
 * 与 pool 默认时区（不设 timezone）写入 DATETIME 的口径一致，可直接写 datetime 列。
 */
export function fmtLocalDateTime(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/**
 * 解析时间字符串为 Date（UTC）。
 * 兼容：'2026-09-19 04:16:48.000000'、'2026-09-20T20:03:29.529'、带 Z 或 ±hhmm 偏移。
 * 无时区标记的按 UTC 处理（Space-Track 的口径）。
 */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null
  const str = String(s).trim().replace(/\s+/g, ' ')
  if (!str) return null
  const m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      str
    )
  if (!m) {
    const d = new Date(str)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0,
    m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
  )
  let out = ms
  const tz = m[8]
  if (tz && tz !== 'Z' && tz !== 'z') {
    const sign = tz[0] === '-' ? -1 : 1
    const body = tz.slice(1).replace(':', '')
    out -= sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4))) * 60_000
  }
  return new Date(out)
}

export { MS_PER_DAY }
