<script setup lang="ts">
/** 左侧「星座列表」面板外壳：数据接入前显示空状态 */
import { ref } from 'vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const keyword = ref('')
</script>

<template>
  <transition name="panel">
    <aside v-if="open" class="side-panel">
      <div class="sp-head">
        <div class="sp-head-main">
          <b class="sp-title">星座列表</b>
          <span class="sp-count">0 个星座</span>
        </div>
        <button class="sp-close" title="收起（点左缘浮标可再次展开）" @click="emit('close')">»</button>
      </div>
      <div class="sp-search">
        <input v-model="keyword" class="sp-input" type="text" placeholder="按星座名称检索" spellcheck="false" />
        <span v-if="keyword" class="sp-clear" @click="keyword = ''">×</span>
      </div>
      <div class="sp-list">
        <div class="sp-empty">暂无星座数据<br />星座接口接入后将在此展示</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
