<script setup lang="ts">
/**
 * 轻量 ECharts 容器（按需注册折线/散点 + 网格/提示/图例/标线）。
 * 只打包用到的模块，产物随 web/dist 本地托管，运行时不请求任何外部 CDN。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer
])

const props = withDefaults(defineProps<{ option: EChartsCoreOption; height?: number }>(), { height: 220 })

const el = ref<HTMLDivElement | null>(null)
const chart = shallowRef<echarts.ECharts | null>(null)

function resize() {
  chart.value?.resize()
}

onMounted(() => {
  if (!el.value) return
  chart.value = echarts.init(el.value, undefined, { renderer: 'canvas' })
  chart.value.setOption(props.option)
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart.value?.dispose()
  chart.value = null
})

watch(
  () => props.option,
  (option) => chart.value?.setOption(option, true),
  { deep: true }
)
</script>

<template>
  <div ref="el" class="echart" :style="{ height: `${height}px` }"></div>
</template>

<style scoped>
.echart {
  width: 100%;
}
</style>
