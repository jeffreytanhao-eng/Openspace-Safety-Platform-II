<script setup lang="ts">
/**
 * One-line compact pager: link-style page numbers, current page underlined,
 * ellipsis for skipped pages, 「当前页/总页数」, and a jump field.
 * No total-item count. Fits a narrow sidebar without wrapping (overflow-x if needed).
 */
import { computed, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'

const props = withDefaults(
  defineProps<{
    page: number
    totalPages: number
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{
  'update:page': [page: number]
}>()

const { t } = useI18n()
const jumpInput = ref('')

const total = computed(() => Math.max(1, Math.floor(Number(props.totalPages)) || 1))
const current = computed(() => Math.min(Math.max(1, Math.floor(Number(props.page)) || 1), total.value))

function go(p: number) {
  if (props.disabled) return
  const next = Math.min(Math.max(1, Math.trunc(p)), total.value)
  if (next !== props.page) emit('update:page', next)
}

/** First, last, and a small window around the current page; gaps become … */
function buildItems(pageCount: number, cur: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const set = new Set<number>([1, pageCount, cur - 1, cur, cur + 1])
  if (cur <= 3) [2, 3, 4].forEach((n) => set.add(n))
  if (cur >= pageCount - 2) [pageCount - 1, pageCount - 2, pageCount - 3].forEach((n) => set.add(n))
  const nums = [...set].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  const out: (number | '…')[] = []
  let prev = 0
  for (const n of nums) {
    if (n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
}

const items = computed(() => buildItems(total.value, current.value))
const showJump = computed(() => total.value > 1)

function jump() {
  if (props.disabled) return
  const raw = String(jumpInput.value ?? '').trim()
  if (!raw) return
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return
  go(n)
  jumpInput.value = ''
}
</script>

<template>
  <nav class="osp-pager" :aria-label="t('pager.nav')">
    <template v-if="total > 1">
      <button
        type="button"
        class="osp-pager-chev"
        :disabled="disabled || current <= 1"
        :title="t('pager.prev')"
        @click="go(current - 1)"
      >‹</button>
      <template v-for="(p, i) in items" :key="`${p}-${i}`">
        <span v-if="p === '…'" class="osp-pager-ell" aria-hidden="true">…</span>
        <button
          v-else
          type="button"
          class="osp-pager-num"
          :class="{ on: p === current }"
          :disabled="disabled"
          :aria-current="p === current ? 'page' : undefined"
          @click="go(p)"
        >{{ p }}</button>
      </template>
      <button
        type="button"
        class="osp-pager-chev"
        :disabled="disabled || current >= total"
        :title="t('pager.next')"
        @click="go(current + 1)"
      >›</button>
    </template>
    <span class="osp-pager-pos">{{ t('pager.pageOf', { p: current, n: total }) }}</span>
    <form v-if="showJump" class="osp-pager-jump" @submit.prevent="jump">
      <input
        v-model="jumpInput"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        :disabled="disabled"
        :aria-label="t('pager.jump')"
        @keydown.enter.prevent="jump"
      />
      <button type="submit" :disabled="disabled">{{ t('pager.jump') }}</button>
    </form>
  </nav>
</template>

<style scoped>
.osp-pager {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px 6px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.2;
  color: var(--text-dim, #8ea4c4);
  font-variant-numeric: tabular-nums;
  scrollbar-width: thin;
}
.osp-pager-chev,
.osp-pager-num,
.osp-pager-jump button {
  appearance: none;
  border: 0;
  background: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--text-muted, #9dbbdd);
  cursor: pointer;
  line-height: inherit;
}
.osp-pager-chev {
  flex: none;
  padding: 0 1px;
  font-size: 13px;
}
.osp-pager-num {
  flex: none;
  padding: 0 1px;
  text-decoration: none;
  color: var(--text-muted, #9dbbdd);
}
.osp-pager-num:hover:not(:disabled) {
  color: var(--text, #eaf2fc);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.osp-pager-num.on {
  color: var(--text, #eaf2fc);
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.osp-pager-chev:disabled,
.osp-pager-num:disabled,
.osp-pager-jump button:disabled {
  opacity: 0.35;
  cursor: default;
}
.osp-pager-ell {
  color: var(--text-dim, #8ea4c4);
  pointer-events: none;
  padding: 0 1px;
  flex: none;
}
.osp-pager-pos {
  flex: none;
  color: var(--text-muted, #9dbbdd);
  margin-left: 2px;
}
.osp-pager-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  margin: 0;
  min-width: 0;
}
.osp-pager-jump input {
  width: 34px;
  height: 20px;
  box-sizing: border-box;
  padding: 0 3px;
  border: 1px solid var(--border, rgba(110, 150, 210, 0.28));
  background: var(--bg-deep, rgba(10, 20, 36, 0.5));
  color: var(--text, #eaf2fc);
  border-radius: 3px;
  font: inherit;
  text-align: center;
  outline: none;
}
.osp-pager-jump input:focus {
  border-color: rgba(74, 125, 154, 0.55);
}
.osp-pager-jump button {
  color: var(--accent-strong, #7fb0ff);
}
.osp-pager-jump button:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
