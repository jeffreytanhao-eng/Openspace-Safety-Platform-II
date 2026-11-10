<script setup lang="ts">
/**
 * 统一数字输入：隐藏系统默认步进箭头，改为与深色控件一致的自定义上下按钮。
 */
import { computed, onUnmounted, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false, name: 'OspNumberInput' })

const props = withDefaults(
  defineProps<{
    min?: number | string
    max?: number | string
    step?: number | string
    disabled?: boolean
    placeholder?: string
  }>(),
  { step: 1, disabled: false }
)

const model = defineModel<number | string | null>({ default: null })
const emit = defineEmits<{ input: [e: Event] }>()
const attrs = useAttrs()

const inputAttrs = computed(() => {
  const a = { ...(attrs as Record<string, unknown>) }
  delete a.class
  delete a.style
  return a
})

const rootClass = computed(() => attrs.class)
const rootStyle = computed(() => attrs.style)

function toNum(v: unknown): number | null {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function stepVal(): number {
  const s = props.step
  if (s === 'any' || s == null || s === '') return 1
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function decimalsForStep(): number {
  const raw = String(props.step ?? '1')
  const exp = /e-(\d+)/i.exec(raw)
  if (exp) return Number(exp[1])
  const i = raw.indexOf('.')
  return i >= 0 ? raw.length - i - 1 : 0
}

function roundToStep(n: number): number {
  return Number(n.toFixed(Math.min(decimalsForStep(), 10)))
}

function clamp(n: number): number {
  const min = toNum(props.min)
  const max = toNum(props.max)
  let x = n
  if (min != null && x < min) x = min
  if (max != null && x > max) x = max
  return x
}

function onNativeInput(e: Event) {
  const el = e.target as HTMLInputElement
  if (el.value === '') {
    model.value = ''
    return
  }
  const n = Number(el.value)
  model.value = Number.isFinite(n) ? n : el.value
  emit('input', e)
}

function atBound(dir: 1 | -1): boolean {
  if (props.disabled) return true
  const cur = toNum(model.value)
  if (cur == null) return false
  if (dir > 0) {
    const max = toNum(props.max)
    return max != null && cur >= max - 1e-12
  }
  const min = toNum(props.min)
  return min != null && cur <= min + 1e-12
}

function nudge(dir: 1 | -1) {
  if (props.disabled) return
  const step = stepVal()
  const cur = toNum(model.value)
  const min = toNum(props.min)
  const max = toNum(props.max)
  const base = cur ?? (dir > 0 ? (min ?? 0) : (max ?? 0))
  model.value = clamp(roundToStep(base + dir * step))
  emit('input', new Event('input'))
}

let holdDelay: ReturnType<typeof setTimeout> | null = null
let holdInt: ReturnType<typeof setInterval> | null = null

function startHold(dir: 1 | -1) {
  if (props.disabled) return
  nudge(dir)
  stopHold()
  holdDelay = setTimeout(() => {
    holdInt = setInterval(() => {
      if (atBound(dir)) {
        stopHold()
        return
      }
      nudge(dir)
    }, 70)
  }, 380)
}

function stopHold() {
  if (holdDelay) clearTimeout(holdDelay)
  if (holdInt) clearInterval(holdInt)
  holdDelay = null
  holdInt = null
}

onUnmounted(stopHold)
</script>

<template>
  <span class="osp-num" :class="[rootClass, { disabled: disabled }]" :style="rootStyle">
    <input
      v-bind="inputAttrs"
      type="number"
      :value="model"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :placeholder="placeholder"
      @input="onNativeInput"
    />
    <span class="osp-num-spin" aria-hidden="true">
      <button
        type="button"
        tabindex="-1"
        class="up"
        :disabled="disabled || atBound(1)"
        @mousedown.prevent="startHold(1)"
        @mouseup="stopHold"
        @mouseleave="stopHold"
      >
        <i></i>
      </button>
      <button
        type="button"
        tabindex="-1"
        class="down"
        :disabled="disabled || atBound(-1)"
        @mousedown.prevent="startHold(-1)"
        @mouseup="stopHold"
        @mouseleave="stopHold"
      >
        <i></i>
      </button>
    </span>
  </span>
</template>

<style scoped>
.osp-num {
  display: inline-flex;
  align-items: stretch;
  vertical-align: middle;
  min-height: 26px;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  box-sizing: border-box;
}
.osp-num:focus-within {
  border-color: var(--accent);
}
.osp-num.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.osp-num input {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: auto;
  margin: 0;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  outline: none;
  padding: 4px 6px;
  color: inherit;
  font: inherit;
  font-size: inherit;
  line-height: 1.3;
  appearance: textfield;
  -moz-appearance: textfield;
}
.osp-num input::-webkit-outer-spin-button,
.osp-num input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.osp-num input:disabled {
  opacity: 1;
  cursor: not-allowed;
}
.osp-num-spin {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 16px;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
}
.osp-num-spin button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  line-height: 0;
}
.osp-num-spin button + button {
  border-top: 1px solid var(--border);
}
.osp-num-spin button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.osp-num-spin button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.osp-num-spin i {
  display: block;
  width: 0;
  height: 0;
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
}
.osp-num-spin .up i {
  border-bottom: 4px solid currentColor;
}
.osp-num-spin .down i {
  border-top: 4px solid currentColor;
}
</style>
