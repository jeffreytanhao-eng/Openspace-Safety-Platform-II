<script setup lang="ts">
/**
 * 态势主页面外壳（3D 地球 + UI 框架）
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import SceneCore from './SceneCore.vue'
import SatListPanel from './SatListPanel.vue'
import SiteListPanel from './SiteListPanel.vue'
import ConstellationPanel from './ConstellationPanel.vue'
import EphemPanel from './EphemPanel.vue'
import { useDevice } from '@/composables/useDevice'
import { useI18n } from '@/composables/useI18n'
import { ephOpen, simPlaying, simSpeed, simTimeMs } from './scene'
import {
  activeEphem,
  maneuverStates,
  maneuverBurnMs,
  clearManeuver,
  activateEphem,
  deactivateEphem,
  refreshEphemList
} from './ephem/useUserEphemeris'
import { listLocalEphemerides, fetchEphemerisText } from '@/api/ephemerides'
import { parseEphemeris } from './ephem/parse'
import { putSet } from './ephem/store'
import type { EphemSet } from './ephem/types'
import type { CatalogTle } from '@/composables/useCatalog'

type PanelKind = 'sat' | 'site' | 'cons'

const sceneRef = ref<InstanceType<typeof SceneCore>>()
const { isMobile } = useDevice()
const route = useRoute()
const { t } = useI18n()

/* ---------------- 左侧列表面板 ---------------- */

const dockMode = ref<PanelKind | ''>('')

function closePanel() {
  dockMode.value = ''
}

function openSatPanel() {
  dockMode.value = 'sat'
}

const showSatTag = computed(() => !isMobile.value && dockMode.value !== 'sat')
const showEphemTag = computed(() => !isMobile.value && !ephOpen.value)

function toggleEphemDock() {
  ephOpen.value = !ephOpen.value
}

watch(
  () => route.params.type,
  (type) => {
    const t0 = Array.isArray(type) ? type[0] : type
    if (t0 === 'sat' || t0 === 'site' || t0 === 'cons') dockMode.value = t0
    else if (t0 === 'eph') ephOpen.value = true
  },
  { immediate: true }
)

function notReady(name: string) {
  ElMessage.info(t('sit.later', { name }))
}

function reloadSystem() {
  // 初始化 = 回到最初状态：先清星历激活态（否则视口重建后 onViewportReady 会恢复轨道），右侧星历弹出窗一并收回
  deactivateEphem()
  ephOpen.value = false
  void sceneRef.value?.reinitViewport()
  const now = Date.now()
  simAnchorMs.value = now
  simTimeMs.value = now
  sceneRef.value?.setSimTime(now)
}

/* ---------------- 仿真时间条 ---------------- */

const SIM_RATE_OPTIONS = [0.1, 1, 10, 60]
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

function simSeek(e: Event) {
  const span = simStop.value - simStart.value
  if (span <= 0) return
  const tMs = simStart.value + (Number((e.target as HTMLInputElement).value) / 1000) * span
  simTimeMs.value = tMs
  sceneRef.value?.setSimTime(tMs)
}

function simTogglePlay() {
  simPlaying.value = !simPlaying.value
}

function simResetNow() {
  const now = Date.now()
  simAnchorMs.value = now
  simTimeMs.value = now
  sceneRef.value?.setSimTime(now)
}

function resetCameraHome() {
  sceneRef.value?.resetCameraHome()
}

/* ---------------- 目录选择 → 三维 ---------------- */

function onSatSelect(item: CatalogTle) {
  sceneRef.value?.selectCatalogItem(item)
}

function onSatTypes(types: string[]) {
  sceneRef.value?.filterCatalogTypes(types)
}

function onStationShow(norad: number) {
  sceneRef.value?.showStation(norad)
}

function onConsShow(name: string) {
  sceneRef.value?.showConstellation(name)
}

function onConsOrbit(name: string) {
  sceneRef.value?.showConsOrbit(name)
}

/* ---------------- 用户星历图层 ---------------- */

function onEphemFocusSet() {
  void paintUserEphem({ track: true })
}

function onEphemFocusEvent() {
  void paintUserEphem()
}

/**
 * IDB 旧版本只存了 states、丢了 maneuvers → 跳转/琥珀段会空。
 * 用本地 index.maneuverEpochs 补回并写回 IDB（parse 已带 maneuvers 时不覆盖）。
 */
