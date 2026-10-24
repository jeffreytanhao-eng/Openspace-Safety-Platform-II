<script setup lang="ts">
/** 左侧「太空安全目标列表」面板外壳：数据接入前显示空状态 */
import { ref } from 'vue'
import {
  TYPE_COLOR, TYPE_KEYS, TYPE_LABEL,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const keyword = ref('')
const activeTypes = ref<string[]>([...TYPE_KEYS])

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))
</script>

<template>
  <transition name="panel">
    <aside
      v-if="open"
      class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }"
    >
      <div
        class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd"
      >
        <div class="sp-head-main sat-head-main">
          <b class="sp-title">太空安全目标列表</b>
        </div>
        <!-- 收起按钮：向左三角（方向与右侧星历面板的向右三角相反） -->
        <button class="sp-close sp-close-tri" title="收起（点左缘浮标可再次展开）" aria-label="收起列表" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M7 1.5 L3 5 L7 8.5 Z" /></svg>
        </button>
      </div>
      <div class="sp-search">
        <input v-model="keyword" class="sp-input" type="text" placeholder="检索目标名称 / NORAD 编号" spellcheck="false" />
        <span v-if="keyword" class="sp-clear" @click="keyword = ''">×</span>
      </div>
      <div class="sp-types">
        <label v-for="t in TYPE_KEYS" :key="t" class="sp-type" :class="{ on: activeTypes.includes(t) }">
          <span class="sp-type-dot" :style="{ background: `#${TYPE_COLOR[t].toString(16).padStart(6, '0')}` }"></span>
          {{ TYPE_LABEL[t] }}
        </label>
      </div>
      <div class="sp-list">
        <div class="sp-empty">暂无目标数据<br />卫星接口接入后将在此展示</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 目标列表头部定制：标题居中（scoped 隔离，仅作用于本面板） */
.side-panel .sp-head .sp-head-main.sat-head-main {
  flex: 1;
  align-items: center;
  gap: 12px;

  .sp-title {
    text-align: center;
    font-size: 15px;
    margin-top: 5px;
  }
}

/* 收起按钮脱离文档流钉在头部右侧，让标题在面板宽度内真正水平居中 */
.side-panel .sp-head .sp-close.sp-close-tri {
  position: absolute;
  right: 10px;
  top: 8px;
}
</style>
