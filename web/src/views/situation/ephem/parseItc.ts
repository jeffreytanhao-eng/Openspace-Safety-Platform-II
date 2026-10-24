import type { EphemFrame, EphemSet, EphemState, ParseResult, Vec3 } from './types'
import { parseItcEpoch, parseIso } from './time'
import { uvwCovToEci } from './frames'

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
/** ITC 历元：年4 + 年积日3 + 时分秒2/2/2 = 13 位数字，可带小数秒 */
const EPOCH_RE = /^\d{13}(?:\.\d+)?$/

/** 按「行主序下三角」还原 6x6 对称矩阵：C11, C21, C22, C31, … */
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

/** 按「行主序上三角」还原：C11, C12 … C16, C22, …（部分衍生工具使用） */
function upperTriangleToCov(nums: number[]): Float64Array {
  const cov = new Float64Array(36)
  let k = 0
  for (let i = 0; i < 6; i++) {
    for (let j = i; j < 6; j++) {
      const v = nums[k++]
      cov[i * 6 + j] = v
      cov[j * 6 + i] = v
    }
  }
  return cov
}

/**
 * 解析 21 个协方差值。
 * Starlink 实测文件为行主序下三角（C11,C21,C22,…，按此还原可保证正定）；
 * 若还原后出现负方差，则退回上三角顺序，避免不同生产工具造成的偏差。
 */
function buildCov(nums: number[], warnings: string[], line: number): Float64Array {
  const lower = lowerTriangleToCov(nums)
  if (lower[0] >= 0 && lower[7] >= 0 && lower[14] >= 0) return lower
  const upper = upperTriangleToCov(nums)
  if (upper[0] >= 0 && upper[7] >= 0 && upper[14] >= 0) {
    warnings.push(`第 ${line} 行协方差按上三角顺序解析（检测到下三角出现负方差）`)
    return upper
  }
  warnings.push(`第 ${line} 行协方差对角线出现负值，数据可能异常`)
  return lower
}

