<script setup lang="ts">
/**
 * 星历分析面板（桌面右侧滑出 / 移动端底部抽屉，由独立开关 ephOpen 控制）
 *
 * 对标 SpaceX Space Safety Platform 的「高精度星历 + 快速交会筛选」：
 * - 上传 / 内置样本 → 解析（ITC / OEM / OCM）→ 本机 IndexedDB 持久化；
 * - 激活后三维绘出该星历的完整轨道与当前位置；
 * - 一键与在轨目录做 24h / 48h / 72h 交会筛选（Worker 内粗筛 + 精筛 + Pc 计算）；
 * - 事件列表点击即在三维中定位并高亮该次接近。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ephOpen, fmtNum, drawerHeightVh, isDrawerDragging, useDrawerDrag } from './scene'
import {
  MAX_FILE_MB,
  activeEphem, ephemBusy, ephemError, ephemMetas,
  uploadProgress, uploadName, builtinSamples, loadBuiltinIndex, loadBuiltinSample,
  refreshEphemList, activateEphem, deactivateEphem, removeEphem, uploadEphemerides,
  threatEvents, threatSelected, screening, screenProgress, screenError, screenStats,
  runScreening, selectThreat, DEFAULT_SCREEN,
  type ScreenParams, type BuiltinSample
} from './ephem/useUserEphemeris'
import type { ThreatEvent, Vec3 } from './ephem/types'
import { useI18n } from '@/composables/useI18n'
import { getSet } from './ephem/store'
import { interpolateAt } from './ephem/interp'
import { gmstRad } from './ephem/time'
import { twoBodyPropagate } from './ephem/screening'

const { t } = useI18n()

/** 机动明细行：每段 MAN 的起始时刻 / 时长 / 位置经纬度（OCM 专有） */
interface ManRow { t0: number; duraSec: number; lat: string; lon: string; done: boolean }
/** 机动卡片定位事件负载（发给三维做标签文本与高亮定位） */
interface ManLocateInfo { idx: number; t0: number; duraSec: number; lat: string; lon: string }

const emit = defineEmits<{
  (e: 'close'): void
  /** 激活星历后：三维绘出该星历轨道并飞到目标 */
  (e: 'focus-set'): void
  /** 点选一条威胁事件：三维定位并高亮（null = 取消） */
  (e: 'focus-event', ev: ThreatEvent | null): void
  /** 质量卡「AI 解读」：把组织好的评估指标交给智能体抽屉提问 */
  (e: 'ai-explain', text: string): void
  /** 机动卡片点击：定位到该琥珀 MAN 块（null = 取消选中，撤高亮与标签） */
  (e: 'locate-man', idx: number | null, info: ManLocateInfo | null): void
}>()

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

/** 筛选参数（面板可调；默认 24h / 50 km / Pc 1e-6） */
const params = ref<ScreenParams>({ ...DEFAULT_SCREEN })

const activeName = computed(() => activeEphem.value?.name || '')
const activeMeta = computed(() => ephemMetas.value.find((m) => m.id === activeEphem.value?.id) || null)

/** ECI 位置 → 地心经纬度（度，东经 ±180°），仅展示用 */
function eciToLatLon(r: Vec3, tMs: number): { lat: number; lon: number } {
  const lat = (Math.atan2(r[2], Math.hypot(r[0], r[1])) * 180) / Math.PI
  let lon = ((Math.atan2(r[1], r[0]) - gmstRad(tMs)) * 180) / Math.PI
  lon = ((lon + 540) % 360) - 180
  return { lat, lon }
}

/** 纬度 → 「北纬 x.x° / 南纬 x.x°」 */
function fmtLat(lat: number): string {
  return `${lat >= 0 ? '北纬' : '南纬'} ${Math.abs(lat).toFixed(2)}°`
}

/** 经度 → 「东经 x.x° / 西经 x.x°」 */
function fmtLon(lon: number): string {
  return `${lon >= 0 ? '东经' : '西经'} ${Math.abs(lon).toFixed(2)}°`
}

