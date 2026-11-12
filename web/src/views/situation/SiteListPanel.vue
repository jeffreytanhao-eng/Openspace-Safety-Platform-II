<script setup lang="ts">
/** 左侧「发射站列表」面板外壳：数据接入前显示空状态 */
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const keyword = ref('')
</script>

<template>
  <transition name="panel">
    <aside v-if="open" class="side-panel">
      <div class="sp-head">
        <div class="sp-head-main">
          <b class="sp-title">{{ t('sitp.siteTitle') }}</b>
          <span class="sp-count">{{ t('sitp.siteCount') }}</span>
        </div>
        <button class="sp-close" :title="t('sitp.collapse')" @click="emit('close')">»</button>
      </div>
      <div class="sp-search">
        <input v-model="keyword" class="sp-input" type="text" :placeholder="t('sitp.siteSearchPh')" spellcheck="false" />
        <span v-if="keyword" class="sp-clear" @click="keyword = ''">×</span>
      </div>
      <div class="sp-list">
        <div class="sp-empty">{{ t('sitp.siteEmpty') }}<br />{{ t('sitp.siteHint') }}</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
