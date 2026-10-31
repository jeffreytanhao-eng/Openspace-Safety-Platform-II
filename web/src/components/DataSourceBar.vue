<script setup lang="ts">
import { computed } from 'vue'
import { useDataSource, type DataSourceId } from '@/composables/useDataSource'
import { useI18n } from '@/composables/useI18n'
import type { MessageKey } from '@/i18n/messages'

const props = withDefaults(
  defineProps<{ compact?: boolean; label?: string }>(),
  { compact: false, label: undefined }
)

const { t } = useI18n()
const { selected, current, sources, setSource } = useDataSource()

const LABEL_KEY: Record<DataSourceId, MessageKey> = {
  tle: 'ds.tle',
  'space-track-cdm': 'ds.cdm',
  'ephem-sim': 'ds.ephem',
  'aoe-ephem': 'ds.aoe',
  stargaze: 'ds.optical'
}
const DESC_KEY: Record<DataSourceId, MessageKey> = {
  tle: 'ds.tleDesc',
  'space-track-cdm': 'ds.cdmDesc',
  'ephem-sim': 'ds.ephemDesc',
  'aoe-ephem': 'ds.aoeDesc',
  stargaze: 'ds.opticalDesc'
}

const localized = computed(() =>
  sources.map((s) => ({
    ...s,
    label: t(LABEL_KEY[s.id]),
    desc: t(DESC_KEY[s.id])
  }))
)
const currentLoc = computed(() => localized.value.find((d) => d.id === selected.value) || localized.value[0])
const barLabel = computed(() => props.label ?? t('ds.label'))

function onPick(id: DataSourceId) {
  setSource(id)
}
</script>

<template>
  <div class="ds" :class="{ compact }">
    <div class="ds-label">{{ barLabel }}</div>
    <div class="ds-segs">
      <button
        v-for="s in localized"
        :key="s.id"
        type="button"
        class="seg"
        :class="{ on: selected === s.id }"
        :title="s.desc"
        @click="onPick(s.id)"
      >
        {{ compact ? s.short : s.label }}
      </button>
    </div>
    <div v-if="!compact" class="ds-hint">{{ currentLoc.desc }} · {{ t('ds.mockHint') }}</div>
  </div>
</template>

<style scoped lang="scss">
.ds {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ds.compact {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ds-label {
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.ds-segs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.seg {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 11px;
  cursor: pointer;
}
.seg:hover {
  color: var(--text);
  border-color: var(--accent);
}
.seg.on {
  color: var(--text);
  background: var(--accent-soft);
  border-color: rgba(74, 125, 154, 0.45);
}
.ds-hint {
  font-size: 10px;
  color: var(--text-dim);
}
</style>
