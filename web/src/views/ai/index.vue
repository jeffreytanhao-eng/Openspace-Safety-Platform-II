<script setup lang="ts">
/**
 * R2-17：操作事件流（规则聚合，不是聊天机器人 / 也不是模型推理）
 *
 * 只用本平台已有数据：
 *  - 交会事件（CDM / 筛查产出，按 TCA 归属）
 *  - 筛查任务（发起 / 完成 / 失败 / 取消）
 * 按时间倒序排成横向时间线，点任一事件跳到对应详情。
 * 不做意图识别，不输出「检测到对方意图」这类无法由 TLE/CDM 证实的结论。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import { listEvents, type ConjunctionEvent, type EventLevel } from '@/api/events'
import { listScreens, type ScreenJob } from '@/api/screens'
import { AuthError } from '@/api/auth'

const { t } = useI18n()
const router = useRouter()

type WindowKey = '24h' | '3d' | '7d' | 'all'
type LevelFilter = 'all' | 'red' | 'orange' | 'yellow'
type Kind = 'conjunction' | 'screen'

interface StreamItem {
  id: string
  at: number
  kind: Kind
  /** 交会事件级别；筛查任务记为 info */
  level: EventLevel | 'info'
  title: string
  summary: string
  to?: string
}

const windowKey = ref<WindowKey>('7d')
const levelFilter = ref<LevelFilter>('all')
const loading = ref(false)
const error = ref('')
const events = ref<ConjunctionEvent[]>([])
const jobs = ref<ScreenJob[]>([])
const needLogin = ref(false)

const WINDOW_MS: Record<Exclude<WindowKey, 'all'>, number> = {
  '24h': 24 * 3600 * 1000,
  '3d': 3 * 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000
}

const WINDOW_KEY = { '24h': 'ai.window.24h', '3d': 'ai.window.3d', '7d': 'ai.window.7d', all: 'ai.window.all' } as const

function windowLabel(k: WindowKey): string {
  return t(WINDOW_KEY[k])
}