async function ensureActiveMansFromLocalIndex(): Promise<void> {
  const set = activeEphem.value
  if (!set || set.maneuvers?.length) return
  try {
    const list = await listLocalEphemerides()
    const bare = set.id.startsWith('local-') ? set.id.slice('local-'.length) : set.id
    const row =
      list.items.find((x) => x.id === bare) ||
      list.items.find(
        (x) =>
          String(x.norad) === String(set.norad) &&
          String(x.format || '').toLowerCase() === String(set.format || '').toLowerCase()
      )
    if (!row?.maneuverEpochs?.length) return
    attachMansFromIndex(set, row.maneuverEpochs)
    if (set.maneuvers?.length) await putSet(set)
  } catch (e) {
    console.warn('[situation] ensureActiveMans', e)
  }
}

async function paintUserEphem(opts?: { track?: boolean }) {
  await ensureActiveMansFromLocalIndex()
  sceneRef.value?.showEphemOrbit?.(activeEphem.value, opts)
  sceneRef.value?.showEphemManeuver?.(maneuverStates.value, maneuverBurnMs.value)
}

/** 机动卡片定位：相机对准对应琥珀机动块（不改仿真时刻）；idx=null 取消高亮与标签 */
function onLocateMan(
  idx: number | null,
  info: { t0: number; duraSec: number; lat: string; lon: string } | null
) {
  if (idx == null || !info) {
    sceneRef.value?.focusEphemManIndex?.(null)
    return
  }
  const label = `${fmtSimTime(info.t0)} UTC · ${info.duraSec} s\n${info.lat} / ${info.lon}`
  const ok = sceneRef.value?.focusEphemManIndex?.(idx, label)
  if (!ok) {
    // 兜底：MAN 高亮尚未就绪（如 IDB 旧数据）→ 现场重绘后再定位一次
    void ensureActiveMansFromLocalIndex().then(() => {
      sceneRef.value?.showEphemOrbit?.(activeEphem.value, { track: false })
      if (!sceneRef.value?.focusEphemManIndex?.(idx, label)) {
        ElMessage.info(t('sit.noManSegment'))
      }
    })
  }
}

function onViewportReady() {
  // Restore track zoom if an ephem is already active after viewport rebuild
  paintUserEphem(activeEphem.value ? { track: true } : undefined)
}

/** 关联入库前去掉逐点协方差，避免 OCM 撑爆 IndexedDB；轨道绘制不需要 cov（保留集合级 hasCov 标记） */
function stripStatesCov<T extends { states: { t: number; r: [number, number, number]; v: [number, number, number]; cov?: Float64Array }[]; hasCov?: boolean }>(set: T): T {
  const hadCov = set.states.some((s) => !!s.cov) || set.hasCov === true
  return {
    ...set,
    hasCov: hadCov,
    states: set.states.map((s) => ({ t: s.t, r: s.r, v: s.v }))
  }
}

/** 把 index 里的 MAN 历元挂到 EphemSet（parse 已带 maneuvers 时不覆盖） */
function attachMansFromIndex(
  set: EphemSet,
  epochs: { t: number; dvMps?: number; duraSec?: number; id?: string }[] | undefined
) {
  if (set.maneuvers?.length) return set
  if (!epochs?.length) return set
  const t0 = set.states[0]?.t ?? set.start
  const t1 = set.states[set.states.length - 1]?.t ?? set.stop
  const segs = epochs
    .map((m) => {
      const dura = m.duraSec && m.duraSec > 0 ? m.duraSec : 1
      return {
        t0: m.t,
        t1: m.t + dura * 1000,
        dvMps: m.dvMps,
        id: m.id
      }
    })
    .filter((s) => s.t1 >= t0 && s.t0 <= t1)
  if (segs.length) set.maneuvers = segs
  return set
}

watch(
  activeEphem,
  () => {
    paintUserEphem()
  },
  { flush: 'post' }
)

watch(
  [maneuverStates, maneuverBurnMs],
  () => {
    paintUserEphem()
  },
  { flush: 'post' }
)

