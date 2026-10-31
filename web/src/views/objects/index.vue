<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import { OBJECTS, TRAJECTORIES, type SpaceObject } from '@/composables/useMockCatalog'

const q = ref('')
const orbit = ref<'all' | 'LEO' | 'MEO' | 'GEO'>('all')
const fresh = ref<'all' | 'fresh' | 'stale' | 'missing'>('all')
const manOnly = ref(false)
const selectedId = ref<string | null>(null)

const filtered = computed(() => {
  return OBJECTS.filter((o) => {
    if (orbit.value !== 'all' && o.orbit !== orbit.value) return false
    if (fresh.value !== 'all' && o.ephemFreshness !== fresh.value) return false
    if (manOnly.value && !o.maneuverable) return false
    const s = q.value.trim().toLowerCase()
    if (!s) return true
    return (
      o.name.toLowerCase().includes(s) ||
      o.norad.includes(s) ||
      o.operator.toLowerCase().includes(s) ||
      o.constellation.toLowerCase().includes(s)
    )
  })
})

const selected = computed(() => OBJECTS.find((o) => o.id === selectedId.value) || null)
const selectedTraj = computed(() =>
  selected.value ? TRAJECTORIES.filter((t) => t.objectId === selected.value!.id) : []
)

function open(o: SpaceObject) {
  selectedId.value = o.id
}
function close() {
  selectedId.value = null
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('obj.title') }}</h1>
        <p>{{ t('obj.sub') }}</p>
      </div>
      <div class="count">{{ filtered.length }} / {{ OBJECTS.length }}</div>
    </header>

    <section class="filters">
      <input v-model="q" type="search" :placeholder="t('obj.search')" />
      <div class="seg">
        <button type="button" :class="{ on: orbit === 'all' }" @click="orbit = 'all'">{{ t('obj.all') }}</button>
        <button type="button" :class="{ on: orbit === 'LEO' }" @click="orbit = 'LEO'">LEO</button>
        <button type="button" :class="{ on: orbit === 'MEO' }" @click="orbit = 'MEO'">MEO</button>
        <button type="button" :class="{ on: orbit === 'GEO' }" @click="orbit = 'GEO'">GEO</button>
      </div>
      <div class="seg">
        <button type="button" :class="{ on: fresh === 'all' }" @click="fresh = 'all'">{{ t('obj.ephemAll') }}</button>
        <button type="button" :class="{ on: fresh === 'fresh' }" @click="fresh = 'fresh'">{{ t('obj.fresh') }}</button>
        <button type="button" :class="{ on: fresh === 'stale' }" @click="fresh = 'stale'">{{ t('obj.stale') }}</button>
        <button type="button" :class="{ on: fresh === 'missing' }" @click="fresh = 'missing'">{{ t('obj.missing') }}</button>
      </div>
      <label class="chk"><input v-model="manOnly" type="checkbox" /> {{ t('obj.manOnly') }}</label>
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('obj.col.name') }}</th>
            <th>{{ t('obj.col.norad') }}</th>
            <th>{{ t('obj.col.operator') }}</th>
            <th>{{ t('obj.col.constellation') }}</th>
            <th>{{ t('obj.col.orbit') }}</th>
            <th>{{ t('obj.col.ephem') }}</th>
            <th>{{ t('obj.col.maneuver') }}</th>
            <th>{{ t('obj.col.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in filtered" :key="o.id" @click="open(o)">
            <td class="name">{{ o.name }}</td>
            <td class="mono">{{ o.norad }}</td>
            <td>{{ o.operator }}</td>
            <td>{{ o.constellation }}</td>
            <td>{{ o.orbit }}</td>
            <td><span class="pill" :class="o.ephemFreshness">{{ o.ephemFreshness }}</span></td>
            <td>{{ o.maneuverable ? t('obj.yes') : t('obj.no') }}</td>
            <td>{{ o.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <aside v-if="selected" class="drawer" @click.self="close">
      <div class="drawer-panel">
        <header class="dh">
          <div>
            <div class="d-title">{{ selected.name }}</div>
            <div class="d-sub">NORAD {{ selected.norad }} · {{ selected.constellation }}</div>
          </div>
          <button type="button" class="x" @click="close">×</button>
        </header>
        <dl class="kv">
          <div><dt>{{ t('obj.operator') }}</dt><dd>{{ selected.operator }}</dd></div>
          <div><dt>{{ t('obj.country') }}</dt><dd>{{ selected.country }}</dd></div>
          <div><dt>{{ t('obj.orbitClass') }}</dt><dd>{{ selected.orbit }}</dd></div>
          <div><dt>{{ t('obj.status') }}</dt><dd>{{ selected.status }}</dd></div>
          <div><dt>{{ t('obj.maneuverable') }}</dt><dd>{{ selected.maneuverable ? t('obj.yes') : t('obj.no') }}</dd></div>
          <div>
            <dt>{{ t('obj.ephemFresh') }}</dt>
            <dd>
              <span class="pill" :class="selected.ephemFreshness">{{ selected.ephemFreshness }}</span>
              <span v-if="selected.ephemFreshness !== 'missing'" class="age"> · {{ selected.ephemAgeH }}h</span>
            </dd>
          </div>
        </dl>
        <div class="block">
          <div class="bt">{{ t('obj.linkedTraj') }}</div>
          <ul v-if="selectedTraj.length">
            <li v-for="t in selectedTraj" :key="t.id">
              <RouterLink :to="`/trajectories?focus=${t.id}`">{{ t.name }}</RouterLink>
              <span class="meta">{{ t.source }} · {{ t.points }} pts</span>
            </li>
          </ul>
          <p v-else class="empty">{{ t('obj.noTraj') }}</p>
        </div>
        <div class="block actions">
          <RouterLink class="btn" :to="`/ephemerides?object=${selected.id}`">{{ t('obj.openEphem') }}</RouterLink>
          <RouterLink class="btn" to="/conjunctions">{{ t('obj.relatedConj') }}</RouterLink>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
  min-height: 0;
  position: relative;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; }
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.count { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.filters input[type='search'] {
  flex: 1;
  min-width: 180px;
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 7px 9px;
  font-size: 12px;
  outline: none;
}
.seg {
  display: inline-flex;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px;
}
.seg button {
  appearance: none; border: none; background: transparent;
  color: var(--text-muted); font-size: 11px; padding: 4px 8px; border-radius: 3px; cursor: pointer;
}
.seg button.on { background: var(--bg-hover); color: var(--text); }
.chk { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.table-wrap {
  flex: 1; min-height: 0; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th {
  text-align: left; padding: 10px 12px; color: var(--text-dim); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel);
}
td { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
.name { font-weight: 600; }
.mono { font-family: var(--mono); }
.pill {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border); color: var(--text-muted);
}
.pill.fresh { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.pill.stale { color: var(--warn); border-color: rgba(196, 146, 74, 0.35); }
.pill.missing { color: var(--text-dim); }

.drawer {
  position: absolute; inset: 0; background: rgba(0, 0, 0, 0.35);
  display: flex; justify-content: flex-end; z-index: 40;
}
.drawer-panel {
  width: min(420px, 100%); height: 100%; background: var(--bg-panel);
  border-left: 1px solid var(--border); padding: 14px; overflow: auto;
}
.dh { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.d-title { font-size: 15px; font-weight: 650; }
.d-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.x {
  appearance: none; border: 1px solid var(--border); background: transparent;
  color: var(--text-muted); width: 28px; height: 28px; border-radius: 4px; cursor: pointer; font-size: 16px;
}
.kv {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 14px;
}
.kv div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
}
.kv dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.kv dd { margin: 4px 0 0; font-size: 13px; font-weight: 600; }
.age { font-weight: 400; color: var(--text-dim); font-size: 11px; }
.block { margin-bottom: 14px; }
.bt { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
ul { margin: 0; padding: 0; list-style: none; }
li {
  padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px;
}
li a { color: var(--accent-strong); font-size: 12px; }
.meta { font-size: 10px; color: var(--text-dim); }
.empty { font-size: 12px; color: var(--text-dim); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn {
  border: 1px solid rgba(74, 125, 154, 0.45); background: var(--accent-soft);
  color: var(--text); border-radius: 4px; padding: 7px 10px; font-size: 12px;
}
</style>
