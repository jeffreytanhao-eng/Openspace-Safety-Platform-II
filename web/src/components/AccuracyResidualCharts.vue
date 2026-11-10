<script setup lang="ts">
/**
 * 精度对比图：所选 RTN 分量的残差时序、CDF，以及（若有龄期协方差）一维马氏距离²。
 * 预报时效在前端按采样点的预报龄期过滤，不回退到整段重叠。
 */
import { computed, ref } from 'vue'
import type { EChartsCoreOption } from 'echarts/core'
import EChart from '@/components/EChart.vue'
import { useI18n } from '@/composables/useI18n'
import type { AccuracyCompareResult, AccuracyPoint } from '@/api/ephemerides'

type AxisKey = 'radial' | 'along' | 'cross'
type HorizonKey = 'full' | '3' | '6' | '12' | '24'

const HORIZON_BIN_MS = 45 * 60 * 1000
const MIN_POINTS = 3
const AXIS_FIELD: Record<AxisKey, keyof Pick<AccuracyPoint, 'radialKm' | 'alongKm' | 'crossKm'>> = {
  radial: 'radialKm',
  along: 'alongKm',
  cross: 'crossKm'
}
const SIGMA_FIELD: Record<AxisKey, keyof Pick<AccuracyPoint, 'sigmaRadialKm' | 'sigmaAlongKm' | 'sigmaCrossKm'>> = {
  radial: 'sigmaRadialKm',
  along: 'sigmaAlongKm',
  cross: 'sigmaCrossKm'
}

const AXIS_TEXT = '#8fa3b8'
const GRID = { lineStyle: { color: 'rgba(120, 150, 180, 0.12)' } }
const LINE = '#5b9bb8'
const MUTED = '#7a8696'

const props = defineProps<{ result: AccuracyCompareResult }>()
const { t } = useI18n()

const axis = ref<AxisKey>('radial')
const horizon = ref<HorizonKey>('full')

const horizons: HorizonKey[] = ['full', '3', '6', '12', '24']

function horizonLabel(h: HorizonKey): string {
  if (h === 'full') return t('acc.horizonFull')
  if (h === '3') return t('acc.horizon3h')
  if (h === '6') return t('acc.horizon6h')
  if (h === '12') return t('acc.horizon12h')
  return t('acc.horizon24h')
}

function axisLabel(a: AxisKey): string {
  if (a === 'radial') return t('acc.axisR')
  if (a === 'along') return t('acc.axisT')
  return t('acc.axisN')
}

function predSource(r: AccuracyCompareResult): AccuracyCompareResult['a'] {
  const aRoot = r.a.kind === 'tle' || r.a.kind === 'aoe'
  const bRoot = r.b.kind === 'tle' || r.b.kind === 'aoe'
  if (aRoot && !bRoot) return r.a
  if (bRoot && !aRoot) return r.b
  const aT = r.a.epochMs || r.a.startMs || 0
  const bT = r.b.epochMs || r.b.startMs || 0
  return aT <= bT ? r.a : r.b
}

function predRefMs(src: AccuracyCompareResult['a']): number {
  if (src.kind === 'tle' || src.kind === 'aoe') return src.epochMs
  return src.startMs || src.epochMs
}

const pred = computed(() => predSource(props.result))
const predRef = computed(() => predRefMs(pred.value))

const displayed = computed<AccuracyPoint[]>(() => {
  const pts = props.result.points
  if (horizon.value === 'full') return pts
  const ref = predRef.value
  if (!ref) return []
  const target = Number(horizon.value) * 3600_000
  return pts.filter((p) => Math.abs(p.tMs - ref - target) <= HORIZON_BIN_MS)
})

const enough = computed(() => displayed.value.length >= MIN_POINTS)

interface RmsView {
  radialKm: number
  alongKm: number
  crossKm: number
  totalKm: number
  maxKm: number
  meanKm: number
}

