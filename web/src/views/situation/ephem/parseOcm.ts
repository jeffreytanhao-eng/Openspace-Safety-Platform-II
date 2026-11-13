import type { EphemFrame, EphemManSegment, EphemSet, EphemState, ParseResult, Vec3 } from './types'
import { parseIso } from './time'
import { frameToEci, itrfCovToEci, uvwCovToEci } from './frames'

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

/** Row-major 6×6 (36 terms); symmetrized. */
function fullMatrixToCov(nums: number[]): Float64Array {
  const cov = new Float64Array(36)
  for (let i = 0; i < 36; i++) cov[i] = nums[i]
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < i; j++) {
      const a = cov[i * 6 + j]
      const b = cov[j * 6 + i]
      const v = Number.isFinite(a) && Number.isFinite(b) ? 0.5 * (a + b) : Number.isFinite(a) ? a : b
      cov[i * 6 + j] = v
      cov[j * 6 + i] = v
    }
  }
  return cov
}

function numsToCov(nums: number[], ordering: 'LTM' | 'FULL' | ''): Float64Array | null {
  if (ordering === 'FULL' || (ordering !== 'LTM' && nums.length >= 36)) {
    if (nums.length < 36) return null
    return fullMatrixToCov(nums.slice(0, 36))
  }
  if (nums.length < 21) return null
  return lowerTriangleToCov(nums.slice(0, 21))
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
 * 协方差段 `COV_START` / `COVARIANCE_START`：支持 LTM（21 项下三角）与 FULL（6×6 共 36 项），
 * 以及 `EPOCH =` 键值写法。先按文件参考系入库，状态转到 ECI 后再旋转协方差
 * （RTN/UVW/RSW → uvwCovToEci；ITRF CARTPV → itrfCovToEci；惯性系不转）。
 */
export function parseOcm(text: string): ParseResult {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const states: EphemState[] = []

  let section: 'none' | 'meta' | 'traj' | 'cov' | 'man' = 'none'
  const maneuvers: EphemManSegment[] = []
  type ManAcc = {
    id: string | null
    t: number | null
    dura: number | null
    acc: number[] | null
    refFrame: string | null
    basis: string | null
    dcType: string | null
    purpose: string | null
    deviceId: string | null
    extras: Record<string, string>
  }
  const emptyMan = (): ManAcc => ({
    id: null, t: null, dura: null, acc: null,
    refFrame: null, basis: null, dcType: null, purpose: null, deviceId: null, extras: {}
  })
  let manAcc: ManAcc | null = null
  let refFrame: EphemFrame = 'EME2000'
  let timeSystem = 'UTC'
  let objectName = ''
  let objectId = ''
  let covFrame: string = 'RTN'
  let covOrdering: 'LTM' | 'FULL' | '' = ''

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
    const cov = numsToCov(covNums, covOrdering)
    if (!cov) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 只有 ${covNums.length} 个值（LTM 需 21 项，FULL 需 36 项），已忽略`)
      covEpoch = null
      covNums = []
      return
    }
    const idx = nearestIndex(states, covEpoch)
    if (idx < 0 || Math.abs(states[idx].t - covEpoch) > 60000) {
      warnings.push(`协方差历元 ${new Date(covEpoch).toISOString()} 附近 60s 内无状态点，已忽略`)
    } else {
      // Raw file-frame matrix; rotated to ECI after states themselves are in ECI.
      states[idx].cov = cov
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
    if (upper.startsWith('COVARIANCE_START') || upper.startsWith('COV_START')) {
      flushPending()
      attachCov()
      section = 'cov'
      continue
    }
    if (upper.startsWith('COVARIANCE_STOP') || upper.startsWith('COV_STOP')) {
      attachCov()
      section = 'none'
      continue
    }
    if (upper.startsWith('COMMENT')) continue
    if (upper.startsWith('MAN_START')) {
      flushPending()
      section = 'man'
      manAcc = emptyMan()
      continue
    }
    if (upper.startsWith('MAN_STOP')) {
      if (manAcc && manAcc.t != null && manAcc.dura != null && manAcc.dura > 0) {
        const ax = manAcc.acc ? Math.hypot(manAcc.acc[0], manAcc.acc[1], manAcc.acc[2]) : 0
        const dvMps = manAcc.dura * ax * 1000 // km/s^2 * s → m/s
        const extras = Object.keys(manAcc.extras).length ? { ...manAcc.extras } : undefined
        const acc = manAcc.acc && manAcc.acc.length >= 3
          ? [manAcc.acc[0], manAcc.acc[1], manAcc.acc[2]] as [number, number, number]
          : undefined
        maneuvers.push({
          t0: manAcc.t,
          t1: manAcc.t + manAcc.dura * 1000,
          dvMps: Number(dvMps.toFixed(6)),
          id: manAcc.id || undefined,
          acc,
          refFrame: manAcc.refFrame || undefined,
          basis: manAcc.basis || undefined,
          dcType: manAcc.dcType || undefined,
          purpose: manAcc.purpose || undefined,
          deviceId: manAcc.deviceId || undefined,
          extras
        })
      }
      manAcc = null
      section = 'none'
      continue
    }

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
        } else if (key === 'COV_ORDERING') {
          const o = value.toUpperCase()
          covOrdering = o.includes('FULL') ? 'FULL' : o.includes('LTM') ? 'LTM' : covOrdering
        } else if (key === 'COV_TYPE') {
          /* CARTPV / other; CARTPV is the 6×6 position-velocity block we already parse */
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
      } else if (key === 'OBJECT_ID' || key === 'OBJECT_DESIGNATOR') {
        if (!objectId) objectId = value
      } else if (key === 'TRAJ_REF_FRAME') {
        const frameCand = value.toUpperCase().startsWith('ITRF') ? 'ITRF' : value.toUpperCase()
        if ((FRAME_SET as string[]).indexOf(frameCand) >= 0) refFrame = frameCand as EphemFrame
      } else if (key === 'COV_REF_FRAME') {
        covFrame = value
      } else if (key === 'COV_ORDERING') {
        const o = value.toUpperCase()
        covOrdering = o.includes('FULL') ? 'FULL' : o.includes('LTM') ? 'LTM' : covOrdering
      } else if (section === 'man' && manAcc) {
        if (key === 'MAN_ID') manAcc.id = value
        else if (key === 'MAN_BASIS') manAcc.basis = value
        else if (key === 'DC_TYPE' || key === 'MAN_DC_TYPE') manAcc.dcType = value
        else if (key === 'MAN_PURPOSE') manAcc.purpose = value
        else if (key === 'MAN_DEVICE_ID') manAcc.deviceId = value
        else if (key === 'MAN_REF_FRAME') manAcc.refFrame = value
        else if (key === 'MAN_DURA' && NUM_RE.test(value)) manAcc.dura = Number(value)
        else if ((key === 'TIME_ABSOLUTE' || key === 'MAN_EPOCH') && manAcc.t == null) {
          const mt = parseIso(value)
          if (mt != null) manAcc.t = mt
        } else if ((key === 'ACC_X' || key === 'MAN_ACC_X') && NUM_RE.test(value)) {
          if (!manAcc.acc) manAcc.acc = [0, 0, 0]
          manAcc.acc[0] = Number(value)
        } else if ((key === 'ACC_Y' || key === 'MAN_ACC_Y') && NUM_RE.test(value)) {
          if (!manAcc.acc) manAcc.acc = [0, 0, 0]
          manAcc.acc[1] = Number(value)
        } else if ((key === 'ACC_Z' || key === 'MAN_ACC_Z') && NUM_RE.test(value)) {
          if (!manAcc.acc) manAcc.acc = [0, 0, 0]
          manAcc.acc[2] = Number(value)
        } else if (key !== 'MAN_ID') {
          manAcc.extras[key] = value
        }
      }
      continue
    }

    if (section === 'cov') {
      const tokens = line.split(/\s+/)
      // Starlink public OCM: "<ISO> c11..c66" (21 LTM values after time)
      const maybeT = parseIso(tokens[0])
      const rest = tokens.slice(1)
      const nums = rest.filter((c) => NUM_RE.test(c)).map(Number)
      const wantFull = covOrdering === 'FULL' || (covOrdering !== 'LTM' && nums.length >= 36)
      const need = wantFull ? 36 : 21
      if (maybeT !== null && nums.length >= need) {
        attachCov()
        covEpoch = maybeT
        covNums = nums.slice(0, need)
        attachCov()
        continue
      }
      if (tokens.every((c) => NUM_RE.test(c))) {
        for (const c of tokens) covNums.push(Number(c))
      }
      continue
    }

    // MAN 数据行：TIME_ABSOLUTE MAN_DURA ACC_X ACC_Y ACC_Z
    if (section === 'man' && manAcc) {
      const toks = line.split(/\s+/)
      const mt = parseIso(toks[0])
      if (mt !== null && toks.length >= 5) {
        manAcc.t = mt
        manAcc.dura = Number(toks[1])
        manAcc.acc = [Number(toks[2]), Number(toks[3]), Number(toks[4])]
      }
      continue
    }

    // 轨迹数值行：仅在 TRAJ 段内；第一列为 ISO 时间
    if (section !== 'traj') continue
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
    warnings.push('状态已从 ITRF 旋转到 ECI（仅 GMST 绕 Z 轴）')
    usedFrame = 'EME2000'
  }
  const covIsRtn = /RTN|UVW|RSW/i.test(covFrame)
  const covIsItrf = /ITRF/i.test(covFrame)
  let covCount = 0
  for (const st of states) {
    if (!st.cov) continue
    covCount++
    if (covIsRtn) st.cov = uvwCovToEci(st.cov, st.r, st.v)
    else if (covIsItrf) st.cov = itrfCovToEci(st.cov, st.t)
    // inertial / unspecified non-RTN: already treated as ECI/ITRF-like inertial components
  }
  if (covCount) {
    if (covIsRtn) warnings.push('协方差按 RTN(UVW) 处理，已旋转到 ECI')
    else if (covIsItrf) warnings.push('协方差按 ITRF CARTPV 处理，已随状态旋转到 ECI（位置块精确）')
    else warnings.push(`协方差参考系 ${covFrame || '未标注'}，按惯性系分量使用`)
  }

  const first = states[0]
  const last = states[states.length - 1]
  // NORAD 以 OBJECT_ID/DESIGNATOR 为首选（SpaceX OCM 该字段即编目号）；
  // 名称后缀（STARLINK-1316 等）是内部序列名，不等于 NORAD，仅作最后兜底
  const noradMatch = /\b(\d{5})\b/.exec(objectId)
  const nameMatch = /STARLINK-(\d+)/i.exec(objectName)
  const norad = noradMatch ? Number(noradMatch[1]) : nameMatch ? Number(nameMatch[1]) : 0

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
    maneuvers: maneuvers.length ? maneuvers : undefined,
    hasCov: states.some((s) => !!s.cov),
    warnings
  }

  return { ok: true, set, warnings }
}
