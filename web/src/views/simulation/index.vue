<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import DataSourceBar from '@/components/DataSourceBar.vue'
import { useDataSource } from '@/composables/useDataSource'

const router = useRouter()
const { current } = useDataSource()
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('sim.title') }}</h1>
        <p>{{ t('sim.sub') }}</p>
      </div>
      <button type="button" class="btn" @click="router.push('/situation')">{{ t('sim.open3d') }}</button>
    </header>

    <section class="toolbar">
      <DataSourceBar label="Propagation / screening source for sim" />
    </section>

    <section class="card">
      <div class="k">{{ t('sim.activeSource') }}</div>
      <div class="v">{{ current.label }}</div>
      <p class="note">{{ current.desc }}</p>
      <ul>
        <li>{{ t('sim.srcTle') }}</li>
        <li>{{ t('sim.srcCdm') }}</li>
        <li>{{ t('sim.srcEph') }}</li>
        <li>{{ t('sim.srcAoe') }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); max-width: 520px; }
.btn {
  appearance: none;
  border: 1px solid rgba(74, 125, 154, 0.5);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 4px;
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.toolbar {
  padding: 10px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  max-width: 640px;
}
.k { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.v { margin-top: 4px; font-size: 15px; font-weight: 650; color: var(--text); }
.note { margin: 8px 0 12px; font-size: 12px; color: var(--text-muted); }
ul { margin: 0; padding-left: 18px; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
</style>