/** 相邻状态间隔中位数（秒） */
function medianStep(states: EphemState[]): number {
  if (states.length < 2) return 0
  const diffs: number[] = []
  for (let i = 1; i < states.length; i++) diffs.push((states[i].t - states[i - 1].t) / 1000)
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

/**
 * 解析 ITC（Starlink 公开星历）文本。
 *
 * 文件结构：
 * ```
 * created:...            ephemeris_start:... ephemeris_stop:... step_size:60
 * UVW
 * 2026294100442.000  x y z vx vy vz
 * (6x6 对称矩阵的 21 个独立分量，可跨多行；实测文件为行主序下三角
 *  C11,C21,C22,C31,…，即 (0,0),(1,0),(1,1),(2,0)…)
 * ```
 * 状态向量本身已是惯性系位置/速度，`UVW` 只描述协方差所在坐标系，
 * 因此协方差需用 uvwCovToEci 旋转到 ECI。
 */
export function parseItc(text: string, hint?: { name?: string; norad?: number }): ParseResult {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const states: EphemState[] = []

  let startMs: number | null = null
  let stopMs: number | null = null
  let stepSecHeader = 0
  let covFrame: EphemFrame = 'UVW'
  let timeErrorLine = 0
  let timeErrorMsg = ''

  interface Acc {
    t: number
    r: Vec3
    v: Vec3
    nums: number[]
    line: number
  }
  let acc: Acc | null = null

  const flush = () => {
    if (!acc) return
    const prev = states.length ? states[states.length - 1] : null
    if (prev && acc.t <= prev.t) {
      if (timeErrorLine === 0) {
        timeErrorLine = acc.line
        timeErrorMsg = `时间戳非递增：第 ${acc.line} 行不晚于上一状态`
      }
      acc = null
      return
    }
    const st: EphemState = { t: acc.t, r: acc.r, v: acc.v }
    if (acc.nums.length >= 21) {
      const cov = buildCov(acc.nums.slice(0, 21), warnings, acc.line)
      st.cov = covFrame === 'UVW' ? uvwCovToEci(cov, st.r, st.v) : cov
    } else if (acc.nums.length > 0) {
      warnings.push(`第 ${acc.line} 行状态的协方差仅 ${acc.nums.length} 个值（应为 21 个），已忽略`)
    }
    states.push(st)
    acc = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const ln = i + 1
    const lower = line.toLowerCase()

    if (lower.startsWith('ephemeris_start')) {
      const times = line.match(/\d{4}-\d{1,2}-\d{1,2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g)
      if (times && times[0]) startMs = parseIso(times[0])
      if (times && times[1]) stopMs = parseIso(times[1])
      const mStep = /step_size\s*:\s*([\d.]+)/i.exec(line)
      if (mStep) stepSecHeader = Number(mStep[1])
      continue
    }
    if (lower.startsWith('created') || lower.startsWith('ephemeris_source')) continue

    const upper = line.toUpperCase()
    if (
      upper === 'UVW' ||
      upper === 'ECI' ||
      upper === 'EME2000' ||
      upper === 'ICRF' ||
      upper === 'ITRF' ||
      upper === 'TEME'
    ) {
      // 该行描述协方差所在坐标系（样本为 UVW）
      covFrame = upper === 'ECI' ? 'EME2000' : (upper as EphemFrame)
      continue
    }

    const tokens = line.split(/\s+/)
    if (EPOCH_RE.test(tokens[0])) {
      // 新的状态行
      flush()
      if (tokens.length < 7) {
        return {
          ok: false,
          error: `第 ${ln} 行状态分量不足 7 列（历元 + 位置 + 速度）`,
          line: ln,
          warnings
        }
      }
      const t = parseItcEpoch(tokens[0])
      if (t === null) {
        return { ok: false, error: `第 ${ln} 行历元无法解析：${tokens[0]}`, line: ln, warnings }
      }
      const comps = tokens.slice(1, 7)
      if (!comps.every((c) => NUM_RE.test(c))) {
        return { ok: false, error: `第 ${ln} 行存在非法数字分量`, line: ln, warnings }
      }
      acc = {
        t,
        r: [Number(comps[0]), Number(comps[1]), Number(comps[2])],
        v: [Number(comps[3]), Number(comps[4]), Number(comps[5])],
        nums: [],
        line: ln
      }
      continue
    }

    if (tokens.every((c) => NUM_RE.test(c))) {
      // 协方差数据（每个状态 21 个数，可跨多行）
      if (!acc) {
        warnings.push(`第 ${ln} 行的数字没有归属的状态，已忽略`)
        continue
      }
      for (const c of tokens) acc.nums.push(Number(c))
      continue
    }
    // 其它未知行直接忽略
  }
  flush()

  if (timeErrorLine > 0) {
    return { ok: false, error: timeErrorMsg, line: timeErrorLine, warnings }
  }
  if (states.length < 2) {
    return { ok: false, error: '有效状态点少于 2 个，无法用于插值', line: 1, warnings }
  }

  if (covFrame !== 'UVW' && covFrame !== 'EME2000' && covFrame !== 'ICRF') {
    warnings.push(`协方差坐标系为 ${covFrame}，未做额外旋转（按惯性系处理）`)
  } else if (covFrame === 'UVW') {
    warnings.push('协方差原始坐标系为 UVW（RTN），已旋转到 ECI')
  }

  const first = states[0]
  const last = states[states.length - 1]
  const start = startMs ?? first.t
  const stop = stopMs ?? last.t
  if (startMs !== null && Math.abs(startMs - first.t) > 1000) {
    warnings.push('头部 ephemeris_start 与首个状态历元不一致，以状态数据为准')
  }
  const stepSec = stepSecHeader > 0 ? stepSecHeader : medianStep(states)
  const norad = hint?.norad ?? 0
  const name = (hint?.name ?? '').trim() || 'UNKNOWN'

  const set: EphemSet = {
    id: `${norad || 'X'}-${first.t}`,
    norad,
    name,
    format: 'itc',
    // 状态向量已是惯性系，统一标记为 EME2000
    frame: 'EME2000',
    source: 'upload',
    createdAt: Date.now(),
    start,
    stop,
    stepSec,
    states,
    warnings
  }

  return { ok: true, set, warnings }
}
