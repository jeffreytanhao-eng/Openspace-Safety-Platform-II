<script setup lang="ts">
/**
 * 星历分析面板（桌面右侧滑出 / 移动端底部抽屉，由独立开关 ephOpen 控制）
 *
 * 对标 SpaceX Space Safety Platform 的「高精度星历」：
 * - 服务端内置样本（data/ephemerides 索引）与本机上传统一为一份合并列表 → 解析（ITC / OEM / OCM）→ IndexedDB 持久化；
 * - 激活后三维绘出该星历的完整轨道与当前位置。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ephOpen, drawerHeightVh, isDrawerDragging, useDrawerDrag } from './scene'
import {
  MAX_FILE_MB,
  activeEphem, ephemBusy, ephemError, ephemMetas,
  uploadProgress, uploadName, builtinSamples, loadBuiltinIndex, loadBuiltinSample,
  refreshEphemList, activateEphem, deactivateEphem, removeEphem, uploadEphemerides,
  type BuiltinSample
} from './ephem/useUserEphemeris'
import type { ThreatEvent, Vec3 } from './ephem/types'
import { useI18n } from '@/composables/useI18n'
import type { EphemMeta } from './ephem/store'
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

const activeName = computed(() => activeEphem.value?.name || '')
const activeMeta = computed(() => ephemMetas.value.find((m) => m.id === activeEphem.value?.id) || null)

/* ---------------- 星历搜索（大数量时快速定位；本地过滤 name / NORAD / 格式） ---------------- */

const epInput = ref('')
const epFilter = ref('')
const epFilterKey = computed(() => epFilter.value.trim().toLowerCase())

/** 点击「搜索」按钮或回车时应用过滤词（大列表避免逐键过滤） */
function applySearch() {
  epFilter.value = epInput.value
  ;(document.activeElement as HTMLElement | null)?.blur?.()
}

/** 清空输入框（含原生 × 清除）即时恢复全量列表 */
watch(epInput, (v) => {
  if (!v.trim()) epFilter.value = ''
})

/* ---------------- 合并列表（内置样本 + 本机记录，去重后统一分页展示） ---------------- */

/** 统一卡片数据：服务端样本（载入即用）与本机记录（可删除）归一化 */
interface EphCard {
  key: string
  kind: 'builtin' | 'local'
  id: string
  name: string
  norad: number | string
  format: string
  points: number
  hasCov: boolean
  maneuvers: number
  maneuverSummary?: string
  startMs?: number
  stopMs?: number
  stepSec?: number
  /** 文件原大小展示文案（本机记录为 IndexedDB 占用估算） */
  sizeText?: string
  /** builtin：已载入过（角标「重新载入」） */
  loaded?: boolean
  /** builtin 原始样本对象（点击载入用） */
  sample?: BuiltinSample
  /** local 原始元数据 */
  meta?: EphemMeta
}

/** builtin 样本 → 卡片 */
function builtinCard(s: BuiltinSample): EphCard {
  return {
    key: `b-${s.id}`,
    kind: 'builtin',
    id: s.id,
    name: s.name,
    norad: s.norad,
    format: s.format,
    points: s.points,
    hasCov: s.hasCov,
    maneuvers: s.maneuvers,
    maneuverSummary: s.maneuverSummary || undefined,
    startMs: s.startMs,
    stopMs: s.stopMs,
    stepSec: s.stepSec,
    sizeText: s.sizeText,
    loaded: s.loaded,
    sample: s
  }
}

/** 本机记录 → 卡片 */
function localCard(m: EphemMeta): EphCard {
  return {
    key: `u-${m.id}`,
    kind: 'local',
    id: m.id,
    name: m.name,
    norad: m.norad,
    format: m.format.toUpperCase(),
    points: m.points,
    hasCov: m.hasCov,
    maneuvers: m.maneuvers?.length || 0,
    startMs: m.start,
    stopMs: m.stop,
    stepSec: m.stepSec,
    sizeText: metaSize(m.points, m.hasCov),
    meta: m
  }
}