/** 机动明细列表：每段 MAN 的起始时刻 / 时长 / 位置经纬度（OCM 专有） */
const activeManList = computed<ManRow[]>(() => {
  const mans = activeMeta.value?.maneuvers || []
  const set = activeEphem.value
  if (!mans.length || !set) return []
  return mans.map((m) => {
    // MAN 可落在 TRAJ 区间外（OCM 的 MAN 窗口常早于首点）：区间外用两端状态做二体推进近似
    let r: Vec3 | null = null
    const st = interpolateAt(set.states, m.t0)
    if (st) r = st.r
    else if (set.states.length) {
      const s0 = set.states[0]
      const sN = set.states[set.states.length - 1]
      const base = m.t0 < s0.t ? s0 : sN
      const prop = twoBodyPropagate(base.r, base.v, (m.t0 - base.t) / 1000)
      if (prop) r = prop.r
    }
    const ll = r ? eciToLatLon(r, m.t0) : null
    return {
      t0: m.t0,
      duraSec: Math.max(0, Math.round((m.t1 - m.t0) / 1000)),
      lat: ll ? fmtLat(ll.lat) : '—',
      lon: ll ? fmtLon(ll.lon) : '—',
      done: m.t1 < Date.now()
    }
  })
})
/** 当前选中的机动卡片下标（null = 无） */
const selectedMan = ref<number | null>(null)

/** 切换星历（或取消激活）时清空卡片选中态 */
watch(
  () => activeEphem.value?.id,
  () => {
    selectedMan.value = null
  }
)

/** 卡片点击：选中 → 高亮+大屏定位；再点取消；点其它卡片切换（窗口外段由三维二体推进近似定位） */
function toggleMan(i: number, m: ManRow) {
  if (selectedMan.value === i) {
    selectedMan.value = null
    emit('locate-man', null, null)
    return
  }
  selectedMan.value = i
  emit('locate-man', i, { idx: i, t0: m.t0, duraSec: m.duraSec, lat: m.lat, lon: m.lon })
}

/** 事件分档配色（与三维标记同一套） */
const LEVEL_COLOR: Record<ThreatEvent['level'], string> = {
  high: '#ff6b6b',
  medium: '#ffb454',
  low: '#7fb0ff'
}
const LEVEL_TEXT: Record<ThreatEvent['level'], string> = { high: '高危', medium: '警告', low: '关注' }