/** 深链 /situation/eph?ephId=ocm-38054 从本地星历目录载入并展示 */
watch(
  () => [route.params.type, route.query.ephId] as const,
  async ([type, ephId]) => {
    if (type !== 'eph' && !ephId) return
    ephOpen.value = true
    const id = ephId ? String(ephId) : ''
    if (!id) return
    const activeId = activeEphem.value?.id
    if (activeId && (activeId === `local-${id}` || activeId.startsWith('builtin-'))) {
      paintUserEphem({ track: true })
      return
    }
    try {
      // 显式拉全量（默认分页只有前 20 条，目标行排在后面时会 find 失败 → 深链静默失效）
      const list = await listLocalEphemerides({ page: 1, size: 500 })
      const row = list.items.find((x) => x.id === id)
      if (!row) return
      const body = await fetchEphemerisText(row.file)
      const parsed = parseEphemeris(body, {
        fileName: row.file,
        name: row.name,
        norad: Number(row.norad) || undefined
      })
      if (!parsed.ok || !parsed.set) {
        console.warn('[situation] eph parse failed', parsed.error)
        return
      }
      let set = parsed.set
      // 与星历面板内置样本同 ID（builtin[-ocm]-<norad>）→ 面板卡片可正确高亮
      const n = Number(row.norad) || set.norad
      set.id = set.format === 'ocm' && n ? `builtin-ocm-${n}` : n ? `builtin-${n}` : `local-${row.id}`
      set.source = 'builtin'
      set.name = row.name
      if (set.format === 'ocm' || set.states.length > 4000) {
        set = stripStatesCov(set)
      }
      set = attachMansFromIndex(set, row.maneuverEpochs)
      await putSet(set)
      await refreshEphemList()
      await activateEphem(set.id)
      if (!activeEphem.value) {
        console.warn('[situation] activateEphem failed for', set.id)
        return
      }
      clearManeuver()
      paintUserEphem({ track: true })
    } catch (e) {
      console.warn('[situation] load ephId failed', e)
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="constel-page">
    <!-- Embedded 态势: no own logo / title / platform clock (AppShell owns those). -->
    <SceneCore ref="sceneRef" @viewport-ready="onViewportReady" />

    <SatListPanel
      :open="dockMode === 'sat'"
      @close="closePanel"
      @select="onSatSelect"
      @types="onSatTypes"
      @station-show="onStationShow"
      @cons-show="onConsShow"
      @cons-orbit="onConsOrbit"
    />
    <SiteListPanel :open="dockMode === 'site'" @close="closePanel" />
    <ConstellationPanel :open="dockMode === 'cons'" @close="closePanel" />

    <EphemPanel
      @close="ephOpen = false"
      @locate-man="onLocateMan"
      @focus-set="onEphemFocusSet"
      @focus-event="onEphemFocusEvent"
    />

    <div class="sim-bar">
      <button class="sim-play sim-reset" :title="t('sit.resetNowTip')" @click="simResetNow">↻</button>
      <button class="sim-play" :title="simPlaying ? t('sit.pause') : t('sit.play')" @click="simTogglePlay">
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
          :title="t('sit.rateTip', { r })"
          @click="simSpeed = r"
        >{{ r }}×</button>
      </div>
    </div>

    <div class="constel-dock">
      <button class="dock-btn" :title="t('sit.heatTip')" @click="notReady(t('sit.heat'))">
        <span class="dock-ico">✱</span><span class="dock-txt">{{ t('sit.heat') }}</span>
      </button>
      <button class="dock-btn" :title="t('sit.reloadTip')" @click="reloadSystem">
        <span class="dock-ico">↻</span><span class="dock-txt">{{ t('sit.reload') }}</span>
      </button>
    </div>

    <button class="constel-reset" :title="t('sit.resetTip')" @click="resetCameraHome">
      <svg class="reset-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      </svg>
      <span class="reset-txt">{{ t('sit.reset') }}</span>
    </button>

    <button
      v-if="showSatTag"
      class="edge-tag edge-tag-left"
      :title="t('sit.satListTip')"
      @click="openSatPanel"
    >{{ t('sit.satList') }}</button>

    <button
      v-if="showEphemTag"
      class="edge-tag edge-tag-right"
      :title="t('sit.ephemAnalTip')"
      @click="toggleEphemDock"
    >{{ t('sit.ephemAnal') }}</button>
  </div>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
