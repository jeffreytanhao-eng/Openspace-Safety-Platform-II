import type { EphemFrame, EphemSet, EphemState, ParseResult, Vec3 } from './types'
import { parseIso } from './time'
import { frameToEci, uvwCovToEci } from './frames'

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const FRAME_SET: EphemFrame[] = ['UVW', 'EME2000', 'ICRF', 'ITRF', 'TEME']

/** CCSDS 下三角（行主序）：C11, C21, C22, C31, ... 共 21 个数 */
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

function medianStep(states: EphemState[]): number {
  if (states.length < 2) return 0
  const diffs: number[] = []
  for (let i = 1; i < states.length; i++) diffs.push((states[i].t - states[i - 1].t) / 1000)
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

function nearestIndex(states: EphemState[], t: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < states.length; i++) {
    const d = Math.abs(states[i].t - t)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 解析 CCSDS OCM（B 版，KVN）文本。
 *
 * 轨迹数据兼容两种写法：
 * (a) 每行 7 列数字：`ISO时间 x y z vx vy vz`；
 * (b) 键值组：`EPOCH = <iso>` 后跟 `X/Y/Z/X_DOT/Y_DOT/Z_DOT = ...`。
 *
 * 协方差段 `COVARIANCE_START ... COVARIANCE_STOP` 内 `EPOCH =` 起 21 个下三角值，
 * 默认按 RTN(=UVW) 处理并旋转到 ECI（若 COV_REF_FRAME 明确为惯性系则不旋转）。
 */
export function parseOcm(text: string): ParseResult {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const states: EphemState[] = []

  let section: 'none' | 'meta' | 'traj' | 'cov' = 'none'
  let refFrame: EphemFrame = 'EME2000'
  let timeSystem = 'UTC'
  let objectName = ''
  let objectId = ''
  let covFrame: string = 'RTN'

  let covEpoch: number | null = null
  let covNums: number[] = []
  let error: { line: number; msg: string } | null = null

  /** 键值组写法中的待完成状态 */
  let pending: { t: number; vals: Partial<Record<string, number>>; line: number } | null = null

  const pushState = (t: number, r: Vec3, v: Vec3, line: number): boolean => {
    const prev = states.length ? states[states.length - 1] : null
    if (prev && t <= prev.t) {
      error = { line, msg: `时间戳非递增：第 ${line} 行` }
      return false
    }
    states.push({ t, r, v })
    return true
  }

  const flushPending = () => {
    if (!pending) return
    const { t, vals, line } = pending
    pending = null
    const keys = ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT']
    if (!keys.every((k) => typeof vals[k] === 'number')) {
      warnings.push(`第 ${line} 行的键值状态缺少分量，已忽略`)
      return
    }
    pushState(
      t,
      [vals.X as number, vals.Y as number, vals.Z as number],
      [vals.X_DOT as number, vals.Y_DOT as number, vals.Z_DOT as number],
      line
    )
  }

  const attachCov = () => {
    if (covEpoch === null || covNums.length === 0) {
      covEpoch = null
      covNums = []
      return
    }
    if (covNums.length < 21) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 只有 ${covNums.length} 个值（应为 21 个），已忽略`)
      covEpoch = null
      covNums = []
      return
    }
    const idx = nearestIndex(states, covEpoch)
    if (idx < 0 || Math.abs(states[idx].t - covEpoch) > 60000) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 附近 60s 内无状态点，已忽略`)
    } else {
      const st = states[idx]
      const cov = lowerTriangleToCov(covNums.slice(0, 21))
      const isRtn = /RTN|UVW|RSW/i.test(covFrame)
      st.cov = isRtn ? uvwCovToEci(cov, st.r, st.v) : cov
    }
    covEpoch = null
    covNums = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const ln = i + 1
    const upper = line.toUpperCase()

    if (upper === 'META_START') {
      section = 'meta'
      continue
    }
    if (upper === 'META_STOP') {
      section = 'none'
      continue
    }
    if (upper.startsWith('TRAJ_START') || upper.startsWith('TRAJ_BLK_START')) {
      section = 'traj'
      continue
    }
    if (upper.startsWith('TRAJ_STOP') || upper.startsWith('TRAJ_BLK_STOP')) {
      flushPending()
      section = 'none'
      continue
    }
    if (upper.startsWith('COVARIANCE_START')) {
      flushPending()
      attachCov()
      section = 'cov'
      continue
    }
    if (upper.startsWith('COVARIANCE_STOP')) {
      attachCov()
      section = 'none'
      continue
    }
    if (upper.startsWith('COMMENT')) continue

    const eq = line.indexOf('=')
    if (eq > 0 && !NUM_RE.test(line.slice(0, eq).trim())) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()

      if (section === 'cov') {
        if (key === 'EPOCH') {
          attachCov()
          covEpoch = parseIso(value)
          if (covEpoch === null) warnings.push(`第 ${ln} 行协方差 EPOCH 无法解析：${value}`)
        } else if (key === 'COV_REF_FRAME') {
          covFrame = value
        } else if (NUM_RE.test(value)) {
          covNums.push(Number(value))
        }
        continue
      }

      if (key === 'EPOCH' && section === 'traj') {
        flushPending()
        const t = parseIso(value)
        if (t === null) warnings.push(`第 ${ln} 行 EPOCH 无法解析：${value}`)
        else pending = { t, vals: {}, line: ln }
        continue
      }

      if (section === 'traj' && /^[XYZ](_DOT)?$/.test(key) && NUM_RE.test(value)) {
        if (!pending) pending = { t: NaN, vals: {}, line: ln }
        pending.vals[key] = Number(value)
        continue
      }

      if (key === 'REF_FRAME') {
        const f = value.toUpperCase() as EphemFrame
        if (FRAME_SET.indexOf(f) >= 0) refFrame = f
        else warnings.push(`未识别的 REF_FRAME=${value}，按 EME2000 处理`)
      } else if (key === 'TIME_SYSTEM') {
        timeSystem = value.toUpperCase()
      } else if (key === 'OBJECT_NAME') {
        objectName = value
      } else if (key === 'OBJECT_ID') {
        objectId = value
      }
      continue
    }

    if (section === 'cov') {
      const tokens = line.split(/\s+/)
      if (tokens.every((c) => NUM_RE.test(c))) {
        for (const c of tokens) covNums.push(Number(c))
      }
      continue
    }

    // 轨迹数值行：第一列为 ISO 时间
    const tokens = line.split(/\s+/)
    const t = parseIso(tokens[0])
    if (t === null) continue
    if (tokens.length < 7) {
      error = { line: ln, msg: `第 ${ln} 行状态分量不足 7 列（时间 + 位置 + 速度）` }
      break
    }
    const comps = tokens.slice(1, 7)
    if (!comps.every((c) => NUM_RE.test(c))) {
      error = { line: ln, msg: `第 ${ln} 行存在非法数字分量` }
      break
    }
    flushPending()
    const ok = pushState(
      t,
      [Number(comps[0]), Number(comps[1]), Number(comps[2])],
      [Number(comps[3]), Number(comps[4]), Number(comps[5])],
      ln
    )
    if (!ok) break
  }
  flushPending()
  attachCov()

  if (error) return { ok: false, error: error.msg, line: error.line, warnings }
  if (states.length < 2) {
    return { ok: false, error: '有效状态点少于 2 个，无法用于插值', line: 1, warnings }
  }
  if (timeSystem && timeSystem !== 'UTC') {
    warnings.push(`TIME_SYSTEM=${timeSystem}，当前按 UTC 近似处理`)
  }

  let usedFrame = refFrame
  if (refFrame === 'ITRF') {
    for (const st of states) {
      const conv = frameToEci('ITRF', st.r, st.v, st.t)
      st.r = conv.r
      st.v = conv.v
    }
    warnings.push('状态已从 ITRF 旋转到 ECI（仅 GMST 绕 Z 轴），协方差未旋转')
    usedFrame = 'EME2000'
  }
  if (/RTN|UVW|RSW/i.test(covFrame)) {
    warnings.push('协方差按 RTN(UVW) 处理，已旋转到 ECI')
  }

  const first = states[0]
  const last = states[states.length - 1]
  const noradMatch = /\b(\d{5})\b/.exec(objectId)
  const norad = noradMatch ? Number(noradMatch[1]) : 0

  const set: EphemSet = {
    id: `${norad || 'X'}-${first.t}`,
    norad,
    name: objectName || objectId || 'UNKNOWN',
    format: 'ocm',
    frame: usedFrame,
    source: 'upload',
    createdAt: Date.now(),
    start: first.t,
    stop: last.t,
    stepSec: medianStep(states),
    states,
    objectId: objectId || undefined,
    warnings
  }

  return { ok: true, set, warnings }
}
