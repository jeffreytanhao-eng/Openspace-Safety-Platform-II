<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import DataSourceBar from '@/components/DataSourceBar.vue'
import { getOverviewSummary, type OverviewSummary, type OwnedCdmItem } from '@/api/overview'
import { listObjects, type ManagedObject } from '@/api/objects'
import { AuthError } from '@/api/auth'

const router = useRouter()
const { t } = useI18n()

const loading = ref(true)
const needAuth = ref(false)
const loadError = ref('')
const summary = ref<OverviewSummary | null>(null)
const assets = ref<ManagedObject[]>([])

async function load() {
  loading.value = true
  needAuth.value = false
  loadError.value = ''
  try {
    summary.value = await getOverviewSummary()
    assets.value = await listObjects()
  } catch (e) {
    if (e instanceof AuthError && e.httpStatus === 401) needAuth.value = true
    else loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

/* ---------------------------------- KPI ---------------------------------- */

const kpis = computed(() => {
  const s = summary.value
  return [
    { key: 'owned', label: t('ov.stat.owned'), value: s ? String(s.owned) : '—', unit: t('ov.unit.objs'), tone: '' },
    {
      key: 'cdm24',
      label: t('ov.stat.high'),
      value: s ? String(s.cdm.next24h) : '—',
      unit: 'CDM',
      tone: s && s.cdm.next24h > 0 ? 'danger' : ''
    },
    { key: 'cdm7d', label: t('ov.stat.warn'), value: s ? String(s.cdm.next7d) : '—', unit: 'CDM', tone: '' },
    { key: 'screen', label: t('ov.stat.screen'), value: s ? String(s.screensToday) : '—', unit: t('ov.unit.runs'), tone: '' },
    {
      key: 'ephem',
      label: t('ov.stat.ephem'),
      value: s ? `${s.ephem.fresh}/${s.ephem.total}` : '—',
      unit: t('ov.unit.fresh'),
      tone: ''
    }
  ]
})

/* ------------------------------ 资产清单视图 ------------------------------ */

function assetName(a: ManagedObject): string {
  return a.name?.trim() || `NORAD ${a.norad_id}`
}
function assetBound(a: ManagedObject): number {
  return a.bound_ephemerides ?? 0
}

/* ------------------------------ 关注事件视图 ------------------------------ */

type WindowKey = '24h' | '3d' | '7d'
const windowTab = ref<WindowKey>('7d')

const events = computed<OwnedCdmItem[]>(() => {
  const list = summary.value?.cdm.ownedCdm ?? []
  const hours = windowTab.value === '24h' ? 24 : windowTab.value === '3d' ? 72 : 168
  const cutoff = Date.now() + hours * 3_600_000
  return list.filter((e) => {
    const ts = new Date(e.tca).getTime()
    return Number.isFinite(ts) && ts <= cutoff
  })
})

const pairOf = (e: OwnedCdmItem) =>
  `${e.name_a || e.norad_a} × ${e.name_b || e.norad_b}`

function fmtTca(v: string): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}
function fmtWhen(v: string | null): string {
  if (!v) return t('ov.src.never')
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}
const fmtPc = (p: number | null) =>
  p === null || !Number.isFinite(p) ? '—' : p.toExponential(2)
const fmtMiss = (m: number | null) =>
  m === null || !Number.isFinite(m) ? '— km' : `${m.toFixed(2)} km`
function fmtDur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/* ------------------------------ 数据源健康 ------------------------------ */

type I18nKey = Parameters<ReturnType<typeof useI18n>['t']>[0]

const SRC_LABEL: Record<string, I18nKey> = {
  spacetrack_gp: 'ov.src.gp',
  spacetrack_cdm: 'ov.src.cdm',
  aoe: 'ov.src.aoe'
}
const STATE_LABEL: Record<string, I18nKey> = {
  running: 'ov.src.running',
  success: 'ov.src.ok',
  failed: 'ov.src.failed',
  idle: 'ov.src.idle'
}
</script>

<template>
  <div class="overview">
    <section class="toolbar">
      <DataSourceBar />
    </section>

    <!-- 未登录：不显示任何假数据，引导登录 -->
    <section v-if="needAuth" class="panel auth-hint">
      <p>{{ t('ov.needAuth') }}</p>
      <button type="button" class="ghost" @click="router.push('/login')">{{ t('ov.goLogin') }}</button>
    </section>

    <section v-else-if="loadError" class="panel auth-hint">
      <p>{{ t('ov.loadFail') }}：{{ loadError }}</p>
      <button type="button" class="ghost" @click="load">{{ t('ov.retry') }}</button>
    </section>

    <template v-else>
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
        <aside class="col-left">
          <div class="panel assets">
            <header class="panel-h">
              <div>
                <div class="h-title">{{ t('ov.ownedTitle') }}</div>
                <div class="h-sub">{{ t('ov.ownedSub') }}</div>
              </div>
              <button type="button" class="ghost" @click="router.push('/objects')">{{ t('ov.manage') }}</button>
            </header>
            <div class="asset-list">
              <div v-if="!assets.length" class="empty">{{ t('ov.noAssets') }}</div>
              <div v-for="a in assets" :key="a.id" class="asset">
                <div class="asset-top">
                  <div class="asset-name">{{ assetName(a) }}</div>
                  <span class="status" :class="assetBound(a) > 0 ? 'ok' : 'stale'">
                    {{ assetBound(a) > 0 ? t('ov.ephBound') : t('ov.ephNone') }}
                  </span>
                </div>
                <div class="asset-meta">
                  <span>NORAD {{ a.norad_id }}</span>
                  <span>{{ assetBound(a) }} {{ t('ov.unit.ephem') }}</span>
                  <span>{{ fmtWhen(a.updated_at) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="panel sources">
            <header class="panel-h">
              <div>
                <div class="h-title">{{ t('ov.srcHealth') }}</div>
                <div class="h-sub">{{ summary?.running ? t('ov.src.running') : 'Space-Track / AOE' }}</div>
              </div>
            </header>
            <div class="src-list">
              <div v-for="s in summary?.sources ?? []" :key="s.source" class="src">
                <div class="src-top">
                  <span class="src-name">{{ t((SRC_LABEL[s.source] ?? s.source) as I18nKey) }}</span>
                  <span class="state" :class="s.state">{{ t((STATE_LABEL[s.state] ?? s.state) as I18nKey) }}</span>
                </div>
                <div class="src-meta">
                  <span>{{ t('ov.src.last') }} {{ fmtWhen(s.last_success) }}</span>
                  <span v-if="s.duration_ms != null">{{ fmtDur(s.duration_ms) }}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section class="panel safety">
          <header class="panel-h">
            <div>
              <div class="h-title">{{ t('ov.safetyTitle') }}</div>
              <div class="h-sub">{{ t('ov.safetySub') }}</div>
            </div>
            <div class="seg">
              <button type="button" :class="{ on: windowTab === '24h' }" @click="windowTab = '24h'">24h</button>
              <button type="button" :class="{ on: windowTab === '3d' }" @click="windowTab = '3d'">3d</button>
              <button type="button" :class="{ on: windowTab === '7d' }" @click="windowTab = '7d'">7d</button>
            </div>
          </header>

          <div class="event-list">
            <div v-if="loading" class="empty">{{ t('obj.loading') }}</div>
            <div v-else-if="!events.length" class="empty">{{ t('ov.noEvents') }}</div>
            <div v-for="e in events" :key="e.cdm_id" class="event">
              <div class="ev-left">
                <span class="risk-pill">CDM</span>
                <div class="ev-names">
                  <div class="pair">{{ pairOf(e) }}</div>
                  <div class="meta">TCA {{ fmtTca(e.tca) }}</div>
                </div>
              </div>
              <div class="ev-right">
                <div class="pc">Pc {{ fmtPc(e.collision_probability) }}</div>
                <div class="miss">{{ fmtMiss(e.miss_distance_km) }}</div>
              </div>
            </div>
            <div class="note">
              {{ t('ov.screenSoon') }}
              <button type="button" class="ghost note-btn" @click="router.push('/screens')">
                {{ t('nav.screens') }} →
              </button>
            </div>
          </div>
        </section>
      </section>
    </template>
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
.kpi.soon { border-left-color: var(--border); }
.kpi.soon .num { color: var(--text-dim); }
.kpi-label { font-size: 11px; color: var(--text-muted); }
.kpi-value { margin-top: 4px; display: flex; align-items: baseline; gap: 6px; }
.kpi-value .num { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--text); }
.kpi-value .unit { font-size: 10px; color: var(--text-dim); }

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 10px;
}
.col-left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.assets { flex: 1; }
.sources { flex: 0 0 auto; }
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

.empty {
  padding: 14px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}
.note {
  padding: 8px 12px 12px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
  border-top: 1px dashed var(--border);
  margin-top: auto;
}
.note-btn { margin-left: 8px; }

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
.asset-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status {
  flex: 0 0 auto;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.status.ok { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.status.stale { color: var(--warn); border-color: rgba(196, 146, 74, 0.35); }
.asset-meta {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}

.src-list { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.src {
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.src-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.src-name { font-size: 12px; font-weight: 600; }
.state {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.state.success { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.state.running { color: var(--accent-strong); border-color: rgba(74, 125, 154, 0.4); }
.state.failed { color: var(--danger); border-color: rgba(196, 91, 91, 0.4); }
.src-meta {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}

.event-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.event {
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text);
}
.event:hover { border-color: var(--border-strong); }

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
.ev-names { min-width: 0; }
.pair { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.ev-right { text-align: right; flex: 0 0 auto; }
.pc { font-family: var(--mono); font-size: 11px; font-weight: 600; }
.miss { margin-top: 2px; font-size: 10px; color: var(--text-dim); }

.auth-hint {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
