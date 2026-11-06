<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t, locale } = useI18n()
import {
  getEvent,
  getCdmRaw,
  pcCompare,
  getRelativeMotion,
  type ConjunctionEvent,
  type CdmMember,
  type TleProfile,
  type EventLevel,
  type PcCompareResult,
  type PcAgreement,
  type PcMethod,
  type RelMotionSample,
  type RelMotionResult
} from '@/api/events'
import {
  getCaDefaults,
  getCaProfiles,
  recomputeEvent,
  listRecomputeRuns,
  type CaDefaults,
  type RecomputeResult,
  type PcRun,
  type HbrMode,
  type CovMode,
  type Propagator
} from '@/api/ca'
import { AuthError } from '@/api/auth'
import EChart from '@/components/EChart.vue'
import type { EChartsCoreOption } from 'echarts/core'

const route = useRoute()
const router = useRouter()
const key = computed(() => decodeURIComponent(String(route.params.id || '')))

const loading = ref(true)
const error = ref('')
const event = ref<ConjunctionEvent | null>(null)
const cdms = ref<CdmMember[]>([])
const primary = ref<TleProfile | null>(null)
const secondary = ref<TleProfile | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await getEvent(key.value)
    event.value = resp.event
    cdms.value = resp.cdms ?? []
    primary.value = resp.primary
    secondary.value = resp.secondary
    void runCompare() // 详情就绪后自动比对（onMounted 时 event 尚为 null，不能挂在那里）
    void loadCaContext() // F1：预填组织默认参数 + 拉 run 历史（未登录回落系统缺省）
    void loadCaProfiles() // 第 4 项：个人 2 组参数可用性
    void loadRelativeMotion() // R2-16：TCA 附近相对运动序列
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    event.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/* ------------------------- R2-16 相对运动（TCA 附近） ------------------------- */
const rmLoading = ref(false)
const rmError = ref('')
const rm = ref<RelMotionResult | null>(null)

async function loadRelativeMotion(): Promise<void> {
  rmLoading.value = true
  rmError.value = ''
  try {
    rm.value = await getRelativeMotion(key.value, 30, 30)
  } catch (e) {
    rmError.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
    rm.value = null
  } finally {
    rmLoading.value = false
  }
}

const RM_AXIS_TEXT = '#8fa3b8'
const RM_GRID_LINE = { lineStyle: { color: 'rgba(120,150,180,0.12)' } }

/** 距离—时间：总距离与 R/I/C 三分量同轴（单位一致，均为 km） */
const rmTimeOption = computed<EChartsCoreOption>(() => {
  const s = rm.value?.samples ?? []
  const tcaMs = rm.value?.tcaMs ?? 0
  const xs = s.map((p) => Number(((p.tMs - tcaMs) / 60000).toFixed(2)))
  const mk = (name: string, pick: (p: RelMotionSample) => number, color: string) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    data: s.map((p, i) => [xs[i], pick(p)]),
    lineStyle: { width: 1.6, color },
    itemStyle: { color }
  })
  return {
    backgroundColor: 'transparent',
    grid: { left: 56, right: 18, top: 34, bottom: 38 },
    legend: { top: 0, textStyle: { color: '#9fb3c8', fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => `${v} km` },
    xAxis: {
      type: 'value',
      name: t('rm.axisMin'),
      nameTextStyle: { color: '#7f93a8', fontSize: 11 },
      axisLabel: { color: RM_AXIS_TEXT, fontSize: 11 },
      splitLine: RM_GRID_LINE
    },
    yAxis: {
      type: 'value',
      name: t('rm.axisKm'),
      nameTextStyle: { color: '#7f93a8', fontSize: 11 },
      axisLabel: { color: RM_AXIS_TEXT, fontSize: 11 },
      splitLine: RM_GRID_LINE
    },
    series: [
      {
        ...mk(t('rm.total'), (p) => p.dist, '#e2e8f0'),
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ xAxis: 0 }],
          lineStyle: { color: '#f59e0b', type: 'dashed' },
          label: { formatter: t('rm.tca'), color: '#f59e0b' }
        }
      },
      mk(t('rm.radial'), (p) => p.dR, '#3b82f6'),
      mk(t('rm.intrack'), (p) => p.dI, '#22c55e'),
      mk(t('rm.crosstrack'), (p) => p.dC, '#a855f7')
    ]
  }
})

/** R–I / C–I 平面：横轴均为迹向 I，纵轴为径向 R 或法向 C；TCA 点高亮 */
function rmPlaneOption(xKey: 'dI', yKey: 'dR' | 'dC', yName: string): EChartsCoreOption {
  const s = rm.value?.samples ?? []
  const tcaMs = rm.value?.tcaMs ?? 0
  const tcaPoint = s.reduce<typeof s[number] | null>(
    (best, p) => (!best || Math.abs(p.tMs - tcaMs) < Math.abs(best.tMs - tcaMs) ? p : best),
    null
  )
  return {
    backgroundColor: 'transparent',
    grid: { left: 52, right: 16, top: 30, bottom: 34 },
    tooltip: {
      trigger: 'item',
      valueFormatter: (v: unknown) => `${v} km`
    },
    xAxis: {
      type: 'value',
      name: 'I (km)',
      nameTextStyle: { color: '#7f93a8', fontSize: 11 },
      axisLabel: { color: RM_AXIS_TEXT, fontSize: 11 },
      splitLine: RM_GRID_LINE
    },
    yAxis: {
      type: 'value',
      name: yName,
      nameTextStyle: { color: '#7f93a8', fontSize: 11 },
      axisLabel: { color: RM_AXIS_TEXT, fontSize: 11 },
      splitLine: RM_GRID_LINE
    },
    series: [
      {
        type: 'scatter',
        symbolSize: 5,
        data: s.map((p) => [p[xKey], p[yKey]]),
        itemStyle: { color: '#38bdf8' }
      },
      {
        type: 'scatter',
        symbolSize: 10,
        data: tcaPoint ? [[tcaPoint[xKey], tcaPoint[yKey]]] : [],
        itemStyle: { color: '#f59e0b' },
        z: 3
      }
    ]
  }
}

