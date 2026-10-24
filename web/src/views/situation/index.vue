<script setup lang="ts">
/**
 * 态势主页面外壳（第一部分：3D 地球 + UI 框架）
 *
 * 与原系统对齐：
 *   · 底部 dock：安全热力图 / AI专家 / 初始化窗口（前两项本期未实现，点击给出提示）；
 *   · 左侧「太空安全目标列表」由左缘竖排 tag 拉出；
 *   · 右侧为「星历分析」窗口，由右缘竖排 tag「星历与安全分析」拉出；
 *   · 右下角只保留 UTC + 北京时间双时区时钟。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import SceneCore from './SceneCore.vue'
import SatListPanel from './SatListPanel.vue'
import SiteListPanel from './SiteListPanel.vue'
import ConstellationPanel from './ConstellationPanel.vue'
import EphemPanel from './EphemPanel.vue'
import { useDevice } from '@/composables/useDevice'
import { ephOpen, simPlaying, simSpeed, simTimeMs } from './scene'
import logoUrl from '@/assets/logo/openspace-logo.png'

type PanelKind = 'sat' | 'site' | 'cons'

const sceneRef = ref<InstanceType<typeof SceneCore>>()
const { isMobile } = useDevice()
const route = useRoute()

/* ---------------- 左侧列表面板 ---------------- */

/** 左侧当前展开的面板；空串 = 全部收起 */
const dockMode = ref<PanelKind | ''>('')

function closePanel() {
  dockMode.value = ''
}

/** 左缘 tag：拉出「太空安全目标列表」 */
function openSatPanel() {
  dockMode.value = 'sat'
}

const showSatTag = computed(() => !isMobile.value && dockMode.value !== 'sat')
/** 右缘 tag：星历分析与右侧详情同侧，展开时隐藏 */
const showEphemTag = computed(() => !isMobile.value && !ephOpen.value)

function toggleEphemDock() {
  ephOpen.value = !ephOpen.value
}

/** URL 深链：/situation/sat|site|cons 打开左侧列表，/situation/eph 打开星历分析 */
watch(
  () => route.params.type,
  (t) => {
    if (t === 'sat' || t === 'site' || t === 'cons') dockMode.value = t
    else if (t === 'eph') ephOpen.value = true
  },
  { immediate: true }
)

/* ---------------- dock（与原系统一致，本期仅初始化窗口可用） ---------------- */

/** 本期未实现的功能入口：给出提示，不产生任何三维副作用 */
function notReady(name: string) {
  ElMessage.info(`${name}将在后续版本接入`)
}

/** dock「初始化窗口」：整页刷新 */
function reloadSystem() {
  window.location.reload()
}

/* ---------------- 仿真时间条 ---------------- */

const SIM_RATE_OPTIONS = [0.1, 1, 10, 60]
/** 时间轴中心：启动 / 重置 / 拖动后保证「现在」落在进度条中点 */
const simAnchorMs = ref(Date.now())
const SIM_HALF_SPAN_MS = 12 * 3600e3
const simStart = computed(() => simAnchorMs.value - SIM_HALF_SPAN_MS)
const simStop = computed(() => simAnchorMs.value + SIM_HALF_SPAN_MS)
const simRatio = computed(() => {
  const span = simStop.value - simStart.value
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (simTimeMs.value - simStart.value) / span))
})

const pad2 = (v: number) => String(v).padStart(2, '0')

function fmtSimTime(ms: number, withSec = true) {
  const d = new Date(ms)
  const base = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  return withSec ? `${base}:${pad2(d.getUTCSeconds())}` : base
}

const simClockUtc = computed(() => `${fmtSimTime(simTimeMs.value)} UTC`)
const simRangeText = computed(
  () => `${fmtSimTime(simStart.value, false)} ~ ${fmtSimTime(simStop.value, false)} UTC · 24 h`
)

/** 拖动播放头：直接改写仿真时刻（晨昏线随之变化） */
function simSeek(e: Event) {
  const span = simStop.value - simStart.value
  if (span <= 0) return
  const t = simStart.value + (Number((e.target as HTMLInputElement).value) / 1000) * span
  simTimeMs.value = t
  sceneRef.value?.setSimTime(t)
}

function simTogglePlay() {
  simPlaying.value = !simPlaying.value
}

/** 重置到当前真实 UTC 时刻（时间轴重新以现在为中心） */
function simResetNow() {
  const now = Date.now()
  simAnchorMs.value = now
  simTimeMs.value = now
  sceneRef.value?.setSimTime(now)
}

/** 复位镜头：回到武汉初始视角与初始地球大小 */
function resetCameraHome() {
  sceneRef.value?.resetCameraHome()
}

/* ---------------- 右下角双时区时钟 ---------------- */

const clockNow = ref(Date.now())
let clockTimer = 0
onMounted(() => {
  clockTimer = window.setInterval(() => { clockNow.value = Date.now() }, 1000)
})
onBeforeUnmount(() => clearInterval(clockTimer))

