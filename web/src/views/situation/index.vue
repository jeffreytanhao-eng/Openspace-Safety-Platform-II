<script setup lang="ts">
/**
 * 态势主页面外壳（3D 地球 + UI 框架）
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
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
import { listEvents, type ConjunctionEvent } from '@/api/events'
import { parseEphemeris } from './ephem/parse'
import { putSet } from './ephem/store'
import type { EphemSet } from './ephem/types'
import { epochToSegment, fmtDvMps } from './ephem/maneuverDisplay'
import type { CatalogTle } from '@/composables/useCatalog'
import { useCatalog } from '@/composables/useCatalog'
import { useObjectAliases } from '@/composables/useObjectAliases'
import { buildEventCloudItems, type EventCloudItem } from './eventCloudThree'

type I18nKey = Parameters<ReturnType<typeof useI18n>['t']>[0]

type PanelKind = 'sat' | 'site' | 'cons'

const sceneRef = ref<InstanceType<typeof SceneCore>>()
const { isMobile } = useDevice()
const route = useRoute()
const { label: objLabel, load: loadAliases } = useObjectAliases({ autoLoad: true })
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

/** 离开态势页时丢掉本次带入的星历/交会会话（模块单例不会随组件卸载而清）。不删 IndexedDB 里的星历文件。 */
function resetSituationSession() {
  deactivateEphem()
  ephOpen.value = false
  eventOn.value = false
  eventLoading.value = false
  eventRaw.value = []
  eventItems.value = []
  selEvent.value = null
  pendingEventDeepLink = false
  const now = Date.now()
  simAnchorMs.value = now
  simTimeMs.value = now
  simSpeed.value = 1
  simPlaying.value = true
  sceneRef.value?.showEventCloud?.(null)
  sceneRef.value?.clearUserEphemOrbit?.()
  sceneRef.value?.focusEventCloud?.(null)
}

onBeforeRouteLeave((to) => {
  if (to.name === 'situation') return
  resetSituationSession()
})

onBeforeUnmount(() => {
  resetSituationSession()
})

