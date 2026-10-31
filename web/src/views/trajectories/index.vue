<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import { OBJECTS, TRAJECTORIES, objectById } from '@/composables/useMockCatalog'

const route = useRoute()
const q = ref('')
const focusId = ref<string | null>(null)

watch(
  () => route.query.focus,
  (f) => {
    focusId.value = f ? String(f) : null
  },
  { immediate: true }
)

const rows = computed(() => {
  return TRAJECTORIES.filter((t) => {
    const o = objectById(t.objectId)
    const s = q.value.trim().toLowerCase()
    if (!s) return true
    return (
      t.name.toLowerCase().includes(s) ||
      t.source.toLowerCase().includes(s) ||
      (o?.name.toLowerCase().includes(s) ?? false) ||
      (o?.norad.includes(s) ?? false)
    )
  })
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('traj.title') }}</h1>
        <p>对象 ↔ 轨迹关联列表（Stage 2 mock）</p>
      </div>
      <div class="count">{{ rows.length }} trajectories</div>
    </header>

    <section class="filters">
      <input v-model="q" type="search" :placeholder="t('traj.search')" />
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('traj.col.traj') }}</th>
            <th>{{ t('traj.col.object') }}</th>
            <th>{{ t('traj.col.norad') }}</th>
            <th>{{ t('traj.col.source') }}</th>
            <th>{{ t('traj.col.start') }}</th>
            <th>{{ t('traj.col.end') }}</th>
            <th>{{ t('traj.col.step') }}</th>
            <th>{{ t('traj.col.points') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in rows"
            :key="t.id"
            :class="{ focus: focusId === t.id }"
          >
            <td class="name">{{ t.name }}</td>
            <td>
              <RouterLink :to="`/objects`">{{ objectById(t.objectId)?.name }}</RouterLink>
            </td>
            <td class="mono">{{ objectById(t.objectId)?.norad }}</td>
            <td>{{ t.source }}</td>
            <td class="mono">{{ t.startUtc.replace('T', ' ').replace('Z', '') }}</td>
            <td class="mono">{{ t.endUtc.replace('T', ' ').replace('Z', '') }}</td>
            <td class="mono">{{ t.stepS }} s</td>
            <td class="mono">{{ t.points }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="note">
      Objects catalog size {{ OBJECTS.length }}. Open an object drawer to jump here with
      <code>?focus=</code> query.
    </p>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 36px; min-height: 0;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; }
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.count { font-size: 12px; color: var(--text-muted); }
.filters {
  padding: 10px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
}
.filters input {
  width: 100%; appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 12px; outline: none;
}
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
td { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
tr.focus { background: var(--accent-soft); }
.name { font-weight: 600; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
a { color: var(--accent-strong); }
.note { font-size: 11px; color: var(--text-dim); margin: 0; }
code { font-family: var(--mono); font-size: 10px; }
</style>
