<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
const { t } = useI18n()

</script>

<template>
  <div class="page">
    <h1>{{ t('ai.title') }}</h1>
    <p>{{ t('ai.sub') }}</p>
    <p class="muted">{{ t('ai.note') }}</p>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  padding: 20px 18px 40px;
}
h1 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}
p {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.muted { color: var(--text-dim); }
</style>
