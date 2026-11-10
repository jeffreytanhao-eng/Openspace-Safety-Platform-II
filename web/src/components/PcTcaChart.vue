<script setup lang="ts">
/**
 * 即将交会总览：Pc（对数）对 TCA 散点。
 * 阈值与列表分级同一口径（api/src/screen/levels.ts）：
 *   ≥1e-4 高危 / ≥1e-5 警告 / ≥1e-7 关注。
 * Pc < 1e-7 的事件不绘制（纵轴从 1e-7 起，避免下方空带）。
 * 无 Pc 的事件不绘点。筛查源使用事件上的筛查 Pc，而非回查官方 CDM。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { EChartsCoreOption } from 'echarts/core'
import EChart from '@/components/EChart.vue'
import { useI18n } from '@/composables/useI18n'
import { eventDetailPath, type ConjunctionEvent, type EventLevel } from '@/api/events'

const PC_RED = 1e-4
const PC_ORANGE = 1e-5
const PC_YELLOW = 1e-7

const LEVEL_COLOR: Record<EventLevel, string> = {
  red: '#c45b5b',
  orange: '#c4924a',
  yellow: '#a89a5c',
  low: '#7a8696'
}

const AXIS = '#8fa3b8'
const GRID = { lineStyle: { color: 'rgba(120, 150, 180, 0.12)' } }

const props = withDefaults(
  defineProps<{
    events: ConjunctionEvent[]
    height?: number
  }>(),
  { height: 160 }
)

const { t, isZh } = useI18n()
const router = useRouter()

interface PointDatum {
  value: [number, number]
  key: string
  jobId?: number
  nameA: string
  nameB: string
  noradA: number
  noradB: number
  tca: string
  pc: number
  level: EventLevel
  pcSource: string
  upcoming: boolean
  itemStyle: { color: string; opacity: number }
}

function fmtTca(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}

function fmtPc(pc: number): string {
  return pc.toExponential(2)
}

function srcLabel(pcSource: string): string {
  if (pcSource === 'customer') return `${t('pcTca.srcCdm')} · ${t('conj.src.customer')}`
  if (pcSource === 'system') return `${t('pcTca.srcCdm')} · ${t('conj.src.system')}`
  if (pcSource === 'screen-tle') return t('conj.src.screenTle')
  if (pcSource === 'screen-ephem') return t('conj.src.screenEphem')
  if (pcSource === 'screen-aoe') return t('conj.src.screenAoe')
  if (pcSource === 'screen' || pcSource === 'screening' || pcSource.startsWith('screen-')) {
    return t('pcTca.srcLocal')
  }
  return t('pcTca.srcCdm')
}

function keepWatchOrAbove(e: ConjunctionEvent): boolean {
  if (e.pc === null || !Number.isFinite(e.pc) || e.pc <= 0) return false
  if (e.pc >= PC_YELLOW) return true
  return e.levelBasis === 'pc' && (e.level === 'yellow' || e.level === 'orange' || e.level === 'red')
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatAxisTime(value: number, _zh?: boolean): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const isDateTick = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
  if (isDateTick) {
    return `${MONTH_ABBR[d.getMonth()]}.${d.getDate()}`
  }
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const points = computed<PointDatum[]>(() => {
  const now = Date.now()
  const out: PointDatum[] = []
  for (const e of props.events) {
    if (!keepWatchOrAbove(e) || e.pc === null) continue
    const tcaMs = Date.parse(e.tca)
    if (!Number.isFinite(tcaMs)) continue
    const upcoming = tcaMs >= now
    out.push({
      value: [tcaMs, e.pc],
      key: e.key,
      jobId: e.jobId,
      nameA: e.nameA || `NORAD ${e.noradA}`,
      nameB: e.nameB || `NORAD ${e.noradB}`,
      noradA: e.noradA,
      noradB: e.noradB,
      tca: e.tca,
      pc: e.pc,
      level: e.level,
      pcSource: e.pcSource,
      upcoming,
      itemStyle: {
        color: LEVEL_COLOR[e.level] ?? LEVEL_COLOR.low,
        opacity: upcoming ? 0.92 : 0.42
      }
    })
  }
  return out
})

const emptyKind = computed<'none' | 'noPc' | ''>(() => {
  if (!props.events.length) return 'none'
  if (!points.value.length) return 'noPc'
  return ''
})

function tooltipHtml(raw: unknown): string {
  const d = (raw as { data?: PointDatum }).data
  if (!d || typeof d !== 'object' || !('key' in d)) return ''
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return [
    `<div style="font-weight:650;margin-bottom:4px">${esc(d.nameA)} · ${esc(d.nameB)}</div>`,
    `<div>NORAD ${d.noradA} / ${d.noradB}</div>`,
    `<div>TCA ${esc(fmtTca(d.tca))}</div>`,
    `<div>${t('pcTca.tooltipPc')} ${fmtPc(d.pc)}</div>`,
    `<div>${t('pcTca.tooltipSrc')} ${esc(srcLabel(d.pcSource))}</div>`
  ].join('')
}

const option = computed<EChartsCoreOption>(() => {
  const zh = isZh.value
  return {
    backgroundColor: 'transparent',
    grid: { left: 58, right: 16, top: 18, bottom: 22 },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#0f1318',
      borderColor: '#1e2630',
      textStyle: { color: '#c5cdd6', fontSize: 11 },
      formatter: (raw: unknown) => tooltipHtml(raw)
    },
    xAxis: {
      type: 'time',
      axisLabel: {
        color: AXIS,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: string | number) => formatAxisTime(Number(value), zh)
      },
      axisLine: { lineStyle: { color: '#1e2630' } },
      splitLine: GRID
    },
    yAxis: {
      type: 'log',
      name: 'Pc',
      min: PC_YELLOW,
      nameTextStyle: { color: '#7a8696', fontSize: 11 },
      axisLabel: { color: AXIS, fontSize: 11, formatter: (v: number) => v.toExponential(0) },
      axisLine: { lineStyle: { color: '#1e2630' } },
      splitLine: GRID
    },
    series: [
      {
        type: 'scatter',
        symbolSize: 8,
        data: points.value,
        cursor: 'pointer',
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          label: { color: AXIS, fontSize: 10, position: 'insideEndTop' },
          data: [
            {
              xAxis: Date.now(),
              name: '',
              label: { show: false },
              lineStyle: { type: 'dashed', width: 1, color: 'rgba(197, 205, 214, 0.7)' }
            },
            {
              yAxis: PC_RED,
              name: `${t('conj.high')} 1e-4`,
              label: { formatter: `${t('conj.high')} 1e-4` },
              lineStyle: { type: 'dashed', width: 1, color: '#c45b5b' }
            },
            {
              yAxis: PC_ORANGE,
              name: `${t('conj.warn')} 1e-5`,
              label: { formatter: `${t('conj.warn')} 1e-5` },
              lineStyle: { type: 'dashed', width: 1, color: '#c4924a' }
            },
            {
              yAxis: PC_YELLOW,
              name: `${t('conj.watch')} 1e-7`,
              label: { formatter: `${t('conj.watch')} 1e-7` },
              lineStyle: { type: 'dashed', width: 1, color: '#a89a5c' }
            }
          ]
        }
      }
    ]
  }
})

function onChartClick(payload: { data: unknown }): void {
  const d = payload.data as PointDatum | undefined
  if (!d || typeof d !== 'object' || !('key' in d) || !d.key) return
  void router.push(eventDetailPath({ key: d.key, jobId: d.jobId }))
}
</script>

<template>
  <div class="pc-tca">
    <p v-if="emptyKind === 'none'" class="empty">{{ t('pcTca.empty') }}</p>
    <p v-else-if="emptyKind === 'noPc'" class="empty">{{ t('pcTca.emptyNoPc') }}</p>
    <EChart v-else :option="option" :height="height" @chart-click="onChartClick" />
  </div>
</template>

<style scoped>
.pc-tca {
  width: 100%;
}
.empty {
  margin: 0;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
</style>
