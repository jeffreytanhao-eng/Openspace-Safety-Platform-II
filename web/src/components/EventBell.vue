<script setup lang="ts">
/**
 * 左下角事件警铃：有新事件时显示琥珀色数字，点开为事件列表，
 * 每行可点 × 删除该条（数字同步减少）。事件不删除则一直保留。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { deleteUserEvent, listUserEvents, type UserEventItem } from '@/api/userEvents'

const { t } = useI18n()

const wrapEl = ref<HTMLElement | null>(null)
const items = ref<UserEventItem[]>([])
const total = ref(0)
const open = ref(false)
let timer: number | undefined

async function refresh(): Promise<void> {
  try {
    const data = await listUserEvents(50)
    items.value = data.items
    total.value = data.total
  } catch {
    /* 未登录或网络异常时静默 */
  }
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) await refresh()
}

async function dismiss(ev: Event, item: UserEventItem): Promise<void> {
  ev.stopPropagation()
  try {
    await deleteUserEvent(item.id)
    items.value = items.value.filter((x) => x.id !== item.id)
    total.value = Math.max(0, total.value - 1)
  } catch {
    /* 忽略删除失败，下次刷新会恢复真实状态 */
  }
}

function textOf(e: UserEventItem): string {
  const p = e.payload || {}
  const norad = p.norad != null && p.norad !== '' ? String(p.norad) : ''
  const name = String(p.name || '').trim()
  const target = norad ? (name ? `${name}（NORAD ${norad}）` : `NORAD ${norad}`) : name || '—'
  switch (e.eventType) {
    case 'claim.approved':
      return t('evt.claimApproved', { target })
    case 'claim.rejected':
      return t('evt.claimRejected', { target })
    case 'screen.done':
      return t('evt.screenDone', { id: Number(p.jobId || 0) })
    case 'screen.failed':
      return t('evt.screenFailed', { id: Number(p.jobId || 0) })
    case 'report.delivered':
      return t('evt.reportDelivered', { date: String(p.date || ''), n: Number(p.delivered || 0) })
    case 'report.failed':
      return t('evt.reportFailed', { date: String(p.date || ''), n: Number(p.failed || 0) })
    default:
      return String(e.eventType)
  }
}

function fmtTime(s: string): string {
  const d = new Date(s)
  const p = (n: number) => String(n).padStart(2, '0')
  if (Number.isNaN(d.getTime())) return String(s).slice(0, 16).replace('T', ' ')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return
  if (wrapEl.value && !wrapEl.value.contains(ev.target as Node)) open.value = false
}

onMounted(() => {
  void refresh()
  timer = window.setInterval(refresh, 60_000)
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div ref="wrapEl" class="bell-wrap">
    <button type="button" class="bell" :class="{ on: open }" :title="t('evt.title')" @click="toggle">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <span v-if="total > 0" class="badge">{{ total > 99 ? '99+' : total }}</span>
    </button>

    <div v-if="open" class="panel">
      <div class="panel-head">{{ t('evt.title') }}</div>
      <ul v-if="items.length" class="list">
        <li v-for="it in items" :key="it.id">
          <div class="body">
            <div class="txt">{{ textOf(it) }}</div>
            <div class="time">{{ fmtTime(it.createdAt) }}</div>
          </div>
          <button type="button" class="x" :title="t('evt.delete')" @click="dismiss($event, it)">×</button>
        </li>
      </ul>
      <div v-else class="empty">{{ t('evt.empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.bell-wrap {
  position: relative;
  display: inline-flex;
}
.bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.bell:hover,
.bell.on {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}
.badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: rgba(245, 158, 11, 0.18);
  border: 1px solid rgba(245, 158, 11, 0.65);
  color: #f59e0b;
  font-size: 9px;
  line-height: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.panel {
  position: fixed;
  left: 10px;
  bottom: 52px;
  z-index: 80;
  width: 300px;
  max-height: 50vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}
.panel-head {
  position: sticky;
  top: 0;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.list li:last-child {
  border-bottom: 0;
}
.body {
  flex: 1;
  min-width: 0;
}
.txt {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text);
  word-break: break-word;
}
.time {
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.x {
  flex: none;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 16px;
  cursor: pointer;
}
.x:hover {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}
.empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-dim);
}
</style>
