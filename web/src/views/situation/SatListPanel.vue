<script setup lang="ts">
/**
 * 左侧「太空安全目标列表」— 对齐旧 Openspace-Safety-Platform SatListPanel 口径：
 * - 「卫星/碎片/残骸/未知」类型芯片：只驱动三维类型显隐（默认全关）；切「卫星」会复位星座卡片覆盖态
 * - 「位置展示」：空间站独立通道（stationFocus），不影响类型芯片与星座展示
 * - 「星座展示」：星座独立通道（consShowMap），不写搜索框、不改类型芯片
 * - 「轨道展示」：仅在该星座已展示时可点；点亮后画该星座轨道（旧叫轨道展示，不是文案说明）
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  TYPE_COLOR, TYPE_KEYS, TYPE_LABEL, normalizeObjectType,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'
import { useCatalog, type CatalogTle } from '@/composables/useCatalog'
import { useI18n } from '@/composables/useI18n'

const { t, locale } = useI18n()

const TYPE_LABEL_EN: Record<string, string> = {
  PAYLOAD: 'Satellite',
  DEBRIS: 'Debris',
  'ROCKET BODY': 'Rocket body',
  UNKNOWN: 'Unknown'
}
function typeLabel(k: string) {
  if (locale.value === 'en') return TYPE_LABEL_EN[k] || TYPE_LABEL[k] || k
  return TYPE_LABEL[k] || k
}

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', item: CatalogTle): void
  (e: 'types', types: string[]): void
  (e: 'stationShow', norad: number): void
  (e: 'consShow', name: string): void
  (e: 'consOrbit', name: string): void
}>()

const keyword = ref('')
/** Default all OFF — empty globe until user enables a type (old satPanel.typeF). */
const activeTypes = ref<string[]>([])
const LIST_PAGE = 400
const {
  tles, loading, error, loadAllTles, fetchTleByNorad,
  cloudList, cloudLoading, loadConstellation, materializeTlesForTypes
} = useCatalog()
const selectedNorad = ref<number | null>(null)

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

const OWNER_ISO: Record<string, string> = {
  US: 'us', PRC: 'cn', CN: 'cn', CIS: 'ru', RUSS: 'ru', RU: 'ru',
  ESA: 'eu', FR: 'fr', JPN: 'jp', UK: 'gb', GER: 'de', IND: 'in',
  CA: 'ca', IT: 'it', SKOR: 'kr', PRK: 'kp', BRAZ: 'br', AUS: 'au',
  UAE: 'ae', TURK: 'tr', ARGN: 'ar', ISRA: 'il', NOR: 'no', SWE: 'se'
}

function flagIso(code?: string) {
  if (!code) return ''
  return OWNER_ISO[code.toUpperCase()] || ''
}

function colorCss(type?: string) {
  const key = normalizeObjectType(type)
  const n = TYPE_COLOR[key] ?? 0xffffff
  return `#${n.toString(16).padStart(6, '0')}`
}

function typeKey(item: CatalogTle) {
  return normalizeObjectType(item.object_type)
}

/** Client-side type filter for bottom catalog cards only. */
const filtered = computed(() => {
  const q = keyword.value.trim().toUpperCase()
  let list = tles.value
  if (activeTypes.value.length) {
    list = list.filter((x) => activeTypes.value.includes(typeKey(x)))
  } else if (!q) {
    return [] as CatalogTle[]
  }
  if (q) {
    list = list.filter((x) =>
      (x.object_name || '').toUpperCase().includes(q) || String(x.norad_id).includes(q)
    )
  }
  return list.slice(0, LIST_PAGE)
})

const stationCards = [
  { key: 'css', name: '天宫空间站', operator: '中国载人航天工程', country: '中国', iso: 'cn', norad: 48274 },
  { key: 'iss', name: '国际空间站', operator: '多国合作', country: '国际', iso: '', norad: 25544 }
]
/** Lit when parent/scene stationFocus matches (updated via local toggle echo). */
const stationOn = ref('')

const featuredCons = [
  { name: 'Starlink', op: 'SpaceX', country: '美国', iso: 'us', tag: '通信', q: 'STARLINK' },
  { name: 'OneWeb', op: 'OneWeb', country: '英国', iso: 'gb', tag: '通信', q: 'ONEWEB' },
  { name: '北斗', op: '中国卫星导航', country: '中国', iso: 'cn', tag: '导航', q: 'BEIDOU' }
]
/** Local mirror of consShow — true = card lit (scene owns authoritative map). */
const consOnMap = ref<Record<string, boolean>>({})
const consOrbitOnMap = ref<Record<string, boolean>>({})