function rmsOf(points: AccuracyPoint[]): RmsView | null {
  const n = points.length
  if (n < MIN_POINTS) return null
  let sumR = 0
  let sumA = 0
  let sumC = 0
  let sumD = 0
  let maxD = 0
  for (const p of points) {
    sumR += p.radialKm * p.radialKm
    sumA += p.alongKm * p.alongKm
    sumC += p.crossKm * p.crossKm
    sumD += p.distKm
    if (p.distKm > maxD) maxD = p.distKm
  }
  return {
    radialKm: Math.sqrt(sumR / n),
    alongKm: Math.sqrt(sumA / n),
    crossKm: Math.sqrt(sumC / n),
    totalKm: Math.sqrt((sumR + sumA + sumC) / n),
    maxKm: maxD,
    meanKm: sumD / n
  }
}

const viewRms = computed(() => (enough.value ? rmsOf(displayed.value) : null))
const fullRms = computed(() => rmsOf(props.result.points) ?? props.result.rms)

function fmtKm(km: number | undefined): string {
  if (km === undefined || !Number.isFinite(km)) return '—'
  if (Math.abs(km) < 1) return `${(km * 1000).toFixed(1)} m`
  return `${km.toFixed(3)} km`
}

function fmtIso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function axisErr(p: AccuracyPoint): number {
  return Number(p[AXIS_FIELD[axis.value]])
}

function axisSigma(p: AccuracyPoint): number | null {
  const s = p[SIGMA_FIELD[axis.value]]
  return s !== undefined && Number.isFinite(s) && s > 0 ? s : null
}

const signedErrors = computed(() => {
  if (!enough.value) return [] as number[]
  return displayed.value.map(axisErr).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
})

const biasNote = computed(() => {
  const vals = signedErrors.value
  if (vals.length < MIN_POINTS || !viewRms.value) return false
  const mid = vals[Math.floor(vals.length / 2)]
  const fracNeg = vals.filter((v) => v < 0).length / vals.length
  const axisRms =
    axis.value === 'radial' ? viewRms.value.radialKm : axis.value === 'along' ? viewRms.value.alongKm : viewRms.value.crossKm
  return Math.abs(fracNeg - 0.5) > 0.15 || Math.abs(mid) > 0.25 * axisRms
})

const hasAgeSigma = computed(() => {
  if (!enough.value) return false
  return displayed.value.some((p) => axisSigma(p) !== null)
})

const mahaSq = computed(() => {
  if (!hasAgeSigma.value) return [] as number[]
  const out: number[] = []
  for (const p of displayed.value) {
    const sig = axisSigma(p)
    if (sig === null) continue
    const z = axisErr(p) / sig
    if (Number.isFinite(z)) out.push(z * z)
  }
  return out.sort((a, b) => a - b)
})

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

function chi2k1Cdf(x: number): number {
  if (x <= 0) return 0
  return erfApprox(Math.sqrt(x / 2))
}

function statusText(): string {
  const filter =
    horizon.value === 'full' ? t('acc.horizonFull') : `${horizonLabel(horizon.value)} ±45 min`
  return t('acc.horizonStatus', {
    filter,
    n: displayed.value.length,
    total: props.result.points.length
  })
}

const timeOption = computed<EChartsCoreOption>(() => {
  const data = displayed.value.map((p) => [p.tMs, axisErr(p)] as [number, number])
  return {
    backgroundColor: 'transparent',
    grid: { left: 58, right: 18, top: 28, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f1318',
      borderColor: '#1e2630',
      textStyle: { color: '#c5cdd6', fontSize: 11 }
    },
    xAxis: {
      type: 'time',
      axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
      splitLine: GRID
    },
    yAxis: {
      type: 'value',
      name: `${axisLabel(axis.value)} (km)`,
      nameTextStyle: { color: MUTED, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: GRID
    },
    series: [
      {
        type: 'line',
        showSymbol: data.length <= 80,
        symbolSize: 5,
        data,
        lineStyle: { width: 1.5, color: LINE },
        itemStyle: { color: LINE }
      }
    ]
  }
})

const cdfOption = computed<EChartsCoreOption>(() => {
  const vals = signedErrors.value
  const n = vals.length
  const data = vals.map((v, i) => [v, (i + 1) / n] as [number, number])
  return {
    backgroundColor: 'transparent',
    grid: { left: 48, right: 18, top: 28, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f1318',
      borderColor: '#1e2630',
      textStyle: { color: '#c5cdd6', fontSize: 11 }
    },
    xAxis: {
      type: 'value',
      name: `${axisLabel(axis.value)} (km)`,
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: MUTED, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: GRID
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      name: 'CDF',
      nameTextStyle: { color: MUTED, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: GRID
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        data,
        lineStyle: { width: 1.6, color: LINE },
        itemStyle: { color: LINE },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          data: [{ xAxis: 0, lineStyle: { type: 'solid', width: 1, color: MUTED } }]
        }
      }
    ]
  }
})

