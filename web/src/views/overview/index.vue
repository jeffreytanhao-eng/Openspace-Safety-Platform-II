<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import DataSourceBar from '@/components/DataSourceBar.vue'
import { useDataSource } from '@/composables/useDataSource'

const router = useRouter()
const { t, locale } = useI18n()
const { current } = useDataSource()

type Risk = 'high' | 'warn' | 'watch' | 'low'

interface EventRow {
  id: string
  primary: string
  secondary: string
  tca: string
  missKm: number
  pc: string
  risk: Risk
}

const kpis = computed(() => [
  { key: 'owned', label: t('ov.stat.owned'), value: '128', unit: 'sats' },
  { key: 'high', label: t('ov.stat.high'), value: '3', unit: '24h', tone: 'danger' as const },
  { key: 'warn', label: t('ov.stat.warn'), value: '19', unit: '7d', tone: 'warn' as const },
  { key: 'screen', label: t('ov.stat.screen'), value: '46', unit: 'runs' },
  { key: 'ephem', label: t('ov.stat.ephem'), value: '97%', unit: 'ok' }
])

const assets = [
  { name: 'Demo-LEO Cluster A', norad: '38124–38140', count: 16, ephem: 'ITC · 60s', status: 'fresh' },
  { name: 'Demo-LEO Cluster B', norad: '42001–42018', count: 18, ephem: 'OEM · 30s', status: 'fresh' },
  { name: 'Research CubeSat Pack', norad: '99101–99108', count: 8, ephem: 'TLE fallback', status: 'stale' },
  { name: 'Ground Assets / Sites', norad: '—', count: 4, ephem: 'N/A', status: 'ok' }
]

const events = ref<EventRow[]>([
  { id: 'e1', primary: 'STARLINK-38124', secondary: 'STARLINK-5315', tca: '10-29 09:51 UTC', missKm: 2.67, pc: '2.1e-5', risk: 'warn' },
  { id: 'e2', primary: 'STARLINK-38128', secondary: 'COSMOS 1408 DEB', tca: '10-29 14:22 UTC', missKm: 0.84, pc: '1.3e-4', risk: 'high' },
  { id: 'e3', primary: 'DEMO-99103', secondary: 'CZ-8A R/B', tca: '10-30 02:08 UTC', missKm: 5.03, pc: '4.6e-6', risk: 'watch' },
  { id: 'e4', primary: 'STARLINK-38123', secondary: 'CHAMRAN-1', tca: '10-30 11:40 UTC', missKm: 12.1, pc: '8.2e-7', risk: 'watch' },
  { id: 'e5', primary: 'STARLINK-37711', secondary: 'IRIDIUM 33 DEB', tca: '10-31 06:15 UTC', missKm: 1.42, pc: '2.4e-4', risk: 'high' },
  { id: 'e6', primary: 'DEMO-42007', secondary: 'SL-16 R/B', tca: '10-31 18:33 UTC', missKm: 7.55, pc: '3.1e-5', risk: 'warn' }
])

const windowTab = ref<'24h' | '3d' | '7d'>('7d')
const selected = ref('e2')

const bars = computed(() => {
  const base =
    current.value.id === 'space-track-cdm'
      ? [9, 6, 4, 3, 2, 1, 1]
      : current.value.id === 'tle'
        ? [5, 4, 3, 3, 2, 2, 1]
        : [4, 3, 3, 2, 2, 1, 1]
  return base.map((v, i) => ({ day: `10-${25 + i}`, count: v }))
})

const filtered = computed(() => {
  if (windowTab.value === '24h') return events.value.slice(0, 2)
  if (windowTab.value === '3d') return events.value.slice(0, 4)
  return events.value
})

const riskLabel = computed<Record<Risk, string>>(() => ({
  high: t('conj.high'),
  warn: t('conj.warn'),
  watch: t('conj.watch'),
  low: locale.value === 'zh' ? '低' : 'Low'
}))

