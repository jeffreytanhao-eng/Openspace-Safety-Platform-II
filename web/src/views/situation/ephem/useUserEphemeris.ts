/**
 * 「星历分析」模块的状态与动作（纯前端，不落服务器）。
 *
 * 职责：
 * - 我的星历（IndexedDB 持久化）：上传 → 解析 → 质量评估 → 入库 → 激活；
 * - 内置样本：Starlink 官方公开星历（public/ephemeris-samples，抓取脚本见 scripts/）；
 * - 威胁筛选：拉取在轨目录快照 → 半长轴/倾角预过滤 → Worker 内粗筛+精筛 → 事件列表；
 * - 质量评估：自洽性（5 点多项式 vs Hermite 插值残差）+ 协方差/跨度打分。
 *
 * 所有状态为模块级单例：面板与三维场景共享同一份「当前激活星历」，
 * 父组件（index.vue）负责把事件转发给 BaseScene 绘制。
 */
import { computed, ref, shallowRef } from 'vue'
import { parseEphemeris } from './parse'
import { applyImpulse } from './maneuver'
import { compareTwoSets, neesScore, scoreQuality } from './quality'
import { compareWithTle, type TleDeviationResult } from './tleCompare'
import { interpolateAt } from './interp'
import { elementsFromRV } from './screening'
import type { CatalogSnapshotEntry, PairCompareRow, PairTarget, ScreenOptions } from './screening'
import { deleteSet, getSet, listMetas, putSet, deleteThreatEvents, getThreatEvents, putThreatEvents, type EphemMeta } from './store'
import type { EphemSet, EphemState, QualityReport, ThreatEvent, Vec3 } from './types'
import { getSatDetailPublic, listConstellationPublic } from '@/api/sat_public'
import { listLocalEphemerides, fetchEphemerisText, type EphListItem } from '@/api/ephemerides'
import { decodeConstellation } from '@/api/satTypes'

/** 单文件上限（MB）：Starlink 72h ITC 约 2 MB，留足余量 */
export const MAX_FILE_MB = 12

/** 我的星历列表（元数据，倒序） */
export const ephemMetas = ref<EphemMeta[]>([])
/** 当前激活的星历（完整状态序列） */
export const activeEphem = shallowRef<EphemSet | null>(null)
/** 当前激活星历的质量报告 */
export const activeQuality = shallowRef<QualityReport | null>(null)
/** 与编目 TLE 外推的偏差（异步计算；null 表示尚未算出 / 不可用） */
export const qualityTle = shallowRef<TleDeviationResult | null>(null)
export const qualityTleBusy = ref(false)
export const qualityTleError = ref('')
/** 实际参与比对的编目 NORAD（样本里的 norad 是生产编号，需按名称回查） */
export const qualityTleNorad = ref(0)
/** 比对来源说明（按名称匹配 / 目标名不一致等） */
export const qualityTleNote = ref('')

/** 双文件对比：用户选中的「同目标另一份星历」id */
export const qualityCompareId = ref('')
/** 双文件对比结果（重叠 RMS / 漂移 / NEES）；null = 未选或不可比 */
export const qualityCompare = shallowRef<QualityCompareResult | null>(null)
export const qualityCompareBusy = ref(false)
export const qualityCompareError = ref('')

export interface QualityCompareResult {
  otherId: string
  otherName: string
  /** 重叠时段位置差 RMS / 最大（km） */
  rmsKm: number
  maxKm: number
  /** 距离随时间的最小二乘斜率（km/天） */
  driftKmPerDay: number
  /** 重叠时长（秒） */
  commonSec: number
  /** NEES（理想值 1）；任一侧无协方差时为 NaN */
  nees: number
}
/** 列表 / 载入状态 */
export const ephemBusy = ref(false)
export const ephemError = ref('')

/** 上传进度（0~100）与当前处理的文件名 */
export const uploadProgress = ref(0)
export const uploadName = ref('')

/** 威胁事件（当前激活星历的一次筛选结果） */
export const threatEvents = ref<ThreatEvent[]>([])
export const threatSelected = shallowRef<ThreatEvent | null>(null)
export const screening = ref(false)
export const screenProgress = ref(0)
export const screenError = ref('')
/** 上次筛选的统计（用于面板提示） */
export const screenStats = shallowRef<{ catalogT: number; windowH: number; catalog: number; kept: number; ms: number } | null>(null)

/* ============================================================
 * 机动仿真（脉冲机动）
 * ============================================================ */
export type ManeuverDir = 'T' | 'R' | 'N'

