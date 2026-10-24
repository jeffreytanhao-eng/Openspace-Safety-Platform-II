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

/** 找到与给定历元最接近的状态下标 */
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
 * 解析 CCSDS OEM（KVN）文本。
 *
 * - META_START / META_STOP 段读取 REF_FRAME、TIME_SYSTEM、OBJECT_NAME、OBJECT_ID；
 * - 数据行为 `ISO时间 x y z vx vy vz`；
 * - COVARIANCE_START / COVARIANCE_STOP 内 `EPOCH =` 起一段，随后是 21 个下三角值，
 *   按 CCSDS 惯例位于 RTN(=UVW) 坐标系，需旋转到 ECI。
 */
export function parseOem(text: string): ParseResult {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const states: EphemState[] = []

  let section: 'none' | 'meta' | 'cov' = 'none'
  let refFrame: EphemFrame = 'EME2000'
  let timeSystem = 'UTC'
  let objectName = ''
  let objectId = ''
  let covEpoch: number | null = null
  let covNums: number[] = []
  let error: { line: number; msg: string } | null = null

  const attachCov = () => {
    if (covEpoch === null || covNums.length === 0) {
      covNums = []
      covEpoch = null
      return
    }
    if (covNums.length < 21) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 只有 ${covNums.length} 个值（应为 21 个），已忽略`)
      covNums = []
      covEpoch = null
      return
    }
    const idx = nearestIndex(states, covEpoch)
    if (idx < 0 || Math.abs(states[idx].t - covEpoch) > 60000) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 附近 60s 内无状态点，已忽略`)
    } else {
      const st = states[idx]
      st.cov = uvwCovToEci(lowerTriangleToCov(covNums.slice(0, 21)), st.r, st.v)
    }
    covNums = []
    covEpoch = null
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
    if (upper.startsWith('COVARIANCE_START')) {
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

    // 键值行
    const eq = line.indexOf('=')
    if (eq > 0 && !NUM_RE.test(line.slice(0, eq).trim())) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()
      if (key === 'EPOCH' && section === 'cov') {
        attachCov()
        covEpoch = parseIso(value)
        if (covEpoch === null) warnings.push(`第 ${ln} 行协方差 EPOCH 无法解析：${value}`)
        continue
      }
      if (section === 'meta' || section === 'none') {
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
      }
      continue
    }

    const tokens = line.split(/\s+/)
    if (section === 'cov') {
      // 协方差数值行
      if (tokens.every((c) => NUM_RE.test(c))) {
        for (const c of tokens) covNums.push(Number(c))
      }
      continue
    }

    // 数据行：第一列必须是 ISO 时间
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
    const prev = states.length ? states[states.length - 1] : null
    if (prev && t <= prev.t) {
      error = { line: ln, msg: `时间戳非递增：第 ${ln} 行` }
      break
    }
    const r: Vec3 = [Number(comps[0]), Number(comps[1]), Number(comps[2])]
    const v: Vec3 = [Number(comps[3]), Number(comps[4]), Number(comps[5])]
    states.push({ t, r, v })
  }
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

  const first = states[0]
  const last = states[states.length - 1]
  const noradMatch = /\b(\d{5})\b/.exec(objectId)
  const norad = noradMatch ? Number(noradMatch[1]) : 0

  const set: EphemSet = {
    id: `${norad || 'X'}-${first.t}`,
    norad,
    name: objectName || objectId || 'UNKNOWN',
    format: 'oem',
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
