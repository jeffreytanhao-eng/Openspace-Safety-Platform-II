<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import DataSourceBar from '@/components/DataSourceBar.vue'
import PcTcaChart from '@/components/PcTcaChart.vue'
import CompactPager from '@/components/CompactPager.vue'
import { EVENT_SOURCE_BY_DS, useDataSource, type DataSourceId } from '@/composables/useDataSource'
import { useAuthStore } from '@/stores/auth'
import {
  eventDetailPath,
  isBelowWatchPc,
  listEvents,
  importCdm,
  type ConjunctionEvent,
  type EventLevel
} from '@/api/events'
import type { MessageKey } from '@/i18n/messages'
import { useObjectAliases } from '@/composables/useObjectAliases'

const { selected } = useDataSource()
const auth = useAuthStore()
const router = useRouter()
const { label: objLabel } = useObjectAliases()

const windowTab = ref<'24h' | '3d' | '7d' | 'all'>('3d')
const scope = ref<'all' | 'mine'>('all')
const levelFilter = ref<'all' | EventLevel>('all')
/** 排序：默认=风险优先（服务端顺序）；其余按 TCA / Pc 顺序或倒序 */
const sortKey = ref<'default' | 'tcaAsc' | 'tcaDesc' | 'pcAsc' | 'pcDesc'>('default')
const q = ref('')
const loading = ref(false)
const error = ref('')
const allEvents = ref<ConjunctionEvent[]>([])
const hasScreenJobs = ref(false)

/** 导入弹层 */
const showImport = ref(false)
const importText = ref('')
const importing = ref(false)
const importMsg = ref('')
const importErr = ref('')

const SHORT_KEY: Record<DataSourceId, MessageKey> = {
  tle: 'ds.short.tle',
  'space-track-cdm': 'ds.short.cdm',
  'ephem-sim': 'ds.short.ephem',
  'aoe-ephem': 'ds.short.aoe',
  stargaze: 'ds.short.optical'
}

const currentShort = computed(() => t(SHORT_KEY[selected.value] || SHORT_KEY['space-track-cdm']))

async function load(): Promise<void> {
  const src = EVENT_SOURCE_BY_DS[selected.value]
  if (src == null) {
    allEvents.value = []
    hasScreenJobs.value = false
    error.value = ''
    return
  }
  loading.value = true
  error.value = ''
  try {
    const resp = await listEvents(windowTab.value, scope.value, src)
    allEvents.value = resp.events ?? []
    hasScreenJobs.value = Boolean(resp.hasScreenJobs)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    allEvents.value = []
    hasScreenJobs.value = false
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void auth.init()
})

watch(selected, () => {
  void load()
})

function switchWindow(w: '24h' | '3d' | '7d' | 'all'): void {
  if (windowTab.value === w) return
  windowTab.value = w
  void load()
}

function switchScope(s: 'all' | 'mine'): void {
  if (scope.value === s) return
  scope.value = s
  void load()
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
  if (s === 'customer') return t('conj.src.customer')
  if (s === 'system') return t('conj.src.system')
  if (s === 'screen-tle') return t('conj.src.screenTle')
  if (s === 'screen-ephem') return t('conj.src.screenEphem')
  if (s === 'screen-aoe') return t('conj.src.screenAoe')
  if (s === 'screen' || s === 'screening') return t('conj.src.screen')
  return s
}

function fmtPc(pc: number | null): string {
  if (pc === null) return '—'
  if (pc === 0) return '0'
  return pc.toExponential(2)
}