const mahaOption = computed<EChartsCoreOption>(() => {
  const vals = mahaSq.value
  const n = vals.length
  const emp = vals.map((v, i) => [v, (i + 1) / n] as [number, number])
  const xMax = Math.max(vals[n - 1] ?? 1, 8)
  const ref: Array<[number, number]> = []
  const steps = 48
  for (let i = 0; i <= steps; i++) {
    const x = (xMax * i) / steps
    ref.push([x, chi2k1Cdf(x)])
  }
  return {
    backgroundColor: 'transparent',
    grid: { left: 48, right: 18, top: 32, bottom: 32 },
    legend: { top: 0, textStyle: { color: '#9fb3c8', fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f1318',
      borderColor: '#1e2630',
      textStyle: { color: '#c5cdd6', fontSize: 11 }
    },
    xAxis: {
      type: 'value',
      name: 'd²',
      nameTextStyle: { color: MUTED, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: GRID
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      name: 'CDF',
      nameTextStyle: { color: MUTED, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: GRID
    },
    series: [
      {
        name: t('acc.mahaEmp'),
        type: 'line',
        showSymbol: false,
        data: emp,
        lineStyle: { width: 1.6, color: LINE },
        itemStyle: { color: LINE }
      },
      {
        name: t('acc.mahaRef'),
        type: 'line',
        showSymbol: false,
        data: ref,
        lineStyle: { width: 1.2, type: 'dashed', color: MUTED },
        itemStyle: { color: MUTED }
      }
    ]
  }
})
</script>

<template>
  <div class="acc-charts">
    <div class="acc-meta">
      <span>{{ t('acc.overlap') }}：<span class="mono">{{ fmtIso(result.overlap.startMs) }} → {{ fmtIso(result.overlap.stopMs) }}</span></span>
      <span>{{ t('acc.predSource') }}：{{ pred.kind.toUpperCase() }} {{ pred.label }}</span>
      <span>{{ statusText() }}</span>
    </div>

    <div class="ctrls">
      <div class="ctrl">
        <span class="lbl">{{ t('acc.axis') }}</span>
        <div class="seg">
          <button type="button" :class="{ on: axis === 'radial' }" @click="axis = 'radial'">{{ t('acc.axisR') }}</button>
          <button type="button" :class="{ on: axis === 'along' }" @click="axis = 'along'">{{ t('acc.axisT') }}</button>
          <button type="button" :class="{ on: axis === 'cross' }" @click="axis = 'cross'">{{ t('acc.axisN') }}</button>
        </div>
      </div>
      <div class="ctrl">
        <span class="lbl">{{ t('acc.horizon') }}</span>
        <div class="seg">
          <button
            v-for="h in horizons"
            :key="h"
            type="button"
            :class="{ on: horizon === h }"
            @click="horizon = h"
          >{{ horizonLabel(h) }}</button>
        </div>
      </div>
    </div>
    <p class="hint">{{ t('acc.horizonHint') }}</p>

    <div class="kpis">
      <div class="kpi"><span>{{ t('acc.rmsR') }}</span><b>{{ fmtKm(viewRms?.radialKm) }}</b></div>
      <div class="kpi"><span>{{ t('acc.rmsT') }}</span><b>{{ fmtKm(viewRms?.alongKm) }}</b></div>
      <div class="kpi"><span>{{ t('acc.rmsN') }}</span><b>{{ fmtKm(viewRms?.crossKm) }}</b></div>
      <div class="kpi"><span>{{ t('acc.rmsTotal') }}</span><b>{{ fmtKm(viewRms?.totalKm) }}</b></div>
      <div class="kpi"><span>{{ t('acc.max') }}</span><b>{{ fmtKm(viewRms?.maxKm) }}</b></div>
      <div class="kpi"><span>{{ t('acc.mean') }}</span><b>{{ fmtKm(viewRms?.meanKm) }}</b></div>
    </div>
    <p v-if="horizon !== 'full'" class="full-rms">
      {{ t('acc.fullRms') }}：
      R {{ fmtKm(fullRms.radialKm) }} ·
      T {{ fmtKm(fullRms.alongKm) }} ·
      N {{ fmtKm(fullRms.crossKm) }}
    </p>

    <p v-if="!enough" class="empty">{{ t('acc.horizonEmpty', { min: MIN_POINTS }) }}</p>
    <template v-else>
      <div class="chart-grid">
        <div class="chart-card">
          <div class="chart-h">{{ t('acc.errVsTime') }}</div>
          <EChart :option="timeOption" :height="220" />
        </div>
        <div class="chart-card">
          <div class="chart-h">{{ t('acc.cdf') }}</div>
          <EChart :option="cdfOption" :height="220" />
          <p v-if="biasNote" class="hint warn">{{ t('acc.cdfBias') }}</p>
        </div>
      </div>
      <div v-if="hasAgeSigma && mahaSq.length >= MIN_POINTS" class="chart-card maha">
        <div class="chart-h">{{ t('acc.mahaTitle') }}</div>
        <EChart :option="mahaOption" :height="220" />
        <p class="hint">{{ t('acc.mahaHint') }}</p>
      </div>
      <p v-else-if="!hasAgeSigma" class="hint">{{ t('acc.mahaSkip') }}</p>
    </template>
  </div>
</template>

<style scoped>
.acc-charts { width: 100%; }
.acc-meta {
  display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 8px;
  font-size: 11px; color: var(--text-dim);
}
.acc-meta .mono { font-family: var(--mono); font-size: 10px; color: var(--text); }
.ctrls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-top: 4px; }
.ctrl { display: flex; align-items: center; gap: 8px; }
.lbl { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.seg { display: inline-flex; background: var(--bg-deep); border: 1px solid var(--border); border-radius: 4px; padding: 2px; flex-wrap: wrap; }
.seg button {
  appearance: none; border: none; background: transparent; color: var(--text-muted);
  font-size: 11px; padding: 4px 8px; border-radius: 3px; cursor: pointer;
}
.seg button.on { background: var(--bg-hover); color: var(--text); }
.hint { margin: 6px 0 0; font-size: 10px; color: var(--text-dim); line-height: 1.45; }
.hint.warn { color: var(--warn); }
.kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
.kpi {
  border: 1px solid var(--border); background: var(--bg-deep); border-radius: 4px;
  padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.kpi span { font-size: 9px; color: var(--text-dim); white-space: nowrap; }
.kpi b { font-family: var(--mono); font-size: 11px; font-weight: 650; color: var(--text); white-space: nowrap; }
.full-rms { margin: 6px 0 0; font-size: 10px; color: var(--text-dim); }
.empty {
  margin: 10px 0 0; padding: 14px 10px; text-align: center; font-size: 12px;
  color: var(--text-dim); line-height: 1.5; border: 1px dashed var(--border); border-radius: 6px;
}
.chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.chart-card { min-width: 0; }
.chart-card.maha { margin-top: 10px; }
.chart-h { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
@media (max-width: 960px) {
  .kpis, .chart-grid { grid-template-columns: 1fr; }
}
</style>