function consShowLit(name: string) {
  // Old consShowOf: explicit map entry wins; otherwise follow「卫星」chip
  if (Object.prototype.hasOwnProperty.call(consOnMap.value, name)) return !!consOnMap.value[name]
  return activeTypes.value.includes('PAYLOAD')
}
function orbitLit(name: string) {
  return !!consOrbitOnMap.value[name]
}

let debounce: ReturnType<typeof setTimeout> | undefined
let refreshSeq = 0

function typeQuery(): string | undefined {
  const types = activeTypes.value
  if (!types.length) return undefined
  if (types.length === TYPE_KEYS.length) return undefined
  return types.join(',')
}

/** List cards only — never drives globe (chips/ cons / station do). */
async function refreshList() {
  const seq = ++refreshSeq
  const q = keyword.value.trim() || undefined
  if (!activeTypes.value.length && !q) {
    tles.value = []
    return
  }
  try {
    if (!q && activeTypes.value.length) {
      await materializeTlesForTypes(activeTypes.value, {
        cap: LIST_PAGE,
        preferNorad: selectedNorad.value
      })
    } else {
      await loadAllTles({
        q,
        type: typeQuery(),
        pageSize: LIST_PAGE,
        maxPages: 1
      })
    }
    if (seq !== refreshSeq) return
  } catch (e) {
    if (seq !== refreshSeq) return
    console.warn('[SatListPanel] refreshList', e)
  }
}

/** 类型芯片：只 emit types → SceneCore.filterCatalogTypes；不碰星座/空间站本地态以外的搜索框。 */
function toggleType(key: string) {
  if (activeTypes.value.includes(key)) {
    activeTypes.value = activeTypes.value.filter((x) => x !== key)
  } else {
    activeTypes.value = [...activeTypes.value, key]
  }
  // Old: flipping PAYLOAD resets constellation card overrides
  if (key === 'PAYLOAD') {
    consOnMap.value = {}
    consOrbitOnMap.value = {}
  }
  emit('types', [...activeTypes.value])
}

function pick(item: CatalogTle) {
  selectedNorad.value = item.norad_id
  emit('select', item)
}

/** 位置展示：独立通道。不关类型芯片、不关星座展示、不写 keyword。 */
function pickStation(s: (typeof stationCards)[0]) {
  if (stationOn.value === s.key) {
    stationOn.value = ''
  } else {
    stationOn.value = s.key
  }
  emit('stationShow', s.norad)
  // Soft: ensure list has the station card data without wiping filters
  void (async () => {
    try {
      let hit = tles.value.find((x) => x.norad_id === s.norad) || null
      if (!hit) hit = await fetchTleByNorad(s.norad)
      if (hit && stationOn.value === s.key) {
        if (!tles.value.some((x) => x.norad_id === hit!.norad_id)) {
          tles.value = [hit, ...tles.value]
        }
        selectedNorad.value = hit.norad_id
        // scene select is done inside showStation; still emit for parent parity
        emit('select', hit)
      }
    } catch (e) {
      console.warn('[SatListPanel] station', e)
    }
  })()
}

/** 星座展示：独立通道。不写搜索框、不清空间站（旧：互不干扰；仅 filterNorads/compare 会清）。 */
function pickCons(name: string) {
  const next = !consShowLit(name)
  consOnMap.value = { ...consOnMap.value, [name]: next }
  if (!next) {
    const { [name]: _, ...rest } = consOrbitOnMap.value
    consOrbitOnMap.value = rest
  }
  emit('consShow', name)
}

/** 轨道展示：必须先星座展示；点亮画轨，再点熄灭。 */
function toggleOrbit(name: string) {
  if (!consShowLit(name)) return
  const next = !orbitLit(name)
  consOrbitOnMap.value = { ...consOrbitOnMap.value, [name]: next }
  emit('consOrbit', name)
}

watch(keyword, () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { void refreshList() }, 450)
})
let typeDebounce: ReturnType<typeof setTimeout> | undefined
watch(activeTypes, () => {
  clearTimeout(typeDebounce)
  typeDebounce = setTimeout(() => { void refreshList() }, 120)
}, { deep: true })

onMounted(() => {
  const warm = () => { void loadConstellation().catch(() => { /* chip-on retries */ }) }
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
  if (typeof ric === 'function') ric(warm, { timeout: 2500 })
  else window.setTimeout(warm, 800)
  void refreshList()
})
</script>