const aiMessages = ref([
  { role: 'ai', text: '近 7 日交会摘要（当前数据源）：2 起高危、2 起警告。建议优先复核 STARLINK-38128 × COSMOS 1408 DEB。' },
  { role: 'ai', text: 'CubeSat Pack 仍为 TLE fallback；可在 Ephemerides 上传精密星历后重新筛查。' }
])
const draft = ref('')

function sendAi() {
  const text = draft.value.trim()
  if (!text) return
  aiMessages.value.push({ role: 'user', text })
  draft.value = ''
  aiMessages.value.push({
    role: 'ai',
    text: locale.value === 'zh'
      ? `（Stage 1 占位）已记录。当前数据源：${current.value.label}。后续阶段接入筛查 / 星历工具链。`
      : `(Stage 1 stub) Noted. Active source: ${current.value.label}. Screening / ephemeris tools come later.`
  })
}
</script>

<template>
  <div class="overview">
    <section class="toolbar">
      <DataSourceBar />
    </section>

    <section class="kpi-row">
      <div v-for="k in kpis" :key="k.key" class="kpi" :class="k.tone">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-value">
          <span class="num">{{ k.value }}</span>
          <span class="unit">{{ k.unit }}</span>
        </div>
      </div>
    </section>

    <section class="grid">
      <aside class="panel assets">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('ov.ownedTitle') }}</div>
            <div class="h-sub">{{ t('ov.ownedSub') }}</div>
          </div>
          <button type="button" class="ghost" @click="router.push('/situation')">{{ t('ov.open3d') }}</button>
        </header>
        <div class="asset-list">
          <div v-for="a in assets" :key="a.name" class="asset">
            <div class="asset-top">
              <div class="asset-name">{{ a.name }}</div>
              <span class="status" :class="a.status">{{ a.status }}</span>
            </div>
            <div class="asset-meta">
              <span>NORAD {{ a.norad }}</span>
              <span>{{ a.count }} objs</span>
              <span>{{ a.ephem }}</span>
            </div>
          </div>
        </div>
      </aside>

      <section class="panel safety">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('ov.safetyTitle') }}</div>
            <div class="h-sub">交会态势 · {{ current.short }}</div>
          </div>
          <div class="seg">
            <button type="button" :class="{ on: windowTab === '24h' }" @click="windowTab = '24h'">24h</button>
            <button type="button" :class="{ on: windowTab === '3d' }" @click="windowTab = '3d'">3d</button>
            <button type="button" :class="{ on: windowTab === '7d' }" @click="windowTab = '7d'">7d</button>
          </div>
        </header>

        <div class="filters">
          <div class="legend">
            <span class="dot high" />高危
            <span class="dot warn" />警告
            <span class="dot watch" />关注
          </div>
        </div>

        <div class="bars">
          <div v-for="b in bars" :key="b.day" class="bar-col">
            <div class="bar" :style="{ height: `${16 + b.count * 9}px` }">
              <span>{{ b.count }}</span>
            </div>
            <div class="bar-day">{{ b.day }}</div>
          </div>
        </div>

        <div class="event-list">
          <button
            v-for="e in filtered"
            :key="e.id"
            type="button"
            class="event"
            :class="[{ on: selected === e.id }, e.risk]"
            @click="selected = e.id"
          >
            <div class="ev-left">
              <span class="risk-pill">{{ riskLabel[e.risk] }}</span>
              <div class="ev-names">
                <div class="pair">{{ e.primary }} <span>×</span> {{ e.secondary }}</div>
                <div class="meta">TCA {{ e.tca }} · {{ current.short }}</div>
              </div>
            </div>
            <div class="ev-right">
              <div class="pc">Pc {{ e.pc }}</div>
              <div class="miss">{{ e.missKm.toFixed(2) }} km</div>
            </div>
          </button>
        </div>
      </section>

      <aside class="panel ai">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('ov.aiTitle') }}</div>
            <div class="h-sub">{{ t('ov.aiSub') }}</div>
          </div>
        </header>
        <div class="chat">
          <div v-for="(m, i) in aiMessages" :key="i" class="bubble" :class="m.role">{{ m.text }}</div>
        </div>
        <form class="composer" @submit.prevent="sendAi">
          <input v-model="draft" type="text" :placeholder="t('ov.aiPlaceholder')" />
          <button type="submit">{{ t('ov.send') }}</button>
        </form>
      </aside>
    </section>
  </div>