const rmRiOption = computed<EChartsCoreOption>(() => rmPlaneOption('dI', 'dR', 'R (km)'))
const rmCiOption = computed<EChartsCoreOption>(() => rmPlaneOption('dI', 'dC', 'C (km)'))

/* ------------------------- R2-18 风险演变（多源 Pc / 脱靶随时间） ------------------------- */
const pct = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const riskOption = computed<EChartsCoreOption>(() => {
  // CDM 报文序列（Space-Track / 客户上传）：按报文发布时间排序
  const cdmPc: Array<[number, number]> = []
  const cdmMiss: Array<[number, number]> = []
  for (const c of cdms.value) {
    const t = Date.parse(c.creation_date)
    if (!Number.isFinite(t)) continue
    const pc = pct(c.collision_probability)
    if (pc) cdmPc.push([t, pc])
    if (c.miss_distance_km != null && Number.isFinite(Number(c.miss_distance_km)))
      cdmMiss.push([t, Number(c.miss_distance_km)])
  }
  cdmPc.sort((a, b) => a[0] - b[0])
  cdmMiss.sort((a, b) => a[0] - b[0])
  // 本平台重算 run：取首个可用非官方方法的结果，按 run 创建时刻
  const localPc: Array<[number, number]> = []
  for (const r of rcRuns.value) {
    const t = Date.parse(r.created_at)
    if (!Number.isFinite(t)) continue
    const row = r.rows.find((x) => !x.disabled && x.method !== 'official' && pct(x.pc))
    const pc = row ? pct(row.pc) : null
    if (pc) localPc.push([t, pc])
  }
  localPc.sort((a, b) => a[0] - b[0])

  return {
    backgroundColor: 'transparent',
    grid: { left: 62, right: 58, top: 34, bottom: 38 },
    legend: { top: 0, textStyle: { color: '#9fb3c8', fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    xAxis: {
      type: 'time',
      axisLabel: { color: RM_AXIS_TEXT, fontSize: 11, hideOverlap: true },
      splitLine: RM_GRID_LINE
    },
    yAxis: [
      {
        type: 'log',
        name: 'Pc',
        min: 1e-12,
        nameTextStyle: { color: '#7f93a8', fontSize: 11 },
        axisLabel: { color: RM_AXIS_TEXT, fontSize: 11, formatter: (v: number) => v.toExponential(0) },
        splitLine: RM_GRID_LINE
      },
      {
        type: 'value',
        name: `${t('conj.col.miss')} (km)`,
        nameTextStyle: { color: '#7f93a8', fontSize: 11 },
        axisLabel: { color: RM_AXIS_TEXT, fontSize: 11 },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: t('rk.cdmPc'),
        type: 'line',
        symbolSize: 7,
        data: cdmPc,
        lineStyle: { width: 1.6, color: '#f59e0b' },
        itemStyle: { color: '#f59e0b' }
      },
      {
        name: t('rk.localPc'),
        type: 'scatter',
        symbolSize: 9,
        data: localPc,
        itemStyle: { color: '#38bdf8' }
      },
      {
        name: t('rk.cdmMiss'),
        type: 'line',
        yAxisIndex: 1,
        symbolSize: 5,
        data: cdmMiss,
        lineStyle: { width: 1.2, type: 'dashed', color: '#94a3b8' },
        itemStyle: { color: '#94a3b8' }
      }
    ]
  }
})

/** Pc 多算法比对（E3）：同源输入由服务端统一 TLE 传播，官方 Pc 仅作对照行 */
type I18nKey = Parameters<ReturnType<typeof useI18n>['t']>[0]
const cmpLoading = ref(false)
const cmpError = ref('')
const cmp = ref<PcCompareResult | null>(null)
const methodKeys: Record<PcMethod, I18nKey> = {
  official: 'pc.cmp.m.official',
  foster: 'pc.cmp.m.foster',
  chan: 'pc.cmp.m.chan',
  alfano: 'pc.cmp.m.alfano'
}
const agreeKeys: Record<PcAgreement, I18nKey> = {
  green: 'pc.cmp.agree.green',
  yellow: 'pc.cmp.agree.yellow',
  red: 'pc.cmp.agree.red'
}
function fmtMs(ms: number): string {
  return ms > 0 && ms < 0.01 ? '<0.01' : ms.toFixed(2)
}
async function runCompare(): Promise<void> {
  if (!event.value) return
  cmpLoading.value = true
  cmpError.value = ''
  try {
    // HBR 取成员 CDM 最新提供的值（缺省由服务端按 15m 兜底）；
    // 官方 Pc / miss / relSpeed 用事件聚合口径作对照行
    const hbr = [...cdms.value].reverse().find((c) => c.hard_body_radius_m !== null)?.hard_body_radius_m ?? undefined
    cmp.value = await pcCompare({
      noradA: event.value.noradA,
      noradB: event.value.noradB,
      tcaMs: new Date(event.value.tca).getTime(),
      hbrM: hbr ?? undefined,
      officialPc: event.value.pc ?? undefined,
      officialMissKm: event.value.missKm ?? undefined,
      officialRelSpeedKms: event.value.relSpeedKmS ?? undefined
    })
  } catch (e) {
    cmpError.value = e instanceof Error ? e.message : String(e)
    cmp.value = null
  } finally {
    cmpLoading.value = false
  }
}

const levelKeys: Record<EventLevel, Parameters<ReturnType<typeof useI18n>['t']>[0]> = {
  red: 'conj.high',
  orange: 'conj.warn',
  yellow: 'conj.watch',
  low: 'conj.low'
}
function levelLabel(lv: EventLevel): string {
  return t(levelKeys[lv])
}
function srcLabel(s: string): string {
  return s === 'customer' ? t('conj.src.customer') : t('conj.src.system')
}
function fmtPc(pc: number | null): string {
  if (pc === null) return '—'
  if (pc === 0) return '0'
  return pc.toExponential(2)
}
function fmtTca(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}
function num(v: number | null, digits = 2, suffix = ''): string {
  return v === null ? '—' : `${v.toFixed(digits)}${suffix}`
}

/** 深链：把交会对与 TCA 时刻带给态势页（E4 消费定位与高亮） */
const situationLink = computed(() => {
  if (!event.value) return '/situation'
  const e = event.value
  return `/situation?conj=${e.noradA}-${e.noradB}&tca=${new Date(e.tca).getTime()}`
})

/** CDM 原文弹层 */
const rawOpen = ref(false)
const rawText = ref('')
const rawTitle = ref('')
const rawLoading = ref(false)
async function showRaw(c: CdmMember): Promise<void> {
  rawTitle.value = c.cdm_id ? `CDM ${c.cdm_id}` : `CDM #${c.id}`
  rawOpen.value = true
  rawLoading.value = true
  rawText.value = ''
  try {
    const r = await getCdmRaw(key.value, c.id)
    // 后端存的是 JSON 包装（format + text/data），展示内部原文更直观
    try {
      const parsed = JSON.parse(r.raw) as { format?: string; text?: string; data?: unknown }
      rawText.value = parsed.text ?? JSON.stringify(parsed.data ?? parsed, null, 2)
    } catch {
      rawText.value = r.raw
    }
  } catch (e) {
    rawText.value = e instanceof Error ? e.message : String(e)
  } finally {
    rawLoading.value = false
  }
}

/* ------------------- 碰撞参数与重算（F1）：仅本次编辑 + run 对比 ------------------- */

interface CaFormState {
  hbrMode: HbrMode
  hbrM: number
  hbrAM: number
  hbrBM: number
  acceptedPc: number
  acceptedMissKm: number
  screenDistanceKm: number
  covarianceMode: CovMode
  propagator: Propagator
  windowH: number
  stepS: number
  methods: { foster: boolean; chan: boolean; alfano: boolean }
}
const caForm = reactive<CaFormState>({
  hbrMode: 'single',
  hbrM: 15,
  hbrAM: 15,
  hbrBM: 5,
  acceptedPc: 1e-4,
  acceptedMissKm: 1,
  screenDistanceKm: 10,
  covarianceMode: 'tle-age',
  propagator: 'sgp4',
  windowH: 72,
  stepS: 30,
  methods: { foster: true, chan: true, alfano: false }
})
const caDefaults = ref<CaDefaults | null>(null)
const caOrgReady = ref(false) // 有组织账号（可重算）

/* 第 4 项：参数来源（default / mine1 / mine2 / target） */
const rcParamsSource = ref<'default' | 'mine1' | 'mine2' | 'target'>('default')
const rcSlotReady = ref<Record<number, boolean>>({ 1: false, 2: false })

async function loadCaProfiles() {
  try {
    const r = await getCaProfiles()
    rcSlotReady.value = {
      1: !!r.mine.find((x) => x.slot === 1)?.params,
      2: !!r.mine.find((x) => x.slot === 2)?.params
    }
  } catch {
    /* 未登录 / 无组织：仅默认参数 */
  }
}

function fillCaForm(d: CaDefaults | null): void {
  if (!d) return
  caForm.hbrMode = d.hbr_mode
  caForm.hbrM = d.hbr_m
  caForm.hbrAM = d.hbr_a_m ?? 15
  caForm.hbrBM = d.hbr_b_m ?? 5
  caForm.acceptedPc = d.accepted_pc
  caForm.acceptedMissKm = d.accepted_miss_km
  caForm.screenDistanceKm = d.screen_distance_km
  caForm.covarianceMode = d.covariance_mode
  caForm.propagator = d.propagator
  caForm.windowH = d.window_h
  caForm.stepS = d.step_s
  const list = d.pc_methods.split(',').map((s) => s.trim())
  caForm.methods.foster = list.includes('foster')
  caForm.methods.chan = list.includes('chan')
  caForm.methods.alfano = list.includes('alfano')
}

/** 重算结果（最新一次） */
const rcLoading = ref(false)
const rcError = ref('')
const rcResult = ref<RecomputeResult | null>(null)
const rcRuns = ref<PcRun[]>([])
const runsOpen = ref(false)

async function loadRuns(): Promise<void> {
  if (!caOrgReady.value) return
  try {
    rcRuns.value = (await listRecomputeRuns(key.value)).runs
  } catch {
    rcRuns.value = []
  }
}

async function loadCaContext(): Promise<void> {
  try {
    const resp = await getCaDefaults()
    caDefaults.value = resp.defaults
    fillCaForm(resp.defaults)
    caOrgReady.value = true
    void loadRuns()
  } catch (e) {
    if (e instanceof AuthError && e.httpStatus === 401) {
      // 未登录：保留系统缺省表单，提示登录后可重算
      caOrgReady.value = false
    } else {
      // 组织账号但非管理员等：默认值仍可读（403 = 平台账号），回落系统缺省
      caOrgReady.value = !(e instanceof AuthError && e.httpStatus === 403)
    }
  }
}

function caMethodsList(): Array<'foster' | 'chan' | 'alfano'> {
  const list: Array<'foster' | 'chan' | 'alfano'> = []
  if (caForm.methods.foster) list.push('foster')
  if (caForm.methods.chan) list.push('chan')
  if (caForm.methods.alfano) list.push('alfano')
  return list
}

/** 按此配置重算：生成新 run_id，刷新 run 历史 */
async function runRecompute(): Promise<void> {
  if (!event.value || rcLoading.value) return
  if (!caOrgReady.value) {
    rcError.value = t('ca.detailNeedLogin')
    return
  }
  const useProfile = rcParamsSource.value !== 'default'
  if (!useProfile && !caMethodsList().length) {
    rcError.value = t('ca.err.noMethod')
    return
  }
  rcLoading.value = true
  rcError.value = ''
  try {
    // 参数解析顺序（服务端）：指定参数档案（个人 2 组 / 目标自定义）或本次表单 > 组织默认 > 系统缺省
    const official = {
      officialPc: event.value.pc,
      officialMissKm: event.value.missKm,
      officialRelSpeedKms: event.value.relSpeedKmS
    }
    rcResult.value = await recomputeEvent(
      key.value,
      useProfile
        ? { paramsSource: rcParamsSource.value, ...official }
        : {
            hbrMode: caForm.hbrMode,
            hbrM: caForm.hbrM,
            hbrAM: caForm.hbrAM,
            hbrBM: caForm.hbrBM,
            acceptedPc: caForm.acceptedPc,
            acceptedMissKm: caForm.acceptedMissKm,
            screenDistanceKm: caForm.screenDistanceKm,
            covarianceMode: caForm.covarianceMode,
            propagator: caForm.propagator,
            windowH: caForm.windowH,
            stepS: caForm.stepS,
            methods: caMethodsList(),
            ...official
          }
    )
    void loadRuns()
  } catch (e) {
    rcError.value = e instanceof Error ? e.message : String(e)
    rcResult.value = null
  } finally {
    rcLoading.value = false
  }
}

/** run 判定：Pc 与 miss 相对接受阈值的安全侧/危险侧 */
function runVerdict(
  params: RecomputeResult['run']['params'] | null,
  rows: PcRun['rows']
): { pcExceed: boolean | null; missBelow: boolean | null } {
  if (!params) return { pcExceed: null, missBelow: null }
  const pcs = rows.filter((r) => r.method !== 'official' && !r.disabled && r.pc !== null).map((r) => r.pc as number)
  const pcMax = pcs.length ? Math.max(...pcs) : null
  const miss = rows.find((r) => r.method !== 'official' && !r.disabled && r.missKm !== null)?.missKm ?? null
  return {
    pcExceed: pcMax === null ? null : pcMax >= params.accepted_pc,
    missBelow: miss === null ? null : miss < params.accepted_miss_km
  }
}
function caMethodLabel(m: PcMethod): string {
  return t(methodKeys[m])
}
/** run 内各重算方法的最大 Pc（官方对照行不参与） */
function maxMethodPc(run: PcRun): number | null {
  const pcs = run.rows
    .filter((r) => r.method !== 'official' && !r.disabled && r.pc !== null)
    .map((r) => r.pc as number)
  return pcs.length ? Math.max(...pcs) : null
}
function fmtWhen(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}

/* ------------------- 事件包导出（H1）：Markdown / HTML 打印 / CSV ------------------- */

import { useAuthStore } from '@/stores/auth'
import {
  buildMarkdown,
  buildPrintableHtml,
  buildTimelineCsv,
  downloadText,
  exportBaseName,
  type ExportEventCtx
} from './exportEvent'

const auth = useAuthStore()
const expOpen = ref(false)
const expWrap = ref<HTMLElement | null>(null)

/** 点外关闭（不拦截外部点击，语言切换等按钮首点即生效） */
function onDocClick(e: MouseEvent): void {
  if (expWrap.value && !expWrap.value.contains(e.target as Node)) expOpen.value = false
}
watch(expOpen, (v) => {
  if (v) document.addEventListener('click', onDocClick)
  else document.removeEventListener('click', onDocClick)
})
onUnmounted(() => document.removeEventListener('click', onDocClick))

function expCtx(): ExportEventCtx {
  return {
    event: event.value!,
    cdms: cdms.value,
    primary: primary.value,
    secondary: secondary.value,
    cmp: cmp.value,
    cmpError: cmpError.value,
    runs: rcRuns.value,
    t,
    locale: locale.value,
    exportedBy: auth.user?.email ?? '',
    generatedAt: new Date().toISOString()
  }
}

function doExport(kind: 'md' | 'html' | 'csv'): void {
  if (!event.value) return
  const ctx = expCtx()
  const base = exportBaseName(event.value)
  if (kind === 'md') {
    downloadText(`${base}.md`, buildMarkdown(ctx), 'text/markdown;charset=utf-8')
  } else if (kind === 'html') {
    downloadText(`${base}.html`, buildPrintableHtml(ctx), 'text/html;charset=utf-8')
  } else {
    downloadText(`${base}.csv`, buildTimelineCsv(ctx), 'text/csv;charset=utf-8')
  }
  expOpen.value = false
}
</script>

<template>
  <div v-if="loading" class="page"><section class="state">{{ t('obj.loading') }}</section></div>
  <div v-else-if="!event" class="page">
    <p class="state error">{{ error || t('conj.notFound') }}</p>
    <button type="button" class="btn" @click="router.push('/conjunctions')">{{ t('conj.backList') }}</button>
  </div>
  <div v-else class="page">
    <header class="head">
      <div>
        <button type="button" class="link" @click="router.push('/conjunctions')">{{ t('conj.back') }}</button>
        <h1>
          <span
            class="pill"
            :class="event.level"
            :title="event.levelBasis === 'miss' ? t('conj.missBasis') : undefined"
          >{{ levelLabel(event.level) }}</span>
          {{ event.nameA || `NORAD ${event.noradA}` }} × {{ event.nameB || `NORAD ${event.noradB}` }}
        </h1>
        <p>
          TCA {{ fmtTca(event.tca) }} UTC · {{ t('conj.col.cdm') }} {{ event.cdmCount }}
          <template v-if="event.tcaSpanH > 0"> · {{ t('conj.span') }} {{ event.tcaSpanH }}h</template>
          · {{ event.sources.map(srcLabel).join(' + ') }}
        </p>
      </div>
      <div class="actions">
        <div ref="expWrap" class="exp-wrap">
          <button type="button" class="btn" @click="expOpen = !expOpen">
            {{ t('exp.menu') }} <span class="caret">{{ expOpen ? '▴' : '▾' }}</span>
          </button>
          <div v-if="expOpen" class="exp-menu">
            <button type="button" @click="doExport('md')">{{ t('exp.md') }}</button>
            <button type="button" @click="doExport('html')">{{ t('exp.html') }}</button>
            <button type="button" @click="doExport('csv')">{{ t('exp.csv') }}</button>
          </div>
        </div>
        <a class="btn primary" :href="situationLink" @click.prevent="router.push(situationLink)">
          {{ t('conj.openSituation') }}
        </a>
      </div>
    </header>

    <section class="kpi">
      <div class="card">
        <div class="k">{{ t('conj.col.pc') }}</div>
        <div class="v mono">{{ fmtPc(event.pc) }}</div>
        <div class="sub">{{ event.pcSource ? srcLabel(event.pcSource) : '—' }}</div>
      </div>
      <div class="card"><div class="k">{{ t('conj.missDist') }}</div><div class="v mono">{{ num(event.missKm, 3) }} km</div></div>
      <div class="card">
        <div class="k">{{ t('conj.relVel') }}</div>
        <div v-if="event.relSpeedKmS != null" class="v mono">{{ num(event.relSpeedKmS, 2) }} km/s</div>
        <div v-else class="v sm">{{ t('conj.relVelNa') }}</div>
      </div>
      <div class="card"><div class="k">TCA</div><div class="v mono sm">{{ fmtTca(event.tca) }}</div></div>
    </section>

    <section class="grid">
      <aside class="panel">
        <div class="ph">{{ t('conj.primaryObj') }}</div>
        <div class="obj-name">{{ primary?.object_name || `NORAD ${event.noradA}` }}</div>
        <dl v-if="primary" class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ primary.norad_id }}</dd></div>
          <div><dt>{{ t('obj.type') }}</dt><dd>{{ primary.object_type }}</dd></div>
          <div><dt>{{ t('obj.regime') }}</dt><dd>{{ primary.regime }}</dd></div>
          <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ primary.epoch ? fmtTca(String(primary.epoch)) : '—' }}</dd></div>
          <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ num(primary.incl, 2, '°') }}</dd></div>
          <div><dt>{{ t('conj.perigee') }}</dt><dd class="mono">{{ num(primary.perigee, 0) }}</dd></div>
          <div><dt>{{ t('conj.apogee') }}</dt><dd class="mono">{{ num(primary.apogee, 0) }}</dd></div>
          <div><dt>{{ t('conj.period') }}</dt><dd class="mono">{{ num(primary.period, 1) }}</dd></div>
        </dl>
        <p v-else class="dim">{{ t('conj.notFound') }}</p>
        <RouterLink class="btn" to="/objects">{{ t('conj.viewObjects') }}</RouterLink>
      </aside>

      <aside class="panel">
        <div class="ph">{{ t('conj.secondaryObj') }}</div>
        <div class="obj-name">{{ secondary?.object_name || `NORAD ${event.noradB}` }}</div>
        <dl v-if="secondary" class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ secondary.norad_id }}</dd></div>
          <div><dt>{{ t('obj.type') }}</dt><dd>{{ secondary.object_type }}</dd></div>
          <div><dt>{{ t('obj.regime') }}</dt><dd>{{ secondary.regime }}</dd></div>
          <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ secondary.epoch ? fmtTca(String(secondary.epoch)) : '—' }}</dd></div>
          <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ num(secondary.incl, 2, '°') }}</dd></div>
          <div><dt>{{ t('conj.perigee') }}</dt><dd class="mono">{{ num(secondary.perigee, 0) }}</dd></div>
          <div><dt>{{ t('conj.apogee') }}</dt><dd class="mono">{{ num(secondary.apogee, 0) }}</dd></div>
          <div><dt>{{ t('conj.period') }}</dt><dd class="mono">{{ num(secondary.period, 1) }}</dd></div>
        </dl>
        <p v-else class="dim">{{ t('conj.notFound') }}</p>
        <RouterLink v-if="secondary" class="btn" to="/objects">{{ t('conj.viewObjects') }}</RouterLink>
      </aside>

      <section class="panel wide">
        <div class="ph">{{ t('conj.timeline') }}</div>
        <div class="tl">
          <table>
            <thead>
              <tr>
                <th>{{ t('conj.col.tca') }}</th>
                <th>{{ t('conj.col.pc') }}</th>
                <th>{{ t('conj.col.miss') }}</th>
                <th>{{ t('conj.relVel') }}</th>
                <th>{{ t('conj.hbr') }}</th>
                <th>{{ t('conj.originator') }}</th>
                <th>{{ t('conj.created') }}</th>
                <th>{{ t('conj.col.source') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in cdms" :key="c.id">
                <td class="mono">{{ fmtTca(c.tca) }}</td>
                <td class="mono">{{ fmtPc(c.collision_probability) }}</td>
                <td class="mono">{{ num(c.miss_distance_km, 2) }}</td>
                <td class="mono">{{ num(c.rel_speed_km_per_s, 2) }}</td>
                <td class="mono">{{ num(c.hard_body_radius_m, 2) }}</td>
                <td>{{ c.originator || '—' }}</td>
                <td class="mono">{{ c.creation_date ? fmtTca(c.creation_date) : '—' }}</td>
                <td><span class="pill" :class="c.source === 'customer' ? 'yellow' : 'low'">{{ srcLabel(c.source) }}</span></td>
                <td><button type="button" class="btn sm" @click="showRaw(c)">{{ t('conj.raw') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="note">{{ t('conj.note') }}</p>
      </section>

      <section class="panel wide">
        <div class="ph cmp-head">
          <span>{{ t('pc.cmp.title') }}</span>
          <span v-if="cmp" class="lamp" :class="cmp.agreement">
            <i class="dot"></i>{{ t(agreeKeys[cmp.agreement]) }}
          </span>
          <button type="button" class="btn sm" :disabled="cmpLoading" @click="runCompare">
            {{ t('pc.cmp.run') }}
          </button>
        </div>
        <p class="note">{{ t('pc.cmp.desc') }}</p>
        <p v-if="cmpError" class="state error inline">{{ cmpError }}</p>
        <div v-else-if="cmpLoading" class="dim">{{ t('obj.loading') }}</div>
        <div v-else-if="cmp" class="tl">
          <table>
            <thead>
              <tr>
                <th>{{ t('pc.cmp.col.method') }}</th>
                <th>{{ t('conj.col.pc') }}</th>
                <th>{{ t('conj.col.miss') }}</th>
                <th>{{ t('conj.col.tca') }}</th>
                <th>{{ t('conj.hbr') }} (m)</th>
                <th>{{ t('pc.cmp.col.cov') }}</th>
                <th>{{ t('pc.cmp.col.ms') }} (ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in cmp.rows" :key="r.method" :class="{ off: r.disabled }">
                <td>
                  {{ t(methodKeys[r.method]) }}
                  <span v-if="r.disabled" class="dim">— {{ r.note }}</span>
                </td>
                <td class="mono strong">{{ fmtPc(r.pc) }}</td>
                <td class="mono">{{ num(r.missKm, 3) }}</td>
                <td class="mono">{{ fmtTca(r.tca) }}</td>
                <td class="mono">{{ num(r.hbrM, 1) }}</td>
                <td>{{ r.covSource === 'tle-age' ? t('pc.cmp.cov.tleAge') : r.covSource === 'cdm' ? t('pc.cmp.cov.cdm') : '—' }}</td>
                <td class="mono">{{ r.method === 'official' ? '—' : fmtMs(r.ms) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="note">
            <template v-if="cmp.plane">
              {{ t('pc.cmp.inPlane') }} {{ cmp.plane.inPlaneKm.toFixed(3) }} km ·
              {{ t('conj.relVel') }} {{ cmp.plane.relSpeedKms.toFixed(2) }} km/s
            </template>
            <template v-if="cmp.cov">
              · {{ t('pc.cmp.sigmaT') }} {{ cmp.cov.sigmaT.map((x) => x.toFixed(1)).join(' / ') }} km ·
              {{ t('pc.cmp.age') }} {{ cmp.cov.ageHours.map((x) => x.toFixed(1)).join(' / ') }} h
            </template>
          </p>
        </div>
      </section>
      <!-- R2-18：风险演变（CDM 报文 + 本平台重算的 Pc / 脱靶随时间） -->
      <section class="panel wide">
        <div class="ph">
          <span>{{ t('rk.title') }}</span>
          <span class="dim-tag">{{ t('rk.sources') }}</span>
        </div>
        <p class="note">{{ t('rk.desc') }}</p>
        <EChart v-if="cdms.length || rcRuns.length" :option="riskOption" :height="260" />
        <p v-else class="dim">{{ t('rk.empty') }}</p>
      </section>
      <!-- R2-16：相对运动（TCA 附近距离—时间 + R–I / C–I 平面） -->
      <section class="panel wide">
        <div class="ph">
          <span>{{ t('rm.title') }}</span>
          <span v-if="rm" class="dim-tag">±{{ rm.minutes }} min · {{ rm.source }}</span>
        </div>
        <p class="note">{{ t('rm.desc') }}</p>
        <p v-if="rmLoading" class="dim">{{ t('rm.loading') }}</p>
        <p v-else-if="rmError" class="state error inline">{{ rmError }}</p>
        <template v-else-if="rm && rm.samples.length">
          <div class="rm-title">{{ t('rm.distTime') }}</div>
          <EChart :option="rmTimeOption" :height="240" />
          <div class="rm-planes">
            <div>
              <div class="rm-title">{{ t('rm.planeRI') }}</div>
              <EChart :option="rmRiOption" :height="220" />
            </div>
            <div>
              <div class="rm-title">{{ t('rm.planeCI') }}</div>
              <EChart :option="rmCiOption" :height="220" />
            </div>
          </div>
        </template>
        <p v-else class="dim">{{ t('rm.noTle') }}</p>
      </section>
      <!-- F1：碰撞参数与重算（仅本次 + run 对比） -->
      <section class="panel wide">
        <div class="ph">
          <span>{{ t('ca.detailTitle') }}</span>
          <span class="dim-tag">{{ t('ca.onceOnly') }}</span>
          <button type="button" class="btn primary sm" :disabled="rcLoading || !caOrgReady" @click="runRecompute">
            {{ rcLoading ? t('ca.recomputing') : t('ca.recompute') }}
          </button>
        </div>
        <p class="note">{{ t('ca.detailDesc') }}</p>

        <!-- 参数编辑（仅本次） -->
        <div class="ca-form">
          <label class="cf field">
            <span class="lbl">参数来源</span>
            <span class="row">
              <select v-model="rcParamsSource">
                <option value="default">默认参数（组织）</option>
                <option value="mine1" :disabled="!rcSlotReady[1]">我的参数组 1{{ rcSlotReady[1] ? '' : '（未配置）' }}</option>
                <option value="mine2" :disabled="!rcSlotReady[2]">我的参数组 2{{ rcSlotReady[2] ? '' : '（未配置）' }}</option>
                <option value="target">目标自定义参数（业主）</option>
              </select>
            </span>
          </label>
          <div v-if="rcParamsSource !== 'default'" class="cf-hint">
            使用所选参数档案重算，下方手动参数不再生效（结果摘要会回显实际生效值）。
          </div>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.hbrMode') }}</span>
            <span class="row">
              <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="single" :disabled="rcParamsSource !== 'default'" /> {{ t('ca.single') }}</label>
              <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="both" :disabled="rcParamsSource !== 'default'" /> {{ t('ca.both') }}</label>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ caForm.hbrMode === 'both' ? `${t('ca.f.hbr')} (A / B)` : t('ca.f.hbr') }}</span>
            <span v-if="caForm.hbrMode === 'both'" class="row">
              <input v-model.number="caForm.hbrAM" type="number" min="0.1" max="1000" step="0.1" :disabled="rcParamsSource !== 'default'" /> /
              <input v-model.number="caForm.hbrBM" type="number" min="0.1" max="1000" step="0.1" :disabled="rcParamsSource !== 'default'" /> m
            </span>
            <span v-else class="row">
              <input v-model.number="caForm.hbrM" type="number" min="1" max="1000" step="1" :disabled="rcParamsSource !== 'default'" /> m
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.acceptedPc') }}</span>
            <span class="row"><input v-model.number="caForm.acceptedPc" type="number" min="1e-9" max="1" step="1e-5" :disabled="rcParamsSource !== 'default'" /></span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.acceptedMiss') }}</span>
            <span class="row"><input v-model.number="caForm.acceptedMissKm" type="number" min="0.01" max="100" step="0.1" :disabled="rcParamsSource !== 'default'" /> km</span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.screenDist') }}</span>
            <span class="row"><input v-model.number="caForm.screenDistanceKm" type="number" min="0.5" max="100" step="0.5" :disabled="rcParamsSource !== 'default'" /> km</span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.covMode') }}</span>
            <span class="row">
              <select v-model="caForm.covarianceMode">
                <option value="tle-age">{{ t('ca.covTleAge') }}</option>
                <option value="cdm">CDM</option>
              </select>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.propagator') }}</span>
            <span class="row">
              <select v-model="caForm.propagator">
                <option value="sgp4">SGP4</option>
                <option value="numeric">{{ t('ca.propNumeric') }}</option>
              </select>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.windowStep') }}</span>
            <span class="row">
              <input v-model.number="caForm.windowH" type="number" min="1" max="168" step="1" /> h /
              <input v-model.number="caForm.stepS" type="number" min="1" max="3600" step="1" /> s
            </span>
          </label>
          <div class="cf field">
            <span class="lbl">{{ t('ca.f.methods') }}</span>
            <span class="row">
              <label class="radio"><input v-model="caForm.methods.foster" type="checkbox" /> Foster</label>
              <label class="radio"><input v-model="caForm.methods.chan" type="checkbox" /> Chan</label>
              <label class="radio"><input v-model="caForm.methods.alfano" type="checkbox" /> Alfano</label>
            </span>
          </div>
          <div class="cf field">
            <span class="lbl">{{ t('ca.f.orgDefaults') }}</span>
            <span class="row org-link">
              <template v-if="caDefaults">
                {{ caDefaults.updated_at.replace('T', ' ').slice(0, 16) }} ({{ caDefaults.updated_by }})
              </template>
              <template v-else-if="caOrgReady">{{ t('ca.notSet') }}</template>
              <template v-else>—</template>
              <RouterLink to="/settings">{{ t('ca.goSettings') }}</RouterLink>
            </span>
          </div>
        </div>

        <p v-if="!caOrgReady" class="note warn">{{ t('ca.detailNeedLogin') }}</p>
        <p v-if="rcError" class="state error inline">{{ rcError }}</p>

        <!-- 最新 run 结果 -->
        <template v-if="rcResult">
          <div class="rc-head">
            <span class="run-chip">{{ t('ca.runId') }} #{{ rcResult.run.id }}</span>
            <span v-if="rcResult.run.params" class="mono dim">
              HBR {{ rcResult.run.params.hbr_m }}m · {{ t('ca.f.acceptedPc') }} {{ rcResult.run.params.accepted_pc.toExponential(0) }} ·
              {{ t('ca.f.acceptedMiss') }} {{ rcResult.run.params.accepted_miss_km }}km
            </span>
            <span class="lamp" :class="rcResult.agreement"><i class="dot"></i>{{ t(agreeKeys[rcResult.agreement]) }}</span>
          </div>
          <p v-if="rcResult.notes.length" class="note warn">{{ rcResult.notes.join(' · ') }}</p>
          <p v-if="rcResult.disableNote" class="note warn">{{ rcResult.disableNote }}</p>
          <div class="tl">
            <table>
              <thead>
                <tr>
                  <th>{{ t('pc.cmp.col.method') }}</th>
                  <th>{{ t('conj.col.pc') }}</th>
                  <th>{{ t('conj.col.miss') }}</th>
                  <th>{{ t('conj.hbr') }} (m)</th>
                  <th>{{ t('pc.cmp.col.cov') }}</th>
                  <th>{{ t('pc.cmp.col.ms') }} (ms)</th>
                  <th>{{ t('ca.verdict') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rcResult.rows" :key="r.method" :class="{ off: r.disabled }">
                  <td>{{ caMethodLabel(r.method) }}<span v-if="r.disabled" class="dim">— {{ r.note }}</span></td>
                  <td class="mono strong">{{ fmtPc(r.pc) }}</td>
                  <td class="mono">{{ num(r.missKm, 3) }}</td>
                  <td class="mono">{{ num(r.hbrM, 1) }}</td>
                  <td>{{ r.covSource === 'tle-age' ? t('pc.cmp.cov.tleAge') : r.covSource === 'cdm' ? t('pc.cmp.cov.cdm') : '—' }}</td>
                  <td class="mono">{{ r.method === 'official' ? '—' : fmtMs(r.ms) }}</td>
                  <td v-if="r.method === 'official'" class="dim">—</td>
                  <td v-else class="mono">
                    <span v-if="r.pc !== null && rcResult.run.params" :class="r.pc >= rcResult.run.params.accepted_pc ? 'vd-bad' : 'vd-ok'">
                      {{ r.pc >= rcResult.run.params.accepted_pc ? t('ca.pcExceed') : t('ca.pcOk') }}
                    </span>
                    <span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="rcResult.plane && rcResult.run.params" class="note">
            <span :class="rcResult.plane.inPlaneKm < rcResult.run.params.accepted_miss_km ? 'vd-bad' : 'vd-ok'">
              {{ rcResult.plane.inPlaneKm < rcResult.run.params.accepted_miss_km ? t('ca.missBelow') : t('ca.missOk') }}
            </span>
            ({{ t('pc.cmp.inPlane') }} {{ rcResult.plane.inPlaneKm.toFixed(3) }} km /
            {{ t('ca.f.acceptedMiss') }} {{ rcResult.run.params.accepted_miss_km }} km)
          </p>
        </template>

        <!-- run 历史（旧 run 对比） -->
        <div class="runs-head">
          <button type="button" class="btn sm" @click="runsOpen = !runsOpen">
            {{ runsOpen ? '▾' : '▸' }} {{ t('ca.runHistory') }} ({{ rcRuns.length }})
          </button>
        </div>
        <div v-if="runsOpen" class="tl">
          <div v-if="!caOrgReady" class="note">{{ t('ca.detailNeedLogin') }}</div>
          <div v-else-if="!rcRuns.length" class="note">{{ t('ca.noRuns') }}</div>
          <table v-else>
            <thead>
              <tr>
                <th>run_id</th>
                <th>{{ t('ca.col.time') }}</th>
                <th>{{ t('ca.col.by') }}</th>
                <th>HBR</th>
                <th>{{ t('conj.col.pc') }} ({{ t('ca.col.official') }} / {{ t('ca.methodsMax') }})</th>
                <th>{{ t('pc.cmp.agreement') }}</th>
                <th>{{ t('ca.verdict') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in rcRuns" :key="run.id">
                <td class="mono strong">#{{ run.id }}</td>
                <td class="mono">{{ fmtWhen(run.created_at) }}</td>
                <td>{{ run.triggered_by }}</td>
                <td class="mono">{{ run.params?.hbr_m ?? '—' }} m</td>
                <td class="mono">
                  {{ fmtPc(run.rows.find((r) => r.method === 'official')?.pc ?? null) }} /
                  {{ fmtPc(maxMethodPc(run)) }}
                </td>
                <td>
                  <span v-if="run.agreement" class="lamp" :class="run.agreement"><i class="dot"></i></span>
                  <span v-else>—</span>
                </td>
                <td class="mono">
                  <template v-if="runVerdict(run.params, run.rows).pcExceed !== null">
                    <span :class="runVerdict(run.params, run.rows).pcExceed ? 'vd-bad' : 'vd-ok'">
                      {{ runVerdict(run.params, run.rows).pcExceed ? t('ca.pcExceed') : t('ca.pcOk') }}
                    </span>
                    <span v-if="runVerdict(run.params, run.rows).missBelow !== null" :class="runVerdict(run.params, run.rows).missBelow ? 'vd-bad' : 'vd-ok'">
                      · {{ runVerdict(run.params, run.rows).missBelow ? t('ca.missBelow') : t('ca.missOk') }}
                    </span>
                  </template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>

    <!-- 原文弹层 -->
    <div v-if="rawOpen" class="modal-mask" @click.self="rawOpen = false">
      <div class="modal">
        <div class="mh">{{ rawTitle }}</div>
        <pre class="raw">{{ rawLoading ? t('obj.loading') : rawText }}</pre>
        <div class="mfoot">
          <button type="button" class="btn" @click="rawOpen = false">{{ t('conj.backList') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; overflow: auto; padding: 12px 14px 40px;
  display: flex; flex-direction: column; gap: 12px;
}
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.link {
  appearance: none; border: none; background: transparent; color: var(--accent-strong);
  font-size: 12px; cursor: pointer; padding: 0; margin-bottom: 6px;
}
h1 {
  margin: 0; font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.actions { display: flex; gap: 6px; }
.btn.primary.sm { margin-left: auto; }

/* H1 事件包导出下拉 */
.exp-wrap { position: relative; }
.exp-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 41; min-width: 180px;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 4px; display: flex; flex-direction: column; gap: 2px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.exp-menu button {
  appearance: none; border: none; background: transparent; color: var(--text-muted);
  text-align: left; font-size: 12px; padding: 6px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap;
}
.exp-menu button:hover { background: var(--bg-panel-2); color: var(--text); }
.caret { font-size: 9px; color: var(--text-dim); }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  display: inline-block; text-decoration: none;
}
.btn:hover { color: var(--text); }
.btn.primary { color: var(--accent-strong); border-color: var(--accent-strong); }
.btn.sm { padding: 3px 8px; font-size: 11px; }
.pill {
  font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-muted); font-weight: 650;
}
.pill.red { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.pill.orange { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.pill.yellow { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pill.low { color: var(--text-dim); }

.kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.card {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
}
.k { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.v { margin-top: 4px; font-size: 18px; font-weight: 650; color: var(--text); }
.v.sm { font-size: 13px; }
.sub { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.panel {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
}
.panel.wide { grid-column: 1 / -1; }
.ph { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.obj-name { font-size: 14px; font-weight: 650; margin-bottom: 10px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
.kv div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
}
.kv dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.kv dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; }
.dim { color: var(--text-dim); font-size: 12px; }

.tl { overflow-x: auto; }
.tl table { width: 100%; border-collapse: collapse; font-size: 11px; }
.tl th {
  text-align: left; padding: 8px 10px; color: var(--text-dim); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.tl td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tl td.strong { font-weight: 650; }
.tl tr.off td { color: var(--text-dim); }
.cmp-head { display: flex; align-items: center; gap: 10px; }
.lamp {
  display: inline-flex; align-items: center; gap: 5px; font-size: 10px; text-transform: none;
  letter-spacing: 0; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border);
}
.lamp .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.lamp.green .dot { background: var(--ok, #63b463); }
.lamp.yellow .dot { background: var(--watch); }
.lamp.red .dot { background: var(--danger); }
.state.inline { margin: 8px 0 0; padding: 8px 10px; display: block; }
.note { margin: 10px 0 0; font-size: 10px; color: var(--text-dim); }
.note.warn { color: var(--warn); }

/* R2-16 相对运动 */
.rm-title { margin: 12px 0 4px; font-size: 12px; color: var(--text-dim); }
.rm-planes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) {
  .rm-planes { grid-template-columns: 1fr; }
}

/* F1 碰撞参数与重算 */
.dim-tag {
  font-size: 9px; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 3px; padding: 1px 5px; white-space: nowrap;
}
.btn.primary.sm { margin-left: auto; }
.ca-form {
  margin-top: 10px; display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 8px 14px; align-items: end;
}
.ca-form .field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cf-hint { grid-column: 1 / -1; font-size: 10px; color: var(--text-dim); line-height: 1.5; }
.ca-form .lbl { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em; }
.ca-form .row { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); flex-wrap: wrap; }
.ca-form input[type='number'],
.ca-form select {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 4px 6px; font-size: 11px;
  font-family: var(--mono); outline: none; width: 76px;
}
.ca-form input:focus, .ca-form select:focus { border-color: var(--accent); }
.radio { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-muted); }
.org-link { gap: 8px; }
.org-link a { color: var(--accent-strong); font-size: 11px; text-decoration: none; }
.org-link a:hover { text-decoration: underline; }
.rc-head { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.run-chip {
  font-family: var(--mono); font-size: 11px; font-weight: 650; color: var(--accent-strong);
  border: 1px solid rgba(74, 125, 154, 0.4); border-radius: 3px; padding: 2px 8px;
}
.rc-head .dim { font-size: 10px; }
.runs-head { margin-top: 12px; }
.vd-ok { color: var(--ok, #63b463); font-size: 10px; }
.vd-bad { color: var(--danger); font-size: 10px; }
@media (max-width: 1280px) {
  .ca-form { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
}
@media (max-width: 900px) {
  .ca-form { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
}

.state {
  flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-dim); font-size: 12px;
}
.state.error { color: var(--danger); }

.modal-mask {
  position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: 720px; max-width: 100%; max-height: 84vh; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 10px; padding: 16px;
}
.mh { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
.raw {
  margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-all;
  background: var(--bg-deep); border: 1px solid var(--border); border-radius: 6px; padding: 10px;
  font-size: 11px; font-family: var(--mono); color: var(--text);
}
.mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