/** 机动参数：时刻（Unix ms）/ 方向（RTN）/ 幅值（m/s），由面板编辑 */
export const maneuverConfig = ref<{ atMs: number | null; dir: ManeuverDir; dvMps: number }>({
  atMs: null,
  dir: 'T',
  dvMps: 0.2
})
/** 机动后的星历状态（null = 未施加）；父组件 watch 后交给 BaseScene 画双轨迹 */
export const maneuverStates = shallowRef<EphemState[] | null>(null)
export const maneuverBurnMs = ref<number | null>(null)
/** 已施加的 Δv 幅值（m/s，用于面板回显） */
export const maneuverDvMps = ref(0)
export const maneuverError = ref('')

/** 机动前后对比的对手数量上限（Top-N，按机动前最小距离排序） */
export const MANEUVER_COMPARE_COUNT = 20
/** 机动前 / 后对比行（TCA、最小距离、Pc，同口径重筛） */
export const maneuverCompare = ref<PairCompareRow[]>([])
export const maneuverCompareBusy = ref(false)
export const maneuverCompareError = ref('')

/** 清除机动结果（不改变面板里正在编辑的参数） */
export function clearManeuver() {
  maneuverStates.value = null
  maneuverBurnMs.value = null
  maneuverDvMps.value = 0
  maneuverError.value = ''
  maneuverCompare.value = []
  maneuverCompareError.value = ''
  compareToken++
}

/** 施加脉冲机动：按 RTN 分量构造 Δv，重算 atMs 之后的全部状态 */
export function applyManeuver(): boolean {
  const set = activeEphem.value
  maneuverError.value = ''
  if (!set) {
    maneuverError.value = '请先载入一份星历'
    return false
  }
  const at = maneuverConfig.value.atMs
  if (at == null || !Number.isFinite(at)) {
    maneuverError.value = '请选择机动时刻'
    return false
  }
  // 校验以实际状态序列为准（元数据跨度可能长于数据本身，落在外面的时刻插值不到）
  const t0 = set.states.length ? set.states[0].t : set.start
  const t1 = set.states.length ? set.states[set.states.length - 1].t : set.stop
  if (at < t0 || at > t1) {
    maneuverError.value = '机动时刻不在星历数据范围内'
    return false
  }
  const dv = maneuverConfig.value.dvMps
  if (!Number.isFinite(dv) || dv <= 0) {
    maneuverError.value = 'Δv 幅值需大于 0'
    return false
  }
  const vec: Vec3 = maneuverConfig.value.dir === 'R'
    ? [dv, 0, 0]
    : maneuverConfig.value.dir === 'T' ? [0, dv, 0] : [0, 0, dv]
  maneuverStates.value = applyImpulse(set.states, at, vec)
  maneuverBurnMs.value = at
  maneuverDvMps.value = dv
  // 施加后立即对 Top-N 威胁对手做「原方案 / 机动后」重筛（异步，不阻塞面板操作）
  maneuverCompare.value = []
  void reScreenManeuverCompare()
  return true
}

/** 内置样本清单（后端 data/ephemerides 索引；后端不可用时回退 public/ephemeris-samples 的 JSON） */
export interface BuiltinSample {
  /** 样本 id（itc-xxx / ocm-xxx / json-xxx）：同星 ITC 与 OCM 各一条，列表 key 用 */
  id: string
  norad: number
  name: string
  format: 'ITC' | 'OCM' | 'OEM'
  /** 服务器样本为 data/ephemerides 下的 .txt.gz 相对路径；回退样本为 public 下的 .json */
  file: string
  points: number
  hasCov: boolean
  /** MAN 机动段数量（OCM 专有；ITC 恒为 0） */
  maneuvers: number
  /** 机动摘要（如「2 处 · max Δv 0.0310 m/s」） */
  maneuverSummary: string
  /** 有效期起止（UTC ms；服务端样本提供，回退 JSON 样本无） */
  startMs?: number
  stopMs?: number
  /** 状态点步长（秒） */
  stepSec?: number
  /** 文件原大小展示文案（如「4.8 MB」；服务端 raw size） */
  sizeText?: string
  loaded: boolean
}
export const builtinSamples = ref<BuiltinSample[]>([])

/** 当前激活星历的名称（dock / 详情用） */
export const activeEphemName = computed(() => activeEphem.value?.name || '')

/* ============================================================
 * 威胁事件持久化（IndexedDB）
 * ============================================================ */

/** 转成普通对象：threatEvents 是 ref（深层响应式 Proxy），
 *  IndexedDB / Worker 的结构化克隆都无法直接处理 Proxy，必须逐字段复制。 */
function plainEvents(list: ThreatEvent[]): ThreatEvent[] {
  return list.map((e) => ({
    id: e.id,
    selfNorad: e.selfNorad,
    otherNorad: e.otherNorad,
    otherName: e.otherName,
    tca: e.tca,
    missKm: e.missKm,
    relSpeedKmS: e.relSpeedKmS,
    pc: e.pc,
    risk: e.risk,
    level: e.level,
    midEci: [e.midEci[0], e.midEci[1], e.midEci[2]] as Vec3,
    ...(e.otherEci ? { otherEci: [e.otherEci[0], e.otherEci[1], e.otherEci[2]] as Vec3 } : {}),
    ...(e.otherVel ? { otherVel: [e.otherVel[0], e.otherVel[1], e.otherVel[2]] as Vec3 } : {})
  }))
}