const clockUtc = computed(() => {
  const d = new Date(clockNow.value)
  return `UTC ${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
})

const clockBjt = computed(() => {
  const d = new Date(clockNow.value + 8 * 3600e3)
  return `北京 ${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
})

/* ---------------- 星历面板事件（三维图层绘制待后续接入） ---------------- */

function onEphemFocusSet() {
  // TODO(待后续): 在三维场景绘制星历轨道与当前位置
}

function onEphemFocusEvent() {
  // TODO(待后续): 在三维场景定位星历威胁事件
}
</script>

<template>
  <div class="constel-page">
    <!-- 左上角 logo -->
    <img class="app-logo" :src="logoUrl" alt="Openspace logo" />

    <!-- 正上方标题栏：纯装饰，不拦截画布交互 -->
    <header class="constel-titlebar">
      <div class="tb-frame">
        <span class="tb-wing"></span>
        <div class="tb-texts">
          <h1 class="tb-title">开源太空安全平台</h1>
          <div class="tb-sub">Openspace Space Safety Platform</div>
        </div>
        <span class="tb-wing tb-wing-r"></span>
      </div>
    </header>

    <!-- 三维地球场景 -->
    <SceneCore ref="sceneRef" />

    <!-- 左侧列表面板 -->
    <SatListPanel :open="dockMode === 'sat'" @close="closePanel" />
    <SiteListPanel :open="dockMode === 'site'" @close="closePanel" />
    <ConstellationPanel :open="dockMode === 'cons'" @close="closePanel" />

    <!-- 右侧星历分析面板（独立开关，与左侧面板可同时展开） -->
    <EphemPanel
      @close="ephOpen = false"
      @focus-set="onEphemFocusSet"
      @focus-event="onEphemFocusEvent"
    />

    <!-- 仿真时间条 -->
    <div class="sim-bar">
      <button class="sim-play sim-reset" title="重置到当前时间" @click="simResetNow">↺</button>
      <button class="sim-play" :title="simPlaying ? '暂停仿真' : '继续仿真'" @click="simTogglePlay">
        {{ simPlaying ? '❚❚' : '▶' }}
      </button>
      <div class="sim-main">
        <div class="sim-line">
          <b>{{ simClockUtc }}</b>
          <span class="sim-range">{{ simRangeText }}</span>
        </div>
        <input
          class="sim-slider"
          type="range"
          min="0"
          max="1000"
          step="1"
          :value="Math.round(simRatio * 1000)"
          @input="simSeek"
        />
      </div>
      <div class="sim-rates">
        <button
          v-for="r in SIM_RATE_OPTIONS"
          :key="r"
          :class="{ on: simSpeed === r }"
          :title="`仿真倍率 ${r}×`"
          @click="simSpeed = r"
        >{{ r }}×</button>
      </div>
    </div>

    <!-- 底部 dock 导航栏（与原系统一致：安全热力图 / AI专家 / 初始化窗口） -->
    <div class="constel-dock">
      <button class="dock-btn" title="安全热力图：展示交会分析（CRI/CRP）热力事件" @click="notReady('安全热力图')">
        <span class="dock-ico">✱</span><span class="dock-txt">安全热力图</span>
      </button>
      <button class="dock-btn" title="太空安全专家：用自然语言查询目标、碰撞风险与空间环境" @click="notReady('AI专家')">
        <span class="dock-ico">◈</span><span class="dock-txt">AI专家</span>
      </button>
      <button class="dock-btn" title="初始化窗口：刷新整个页面" @click="reloadSystem">
        <span class="dock-ico">↺</span><span class="dock-txt">初始化窗口</span>
      </button>
    </div>

    <!-- 左下角复位按钮 -->
    <button class="constel-reset" title="复位镜头：回到初始位置（武汉）与初始地球大小" @click="resetCameraHome">
      <svg class="reset-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      </svg>
      <span class="reset-txt">复位</span>
    </button>

    <!-- 右下角图例：只保留 UTC + 北京时间双时区时钟 -->
    <div class="constel-legend">
      <div class="lg-title">
        <div class="lg-clock">
          <span class="lg-clock-line">{{ clockUtc }}</span>
          <span class="lg-clock-line">{{ clockBjt }}</span>
        </div>
      </div>
    </div>

    <!-- 桌面端左缘外拉 tag：拉出太空安全目标列表 -->
    <button
      v-if="showSatTag"
      class="edge-tag edge-tag-left"
      title="展开太空安全目标列表"
      @click="openSatPanel"
    >太空安全目标列表</button>

    <!-- 桌面端右缘外拉 tag：拉出星历分析 -->
    <button
      v-if="showEphemTag"
      class="edge-tag edge-tag-right"
      title="展开星历与安全分析"
      @click="toggleEphemDock"
    >星历与安全分析</button>
  </div>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