<template>
  <transition name="panel">
    <aside
      v-if="open"
      class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }"
    >
      <div
        class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd"
      >
        <div class="sp-head-main sat-head-main">
          <b class="sp-title">{{ t('sat.title') }}</b>
        </div>
        <button class="sp-close sp-close-tri" :title="t('sat.close')" :aria-label="t('sat.close')" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M7 1.5 L3 5 L7 8.5 Z" /></svg>
        </button>
      </div>

      <div class="sp-search">
        <input v-model="keyword" class="sp-input" type="text" :placeholder="t('sat.search')" spellcheck="false" />
        <span v-if="keyword" class="sp-clear" @click="keyword = ''">×</span>
      </div>

      <div class="sp-types">
        <button
          v-for="tk in TYPE_KEYS"
          :key="tk"
          type="button"
          class="sp-type"
          :class="{ on: activeTypes.includes(tk) }"
          :title="(activeTypes.includes(tk) ? '关闭' : '打开') + '「' + typeLabel(tk) + '」'"
          @click="toggleType(tk)"
        >
          <span class="sp-type-dot" :style="{ background: colorCss(tk) }"></span>
          <span class="sp-type-txt">{{ typeLabel(tk) }}</span>
        </button>
      </div>
<div class="sp-list">
        <div class="sp-section-label">{{ t('sat.stations') }}</div>
        <div
          v-for="s in stationCards"
          :key="s.key"
          class="sp-cons-card"
          :class="{ on: stationOn === s.key }"
        >
          <div class="sp-cons-head">
            <span class="sp-cons-name" :title="s.name">{{ s.name }}</span>
            <span class="sp-cons-op">{{ t('sat.operator') }}{{ s.operator }}</span>
            <span class="sp-cons-tag">空间站</span>
          </div>
          <div class="sp-cons-meta">
            <span>{{ s.country }}</span>
            <img v-if="s.iso" class="sp-cons-flag" :src="'https://flagcdn.com/w20/' + s.iso + '.png'" alt="" />
            <span class="sp-cons-stat">NORAD {{ s.norad }}</span>
          </div>
          <div class="sp-cons-actions">
            <button
              type="button"
              class="sp-cons-btn"
              :class="{ on: stationOn === s.key }"
              :title="stationOn === s.key ? '点暗：取消该站的单独展示（之后跟随「卫星」开关）' : '点亮：单独展示该空间站并拉近镜头（不影响其它目标）'"
              @click="pickStation(s)"
            >位置展示</button>
          </div>
        </div>

        <div class="sp-section-label">{{ t('sat.constellations') }}</div>
        <div
          v-for="c in featuredCons"
          :key="c.name"
          class="sp-cons-card"
          :class="{ on: consShowLit(c.name) }"
        >
          <div class="sp-cons-head">
            <span class="sp-cons-name">{{ c.name }}</span>
            <span class="sp-cons-op">{{ t('sat.operator') }}{{ c.op }}</span>
            <span class="sp-cons-tag">{{ c.tag }}</span>
          </div>
          <div class="sp-cons-meta">
            <span>{{ c.country }}</span>
            <img v-if="c.iso" class="sp-cons-flag" :src="'https://flagcdn.com/w20/' + c.iso + '.png'" alt="" />
          </div>
          <div class="sp-cons-actions">
            <button
              type="button"
              class="sp-cons-btn"
              :class="{ on: consShowLit(c.name) }"
              :title="consShowLit(c.name) ? '点暗：不再展示该星座卫星（不影响其它星座与类型开关）' : '点亮：展示该星座全部卫星（不影响类型开关）'"
              @click="pickCons(c.name)"
            >{{ t('sat.consShow') }}</button>
            <button
              type="button"
              class="sp-cons-btn"
              :class="{ on: orbitLit(c.name) }"
              :disabled="!consShowLit(c.name)"
              :title="!consShowLit(c.name) ? '先点亮「星座展示」' : (orbitLit(c.name) ? '点暗：隐藏该星座轨道' : '点亮：显示该星座展示中卫星的轨道（蓝色细线）')"
              @click="toggleOrbit(c.name)"
            >{{ t('sat.orbitShow') }}</button>
          </div>
        </div>

        <div class="sp-section-label">{{ t('sat.catalog') }}</div>
        <div v-if="error" class="sp-empty">{{ t('sat.loadFail') }}<br />{{ error }}</div>
        <div v-else-if="loading && activeTypes.length && !filtered.length" class="sp-empty">{{ t('sat.loading') }}</div>
        <div v-else-if="!filtered.length && !loading && (activeTypes.length || keyword.trim())" class="sp-empty">{{ t('sat.none') }}</div>
        <button
          v-for="item in filtered"
          :key="item.norad_id"
          type="button"
          class="sp-item"
          :class="{ on: selectedNorad === item.norad_id }"
          @click="pick(item)"
        >
          <span class="sp-item-dot" :style="{ background: colorCss(item.object_type) }" />
          <span class="sp-item-main">
            <b class="sp-item-name">{{ item.object_name || '—' }}</b>
            <span class="sp-item-nor">
              NORAD {{ item.norad_id }}
              <template v-if="item.regime"> · {{ item.regime }}</template>
              <template v-if="item.object_type"> · {{ item.object_type }}</template>
            </span>
          </span>
          <img
            v-if="flagIso(item.owner_code)"
            class="sp-item-flag"
            :src="'https://flagcdn.com/w20/' + flagIso(item.owner_code) + '.png'"
            alt=""
          />
          <span class="sp-item-type">{{ TYPE_LABEL[typeKey(item)] }}</span>
        </button>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