/** 保存当前星历的筛选结果（空结果也写，避免旧结果在刷新后复活） */
function persistThreatEvents(set: EphemSet) {
  void putThreatEvents({
    setId: set.id,
    selfName: set.name,
    selfNorad: set.norad,
    savedAt: Date.now(),
    events: plainEvents(threatEvents.value)
  })
}

/* ============================================================
 * 列表 / 激活
 * ============================================================ */

/** 重新读取 IndexedDB 里的星历元数据 */
export async function refreshEphemList() {
  try {
    ephemMetas.value = await listMetas()
  } catch (e) {
    ephemError.value = (e as Error)?.message || '读取本机星历失败'
  }
}

/** 激活某份星历：读完整序列 → 算质量分 → 清空上一次的威胁事件 */
export async function activateEphem(id: string) {
  if (!id) return
  ephemBusy.value = true
  ephemError.value = ''
  try {
    const set = await getSet(id)
    if (!set) {
      ephemError.value = '星历文件已不存在（可能已被清理）'
      return
    }
    activeEphem.value = set
    resetQualityCompare()
    activeQuality.value = evaluateQuality(set)
    resetTleDeviation()
    // 恢复上次筛选结果（同一份星历刷新页面后列表/热力页签仍有数据）
    const saved = await getThreatEvents(set.id)
    threatEvents.value = saved?.events || []
    threatSelected.value = null
    screenStats.value = null
    screenError.value = ''
    // 切换星历后旧的机动结果不再适用（其状态序列属于上一份星历）
    clearManeuver()
    maneuverConfig.value.atMs = (set.states.length ? set.states[0].t : set.start) + 3600e3
    void evaluateTleDeviation(set)
  } catch (e) {
    ephemError.value = (e as Error)?.message || '星历载入失败'
  } finally {
    ephemBusy.value = false
  }
}

/** 取消激活当前星历（面板里再次点击同一份星历）：图层 / 详情 / 质量卡 / 威胁事件一并清空，
 *  星历文件本身保留在 IndexedDB 里，可随时再次点击激活 */
export function deactivateEphem() {
  if (!activeEphem.value) return
  activeEphem.value = null
  activeQuality.value = null
  resetQualityCompare()
  resetTleDeviation()
  threatEvents.value = []
  threatSelected.value = null
  screenStats.value = null
  clearManeuver()
}

/** 删除某份星历（同时清理激活态） */
export async function removeEphem(id: string) {
  await deleteSet(id)
  void deleteThreatEvents(id)
  if (activeEphem.value?.id === id) {
    activeEphem.value = null
    activeQuality.value = null
    resetQualityCompare()
    resetTleDeviation()
    threatEvents.value = []
    threatSelected.value = null
    clearManeuver()
  } else if (qualityCompareId.value === id) {
    // 删掉的是对比星历：取消对比并按单文件口径重新打分
    resetQualityCompare()
    refreshActiveQuality()
  }
  await refreshEphemList()
}

/* ============================================================
 * 上传
 * ============================================================ */