/** 导出某份星历为 JSON（含完整状态表，协方差转普通数组便于其它工具读取） */
async function exportSet(id: string) {
  try {
    const set = await getSet(id)
    if (!set) {
      ephemError.value = '导出失败：星历已不存在'
      return
    }
    const payload = {
      ...set,
      states: set.states.map((s) => ({
        t: s.t,
        r: [s.r[0], s.r[1], s.r[2]],
        v: [s.v[0], s.v[1], s.v[2]],
        ...(s.cov ? { cov: Array.from(s.cov) } : {})
      }))
    }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(set.name || 'ephemeris').replace(/[\\/:*?"<>|]/g, '_')}-${set.norad || 'x'}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    ephemError.value = (e as Error)?.message || '导出失败'
  }
}

function fmtUtc(ms?: number, withSec = false) {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return withSec ? `${base}:${p(d.getUTCSeconds())}` : base
}

function sizeText(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return '—'
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/** 元数据预计占用（状态点 × 7 个 float64 的粗略值） */
function metaSize(points: number, hasCov: boolean) {
  return sizeText(points * (hasCov ? 7 * 8 + 36 * 8 : 7 * 8))
}

onMounted(() => {
  void refreshEphemList().then(() => loadBuiltinIndex())
})

function pickFiles() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const el = e.target as HTMLInputElement
  const files = Array.from(el.files || [])
  el.value = ''
  if (files.length) void uploadEphemerides(files)
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length) void uploadEphemerides(files)
}

async function chooseSet(id: string) {
  // 已激活的星历再点一次 = 取消激活：列表去掉高亮，三维图层 / 目标与准星一并收起
  if (activeEphem.value?.id === id) {
    deactivateEphem()
    emit('focus-set')
    return
  }
  await activateEphem(id)
  emit('focus-set')
}

async function dropSet(id: string) {
  const wasActive = activeEphem.value?.id === id
  await removeEphem(id)
  // 删掉的正是当前激活的那份：通知三维清掉轨迹、目标标记与准星
  if (wasActive) emit('focus-set')
}

async function chooseBuiltin(s: BuiltinSample) {
  await loadBuiltinSample(s)
  if (activeEphem.value) emit('focus-set')
}

function pickEvent(ev: ThreatEvent) {
  // 已选中的行再点仍保持选中并重新定位（取消高亮用「取消高亮」按钮，避免误触把画面清掉）
  selectThreat(ev)
  emit('focus-event', ev)
}

function clearEvent() {
  selectThreat(null)
  emit('focus-event', null)
}

function startScreen() {
  void runScreening(params.value).then(() => {
    // 筛选完成后默认选中第一条最近的接近，用户可继续点其它条目
    if (threatEvents.value.length) pickEvent(threatEvents.value[0])
  })
}
</script>

<template>
  <transition name="panel">
    <aside v-if="ephOpen" class="side-panel ephem-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">星历分析</b>
          <span class="sp-count">{{ ephemMetas.length }} 份星历</span>
          <span class="sp-meta">{{ activeName || '上传高精度星历，生成交会威胁分析' }}</span>
        </div>
        <!-- 收起按钮：向右三角（与左侧「太空安全目标列表」收起键配套，方向相反） -->
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起星历分析" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5 Z" /></svg>
        </button>
      </div>

      <div class="ep-scroll">
        <!-- 上传 -->
        <div class="ep-sec">
          <div class="ep-sec-title">我的星历</div>
          <div class="ep-drop" :class="{ on: dragOver, busy: ephemBusy }"
            @click="pickFiles"
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop">
            <input ref="fileInput" class="ep-file" type="file" multiple
              accept=".itc,.txt,.oem,.ocm,.e,.json" @change="onFileChange" />
            <b>点击或拖拽星历文件到此处</b>
            <span>支持 ITC（Starlink MEME）/ CCSDS OEM / OCM，单文件 ≤ {{ MAX_FILE_MB }} MB</span>
          </div>
          <div v-if="ephemBusy && uploadName" class="ep-progress">
            <div class="ep-bar"><i :style="{ width: uploadProgress + '%' }"></i></div>
            <span>{{ uploadName }} · {{ uploadProgress }}%</span>
          </div>
          <div v-if="ephemError" class="ep-err">{{ ephemError }}</div>

          <div v-if="ephemMetas.length" class="ep-list">
            <div v-for="m in ephemMetas" :key="m.id" class="ep-item"
              :class="{ on: m.id === activeEphem?.id }"
              @click="chooseSet(m.id)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="m.name">{{ m.name }}</b>
                <span class="ep-tag">{{ m.format.toUpperCase() }}</span>
                <span v-if="m.maneuvers?.length" class="ep-tag man" title="OCM MAN 机动段">{{ m.maneuvers.length }} 处机动</span>
                <span class="ep-tag" :class="{ cov: m.hasCov }">{{ m.hasCov ? '含协方差' : '无协方差' }}</span>
                <span class="ep-tag">{{ m.source === 'builtin' ? '样本' : '上传' }}</span>
              </div>
              <div class="ep-item-sub">
                <span>NORAD {{ m.norad || '—' }}</span>
                <span>{{ fmtUtc(m.start) }} ~ {{ fmtUtc(m.stop) }} UTC</span>
                <span>{{ m.points.toLocaleString() }} 点 / {{ m.stepSec }}s</span>
                <span>{{ metaSize(m.points, m.hasCov) }}</span>
              </div>
              <button class="ep-dl" title="导出为 JSON（含完整状态表）" @click.stop="exportSet(m.id)">⇩</button>
              <button class="ep-del" title="删除这份星历" @click.stop="dropSet(m.id)">×</button>
            </div>
          </div>
          <div v-else-if="!ephemBusy" class="ep-empty">还没有星历文件，可先载入下方内置样本体验</div>
        </div>

        <!-- 内置样本 -->
        <div v-if="builtinSamples.length" class="ep-sec">
          <div class="ep-sec-title">内置星历样本<span class="ep-sec-sub">Starlink 官方公开 · ITC / OCM（OCM 含机动段与协方差）</span></div>
          <div class="ep-list is-builtin">
            <div v-for="s in builtinSamples" :key="s.id" class="ep-item is-builtin"
              @click="chooseBuiltin(s)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="`${s.name} · NORAD ${s.norad} · ${s.points.toLocaleString()} 点${s.maneuverSummary ? ' · ' + s.maneuverSummary : ''}`">{{ s.name }}</b>
                <span class="ep-tag" :class="{ ocm: s.format === 'OCM' }">{{ s.format }}</span>
                <span v-if="s.maneuvers > 0" class="ep-tag man" :title="s.maneuverSummary">{{ s.maneuvers }} 处机动</span>
                <span class="ep-tag" :class="{ cov: s.hasCov }">{{ s.hasCov ? '含协方差' : '无协方差' }}</span>
              </div>
              <span class="ep-load">{{ s.loaded ? '重新载入' : '载入' }}</span>
            </div>
          </div>
        </div>

        <!-- 当前星历信息 + 质量 -->
        <div v-if="activeEphem" class="ep-sec">
          <div class="ep-sec-title">星历信息</div>
          <div class="ep-kv">
            <div class="ep-kv-row"><span>名称</span><b>{{ activeEphem.name }}</b></div>
            <div class="ep-kv-row"><span>NORAD</span><b>{{ activeEphem.norad || '—' }}</b></div>
            <div class="ep-kv-row"><span>格式 / 坐标系</span><b>{{ activeEphem.format.toUpperCase() }} · {{ activeEphem.frame }}</b></div>
            <div class="ep-kv-row"><span>有效期(UTC)</span><b>{{ fmtUtc(activeEphem.states[0]?.t ?? activeEphem.start, true) }} ~ {{ fmtUtc(activeEphem.states[activeEphem.states.length - 1]?.t ?? activeEphem.stop, true) }}</b></div>
            <div class="ep-kv-row"><span>步长 / 点数</span><b>{{ activeEphem.stepSec }} s · {{ activeEphem.states.length.toLocaleString() }}</b></div>
            <div class="ep-kv-row"><span>协方差</span><b>{{ activeMeta?.hasCov ? '有' : '无' }}</b></div>
            <div class="ep-kv-row ep-kv-man">
              <span>机动</span>
              <b>
                <template v-if="activeManList.length">
                  <span class="ep-man-line">{{ activeManList.length }} 处机动段</span>
                  <button
                    v-for="(m, i) in activeManList"
                    :key="i"
                    type="button"
                    class="ep-man-card"
                    :class="{ 'is-active': selectedMan === i }"
                    :title="t('sit.locateManTip')"
                    @click="toggleMan(i, m)"
                  >
                    <span class="ep-man-line is-head">
                      <span>{{ i + 1 }}. {{ fmtUtc(m.t0, true) }} UTC · {{ m.duraSec }} s</span>
                      <em v-if="m.done" class="ep-man-done">已完成</em>
                    </span>
                    <span class="ep-man-line is-item">{{ m.lat }} / {{ m.lon }}</span>
                  </button>
                </template>
                <template v-else>无</template>
              </b>
            </div>
          </div>
        </div>

        <!-- 威胁筛选 -->
        <div v-if="activeEphem" class="ep-sec">
          <div class="ep-sec-title">威胁筛选<span class="ep-sec-sub">与在轨目录做快速交会分析</span></div>
          <div class="ep-params">
            <label class="ep-param">
              <span>时间窗</span>
              <select v-model.number="params.windowH">
                <option :value="6">6 小时</option>
                <option :value="12">12 小时</option>
                <option :value="24">24 小时</option>
                <option :value="48">48 小时</option>
                <option :value="72">72 小时</option>
              </select>
            </label>
            <label class="ep-param">
              <span>报告距离</span>
              <select v-model.number="params.maxDistKm">
                <option :value="10">10 km</option>
                <option :value="25">25 km</option>
                <option :value="50">50 km</option>
                <option :value="100">100 km</option>
              </select>
            </label>
            <label class="ep-param">
              <span>粗筛步长</span>
              <select v-model.number="params.coarseStepSec">
                <option :value="120">120 s</option>
                <option :value="300">300 s</option>
                <option :value="600">600 s</option>
              </select>
            </label>
          </div>
          <button class="ep-run" :disabled="screening" @click="startScreen">
            {{ screening ? `筛选中 ${Math.round(screenProgress * 100)}%` : '开始威胁筛选' }}
          </button>
          <div v-if="screening" class="ep-bar is-run"><i :style="{ width: Math.round(screenProgress * 100) + '%' }"></i></div>
          <div v-if="screenError" class="ep-err">{{ screenError }}</div>
          <div v-if="screenStats" class="ep-stat">
            目录 {{ screenStats.catalog.toLocaleString() }} 个 ·
            同轨道带 {{ screenStats.kept.toLocaleString() }} 个 ·
            窗口 {{ screenStats.windowH.toFixed(0) }} h ·
            耗时 {{ (screenStats.ms / 1000).toFixed(1) }} s
          </div>

          <div class="ep-events">
            <div class="ep-ev-head">
              <b>威胁事件</b>
              <span>{{ threatEvents.length }} 条</span>
              <button v-if="threatSelected" class="ep-ev-clear" @click="clearEvent">取消高亮</button>
            </div>
            <div v-if="!threatEvents.length && !screening" class="ep-empty is-sm">
              暂无结果，点击上方按钮开始筛选
            </div>
            <div v-for="ev in threatEvents" :key="ev.id" class="ep-ev"
              :class="{ on: threatSelected?.id === ev.id }"
              @click="pickEvent(ev)">
              <div class="ep-ev-top">
                <span class="ep-ev-name" :title="ev.otherName">{{ ev.otherName }}</span>
                <span class="ep-ev-miss" :style="{ color: LEVEL_COLOR[ev.level] }">{{ fmtNum(ev.missKm, 2) }} km</span>
              </div>
              <div class="ep-ev-sub">
                <span class="ep-dot" :style="{ background: LEVEL_COLOR[ev.level] }"></span>
                <span>{{ LEVEL_TEXT[ev.level] }}</span>
                <span>{{ fmtUtc(ev.tca, true) }} UTC</span>
                <span>相对速度 {{ fmtNum(ev.relSpeedKmS, 2) }} km/s</span>
                <span>Pc {{ ev.pc > 0 ? ev.pc.toExponential(1) : '—' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 本面板是实体内容面板（上传 / 参数 / 列表都要可点），整体恢复事件；
   其它列表面板为「空白处点击穿透到画布」才默认 pointer-events:none */
.side-panel.ephem-panel { pointer-events: auto; user-select: text; }

/* 收起按钮与左侧「太空安全目标列表」同规格：脱离文档流钉在头部右侧，两者顶端对齐（同为面板顶 +8px） */
.side-panel .sp-head .sp-close.sp-close-tri { position: absolute; right: 10px; top: 8px; }

/* 桌面端：停靠右侧（与右侧详情同侧），滑入方向也改为自右向左；
   移动端仍是底部抽屉（html.is-mobile .side-panel 的 left/right/top/bottom 规则优先级更高，这里不覆盖） */
@media (min-width: 769px) {
  .side-panel.ephem-panel {
    left: auto;
    right: 0;
    z-index: 8;
  }
  .ephem-panel.panel-enter-from,
  .ephem-panel.panel-leave-to { transform: translateX(100%); }
}

/* 面板内容滚动区：头部固定，其余整体滚动 */
.ep-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-top: 8px;
  scrollbar-width: thin; scrollbar-color: rgba(120,160,220,0.35) transparent; }

.ep-sec { padding: 8px 0 10px; border-bottom: 1px solid rgba(120,160,220,0.12);
  &:last-child { border-bottom: 0; } }
.ep-sec-title { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; font-weight: 700;
  color: #cfe0f5; letter-spacing: 0.3px; margin-bottom: 7px;
  .ep-sec-sub { font-size: 10px; font-weight: 400; color: #7d92b0; } }

/* 上传区 */
.ep-drop { position: relative; border: 1px dashed rgba(110,160,230,0.42); border-radius: 8px;
  background: rgba(30,60,110,0.18); padding: 14px 10px; text-align: center; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  display: flex; flex-direction: column; gap: 4px;
  b { font-size: 11.5px; color: #dbe9fb; }
  span { font-size: 10px; color: #8ea4c4; }
  &:hover, &.on { background: rgba(50,100,180,0.26); border-color: #4f8de0; }
  &.busy { pointer-events: none; opacity: 0.7; } }
.ep-file { display: none; }

.ep-progress { display: flex; align-items: center; gap: 8px; margin-top: 6px;
  span { font-size: 10px; color: #8ea4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-bar { flex: 1 1 auto; height: 4px; border-radius: 2px; background: rgba(120,160,220,0.2); overflow: hidden;
  i { display: block; height: 100%; background: linear-gradient(90deg, #3f9dff, #6fe0ff); transition: width 0.2s; }
  &.is-run { margin-top: 6px; } }

.ep-err { margin-top: 6px; font-size: 10.5px; line-height: 1.45; color: #ff8f8f;
  background: rgba(255,90,90,0.08); border: 1px solid rgba(255,90,90,0.22); border-radius: 6px; padding: 5px 8px; }
.ep-empty { font-size: 10.5px; color: #7d92b0; padding: 10px 2px; text-align: center;
  &.is-sm { padding: 8px 0; } }

/* 星历列表 */
.ep-list { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.ep-item { position: relative; padding: 7px 46px 7px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.44); border-color: rgba(120,175,255,0.4); }
  &.on { border-color: #4f8de0; background: rgba(50,100,180,0.42); }
  &.is-builtin { padding-right: 9px; display: flex; align-items: center; justify-content: space-between; gap: 8px; } }
.ep-item-main { display: flex; align-items: center; gap: 5px; min-width: 0;
  .ep-item-name { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: #eaf2fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-tag { flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  color: #9dbbdd; background: rgba(110,160,230,0.16); border: 1px solid rgba(110,160,230,0.22);
  &.cov { color: #6fe0c0; background: rgba(80,220,180,0.12); border-color: rgba(80,220,180,0.28); }
  &.man { color: #ffc98a; background: rgba(255,170,70,0.12); border-color: rgba(255,170,80,0.3); }
  &.ocm { color: #ffb46f; background: rgba(255,150,50,0.14); border-color: rgba(255,160,60,0.36); } }
.ep-item-sub { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-del { position: absolute; top: 5px; right: 5px; width: 18px; height: 18px; line-height: 16px;
  border-radius: 4px; border: 0; background: transparent; color: #7d92b0; font-size: 14px; cursor: pointer;
  &:hover { background: rgba(255,90,90,0.18); color: #ff8f8f; } }
.ep-dl { position: absolute; top: 5px; right: 25px; width: 18px; height: 18px; line-height: 16px;
  border-radius: 4px; border: 0; background: transparent; color: #7d92b0; font-size: 12px; cursor: pointer;
  &:hover { background: rgba(80,140,230,0.2); color: #9fc6ff; } }
.ep-load { flex: none; font-size: 10px; color: #7fb0ff; padding: 3px 7px; border-radius: 9px;
  background: rgba(80,140,230,0.16); border: 1px solid rgba(110,160,230,0.3); }
.ep-item.is-builtin:hover .ep-load { background: rgba(80,140,230,0.3); }

/* 键值表 */
.ep-kv { display: flex; flex-direction: column; gap: 4px; }
.ep-kv-row { display: flex; align-items: baseline; gap: 8px; font-size: 10.5px;
  > span { flex: none; width: 84px; color: #8ea4c4; }
  b { flex: 1 1 auto; min-width: 0; color: #eaf2fc; font-weight: 600; word-break: break-all; }
  &.is-sub span { width: auto; } &.is-sub b { flex: none; } }

/* 机动明细：首行总数；每段 MAN 为一张琥珀边框卡片（时刻/时长 + 经纬度两行） */
.ep-man-line { display: block; font-size: 10px; line-height: 1.55; font-weight: 400; color: #cfe0f5;
  &.is-item { color: #9dbbdd; }
  &.is-head { display: flex; align-items: baseline; gap: 6px; > span { flex: 1 1 auto; min-width: 0; } } }

/* 「已完成」小字徽标（机动结束时刻早于真实时间） */
.ep-man-done { flex: none; font-style: normal; font-size: 8.5px; line-height: 1.5;
  color: #ffb454; background: rgba(255, 180, 84, 0.14);
  border: 1px solid rgba(255, 180, 84, 0.4); border-radius: 4px; padding: 0 4px; }

/* 机动卡片：点击高亮并在大屏定位对应琥珀机动块（含 TRAJ 窗口外已完成的段） */
.ep-man-card {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 3px 8px 4px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  background: rgba(255, 180, 84, 0.07);
  border: 1px solid rgba(255, 180, 84, 0.4);
  border-radius: 6px;
  transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;

  &:hover {
    border-color: rgba(255, 180, 84, 0.75);
    background: rgba(255, 180, 84, 0.12);
  }
  &.is-active {
    border-color: #ffb454;
    background: rgba(255, 180, 84, 0.18);
    box-shadow: 0 0 6px rgba(255, 180, 84, 0.35);
  }
}

/* 质量卡 */
.ep-quality { margin-top: 8px; padding: 8px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); }
.ep-q-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px;
  .ep-q-label { font-size: 10.5px; color: #8ea4c4; }
  .ep-q-score { font-size: 16px; font-weight: 800; line-height: 1;
    i { font-size: 10px; font-style: normal; font-weight: 400; opacity: 0.7; } }
  .ep-q-grade { font-size: 11px; font-weight: 700; } }
.ep-q-ai { margin-left: auto; align-self: center; padding: 2px 7px; font-size: 9.5px; line-height: 1.4;
  color: #9fc6ff; background: rgba(46,96,168,0.35); border: 1px solid rgba(110,160,230,0.42);
  border-radius: 4px; cursor: pointer;
  &:hover { color: #dbe9fb; background: rgba(62,120,200,0.5); } }
.ep-notes { margin: 5px 0 0; padding-left: 14px;
  li { font-size: 9.5px; line-height: 1.5; color: #8ea4c4; } }

/* 双文件对比 */
.ep-q-sel { flex: 1 1 auto; min-width: 0; height: 22px; font-size: 10px; color: #dbe9fb;
  background: rgba(20,44,82,0.9); border: 1px solid rgba(110,150,210,0.3); border-radius: 4px; outline: none; }
.ep-q-hint { margin-top: 3px; font-size: 9.5px; color: #7d92b0;
  &.is-err { color: #ff8f8f; } }

/* TLE 外推偏差卡 */
.ep-tle { margin-top: 7px; padding: 8px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.28); border: 1px solid rgba(110,150,210,0.18); }
.ep-tle-norad { margin-left: auto; font-size: 9px; color: #7d92b0; }
.ep-tle-curve { display: block; width: 100%; height: 46px; margin-top: 6px;
  background: rgba(10,26,50,0.5); border-radius: 4px; }
.ep-tle-axis { display: flex; justify-content: space-between; gap: 6px; margin-top: 3px;
  span { font-size: 9px; color: #7d92b0; } }
.ep-tle-note { margin-top: 3px; font-size: 9px; line-height: 1.45; color: #7d92b0; }

/* 筛选参数 */
.ep-params { display: flex; gap: 6px; margin-bottom: 7px; }
.ep-param { flex: 1 1 0; display: flex; flex-direction: column; gap: 3px;
  span { font-size: 9.5px; color: #8ea4c4; }
  select { height: 24px; padding: 0 4px; font-size: 10.5px; color: #dbe9fb; border-radius: 5px;
    background: rgba(20,44,82,0.9); border: 1px solid rgba(110,150,210,0.3); outline: none; } }
.ep-run { width: 100%; height: 28px; border-radius: 6px; border: 1px solid rgba(90,160,255,0.5);
  background: linear-gradient(180deg, rgba(60,130,235,0.55), rgba(40,95,190,0.55)); color: #eaf2fc;
  font-size: 11.5px; font-weight: 700; cursor: pointer;
  &:hover:not(:disabled) { border-color: #7fb8ff; background: linear-gradient(180deg, rgba(70,145,250,0.7), rgba(45,105,205,0.7)); }
  &:disabled { opacity: 0.6; cursor: default; } }
.ep-stat { margin-top: 6px; font-size: 9.5px; color: #7d92b0; line-height: 1.45; }

/* 事件列表 */
.ep-events { margin-top: 9px; display: flex; flex-direction: column; gap: 5px; }
.ep-ev-head { display: flex; align-items: baseline; gap: 6px;
  b { font-size: 11px; color: #cfe0f5; }
  span { font-size: 9.5px; color: #7fb0ff; }
  .ep-ev-clear { margin-left: auto; font-size: 9.5px; color: #8ea4c4; background: transparent;
    border: 1px solid rgba(110,150,210,0.3); border-radius: 4px; padding: 1px 5px; cursor: pointer;
    &:hover { color: #dbe9fb; border-color: rgba(120,175,255,0.5); } } }
.ep-ev { padding: 6px 8px; border-radius: 6px; background: rgba(26,52,96,0.3);
  border: 1px solid rgba(110,150,210,0.18); cursor: pointer; transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.42); }
  &.on { border-color: rgba(120,175,255,0.7); background: rgba(50,100,180,0.44); } }
.ep-ev-top { display: flex; align-items: baseline; gap: 8px;
  .ep-ev-name { flex: 1 1 auto; min-width: 0; font-size: 10.5px; color: #eaf2fc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ep-ev-miss { flex: none; font-size: 11px; font-weight: 700; } }
.ep-ev-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; margin-top: 3px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; }

/* 小屏：面板为底部抽屉，参数区换行 */
@media (max-width: 720px) {
  .ep-params { flex-wrap: wrap; }
  .ep-param { flex: 1 1 30%; }
  .ep-kv-row > span { width: 74px; }
}

</style>
