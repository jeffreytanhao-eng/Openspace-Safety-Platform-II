<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import DataSourceBar from '@/components/DataSourceBar.vue'
import { useDataSource } from '@/composables/useDataSource'
import { CONJUNCTIONS, objectById, type Risk } from '@/composables/useMockCatalog'

const { current } = useDataSource()
const windowTab = ref<'24h' | '3d' | '7d' | 'all'>('all')
const riskFilter = ref<'all' | Risk>('all')
const q = ref('')

const rows = computed(() => {
  return CONJUNCTIONS.filter((c) => {
    if (windowTab.value !== 'all' && c.window !== windowTab.value && !(windowTab.value === '7d')) {
      // simple mock: 7d shows all; 24h/3d filter by tagged window loosely
    }
    if (windowTab.value === '24h' && c.window !== '24h') return false
    if (windowTab.value === '3d' && !['24h', '3d'].includes(c.window)) return false
    if (riskFilter.value !== 'all' && c.risk !== riskFilter.value) return false
    const s = q.value.trim().toLowerCase()
    if (!s) return true
    const a = objectById(c.primaryId)
    const b = objectById(c.secondaryId)
    return (
      c.id.includes(s) ||
      (a?.name.toLowerCase().includes(s) ?? false) ||
      (b?.name.toLowerCase().includes(s) ?? false) ||
      (a?.norad.includes(s) ?? false) ||
      (b?.norad.includes(s) ?? false)
    )
  })
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('conj.title') }}</h1>
        <p>{{ t('conj.sub') }}</p>
      </div>
    </header>

    <section class="toolbar">
      <DataSourceBar compact />
    </section>

    <section class="filters">
      <input v-model="q" type="search" :placeholder="t('conj.search')" />
      <div class="seg">
        <button type="button" :class="{ on: windowTab === 'all' }" @click="windowTab = 'all'">{{ t('conj.all') }}</button>
        <button type="button" :class="{ on: windowTab === '24h' }" @click="windowTab = '24h'">24h</button>
        <button type="button" :class="{ on: windowTab === '3d' }" @click="windowTab = '3d'">3d</button>
        <button type="button" :class="{ on: windowTab === '7d' }" @click="windowTab = '7d'">7d</button>
      </div>
      <div class="seg">
        <button type="button" :class="{ on: riskFilter === 'all' }" @click="riskFilter = 'all'">{{ t('conj.riskAll') }}</button>
        <button type="button" :class="{ on: riskFilter === 'high' }" @click="riskFilter = 'high'">{{ t('conj.high') }}</button>
        <button type="button" :class="{ on: riskFilter === 'warn' }" @click="riskFilter = 'warn'">{{ t('conj.warn') }}</button>
        <button type="button" :class="{ on: riskFilter === 'watch' }" @click="riskFilter = 'watch'">{{ t('conj.watch') }}</button>
      </div>
      <span class="hint">Showing {{ rows.length }} · context {{ current.short }}</span>
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('conj.col.risk') }}</th>
            <th>{{ t('conj.col.primary') }}</th>
            <th>{{ t('conj.col.secondary') }}</th>
            <th>{{ t('conj.col.tca') }}</th>
            <th>{{ t('conj.col.miss') }}</th>
            <th>{{ t('conj.col.pc') }}</th>
            <th>{{ t('conj.col.source') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in rows" :key="c.id" :class="c.risk" @click="$router.push(`/conjunctions/${c.id}`)">
            <td><span class="pill" :class="c.risk">{{ c.risk }}</span></td>
            <td>{{ objectById(c.primaryId)?.name }}</td>
            <td>{{ objectById(c.secondaryId)?.name }}</td>
            <td class="mono">{{ c.tcaUtc.replace('T', ' ').replace('Z', '') }}</td>
            <td class="mono">{{ c.missKm.toFixed(2) }}</td>
            <td class="mono">{{ c.pc }}</td>
            <td>{{ c.source }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 36px; min-height: 0;
}
.head h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
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
.pill {
  font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-muted);
}
.pill.high { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.pill.warn { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.pill.watch { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pill.low { color: var(--text-dim); }
tr.high td:first-child { box-shadow: inset 2px 0 0 var(--danger); }
tr.warn td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
</style>
