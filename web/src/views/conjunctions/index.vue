<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import DataSourceBar from '@/components/DataSourceBar.vue'
import { useDataSource } from '@/composables/useDataSource'
import { useAuthStore } from '@/stores/auth'
import {
  listEvents,
  importCdm,
  type ConjunctionEvent,
  type EventLevel
} from '@/api/events'

const { current } = useDataSource()
const auth = useAuthStore()

const windowTab = ref<'24h' | '3d' | '7d' | 'all'>('3d')
const levelFilter = ref<'all' | EventLevel>('all')
const q = ref('')
const loading = ref(false)
const error = ref('')
const allEvents = ref<ConjunctionEvent[]>([])

/** 导入弹层 */
const showImport = ref(false)
const importText = ref('')
const importing = ref(false)
const importMsg = ref('')
const importErr = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await listEvents(windowTab.value)
    allEvents.value = resp.events ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    allEvents.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void auth.init()
})

function switchWindow(w: '24h' | '3d' | '7d' | 'all'): void {
  if (windowTab.value === w) return
  windowTab.value = w
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
  return s === 'customer' ? t('conj.src.customer') : t('conj.src.system')
}

function fmtPc(pc: number | null): string {
  if (pc === null) return '—'
  if (pc === 0) return '0'
  return pc.toExponential(2)
}

const rows = computed(() => {
  return allEvents.value.filter((e) => {
    if (levelFilter.value !== 'all' && e.level !== levelFilter.value) return false
    const s = q.value.trim().toLowerCase()
    if (!s) return true
    return (
      e.nameA.toLowerCase().includes(s) ||
      e.nameB.toLowerCase().includes(s) ||
      String(e.noradA).includes(s) ||
      String(e.noradB).includes(s)
    )
  })
})

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
      <span class="hint">Showing {{ rows.length }} / {{ allEvents.length }} · context {{ current.short }}</span>
    </section>

    <section v-if="error" class="state error">{{ error }}</section>
    <section v-else-if="loading" class="state">{{ t('obj.loading') }}</section>
    <section v-else-if="!rows.length" class="state">—</section>

    <section v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('conj.col.risk') }}</th>
            <th>{{ t('conj.col.primary') }}</th>
            <th>{{ t('conj.col.secondary') }}</th>
            <th>{{ t('conj.col.tca') }}</th>
            <th>{{ t('conj.col.miss') }}</th>
            <th>{{ t('conj.col.pc') }}</th>
            <th>{{ t('conj.col.cdm') }}</th>
            <th>{{ t('conj.col.source') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in rows"
            :key="e.key"
            :class="e.level"
            @click="$router.push(`/conjunctions/${encodeURIComponent(e.key)}`)"
          >
            <td><span class="pill" :class="e.level">{{ levelLabel(e.level) }}</span></td>
            <td>{{ e.nameA || `NORAD ${e.noradA}` }}</td>
            <td>{{ e.nameB || `NORAD ${e.noradB}` }}</td>
            <td class="mono">{{ fmtTca(e.tca) }}</td>
            <td class="mono">{{ e.missKm === null ? '—' : e.missKm.toFixed(2) }}</td>
            <td class="mono">{{ fmtPc(e.pc) }}</td>
            <td class="mono">{{ e.cdmCount }}<span v-if="e.tcaSpanH > 0" class="dim"> / {{ e.tcaSpanH }}h</span></td>
            <td>{{ e.sources.map(srcLabel).join(' + ') }}</td>
          </tr>
        </tbody>
      </table>
    </section>

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
.hint { font-size: 11px; color: var(--text-dim); margin-left: auto; }
.state {
  flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-dim); font-size: 12px;
}
.state.error { color: var(--danger); }
.table-wrap {
  flex: 1; min-height: 0; overflow: auto; background: var(--bg-panel);
  border: 1px solid var(--border); border-radius: 8px;
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