.side-panel .sp-head .sp-head-main.sat-head-main {
  flex: 1;
  align-items: center;
  gap: 8px;
  .sp-title { text-align: center; font-size: 15px; margin-top: 5px; }
}
.side-panel .sp-head .sp-close.sp-close-tri {
  position: absolute; right: 10px; top: 8px;
}


.sp-section-label {
  margin: 10px 0 6px;
  padding-top: 8px;
  font-size: 12px;
  color: #fff;
  text-align: center;
  border-top: 1px solid rgba(120, 160, 220, 0.16);
  &:first-child { border-top: 0; margin-top: 4px; padding-top: 0; }
}

.sp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 8px 9px;
  margin-bottom: 4px;
  border-radius: 8px;
  border: 1px solid rgba(120, 160, 220, 0.14);
  background: rgba(13, 19, 33, 0.72);
  color: inherit;
  cursor: pointer;
  &:hover { border-color: rgba(63, 157, 255, 0.35); background: rgba(63, 157, 255, 0.08); }
  &.on { border-color: rgba(63, 157, 255, 0.55); box-shadow: 0 0 0 1px rgba(63, 157, 255, 0.2) inset; }
}
.sp-item-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.sp-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sp-item-name {
  font-size: 12.5px; font-weight: 650; color: #e6edf6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sp-item-nor { font-size: 11px; color: #7d8ba3; }
.sp-item-type { flex: none; font-size: 11px; color: #93a4bd; }
.sp-item-flag { width: 16px; height: 11px; object-fit: cover; border-radius: 1px; flex: none; }

.sp-cons-card {
  margin: 0 0 10px; padding: 10px 10px 8px; border-radius: 10px;
  background: rgba(13, 19, 33, 0.85); border: 1px solid rgba(120, 160, 220, 0.18);
  &.on { border-color: rgba(63, 157, 255, 0.55); box-shadow: 0 0 0 1px rgba(63, 157, 255, 0.25) inset; }
}
.sp-cons-head { display: flex; align-items: center; gap: 6px; }
.sp-cons-name {
  flex: none; width: 80px; font-weight: 600; font-size: 13px; color: #fff;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sp-cons-op {
  flex: 1; min-width: 0; font-size: 10px; color: rgba(190, 208, 235, 0.75);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sp-cons-tag {
  margin-left: auto; flex: none; font-size: 10px; color: #8fd0ff; padding: 1px 6px; border-radius: 3px;
  background: rgba(63, 157, 255, 0.12); border: 1px solid rgba(63, 157, 255, 0.3);
}
.sp-cons-meta {
  margin-top: 5px; display: flex; align-items: center; gap: 5px;
  font-size: 10px; color: rgba(190, 208, 235, 0.75);
}
.sp-cons-flag { width: 16px; height: 11px; object-fit: cover; border-radius: 1px; flex: none; }
.sp-cons-stat { margin-left: auto; white-space: nowrap; }
.sp-cons-actions { margin-top: 8px; display: flex; gap: 6px; }
.sp-cons-btn {
  flex: 1; padding: 4px 0; font-size: 11px; color: rgba(200, 216, 240, 0.85); cursor: pointer;
  background: rgba(63, 157, 255, 0.08); border: 1px solid rgba(120, 160, 220, 0.25); border-radius: 6px;
  &.on { color: #fff; background: rgba(63, 157, 255, 0.35); border-color: rgba(63, 157, 255, 0.7); }
  &:disabled { opacity: 0.35; cursor: not-allowed; }
}
.sp-type {
  cursor: pointer; user-select: none;
  appearance: none; font: inherit;
}
.sp-type-txt { font-size: 11px; }
</style>