const rows = computed(() => {
  const list = allEvents.value.filter((e) => {
    if (isBelowWatchPc(e)) return false
    if (levelFilter.value !== 'all' && e.level !== levelFilter.value) return false
    const s = q.value.trim().toLowerCase()
    if (!s) return true
    return (
      objLabel(e.noradA, e.nameA).toLowerCase().includes(s) ||
      objLabel(e.noradB, e.nameB).toLowerCase().includes(s) ||
      (e.nameA || '').toLowerCase().includes(s) ||
      (e.nameB || '').toLowerCase().includes(s) ||
      String(e.noradA).includes(s) ||
      String(e.noradB).includes(s)
    )
  })
  const dir = sortKey.value === 'tcaDesc' || sortKey.value === 'pcDesc' ? -1 : 1
  if (sortKey.value === 'tcaAsc' || sortKey.value === 'tcaDesc') {
    // TCA 为 ISO 字符串，可直接字典序比较
    list.sort((x, y) => dir * x.tca.localeCompare(y.tca))
  } else if (sortKey.value === 'pcAsc' || sortKey.value === 'pcDesc') {
    // Pc 为空（无概率）的事件始终排末尾
    list.sort((x, y) => {
      if (x.pc === null && y.pc === null) return 0
      if (x.pc === null) return 1
      if (y.pc === null) return -1
      return dir * (x.pc - y.pc)
    })
  }
  return list
})

const LIST_PAGE_SIZE = 20
const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(rows.value.length / LIST_PAGE_SIZE)))
const pagedRows = computed(() => {
  const p = Math.min(Math.max(1, page.value), totalPages.value)
  const start = (p - 1) * LIST_PAGE_SIZE
  return rows.value.slice(start, start + LIST_PAGE_SIZE)
})
watch([q, levelFilter, windowTab, scope], () => {
  page.value = 1
})
watch(totalPages, (n) => {
  if (page.value > n) page.value = n
  if (page.value < 1) page.value = 1
})

const emptyHint = computed(() => {
  const src = EVENT_SOURCE_BY_DS[selected.value]
  if (src === 'tle') return hasScreenJobs.value ? t('conj.empty.screenNone') : t('conj.empty.screenTle')
  if (src === 'ephem') return hasScreenJobs.value ? t('conj.empty.screenNone') : t('conj.empty.screenEphem')
  if (src === 'aoe') return hasScreenJobs.value ? t('conj.empty.screenNone') : t('conj.empty.screenAoe')
  return t('pcTca.empty')
})

function openEvent(e: ConjunctionEvent): void {
  void router.push(eventDetailPath(e))
}

/** 表头点击：同列再次点击切换顺序/倒序，第三次恢复默认（风险优先） */
function toggleSort(key: 'tca' | 'pc'): void {
  if (key === 'tca') {
    sortKey.value = sortKey.value === 'tcaAsc' ? 'tcaDesc' : sortKey.value === 'tcaDesc' ? 'default' : 'tcaAsc'
  } else {
    sortKey.value = sortKey.value === 'pcAsc' ? 'pcDesc' : sortKey.value === 'pcDesc' ? 'default' : 'pcAsc'
  }
}

function sortIcon(key: 'tca' | 'pc'): string {
  if (sortKey.value === `${key}Asc`) return '↑'
  if (sortKey.value === `${key}Desc`) return '↓'
  return '⇅'
}

async function doImport(): Promise<void> {
  importErr.value = ''
  importMsg.value = ''
  if (!importText.value.trim()) {
    importErr.value = t('conj.importHint')
    return
  }
  importing.value = true
  try {
    const r = await importCdm(importText.value)
    importMsg.value = `${t('conj.impNew')} ${r.inserted} · ${t('conj.impUpd')} ${r.updated} · ${t('conj.impSkip')} ${r.skipped}`
    importText.value = ''
    window.setTimeout(() => {
      showImport.value = false
      importMsg.value = ''
      void load()
    }, 1200)
  } catch (e) {
    importErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    importing.value = false
  }
}

