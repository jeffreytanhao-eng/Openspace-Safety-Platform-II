/**
 * OCM 星历 PV 序列解析（G2 精度对比，移植自 web/src/views/situation/ephem/parseOcm.ts
 * 的轨迹段逻辑，去掉协方差 / 机动 / 告警细节，只产出 J2000 位置速度序列）。
 *
 * 兼容两种轨迹写法：
 * (a) 7 列行：`ISO时间 x y z vx vy vz`（单位 km、km/s，REF_FRAME=ITRF2000 时旋转到 ECI）；
 * (b) 键值组：`EPOCH = <iso>` 后跟 `X/Y/Z/X_DOT/Y_DOT/Z_DOT = ...`。
 *
 * ITRF/ECEF → ECI 仅做 GMST 绕 Z 旋转并补 ω×r 牵连速度（与前端同口径，
 * 忽略极移与章动；对 G2 的 km 级残差足够）。
 */

export interface PvState {
  /** Unix ms */
  t: number
  /** ECI(J2000 近似) 位置 km */
  r: [number, number, number]
  /** ECI 速度 km/s */
  v: [number, number, number]
}

export interface OcmPvParsed {
  states: PvState[]
  objectName: string
  objectId: string
  /** 归一化后的参考系（ITRF 已旋转到 ECI） */
  frame: 'EME2000' | 'OTHER'
  warnings: string[]
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** 解析 ISO 风格时间（2023-11-06T02:09:42.000000Z / 带空格 / 无 Z / 带偏移） */
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

const MS_PER_DAY = 86400000

/** IAU-82 GMST（弧度，[0, 2π)） */
export function gmstRad(epochMs: number): number {
  const jd = epochMs / MS_PER_DAY + 2440587.5
  const tu = (jd - 2451545.0) / 36525
  const secOfDay =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * tu +
    0.093104 * tu * tu -
    6.2e-6 * tu * tu * tu
  const twoPi = Math.PI * 2
  const rad = (secOfDay * Math.PI) / 43200
  return ((rad % twoPi) + twoPi) % twoPi
}

const EARTH_OMEGA = 7.292115e-5

/** ITRF/ECEF → ECI：GMST 绕 Z 旋转 + ω×r 牵连速度 */
export function itrfToEci(r: [number, number, number], v: [number, number, number], epochMs: number) {
  const th = gmstRad(epochMs)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const re: [number, number, number] = [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]]
  const ve: [number, number, number] = [
    c * v[0] - s * v[1] - EARTH_OMEGA * re[1],
    s * v[0] + c * v[1] + EARTH_OMEGA * re[0],
    v[2]
  ]
  return { r: re, v: ve }
}

/**
 * 解析 OCM 文本 → PV 序列（ECI）。
 * 无有效轨迹段或点数 < 2 时返回 null（由调用方给出业务提示）。
 */
export function parseOcmPv(text: string): OcmPvParsed | null {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const states: PvState[] = []

  let section: 'none' | 'traj' = 'none'
  let refFrame = 'EME2000'
  let objectName = ''
  let objectId = ''
  let pending: { t: number; vals: Partial<Record<string, number>> } | null = null

  const flushPending = () => {
    if (!pending) return
    const { t, vals } = pending
    pending = null
    const keys = ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT'] as const
    if (!keys.every((k) => typeof vals[k] === 'number')) return
    states.push({
      t,
      r: [vals.X as number, vals.Y as number, vals.Z as number],
      v: [vals.X_DOT as number, vals.Y_DOT as number, vals.Z_DOT as number]
    })
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const upper = line.toUpperCase()

    if (upper.startsWith('TRAJ_START') || upper.startsWith('TRAJ_BLK_START')) {
      section = 'traj'
      continue
    }
    if (upper.startsWith('TRAJ_STOP') || upper.startsWith('TRAJ_BLK_STOP')) {
      flushPending()
      section = 'none'
      continue
    }
    if (upper.startsWith('COMMENT') || upper === 'META_START' || upper === 'META_STOP') continue

    const eq = line.indexOf('=')
    if (eq > 0 && !NUM_RE.test(line.slice(0, eq).trim())) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()
      if (key === 'EPOCH' && section === 'traj') {
        flushPending()
        const t = parseIso(value)
        if (t !== null) pending = { t, vals: {} }
        continue
      }
      if (section === 'traj' && /^[XYZ](_DOT)?$/.test(key) && NUM_RE.test(value)) {
        if (!pending) pending = { t: NaN, vals: {} }
        pending.vals[key as 'X' | 'Y' | 'Z' | 'X_DOT' | 'Y_DOT' | 'Z_DOT'] = Number(value)
        continue
      }
      if (key === 'OBJECT_NAME') objectName = value
      else if (key === 'OBJECT_ID' || key === 'OBJECT_DESIGNATOR') {
        if (!objectId) objectId = value
      } else if (key === 'TRAJ_REF_FRAME' || key === 'REF_FRAME') {
        if (value.toUpperCase().startsWith('ITRF')) refFrame = 'ITRF'
        else if (/EME2000|ICRF|GCRF|TEME/i.test(value)) refFrame = 'EME2000'
      }
      continue
    }

    // 轨迹数值行：仅在 TRAJ 段内；第一列为 ISO 时间
    if (section !== 'traj') continue
    const tokens = line.split(/\s+/)
    const t = parseIso(tokens[0])
    if (t === null) continue
    if (tokens.length < 7) continue
    const comps = tokens.slice(1, 7)
    if (!comps.every((c) => NUM_RE.test(c))) continue
    flushPending()
    states.push({
      t,
      r: [Number(comps[0]), Number(comps[1]), Number(comps[2])],
      v: [Number(comps[3]), Number(comps[4]), Number(comps[5])]
    })
  }
  flushPending()

  if (states.length < 2) return null
  // 时间非递增的点剔除（文件级容错，不用中断）
  const clean: PvState[] = []
  for (const st of states) {
    const prev = clean.length ? clean[clean.length - 1] : null
    if (prev && st.t <= prev.t) continue
    clean.push(st)
  }
  if (clean.length < 2) return null

  let frame: 'EME2000' | 'OTHER' = 'EME2000'
  if (refFrame === 'ITRF') {
    for (const st of clean) {
      const conv = itrfToEci(st.r, st.v, st.t)
      st.r = conv.r
      st.v = conv.v
    }
    warnings.push('OCM 状态已从 ITRF 旋转到 ECI（仅 GMST 绕 Z 轴）')
  } else {
    warnings.push('OCM 参考系按惯性系（EME2000 近似）处理')
  }

  return { states: clean, objectName, objectId, frame, warnings }
}

/** 时刻插值：线性插位置 + 速度（t 在序列范围外返回 null） */
export function pvAt(states: PvState[], tMs: number): PvState | null {
  if (tMs < states[0].t || tMs > states[states.length - 1].t) return null
  // 二分找右边界
  let lo = 0
  let hi = states.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (states[mid].t < tMs) lo = mid
    else hi = mid
  }
  const a = states[lo]
  const b = states[hi]
  if (tMs === a.t) return a
  const f = (tMs - a.t) / (b.t - a.t)
  return {
    t: tMs,
    r: [a.r[0] + f * (b.r[0] - a.r[0]), a.r[1] + f * (b.r[1] - a.r[1]), a.r[2] + f * (b.r[2] - a.r[2])],
    v: [a.v[0] + f * (b.v[0] - a.v[0]), a.v[1] + f * (b.v[1] - a.v[1]), a.v[2] + f * (b.v[2] - a.v[2])]
  }
}