function statusLabel(s: string): string {
  const map: Record<string, Parameters<typeof t>[0]> = {
    queued: 'ai.st.queued',
    running: 'ai.st.running',
    done: 'ai.st.done',
    failed: 'ai.st.failed',
    cancelled: 'ai.st.cancelled'
  }
  const key = map[s]
  return key ? t(key) : s
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  needLogin.value = false
  try {
    const [ev, js] = await Promise.all([listEvents(windowKey.value), listScreens()])
    events.value = ev.events ?? []
    jobs.value = js ?? []
  } catch (e) {
    if (e instanceof AuthError) {
      needLogin.value = true
      error.value = e.message
    } else {
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    loading.value = false
  }
}

function setWindow(k: WindowKey): void {
  if (windowKey.value === k) return
  windowKey.value = k
  void load()
}

const withinWindow = (ms: number): boolean => {
  if (windowKey.value === 'all') return true
  return ms >= Date.now() - WINDOW_MS[windowKey.value]
}

const items = computed<StreamItem[]>(() => {
  const out: StreamItem[] = []
  for (const e of events.value) {
    const at = Date.parse(e.tca)
    if (!Number.isFinite(at) || !withinWindow(at)) continue
    const miss = e.missKm != null ? `${e.missKm.toFixed(2)} km` : '—'
    const pc = e.pc != null ? e.pc.toExponential(2) : '—'
    out.push({
      id: `ev-${e.key}`,
      at,
      kind: 'conjunction',
      level: e.level,
      title: `${e.nameA} × ${e.nameB}`,
      summary: `${t('ai.summary.tca')} ${fmtTime(e.tca)} · ${t('conj.col.pc')} ${pc} · ${t('conj.col.miss')} ${miss}`,
      to: `/conjunctions/${encodeURIComponent(e.key)}`
    })
  }
  for (const j of jobs.value) {
    const at = Date.parse(j.queued_at)
    if (!Number.isFinite(at) || !withinWindow(at)) continue
    out.push({
      id: `job-${j.id}`,
      at,
      kind: 'screen',
      level: 'info',
      title: t('ai.job.title'),
      summary: `${t('ai.job.status')} ${statusLabel(j.status)} · ${t('ai.job.events')} ${j.n_events} · ${t('ai.job.window')} ${j.window_h} h`,
      to: '/screens'
    })
  }
  return out.sort((a, b) => b.at - a.at)
})

const filtered = computed<StreamItem[]>(() => {
  if (levelFilter.value === 'all') return items.value
  return items.value.filter((i) => i.level === levelFilter.value)
})

const counts = computed(() => {
  const c = { red: 0, orange: 0, yellow: 0, info: 0 }
  for (const i of items.value) {
    if (i.level === 'red') c.red++
    else if (i.level === 'orange') c.orange++
    else if (i.level === 'yellow') c.yellow++
    else c.info++
  }
  return c
})

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function open(item: StreamItem): void {
  if (item.to) void router.push(item.to)
}

const levelCls: Record<string, string> = { red: 'lv-red', orange: 'lv-orange', yellow: 'lv-yellow', info: 'lv-info' }

onMounted(() => void load())
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('ai.title') }}</h1>
        <p class="sub">{{ t('ai.flowSub') }}</p>
      </div>
      <button type="button" class="btn sm" :disabled="loading" @click="load">{{ t('ai.refresh') }}</button>
    </header>

    <div class="toolbar">
      <div class="chips">
        <button
          v-for="k in (['24h', '3d', '7d', 'all'] as WindowKey[])"
          :key="k"
          type="button"
          class="chip"
          :class="{ on: windowKey === k }"
          @click="setWindow(k)"
        >{{ windowLabel(k) }}</button>
      </div>
      <div class="chips">
        <button type="button" class="chip" :class="{ on: levelFilter === 'all' }" @click="levelFilter = 'all'">
          {{ t('ai.level.all') }} {{ items.length }}
        </button>
        <button type="button" class="chip lv-red" :class="{ on: levelFilter === 'red' }" @click="levelFilter = 'red'">
          {{ t('sit.eventLv.red') }} {{ counts.red }}
        </button>
        <button type="button" class="chip lv-orange" :class="{ on: levelFilter === 'orange' }" @click="levelFilter = 'orange'">
          {{ t('sit.eventLv.orange') }} {{ counts.orange }}
        </button>
        <button type="button" class="chip lv-yellow" :class="{ on: levelFilter === 'yellow' }" @click="levelFilter = 'yellow'">
          {{ t('sit.eventLv.yellow') }} {{ counts.yellow }}
        </button>
      </div>
    </div>

    <p v-if="loading" class="state">{{ t('obj.loading') }}</p>
    <p v-else-if="error" class="state error">{{ error }}</p>
    <p v-else-if="!filtered.length" class="state">{{ t('ai.empty') }}</p>

    <ol v-else class="stream">
      <li v-for="it in filtered" :key="it.id" :class="[levelCls[it.level], { clickable: !!it.to }]" @click="open(it)">
        <span class="dot"></span>
        <div class="body">
          <div class="row">
            <b class="title">{{ it.title }}</b>
            <span class="kind">{{ it.kind === 'conjunction' ? t('ai.kind.conjunction') : t('ai.kind.screen') }}</span>
            <time class="mono">{{ fmtTime(new Date(it.at).toISOString()) }}</time>
          </div>
          <p class="sum">{{ it.summary }}</p>
        </div>
      </li>
    </ol>

    <p class="foot">{{ t('ai.note') }}</p>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  padding: 20px 18px 40px;
  overflow: auto;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
h1 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}
.sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  max-width: 760px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 16px 0 10px;
}
.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 12px;
  cursor: pointer;
}
.chip.on {
  color: var(--text);
  border-color: var(--accent);
  background: rgba(56, 189, 248, 0.12);
}
.chip.lv-red.on { border-color: #ef4444; background: rgba(239, 68, 68, 0.14); }
.chip.lv-orange.on { border-color: #f59e0b; background: rgba(245, 158, 11, 0.14); }
.chip.lv-yellow.on { border-color: #eab308; background: rgba(234, 179, 8, 0.14); }

.state {
  font-size: 12px;
  color: var(--text-dim);
  padding: 18px 0;
}
.state.error { color: var(--danger); }

.stream {
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
  border-left: 1px solid var(--border);
}
.stream li {
  position: relative;
  padding: 8px 0 8px 14px;
  border-bottom: 1px solid rgba(120, 150, 180, 0.08);
}
.stream li.clickable { cursor: pointer; }
.stream li.clickable:hover { background: rgba(56, 189, 248, 0.05); }
.dot {
  position: absolute;
  left: -5px;
  top: 15px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #64748b;
}
.lv-red .dot { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
.lv-orange .dot { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
.lv-yellow .dot { background: #eab308; box-shadow: 0 0 6px #eab308; }
.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.title { font-size: 12px; color: var(--text); font-weight: 600; }
.kind {
  font-size: 9px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
}
time { margin-left: auto; font-size: 10px; color: var(--text-dim); }
.sum { margin: 3px 0 0; font-size: 11px; color: var(--text-muted); }
.foot { margin-top: 18px; font-size: 10px; color: var(--text-dim); }
</style>