/** 单个文件：读文本 → 解析 → 质量评估 → 入库 */
async function ingestFile(file: File): Promise<EphemSet | null> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`${file.name}：文件超过 ${MAX_FILE_MB} MB 上限`)
  }
  const text = await file.text()
  const res = parseEphemeris(text, { fileName: file.name })
  if (!res.ok || !res.set) {
    const at = res.line ? `（第 ${res.line} 行）` : ''
    throw new Error(`${file.name}：${res.error || '解析失败'}${at}`)
  }
  const set = res.set
  // 上传文件可能同名同 NORAD：id 里带创建时间，避免互相覆盖
  set.id = `${set.norad || 'X'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  set.source = 'upload'
  set.createdAt = Date.now()
  await putSet(set)
  return set
}

/** 批量上传（拖拽 / 文件选择共用）：逐个解析并入库，最后激活最后一个成功项 */
export async function uploadEphemerides(files: File[]) {
  if (!files.length) return
  ephemBusy.value = true
  ephemError.value = ''
  uploadProgress.value = 0
  let last: EphemSet | null = null
  const errors: string[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    uploadName.value = f.name
    try {
      const set = await ingestFile(f)
      if (set) last = set
    } catch (e) {
      errors.push((e as Error)?.message || `${f.name}：解析失败`)
    }
    uploadProgress.value = Math.round(((i + 1) / files.length) * 100)
  }
  await refreshEphemList()
  if (errors.length) ephemError.value = errors.join('；')
  if (last) await activateEphem(last.id)
  uploadName.value = ''
  ephemBusy.value = false
}

/* ============================================================
 * 内置样本（Starlink 官方公开星历）
 * ============================================================ */

const SAMPLE_INDEX = `${import.meta.env.BASE_URL}ephemeris-samples/index.json`

/** 读取内置样本清单；已入库的样本标 loaded（同一 norad 按 ITC / OCM 分别提示） */
export async function loadBuiltinIndex() {
  if (builtinSamples.value.length) return
  // 优先走后端 /cgi/ephemerides（data/ephemerides 索引，16 条含 OCM 机动段 / 协方差元数据）
  try {
    const data = await listLocalEphemerides()
    const items = (data.items || []).filter(
      (it): it is EphListItem & { format: 'ITC' | 'OCM' | 'OEM' } =>
        it.format === 'ITC' || it.format === 'OCM' || it.format === 'OEM'
    )
    if (items.length) {
      builtinSamples.value = items.map((it) => {
        const norad = Number(it.norad) || 0
        return {
          id: it.id,
          norad,
          name: it.name,
          format: it.format,
          file: it.file,
          points: it.points,
          hasCov: !!it.covariance,
          maneuvers: it.maneuvers || 0,
          maneuverSummary: it.maneuverSummary || '',
          startMs: it.startMs,
          stopMs: it.stopMs,
          stepSec: it.stepSec,
          sizeText: it.size,
          loaded: ephemMetas.value.some(
            (m) => m.norad === norad && m.source === 'builtin' && m.format === it.format.toLowerCase()
          )
        }
      })
      return
    }
  } catch {
    // 后端不可用（纯静态部署 / 本地预览）→ 回退 public 下的 JSON 样本
  }
  try {
    const res = await fetch(SAMPLE_INDEX, { cache: 'no-cache' })
    if (!res.ok) return
    const list = (await res.json()) as { norad: number; name: string; file: string; points: number }[]
    builtinSamples.value = list.map((s) => ({
      id: `json-${s.norad}`,
      norad: s.norad,
      name: s.name,
      format: 'ITC' as const,
      file: s.file,
      points: s.points,
      hasCov: false,
      maneuvers: 0,
      maneuverSummary: '',
      loaded: ephemMetas.value.some((m) => m.norad === s.norad && m.source === 'builtin' && m.format === 'itc')
    }))
  } catch {
    // 内置样本缺失（离线部署未带 public 目录）时静默：不影响上传功能
  }
}

/** 载入一个内置样本（首次点击才拉取该文件，避免面板打开就下 1MB+） */
export async function loadBuiltinSample(s: BuiltinSample) {
  ephemBusy.value = true
  ephemError.value = ''
  uploadName.value = s.name
  uploadProgress.value = 10
  try {
    if (s.file.endsWith('.json')) {
      // 回退通道：public/ephemeris-samples 的 JSON 样本（不含协方差 / 机动段）
      await loadBuiltinJsonSample(s)
      return
    }
    // 服务器样本（data/ephemerides 的 .txt.gz）：后端解压下发纯文本 → 统一解析入库
    uploadProgress.value = 30
    const text = await fetchEphemerisText(s.file)
    uploadProgress.value = 60
    const res = parseEphemeris(text, { name: s.name, norad: s.norad, fileName: s.file })
    if (!res.ok || !res.set) {
      const at = res.line ? `（第 ${res.line} 行）` : ''
      throw new Error(res.error ? `${res.error}${at}` : '样本解析失败')
    }
    const set = res.set
    // OCM 与 ITC 分 id 入库互不覆盖；ITC 沿用历史 builtin-<norad>（覆盖旧 JSON 样本，升级为含协方差版本）
    set.id = s.format === 'OCM' ? `builtin-ocm-${s.norad}` : `builtin-${s.norad}`
    set.source = 'builtin'
    set.createdAt = Date.now()
    await putSet(set)
    uploadProgress.value = 100
    await refreshEphemList()
    s.loaded = true
    await activateEphem(set.id)
  } catch (e) {
    ephemError.value = (e as Error)?.message || '内置样本载入失败'
  } finally {
    uploadName.value = ''
    ephemBusy.value = false
  }
}

/** 旧 JSON 样本通道（public/ephemeris-samples，后端不可用时的回退） */
async function loadBuiltinJsonSample(s: BuiltinSample) {
  // no-cache：样本文件会随抓取脚本重新生成，force-cache 会一直用旧缓存（点「重新载入」也拿不到新数据）
  const res = await fetch(`${import.meta.env.BASE_URL}ephemeris-samples/${s.file}`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`样本文件加载失败（HTTP ${res.status}）`)
  uploadProgress.value = 60
  const raw = (await res.json()) as {
    norad: number
    name: string
    format: 'itc'
    start: number
    stop: number
    stepSec: number
    states: [number, number, number, number, number, number, number][]
  }
  uploadProgress.value = 80
  const states: EphemState[] = raw.states.map((r) => ({
    t: r[0],
    r: [r[1], r[2], r[3]] as Vec3,
    v: [r[4], r[5], r[6]] as Vec3
  }))
  const set: EphemSet = {
    id: `builtin-${raw.norad}`,
    norad: raw.norad,
    name: raw.name,
    format: 'itc',
    frame: 'UVW',
    source: 'builtin',
    createdAt: Date.now(),
    start: raw.start,
    stop: raw.stop,
    stepSec: raw.stepSec,
    states,
    warnings: ['Starlink 官方公开星历（ITC/MEME）样本，72h 预报、60s 步长；样本不含协方差']
  }
  await putSet(set)
  uploadProgress.value = 100
  await refreshEphemList()
  s.loaded = true
  await activateEphem(set.id)
}

/* ============================================================
 * 质量评估
 * ============================================================ */

/** 5 点（i-2..i+2）拉格朗日多项式在 i+0.5 处的权重（等距节点，预先算好） */
const L5 = [0.0234375, -0.15625, 0.703125, 0.46875, -0.0390625]

/**
 * 自洽性：以「5 点多项式」预测 i+0.5 时刻的位置，与「Hermite 插值」结果比较。
 * 星历本身平滑时二者应高度一致（残差 < 1 km）；残差大说明状态点抖动或时间戳错乱。
 */
function selfConsistency(set: EphemSet): { rms: number; max: number } {
  const st = set.states
  if (st.length < 5) return { rms: NaN, max: NaN }
  const stride = Math.max(1, Math.floor(st.length / 400))
  let sum2 = 0
  let max = 0
  let n = 0
  for (let i = 2; i < st.length - 2; i += stride) {
    const a = st[i]
    const b = st[i + 1]
    const mid = (a.t + b.t) / 2
    const h = interpolateAt(st, mid)
    if (!h) continue
    let d2 = 0
    for (let k = 0; k < 3; k++) {
      const poly =
        L5[0] * st[i - 2].r[k] + L5[1] * st[i - 1].r[k] + L5[2] * st[i].r[k] +
        L5[3] * st[i + 1].r[k] + L5[4] * st[i + 2].r[k]
      const d = poly - h.r[k]
      d2 += d * d
    }
    const dist = Math.sqrt(d2)
    sum2 += dist * dist
    if (dist > max) max = dist
    n++
  }
  return n ? { rms: Math.sqrt(sum2 / n), max } : { rms: NaN, max: NaN }
}

/**
 * 对一份星历做质量评估。
 * cmp 存在时（已选同目标另一份星历）：用重叠时段 RMS 代替单文件插值残差作为自洽性口径，
 * 并补上 NEES（协方差真实性）。
 */
export function evaluateQuality(set: EphemSet, cmp?: QualityCompareResult | null): QualityReport {
  const sc = selfConsistency(set)
  const hasCmp = !!cmp && Number.isFinite(cmp.rmsKm)
  return scoreQuality({
    selfConsistencyRmsKm: hasCmp ? cmp!.rmsKm : sc.rms,
    selfDriftKmPerDay: hasCmp ? cmp!.driftKmPerDay : undefined,
    hasCovariance: set.states.some((s) => !!s.cov),
    spanDays: (set.stop - set.start) / 86400000,
    nees: cmp && Number.isFinite(cmp.nees) && cmp.nees > 0 ? cmp.nees : undefined
  })
}

/* ============================================================
 * 双文件对比（同目标新旧两份星历：重叠 RMS / 漂移 / NEES）
 * ============================================================ */

/** 对比序号：切换星历或重新选择对比对象后丢弃在途结果 */
let compareQualityToken = 0

/** 清空双文件对比状态 */
export function resetQualityCompare() {
  compareQualityToken++
  qualityCompareId.value = ''
  qualityCompare.value = null
  qualityCompareBusy.value = false
  qualityCompareError.value = ''
}

/** 用当前激活星历 + 选中的对比星历重新打分（TLE 数值保留在报告里） */
function refreshActiveQuality() {
  const set = activeEphem.value
  if (!set) return
  const rep = evaluateQuality(set, qualityCompare.value)
  const tle = qualityTle.value
  activeQuality.value = tle ? { ...rep, tleRmsKm: tle.rmsKm, tleMaxKm: tle.maxKm } : rep
}

/** 选择 / 取消对比星历（id 为空表示取消） */
export async function setQualityCompare(id: string) {
  qualityCompareId.value = id
  qualityCompare.value = null
  qualityCompareError.value = ''
  const token = ++compareQualityToken
  const a = activeEphem.value
  if (!a) return
  if (!id) {
    refreshActiveQuality()
    return
  }
  if (id === a.id) {
    qualityCompareError.value = '不能与自身比较'
    refreshActiveQuality()
    return
  }
  qualityCompareBusy.value = true
  try {
    const b = await getSet(id)
    if (token !== compareQualityToken) return
    if (!b) throw new Error('对比星历已不存在')
    const c = compareTwoSets(a, b)
    if (!Number.isFinite(c.rmsKm) || c.commonSec <= 0) throw new Error('两份星历没有重叠时段，无法对比')
    const nees = neesScore(a, b)
    qualityCompare.value = {
      otherId: b.id,
      otherName: b.name,
      rmsKm: c.rmsKm,
      maxKm: c.maxKm,
      driftKmPerDay: c.driftKmPerDay,
      commonSec: c.commonSec,
      nees
    }
    if (token === compareQualityToken) refreshActiveQuality()
  } catch (e) {
    if (token === compareQualityToken) {
      qualityCompareError.value = (e as Error)?.message || '星历对比失败'
      refreshActiveQuality()
    }
  } finally {
    if (token === compareQualityToken) qualityCompareBusy.value = false
  }
}

/* ============================================================
 * 与 TLE 外推的偏差（异步；只作量级参考，不并入总分）
 * ============================================================ */

/** 偏差计算序号：切换 / 删除星历后丢弃在途结果 */
let tleToken = 0

/** 清空 TLE 偏差状态（切换星历、删除激活星历时调用） */
export function resetTleDeviation() {
  tleToken++
  qualityTle.value = null
  qualityTleBusy.value = false
  qualityTleError.value = ''
  qualityTleNorad.value = 0
  qualityTleNote.value = ''
}

function normName(s: string): string {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

/**
 * 回查编目 NORAD：优先按同名目标。
 * 内置样本文件名里的数字是 Starlink 生产编号（如 STARLINK-38123），不是编目号，
 * 直接拿它查 TLE 会命中毫无关系的在轨物体；上传文件通常带真实 NORAD，按 NORAD 命中。
 */
async function resolveCatalogNorad(set: EphemSet): Promise<{ norad: number; byName: boolean } | null> {
  const cat = await loadCatalog()
  const name = normName(set.name)
  if (name) {
    const hit = cat.list.find((e) => normName(e.name) === name)
    if (hit) return { norad: hit.norad, byName: true }
  }
  if (set.norad) {
    const hit = cat.list.find((e) => e.norad === set.norad)
    if (hit) return { norad: hit.norad, byName: false }
  }
  return null
}

/** 拉取该目标的 TLE，逐点与星历位置比对（不阻塞面板；结果进 qualityTle） */
export async function evaluateTleDeviation(set: EphemSet) {
  resetTleDeviation()
  const token = tleToken
  qualityTleBusy.value = true
  try {
    const hit = await resolveCatalogNorad(set)
    if (token !== tleToken) return
    if (!hit) {
      qualityTleError.value = '在轨目录中未找到与该星历同名的目标，无法做 TLE 偏差评估'
      return
    }
    qualityTleNorad.value = hit.norad
    if (hit.byName && hit.norad !== set.norad) {
      qualityTleNote.value = `已按名称匹配到编目 NORAD ${hit.norad}（文件内编号不是编目号）`
    }

    const detail = await getSatDetailPublic(hit.norad)
    if (token !== tleToken) return
    if (!detail?.tle_line1 || !detail?.tle_line2) {
      qualityTleError.value = `NORAD ${hit.norad} 在编目中缺少 TLE 两行`
      return
    }

    const res = compareWithTle(set, detail.tle_line1, detail.tle_line2)
    if (token !== tleToken) return
    if (!res) {
      qualityTleError.value = 'SGP4 外推失败或有效样本不足，无法比对'
      return
    }
    qualityTle.value = res
    // 报告里同步数值（供后续 AI 解读引用），总分不因 TLE 偏差变化
    if (activeEphem.value?.id === set.id && activeQuality.value) {
      activeQuality.value = { ...activeQuality.value, tleRmsKm: res.rmsKm, tleMaxKm: res.maxKm }
    }
  } catch (e) {
    if (token === tleToken) qualityTleError.value = (e as Error)?.message || 'TLE 偏差评估失败'
  } finally {
    if (token === tleToken) qualityTleBusy.value = false
  }
}

/* ============================================================
 * 威胁筛选
 * ============================================================ */

/** 目录快照缓存（10 分钟）：同一会话内多次筛选不重复拉 3.5 万目标点云 */
let catalogCache: { t: number; list: CatalogSnapshotEntry[] } | null = null
/** 上次筛选的时间窗（机动对比沿用同一窗口，保证前后口径一致） */
let lastScreenOpt: ScreenOptions | null = null
/** 对比计算序号：重新施加机动 / 清除机动后，旧结果直接丢弃 */
let compareToken = 0

/** 拉取在轨目录快照并转成筛选输入（记录快照历元 t，供两体推进对齐） */
async function loadCatalog(): Promise<{ t: number; list: CatalogSnapshotEntry[] }> {
  if (catalogCache && Date.now() - catalogCache.t < 10 * 60 * 1000) return catalogCache
  const res = await listConstellationPublic()
  const t = Number(res?.t) || Date.now()
  const pts = decodeConstellation(res)
  const list: CatalogSnapshotEntry[] = pts.map((p) => {
    // 后端点云已带周期 / 倾角：半长轴直接用开普勒第三定律换算，省掉逐目标反解
    const periodMin = Number(p.period)
    const a = periodMin > 0 ? Math.cbrt(398600.4418 * Math.pow((periodMin * 60) / (2 * Math.PI), 2)) : NaN
    return {
      norad: p.norad_id,
      name: p.object_name || `NORAD ${p.norad_id}`,
      r: [p.x, p.y, p.z] as Vec3,
      v: [p.vx ?? 0, p.vy ?? 0, p.vz ?? 0] as Vec3,
      a,
      e: NaN,
      i: Number(p.incl ?? NaN)
    }
  })
  catalogCache = { t, list }
  return catalogCache
}

export interface ScreenParams {
  /** 筛选时间窗（小时） */
  windowH: number
  /** 粗筛步长（秒） */
  coarseStepSec: number
  /** 报告距离阈值（km） */
  maxDistKm: number
  /** 碰撞概率阈值 */
  pcThreshold: number
  maxEvents: number
}

export const DEFAULT_SCREEN: ScreenParams = {
  windowH: 24,
  coarseStepSec: 120,
  maxDistKm: 50,
  pcThreshold: 1e-6,
  maxEvents: 300
}

/** 跑一次威胁筛选（Worker 优先，构造失败时退回主线程） */
export async function runScreening(params: ScreenParams = DEFAULT_SCREEN) {
  const set = activeEphem.value
  if (!set) {
    screenError.value = '请先载入一份星历'
    return
  }
  screening.value = true
  screenProgress.value = 0
  screenError.value = ''
  threatEvents.value = []
  threatSelected.value = null
  maneuverCompare.value = []
  const t0All = performance.now()
  try {
    const cat = await loadCatalog()
    const selfEl = elementsFromRV(set.states[0].r, set.states[0].v)
    // 预过滤：半长轴 ±150 km、倾角 ±10°（与 screening 内部同一口径，这里提前做可把
    // 3.5 万目标降到数千，减小 Worker 消息体与克隆开销）；同时按「名称 + NORAD」排除本星自身
    const selfName = normName(set.name)
    const catalog = cat.list.filter((c) => {
      if (c.norad === set.norad || (selfName !== '' && normName(c.name) === selfName)) return false
      const a = Number.isFinite(c.a) ? c.a : selfEl.a
      const i = Number.isFinite(c.i) ? c.i : selfEl.i
      return Math.abs(a - selfEl.a) < 150 && Math.abs(i - selfEl.i) < 10
    })
    const t0 = Math.max(set.start, cat.t)
    const t1 = Math.min(set.stop, t0 + Math.max(1, params.windowH) * 3600e3)
    if (!(t1 > t0)) {
      screenError.value = '星历有效期与当前时刻没有重叠，无法筛选（星历可能已过期）'
      return
    }
    const opt: ScreenOptions = {
      t0,
      t1,
      catalogT: cat.t,
      coarseStepSec: params.coarseStepSec,
      maxDistKm: params.maxDistKm,
      hardBodyKm: 0.01,
      pcThreshold: params.pcThreshold,
      maxEvents: params.maxEvents
    }
    const events = await runScreenWorker(set, catalog, opt)
    lastScreenOpt = opt
    threatEvents.value = events.sort((a, b) => a.missKm - b.missKm)
    persistThreatEvents(set)
    screenStats.value = {
      catalogT: cat.t,
      windowH: (t1 - t0) / 3600e3,
      catalog: cat.list.length,
      kept: catalog.length,
      ms: Math.round(performance.now() - t0All)
    }
    // 已有施加中的机动时，筛选完成后按新事件列表重算对比表
    if (maneuverStates.value) void reScreenManeuverCompare()
  } catch (e) {
    screenError.value = (e as Error)?.message || '威胁筛选失败'
  } finally {
    screening.value = false
    screenProgress.value = 1
  }
}

/** Worker 执行（不可用时同步兜底）：返回威胁事件 */
function runScreenWorker(set: EphemSet, catalog: CatalogSnapshotEntry[], opt: ScreenOptions): Promise<ThreatEvent[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    try {
      worker = new Worker(new URL('./screen.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      worker = null
    }
    if (!worker) {
      import('./screening').then((m) => {
        try {
          resolve(m.screenEphemeris(set, catalog, opt, (p) => { screenProgress.value = p }))
        } catch (e) {
          reject(e)
        }
      }, reject)
      return
    }
    const w = worker
    let settled = false
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; p?: number; events?: ThreatEvent[]; message?: string }
      if (d.type === 'progress') screenProgress.value = d.p ?? 0
      else if (d.type === 'done') {
        settled = true
        resolve(d.events || [])
        w.terminate()
      } else if (d.type === 'error') {
        settled = true
        reject(new Error(d.message || '筛选失败'))
        w.terminate()
      }
    }
    w.onerror = () => {
      if (settled) return
      settled = true
      w.terminate()
      // Worker 运行环境异常（老 WebView 不支持 module worker 等）：退回主线程同步计算
      import('./screening').then((m) => {
        try {
          resolve(m.screenEphemeris(set, catalog, opt, (p) => { screenProgress.value = p }))
        } catch (e) {
          reject(e)
        }
      }, reject)
    }
    w.postMessage({
      id: set.id,
      norad: set.norad,
      name: set.name,
      states: set.states,
      catalog,
      opt
    })
  })
}

/* ============================================================
 * 机动前后对比（Top-N 单对重筛）
 * ============================================================ */

/**
 * 对当前威胁列表的前 N 个对手，用「原方案 / 机动后」两套状态各做一次单对重筛，
 * 得到同口径的 TCA / 最小距离 / Pc 对比。没有筛选结果时不计算（面板提示先筛选）。
 */
export async function reScreenManeuverCompare() {
  const set = activeEphem.value
  const after = maneuverStates.value
  const opt = lastScreenOpt
  maneuverCompareError.value = ''
  if (!set || !after || !opt) {
    maneuverCompare.value = []
    return
  }
  const others: PairTarget[] = threatEvents.value
    .slice(0, MANEUVER_COMPARE_COUNT)
    .filter((ev) => ev.otherEci && ev.otherVel)
    // 事件来自 ref（深层响应式），数组是 Proxy 无法被 postMessage 结构化克隆，这里复制成普通数组
    .map((ev) => ({
      norad: ev.otherNorad,
      name: ev.otherName,
      r: [(ev.otherEci as Vec3)[0], (ev.otherEci as Vec3)[1], (ev.otherEci as Vec3)[2]] as Vec3,
      v: [(ev.otherVel as Vec3)[0], (ev.otherVel as Vec3)[1], (ev.otherVel as Vec3)[2]] as Vec3,
      epochT: ev.tca
    }))
  if (!others.length) {
    maneuverCompare.value = []
    return
  }
  const token = ++compareToken
  maneuverCompareBusy.value = true
  try {
    const rows = await runPairWorker(set.id, set.norad, set.states, after, others, opt)
    if (token === compareToken) maneuverCompare.value = rows
  } catch (e) {
    if (token === compareToken) maneuverCompareError.value = (e as Error)?.message || '对比计算失败'
  } finally {
    if (token === compareToken) maneuverCompareBusy.value = false
  }
}

/** 主线程兜底：Worker 不可用时同步逐对重筛 */
async function pairFallback(
  id: string,
  norad: number,
  beforeStates: EphemState[],
  afterStates: EphemState[],
  others: PairTarget[],
  opt: ScreenOptions
): Promise<PairCompareRow[]> {
  const m = await import('./screening')
  const before = { id, norad, states: beforeStates }
  const after = { id, norad, states: afterStates }
  const rows: PairCompareRow[] = []
  for (const other of others) {
    const b = m.screenPair(before, other, opt)
    if (b) rows.push({ norad: other.norad, name: other.name, before: b, after: m.screenPair(after, other, opt) })
  }
  return rows
}

/** Top-N 单对重筛（Worker 优先，失败退回主线程） */
function runPairWorker(
  id: string,
  norad: number,
  beforeStates: EphemState[],
  afterStates: EphemState[],
  others: PairTarget[],
  opt: ScreenOptions
): Promise<PairCompareRow[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    try {
      worker = new Worker(new URL('./screen.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      worker = null
    }
    if (!worker) {
      pairFallback(id, norad, beforeStates, afterStates, others, opt).then(resolve, reject)
      return
    }
    const w = worker
    let settled = false
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; p?: number; rows?: PairCompareRow[]; message?: string }
      if (d.type === 'progress') screenProgress.value = d.p ?? 0
      else if (d.type === 'pairsDone') {
        settled = true
        resolve(d.rows || [])
        w.terminate()
      } else if (d.type === 'error') {
        settled = true
        reject(new Error(d.message || '对比计算失败'))
        w.terminate()
      }
    }
    w.onerror = () => {
      if (settled) return
      settled = true
      w.terminate()
      pairFallback(id, norad, beforeStates, afterStates, others, opt).then(resolve, reject)
    }
    w.postMessage({ type: 'pairs', id, norad, statesBefore: beforeStates, statesAfter: afterStates, others, opt })
  })
}

/** 选中一条威胁事件（三维高亮，右侧/列表联动） */
export function selectThreat(ev: ThreatEvent | null) {
  threatSelected.value = ev
}