function fmtTca(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('conj.title') }}</h1>
        <p>{{ t('conj.sub') }}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn" @click="load()">{{ t('eph.reload') }}</button>
        <button type="button" class="btn primary" @click="showImport = true">{{ t('conj.import') }}</button>
      </div>
    </header>

    <section class="toolbar">
      <DataSourceBar compact />
    </section>

    <section class="filters">
      <input v-model="q" type="search" :placeholder="t('conj.search')" />
      <div class="seg">
        <button type="button" :class="{ on: scope === 'all' }" @click="switchScope('all')">{{ t('conj.scope.all') }}</button>
        <button type="button" :class="{ on: scope === 'mine' }" @click="switchScope('mine')">{{ t('conj.scope.mine') }}</button>
      </div>
      <div class="seg">
        <button type="button" :class="{ on: windowTab === '24h' }" @click="switchWindow('24h')">24h</button>
        <button type="button" :class="{ on: windowTab === '3d' }" @click="switchWindow('3d')">3d</button>
        <button type="button" :class="{ on: windowTab === '7d' }" @click="switchWindow('7d')">7d</button>
        <button type="button" :class="{ on: windowTab === 'all' }" @click="switchWindow('all')">{{ t('conj.all') }}</button>
      </div>
      <div class="seg">
        <button type="button" :class="{ on: levelFilter === 'all' }" @click="levelFilter = 'all'">{{ t('conj.riskAll') }}</button>
        <button type="button" :class="{ on: levelFilter === 'red' }" @click="levelFilter = 'red'">{{ t('conj.high') }}</button>
        <button type="button" :class="{ on: levelFilter === 'orange' }" @click="levelFilter = 'orange'">{{ t('conj.warn') }}</button>
        <button type="button" :class="{ on: levelFilter === 'yellow' }" @click="levelFilter = 'yellow'">{{ t('conj.watch') }}</button>
        <button type="button" :class="{ on: levelFilter === 'low' }" @click="levelFilter = 'low'">{{ t('conj.low') }}</button>
      </div>
      <span class="hint">Showing {{ rows.length }} / {{ allEvents.length }} · context {{ currentShort }}</span>
    </section>

    <section v-if="error" class="state error">{{ error }}</section>
    <section v-else-if="loading" class="state">{{ t('obj.loading') }}</section>
    <template v-else>
    <section class="chart-panel">
      <div class="chart-h">
        <span class="chart-title">{{ t('pcTca.title') }}</span>
      </div>
      <PcTcaChart :events="rows" :height="156" />
    </section>
    <section v-if="!rows.length" class="state">{{ emptyHint }}</section>

    <section v-else class="table-wrap">
      <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{{ t('conj.col.risk') }}</th>
            <th>{{ t('conj.col.primary') }}</th>
            <th>{{ t('conj.col.secondary') }}</th>
            <th class="sortable" :title="t('conj.sortHint')" @click="toggleSort('tca')">
              {{ t('conj.col.tca') }} <span class="sarrow">{{ sortIcon('tca') }}</span>
            </th>
            <th>{{ t('conj.col.miss') }}</th>
            <th class="sortable" :title="t('conj.sortHint')" @click="toggleSort('pc')">
              {{ t('conj.col.pc') }} <span class="sarrow">{{ sortIcon('pc') }}</span>
            </th>
            <th>{{ t('conj.col.cdm') }}</th>
            <th>{{ t('conj.col.source') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in pagedRows"
            :key="e.key"
            :class="e.level"
            @click="openEvent(e)"
          >
            <td>
              <span
                class="pill"
                :class="e.level"
                :title="e.levelBasis === 'miss' ? t('conj.missBasis') : undefined"
              >
                {{ levelLabel(e.level) }}<span v-if="e.levelBasis === 'miss'" class="dim">·{{ t('conj.missBasisTag') }}</span>
              </span>
            </td>
            <td>{{ objLabel(e.noradA, e.nameA) }}</td>
            <td>{{ objLabel(e.noradB, e.nameB) }}</td>
            <td class="mono">{{ fmtTca(e.tca) }}</td>
            <td class="mono">{{ e.missKm === null ? '—' : e.missKm.toFixed(2) }}</td>
            <td class="mono">{{ fmtPc(e.pc) }}</td>
            <td class="mono">{{ e.cdmCount }}<span v-if="e.tcaSpanH > 0" class="dim"> / {{ e.tcaSpanH }}h</span></td>
            <td>{{ e.sources.map(srcLabel).join(' + ') }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <div class="list-pager">
        <CompactPager v-model:page="page" :total-pages="totalPages" :disabled="loading" />
      </div>
    </section>
    </template>

    <!-- CDM 导入弹层 -->
    <div v-if="showImport" class="modal-mask" @click.self="showImport = false">
      <div class="modal">
        <div class="mh">{{ t('conj.importTitle') }}</div>
        <p class="hint-text">{{ t('conj.importHint') }}</p>
        <textarea
          v-model="importText"
          spellcheck="false"
          placeholder="CCSDS_CDM_VERS = 2.0 …"
        />
        <p v-if="importErr" class="err">{{ importErr }}</p>
        <p v-if="importMsg" class="ok">{{ importMsg }}</p>
        <div class="mfoot">
          <button type="button" class="btn" @click="showImport = false">{{ t('conj.backList') }}</button>
          <button type="button" class="btn primary" :disabled="importing" @click="doImport">
            {{ importing ? t('obj.loading') : t('conj.importSubmit') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 36px; min-height: 0;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.head h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.actions { display: flex; gap: 6px; }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.btn:hover { color: var(--text); }
.btn.primary { color: var(--accent-strong); border-color: var(--accent-strong); }
.btn:disabled { opacity: 0.5; cursor: default; }
.toolbar, .filters {
  padding: 10px 12px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
}
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filters input {
  flex: 1; min-width: 160px; appearance: none; border: 1px solid var(--border);
  background: var(--bg-deep); color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 12px; outline: none;
}
.seg { display: inline-flex; background: var(--bg-deep); border: 1px solid var(--border); border-radius: 4px; padding: 2px; }
.seg button {
  appearance: none; border: none; background: transparent; color: var(--text-muted);
  font-size: 11px; padding: 4px 8px; border-radius: 3px; cursor: pointer;
}
.seg button.on { background: var(--bg-hover); color: var(--text); }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--text); }
.sarrow { margin-left: 3px; font-size: 10px; opacity: 0.7; }
.hint { font-size: 11px; color: var(--text-dim); margin-left: auto; }
.chart-panel {
  flex: 0 0 auto; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px 4px;
}
.chart-h { display: flex; flex-direction: column; gap: 0; margin-bottom: 2px; }
.chart-title { font-size: 13px; font-weight: 650; color: var(--text); }
.state {
  flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-dim); font-size: 12px; text-align: center; padding: 16px 24px;
}
.state.error { color: var(--danger); }
.table-wrap {
  flex: 1; min-height: 0; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border); border-radius: 8px;
}
.table-scroll { flex: 1; min-height: 0; overflow: auto; }
.list-pager {
  flex: none; min-width: 0;
  border-top: 1px solid var(--border);
  padding: 6px 10px;
}
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th {
  text-align: left; padding: 10px 12px; color: var(--text-dim); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel);
}
td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.dim { color: var(--text-dim); font-size: 10px; }
.pill {
  font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-muted);
}
.pill.red { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.pill.orange { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.pill.yellow { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pill.low { color: var(--text-dim); }
tr.red td:first-child { box-shadow: inset 2px 0 0 var(--danger); }
tr.orange td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
tr.yellow td:first-child { box-shadow: inset 2px 0 0 var(--watch); }

.modal-mask {
  position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: 640px; max-width: 100%; max-height: 80vh; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 10px; padding: 16px;
}
.mh { font-size: 14px; font-weight: 650; margin-bottom: 6px; }
.hint-text { margin: 0 0 8px; font-size: 11px; color: var(--text-dim); }
.modal textarea {
  width: 100%; height: 260px; resize: vertical; appearance: none;
  border: 1px solid var(--border); background: var(--bg-deep); color: var(--text);
  border-radius: 6px; padding: 10px; font-size: 11px; font-family: var(--mono); outline: none;
}
.err { color: var(--danger); font-size: 12px; margin: 8px 0 0; }
.ok { color: var(--accent-strong, #6fbf8f); font-size: 12px; margin: 8px 0 0; }
.mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