function reloadSystem() {
  // 初始化 = 回到最初状态：先清星历激活态（否则视口重建后 onViewportReady 会恢复轨道），右侧星历弹出窗一并收回
  resetSituationSession()
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

/** 机动卡片定位：相机对准对应琥珀机动块，仿真时刻跳到 t0（不自动播放）；idx=null 取消高亮与标签 */
function jumpSimToManeuverStart(t0: number) {
  const half = SIM_HALF_SPAN_MS
  if (t0 < simAnchorMs.value - half || t0 > simAnchorMs.value + half) {
    simAnchorMs.value = t0
  }
  simTimeMs.value = t0
  sceneRef.value?.setSimTime(t0)
}

function onLocateMan(
  idx: number | null,
  info: { t0: number; duraSec: number; lat: string; lon: string; dvMps?: number; purpose?: string; dirText?: string } | null
) {
  if (idx == null || !info) {
    sceneRef.value?.focusEphemManIndex?.(null)
    return
  }
  jumpSimToManeuverStart(info.t0)
  const mid = [info.dirText || fmtDvMps(info.dvMps), info.purpose].filter((s) => s && s !== '—').join(' · ')
  const label = mid
    ? `${fmtSimTime(info.t0)} UTC · ${info.duraSec} s\n${mid}\n${info.lat} / ${info.lon}`
    : `${fmtSimTime(info.t0)} UTC · ${info.duraSec} s\n${info.lat} / ${info.lon}`
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
  viewportReady.value = true
  void runPendingEventDeepLink()
  void runPendingNoradDeepLink()
}

/* ---------------- 交会危险事件云（E4） ---------------- */

const viewportReady = ref(false)
const eventOn = ref(false)
const eventLoading = ref(false)
/** 原始黄/橙/红事件（拉取一次缓存） */
const eventRaw = ref<ConjunctionEvent[]>([])
/** 已挂云的事件（含场景锚点），供点击回查 */
const eventItems = ref<(EventCloudItem & { pos: unknown })[]>([])
const selEvent = ref<(EventCloudItem & { pos: unknown }) | null>(null)
const EVENT_CLOUD_CAP = 300

const eventCount = computed(() => eventRaw.value.length)
const worstLevel = computed<'red' | 'orange' | 'yellow'>(() => {
  if (eventRaw.value.some((e) => e.level === 'red')) return 'red'
  if (eventRaw.value.some((e) => e.level === 'orange')) return 'orange'
  return 'yellow'
})

function toCloudItem(e: ConjunctionEvent): EventCloudItem {
  return {
    key: e.key,
    noradA: e.noradA,
    noradB: e.noradB,
    nameA: objLabel(e.noradA, e.nameA),
    nameB: objLabel(e.noradB, e.nameB),
    tca: e.tca,
    tcaMs: new Date(e.tca).getTime(),
    level: e.level as EventCloudItem['level'],
    pc: e.pc,
    missKm: e.missKm,
    relSpeedKmS: e.relSpeedKmS,
    cdmCount: e.cdmCount
  }
}

async function ensureEventRaw(): Promise<ConjunctionEvent[]> {
  if (eventRaw.value.length) return eventRaw.value
  const { events } = await listEvents('7d')
  eventRaw.value = events.filter((e) => e.level !== 'low')
  return eventRaw.value
}

/** 数量软上限：红 > 橙 > 黄优先，TCA 早者优先，超出截断 */
function capEvents(list: ConjunctionEvent[]): ConjunctionEvent[] {
  if (list.length <= EVENT_CLOUD_CAP) return list
  const rank = (lv: string) => (lv === 'red' ? 0 : lv === 'orange' ? 1 : 2)
  return [...list]
    .sort((a, b) => rank(a.level) - rank(b.level) || a.tca.localeCompare(b.tca))
    .slice(0, EVENT_CLOUD_CAP)
}

async function toggleEventCloud(): Promise<boolean> {
  if (eventOn.value) {
    eventOn.value = false
    closeEventCard()
    sceneRef.value?.showEventCloud(null)
    eventItems.value = []
    return false
  }
  eventLoading.value = true
  try {
    // 锚点依赖编目快照状态向量，未就绪先拉一次
    const { cloudList, loadConstellation } = useCatalog()
    if (!cloudList.value.length) await loadConstellation()
    await loadAliases()
    const raw = capEvents(await ensureEventRaw())
    const built = await buildEventCloudItems(raw.map(toCloudItem))
    eventItems.value = built.items
    if (!built.items.length) {
      ElMessage.info(t('sit.eventNone'))
      return false
    }
    if (built.skipped) console.info('[situation] event cloud skipped (no catalog pos)', built.skipped)
    eventOn.value = true
    sceneRef.value?.showEventCloud(built.items)
    return true
  } catch (e) {
    console.warn('[situation] event cloud load failed', e)
    ElMessage.error(t('sit.eventLoadFail'))
    return false
  } finally {
    eventLoading.value = false
  }
}

/** 三维点击事件云 → 高亮 + 详情卡（再点空白/关闭取消） */
function onEventPick(key: string | null) {
  if (!key) {
    closeEventCard()
    return
  }
  const hit = eventItems.value.find((x) => x.key === key)
  if (!hit) return
  if (selEvent.value?.key === key) {
    closeEventCard()
    return
  }
  selEvent.value = hit
  // R2-7：点选交会点直接进入放大态（双方模型 + 双方轨道 + 白圈）
  sceneRef.value?.focusEventCloud(key, true)
}

function closeEventCard() {
  selEvent.value = null
  sceneRef.value?.focusEventCloud(null)
}

function fmtEventTca(tca: string): string {
  const d = new Date(tca)
  if (Number.isNaN(d.getTime())) return tca
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

function fmtPcSci(pc: number | null): string {
  if (pc == null || !Number.isFinite(pc)) return '—'
  return pc === 0 ? '0' : pc.toExponential(2)
}

/** R2-15：交会点经纬度（度 → 带半球标识的短格式） */
function fmtEventGeo(latDeg?: number, lonDeg?: number): string {
  if (latDeg == null || lonDeg == null || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return '—'
  const ns = latDeg >= 0 ? 'N' : 'S'
  const ew = lonDeg >= 0 ? 'E' : 'W'
  return `${Math.abs(latDeg).toFixed(2)}°${ns}, ${Math.abs(lonDeg).toFixed(2)}°${ew}`
}

/* 深链 /situation?conj=A-B&tca=ms：打开事件云 → 定位 TCA → 飞向并高亮该事件 */
let pendingEventDeepLink = false

watch(
  () => [route.query.conj, route.query.tca] as const,
  ([conj, tca]) => {
    if (!conj) return
    pendingEventDeepLink = true
    void runPendingEventDeepLink()
  },
  { immediate: true }
)

async function runPendingEventDeepLink() {
  if (!pendingEventDeepLink) return
  const conj = String(route.query.conj || '')
  const tcaMs = Number(route.query.tca) || 0
  if (!viewportReady.value || !conj) return
  pendingEventDeepLink = false
  // 交会深链进入时清掉仍激活的星历轨道，避免和事件云叠在一起
  deactivateEphem()
  ephOpen.value = false
  if (!eventOn.value) {
    const ok = await toggleEventCloud()
    if (!ok) return
  }
  const [a, b] = conj.split('-').map((n) => Number(n))
  let hit = tcaMs
    ? eventItems.value.find((x) => x.key === `${a}:${b}:${tcaMs}`)
    : undefined
  if (!hit) {
    // 数据刷新后 TCA 可能漂移：同交会对 ±6h 内取最近
    let bestD = 6 * 3600e3
    for (const it of eventItems.value) {
      if (it.noradA !== a || it.noradB !== b) continue
      const d = tcaMs ? Math.abs(it.tcaMs - tcaMs) : 0
      if (d < bestD) {
        bestD = d
        hit = it
      }
    }
  }
  if (!hit) {
    ElMessage.warning(t('sit.eventMiss'))
    return
  }
  // 把 TCA 带进仿真钟（并重锚 24h 滑杆窗口）
  simAnchorMs.value = hit.tcaMs
  simTimeMs.value = hit.tcaMs
  sceneRef.value?.setSimTime(hit.tcaMs)
  sceneRef.value?.focusEventCloud(hit.key, true)
  selEvent.value = hit
}

/* 深链 /situation?norad=20580：定位编目目标并画出其轨道（不自动播放时间轴，不拉开左侧面板） */
let pendingNoradDeepLink: number | null = null

watch(
  () => route.query.norad,
  (norad) => {
    const raw = Array.isArray(norad) ? norad[0] : norad
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return
    pendingNoradDeepLink = Math.trunc(n)
    void runPendingNoradDeepLink()
  },
  { immediate: true }
)

async function runPendingNoradDeepLink() {
  const n = pendingNoradDeepLink
  if (!n || !viewportReady.value) return
  pendingNoradDeepLink = null
  // Keep default 1× playback running (same as a normal situation visit).
  // Maneuver locate / jump-to-t0 must not be changed — only this 打开仿真 deep-link plays.
  simPlaying.value = true
  try {
    const { fetchTleByNorad, cloudList, loadConstellation } = useCatalog()
    if (!cloudList.value.length) await loadConstellation()
    const hit = await fetchTleByNorad(n)
    if (!hit) {
      ElMessage.warning(t('sit.locateMiss'))
      return
    }
    await sceneRef.value?.selectCatalogItem(hit)
  } catch (e) {
    console.warn('[situation] norad locate failed', e)
    ElMessage.warning(t('sit.locateMiss'))
  }
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
  epochs: { t: number; dvMps?: number; duraSec?: number; id?: string; accX?: number; accY?: number; accZ?: number; refFrame?: string; basis?: string; dcType?: string; purpose?: string; deviceId?: string; extras?: Record<string, string> }[] | undefined
) {
  if (set.maneuvers?.length) return set
  if (!epochs?.length) return set
  const t0 = set.states[0]?.t ?? set.start
  const t1 = set.states[set.states.length - 1]?.t ?? set.stop
  const segs = epochs
    .map((m) => epochToSegment(m))
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
    <SceneCore ref="sceneRef" @viewport-ready="onViewportReady" @event-pick="onEventPick" />

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
      <button
        class="dock-btn"
        :class="{ on: eventOn }"
        :title="t('sit.eventTip')"
        :disabled="eventLoading"
        @click="toggleEventCloud"
      >
        <span class="dock-ico">☁</span><span class="dock-txt">{{ t('sit.eventCloud') }}</span>
        <span v-if="eventCount" class="dock-badge" :class="'lv-' + worstLevel">{{ eventCount }}</span>
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

    <!-- E4 交会事件详情卡：点击事件云 / 深链定位时显示 -->
    <div v-if="selEvent" class="event-card" :class="'lv-' + selEvent.level">
      <div class="ev-head">
        <span class="ev-badge">{{ t(`sit.eventLv.${selEvent.level}` as I18nKey) }}</span>
        <b class="ev-name mono">
          {{ objLabel(selEvent.noradA, selEvent.nameA) || selEvent.noradA }} × {{ objLabel(selEvent.noradB, selEvent.nameB) || selEvent.noradB }}
        </b>
        <button class="ev-close" :title="t('sit.eventClose')" @click="closeEventCard">×</button>
      </div>
      <div class="ev-grid">
        <span>{{ t('conj.col.tca') }}</span><b class="mono">{{ fmtEventTca(selEvent.tca) }}</b>
        <span>{{ t('conj.col.pc') }}</span><b class="mono strong">{{ fmtPcSci(selEvent.pc) }}</b>
        <span>{{ t('conj.col.miss') }}</span>
        <b class="mono">{{ selEvent.missKm != null ? selEvent.missKm.toFixed(3) + ' km' : '—' }}</b>
        <span>{{ t('conj.relVel') }}</span>
        <b class="mono">{{ selEvent.relSpeedKmS != null ? selEvent.relSpeedKmS.toFixed(2) + ' km/s' : t('conj.relVelNaShort') }}</b>
        <span>{{ t('sit.eventGeo') }}</span>
        <b class="mono">{{ fmtEventGeo(selEvent.latDeg, selEvent.lonDeg) }}</b>
        <span>{{ t('sit.eventAlt') }}</span>
        <b class="mono">{{ selEvent.altKm != null ? selEvent.altKm.toFixed(1) + ' km' : '—' }}</b>
        <span>{{ t('conj.col.cdm') }}</span><b class="mono">{{ selEvent.cdmCount }}</b>
      </div>
      <router-link
        class="ev-link"
        :to="{ name: 'conjunction-detail', params: { id: selEvent.key } }"
      >{{ t('sit.eventOpen') }} →</router-link>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