/**
 * 合并列表：服务端内置样本优先；本机记录中 name+format 与样本重复的
 * （同一样本的旧解析缓存副本，NORAD 口径可能还是旧值）不再重复展示。
 */
const mergedEphs = computed<EphCard[]>(() => {
  const seen = new Set<string>()
  const cards: EphCard[] = []
  for (const s of builtinSamples.value) {
    seen.add(`${s.name}|${s.format}`)
    cards.push(builtinCard(s))
  }
  for (const m of ephemMetas.value) {
    const key = `${m.name}|${m.format.toUpperCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    cards.push(localCard(m))
  }
  return cards
})

/** 搜索过滤（name / NORAD / 格式子串） */
const filteredMerged = computed(() => {
  const k = epFilterKey.value
  if (!k) return mergedEphs.value
  return mergedEphs.value.filter(
    (c) =>
      c.name.toLowerCase().includes(k) ||
      String(c.norad || '').includes(k) ||
      c.format.toLowerCase().includes(k)
  )
})

/* ---------------- 分页（每页 6 张卡片） ---------------- */

const EP_PAGE_SIZE = 6
const epPage = ref(1)

const epTotalPages = computed(() => Math.max(1, Math.ceil(filteredMerged.value.length / EP_PAGE_SIZE)))

/** 搜索/过滤变化后回到第一页，并夹紧越界页码 */
watch([epFilterKey, mergedEphs], () => {
  if (epPage.value > epTotalPages.value) epPage.value = epTotalPages.value
  if (epPage.value < 1) epPage.value = 1
})
watch(epFilterKey, () => {
  epPage.value = 1
})

const pagedEphs = computed(() =>
  filteredMerged.value.slice((epPage.value - 1) * EP_PAGE_SIZE, epPage.value * EP_PAGE_SIZE)
)

function epGoPage(p: number) {
  epPage.value = Math.min(Math.max(1, p), epTotalPages.value)
}

/** 头部计数：合并去重后的总份数（与星历管理页口径一致） */
const totalEphCount = computed(() => mergedEphs.value.length)

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

/** 合并卡片点击：内置样本走载入流程，本机记录走激活 / 取消激活 */
function chooseCard(c: EphCard) {
  if (c.kind === 'builtin' && c.sample) void chooseBuiltin(c.sample)
  else if (c.kind === 'local') void chooseSet(c.id)
}

/** 卡片激活态：本机记录按 id；内置样本载入后 set.id 是 builtin-* 派生键，按 名称+格式 匹配（与合并列表去重同口径，对旧缓存记录的 NORAD 旧值免疫） */
function isCardActive(c: EphCard): boolean {
  const a = activeEphem.value
  if (!a) return false
  if (c.kind === 'local') return c.id === a.id
  return c.name.toUpperCase() === a.name.toUpperCase() && c.format.toUpperCase() === a.format.toUpperCase()
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
          <b class="sp-title">星历文件解析</b>
          <span class="sp-count">{{ totalEphCount }} 份星历</span>
          <span class="sp-meta">{{ activeName || '上传高精度星历，生成交会威胁分析' }}</span>
        </div>
        <!-- 收起按钮：向右三角（与左侧「太空安全目标列表」收起键配套，方向相反） -->
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起星历分析" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5 Z" /></svg>
        </button>
      </div>

      <!-- 搜索（固定于面板顶部，不随下方列表滚动；按名称 / NORAD ID 过滤两区列表） -->
      <div class="ep-search">
        <input
          v-model="epInput"
          type="search"
          placeholder="搜索星历（名称 / NORAD ID）"
          @keyup.enter="applySearch"
        />
        <button class="ep-search-btn" type="button" title="应用搜索" @click="applySearch">搜索</button>
      </div>

      <div class="ep-scroll">
        <!-- 星历列表（服务端样本 + 本机记录合并、去重后统一分页，每页 6 张） -->
        <div class="ep-sec">
          <div class="ep-sec-title">我的星历<span class="ep-sec-sub">含服务端样本 · {{ filteredMerged.length }} 份</span></div>
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

          <template v-if="mergedEphs.length">
            <div v-if="pagedEphs.length" class="ep-list">
              <div v-for="c in pagedEphs" :key="c.key" class="ep-item"
                :class="{ on: isCardActive(c), 'is-builtin': c.kind === 'builtin' }"
                @click="chooseCard(c)">
                <b class="ep-name" :title="c.name">{{ c.name }}</b>
                <div class="ep-tags">
                  <span class="ep-tag" :class="{ ocm: c.format === 'OCM' }">{{ c.format }}</span>
                  <span v-if="c.maneuvers > 0" class="ep-tag man" :title="c.maneuverSummary">{{ c.maneuvers }} 处机动</span>
                  <span class="ep-tag" :class="{ cov: c.hasCov }">{{ c.hasCov ? '含协方差' : '无协方差' }}</span>
                </div>
                <div class="ep-meta">
                  <span>NORAD {{ c.norad || '—' }}</span>
                  <span>{{ fmtUtc(c.startMs) }} ~ {{ fmtUtc(c.stopMs) }} UTC</span>
                </div>
                <div class="ep-meta">
                  <span>{{ c.points.toLocaleString() }} 点</span>
                  <span v-if="c.sizeText">{{ c.sizeText }}</span>
                </div>
                <button v-if="c.kind === 'builtin'" class="ep-load" type="button"
                  :title="c.loaded ? '已载入过，点击重新解析载入' : '解析并载入这份样本'"
                  @click.stop="chooseCard(c)">{{ c.loaded ? '重新载入' : '载入' }}</button>
                <button v-else class="ep-del" title="删除这份星历" @click.stop="dropSet(c.id)">×</button>
              </div>
            </div>
            <div v-else class="ep-empty">无匹配星历</div>
            <div v-if="epTotalPages > 1" class="ep-pager">
              <button type="button" :disabled="epPage <= 1" title="上一页" @click="epGoPage(epPage - 1)">‹</button>
              <button v-for="p in epTotalPages" :key="p" type="button"
                :class="{ on: p === epPage }" @click="epGoPage(p)">{{ p }}</button>
              <button type="button" :disabled="epPage >= epTotalPages" title="下一页" @click="epGoPage(epPage + 1)">›</button>
            </div>
          </template>
          <div v-else-if="!ephemBusy" class="ep-empty">还没有星历文件，可上传文件，或在星历管理页点「刷新」同步服务端样本</div>
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

/* 星历搜索栏（固定在面板头部下方，不随 ep-scroll 内容滚动） */
.ep-search {
  display: flex; gap: 6px; align-items: center;
  padding: 8px 10px; border-bottom: 1px solid rgba(120,160,220,0.18);
  background: rgba(6, 12, 22, 0.35);
}
.ep-search input {
  flex: 1 1 auto; min-width: 0; appearance: none; border: 1px solid rgba(110,160,230,0.35);
  background: rgba(8, 16, 28, 0.55); color: var(--text);
  border-radius: 6px; padding: 6px 9px; font-size: 11.5px; outline: none;
}
.ep-search input::placeholder { color: var(--text-dim); }
.ep-search input:focus { border-color: rgba(110,160,230,0.75); background: rgba(8, 16, 28, 0.8); }
.ep-search-btn {
  flex: 0 0 auto; border: 1px solid rgba(110,160,230,0.5); border-radius: 6px;
  background: rgba(30, 60, 100, 0.45); color: var(--text);
  padding: 6px 12px; font-size: 11.5px; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.ep-search-btn:hover { background: rgba(45, 85, 135, 0.6); border-color: rgba(140,190,255,0.75); }

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
  i { display: block; height: 100%; background: linear-gradient(90deg, #3f9dff, #6fe0ff); transition: width 0.2s; } }

.ep-err { margin-top: 6px; font-size: 10.5px; line-height: 1.45; color: #ff8f8f;
  background: rgba(255,90,90,0.08); border: 1px solid rgba(255,90,90,0.22); border-radius: 6px; padding: 5px 8px; }
.ep-empty { font-size: 10.5px; color: #7d92b0; padding: 10px 2px; text-align: center;
  &.is-sm { padding: 8px 0; } }

/* 星历列表（合并卡片 4 行：行1 名称 / 行2 标签 / 行3 NORAD+时间 / 行4 点数+大小） */
.ep-list { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.ep-item { position: relative; padding: 7px 26px 8px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.44); border-color: rgba(120,175,255,0.4); }
  /* 激活（已载入/当前显示）的星历卡片：高亮边框 + 亮底 + 微光，与未选中卡片拉开层次 */
  &.on {
    border-color: #6fb4ff;
    background: rgba(64,128,220,0.58);
    box-shadow: 0 0 10px rgba(80,150,255,0.4), inset 0 0 0 1px rgba(140,190,255,0.4);
    .ep-name { color: #ffffff; }
  }
  /* 内置样本：右上角「载入」角标，右侧留出空间避免标题遮挡 */
  &.is-builtin { padding-right: 76px; } }
.ep-name { display: block; min-width: 0; font-size: 11.5px; color: #eaf2fc;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ep-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.ep-meta { display: flex; flex-wrap: wrap; gap: 3px 10px; margin-top: 4px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-tag { flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  color: #9dbbdd; background: rgba(110,160,230,0.16); border: 1px solid rgba(110,160,230,0.22);
  &.cov { color: #6fe0c0; background: rgba(80,220,180,0.12); border-color: rgba(80,220,180,0.28); }
  &.man { color: #ffc98a; background: rgba(255,170,70,0.12); border-color: rgba(255,170,80,0.3); }
  &.ocm { color: #ffb46f; background: rgba(255,150,50,0.14); border-color: rgba(255,160,60,0.36); } }
.ep-del { position: absolute; top: 5px; right: 5px; width: 18px; height: 18px; line-height: 16px;
  border-radius: 4px; border: 0; background: transparent; color: #7d92b0; font-size: 14px; cursor: pointer;
  &:hover { background: rgba(255,90,90,0.18); color: #ff8f8f; } }
.ep-load { position: absolute; top: 6px; right: 6px; font-family: inherit; font-size: 10px; line-height: 1.3;
  color: #7fb0ff; padding: 3px 8px; border-radius: 9px; cursor: pointer; white-space: nowrap;
  background: rgba(80,140,230,0.16); border: 1px solid rgba(110,160,230,0.3);
  transition: background 0.15s, color 0.15s;
  &:hover { background: rgba(80,140,230,0.3); color: #9fc6ff; } }

/* 分页导航（每页 6 张卡片） */
.ep-pager { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px; margin-top: 8px;
  button { min-width: 22px; height: 22px; padding: 0 5px; font-size: 10.5px; line-height: 1; color: #9dbbdd;
    background: rgba(30,60,100,0.35); border: 1px solid rgba(110,150,210,0.28); border-radius: 4px; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    &:hover:not(:disabled):not(.on) { color: #dbe9fb; border-color: rgba(120,175,255,0.5); }
    &.on { color: #eaf2fc; font-weight: 700; border-color: #4f8de0; background: rgba(50,100,180,0.45); }
    &:disabled { opacity: 0.4; cursor: default; } } }

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

/* 小屏：面板为底部抽屉 */
@media (max-width: 720px) {
  .ep-kv-row > span { width: 74px; }
}

</style>