</template>

<style scoped lang="scss">
.overview {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
  min-height: 0;
}
.toolbar {
  flex: 0 0 auto;
  padding: 10px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.kpi-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}
.kpi {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  border-left: 2px solid var(--border-strong);
}
.kpi.danger { border-left-color: var(--danger); }
.kpi.warn { border-left-color: var(--warn); }
.kpi-label { font-size: 11px; color: var(--text-muted); }
.kpi-value { margin-top: 4px; display: flex; align-items: baseline; gap: 6px; }
.kpi-value .num { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--text); }
.kpi-value .unit { font-size: 10px; color: var(--text-dim); }

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 250px 1fr 280px;
  gap: 10px;
}
.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.panel-h {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px;
  border-bottom: 1px solid var(--border);
}
.h-title { font-size: 13px; font-weight: 650; color: var(--text); }
.h-sub { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
.ghost {
  appearance: none;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}
.ghost:hover { color: var(--accent-strong); border-color: var(--accent); }

.seg {
  display: inline-flex;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px;
  gap: 2px;
}
.seg button {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.seg button.on {
  background: var(--bg-hover);
  color: var(--text);
}

.asset-list { padding: 8px; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.asset {
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.asset-top { display: flex; justify-content: space-between; gap: 6px; }
.asset-name { font-size: 12px; font-weight: 600; }
.status {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.status.fresh, .status.ok { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.status.stale { color: var(--warn); border-color: rgba(196, 146, 74, 0.35); }
.asset-meta {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}

.filters { padding: 8px 12px 0; }
.legend {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  color: var(--text-muted);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 3px;
}
.dot.high { background: var(--danger); }
.dot.warn { background: var(--warn); }
.dot.watch { background: var(--watch); }

.bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 14px 4px;
  height: 96px;
}
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.bar {
  width: 100%;
  max-width: 36px;
  border-radius: 3px 3px 1px 1px;
  background: rgba(74, 125, 154, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 2px;
  font-size: 9px;
  color: var(--text);
  font-weight: 600;
}
.bar-day { font-size: 9px; color: var(--text-dim); }

.event-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.event {
  appearance: none;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  color: var(--text);
}
.event:hover { border-color: var(--border-strong); }
.event.on { border-color: rgba(74, 125, 154, 0.5); }
.event.high { border-left: 2px solid var(--danger); }
.event.warn { border-left: 2px solid var(--warn); }
.event.watch { border-left: 2px solid var(--watch); }

.ev-left { display: flex; gap: 8px; min-width: 0; }
.risk-pill {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 650;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.event.high .risk-pill { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.event.warn .risk-pill { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.event.watch .risk-pill { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pair { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pair span { color: var(--text-dim); margin: 0 3px; }
.meta { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.ev-right { text-align: right; flex: 0 0 auto; }
.pc { font-family: var(--mono); font-size: 11px; font-weight: 600; }
.miss { margin-top: 2px; font-size: 10px; color: var(--text-dim); }

.chat {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble {
  max-width: 95%;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}
.bubble.ai {
  align-self: flex-start;
  background: var(--ai-soft);
  border: 1px solid var(--border);
}
.bubble.user {
  align-self: flex-end;
  background: var(--accent-soft);
  border: 1px solid rgba(74, 125, 154, 0.3);
}
.composer {
  display: flex;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
}
.composer input {
  flex: 1;
  min-width: 0;
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 7px 9px;
  font-size: 12px;
  outline: none;
}
.composer input:focus { border-color: var(--accent); }
.composer button {
  appearance: none;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 12px;
  background: var(--bg-hover);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
</style>
