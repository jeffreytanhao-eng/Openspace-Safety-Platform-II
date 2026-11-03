<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { MessageKey } from '@/i18n/messages'
import {
  createScreen,
  getScreen,
  listScreens,
  type ScreenEvent,
  type ScreenJob,
  type ScreenJobStatus
} from '@/api/screens'
import { AuthError } from '@/api/auth'

const { t } = useI18n()

const loading = ref(true)
const needOrg = ref(false)
const loadError = ref('')
const jobs = ref<ScreenJob[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<{ job: ScreenJob; events: ScreenEvent[] } | null>(null)
const detailLoading = ref(false)

/* ------------------------------ 发起筛查表单 ------------------------------ */

const windowH = ref(72)
const missMaxKm = ref(10)
const hbrM = ref(15)
const submitting = ref(false)
const submitError = ref('')

async function submit() {
  if (submitting.value) return
  submitError.value = ''
  const w = Math.min(168, Math.max(1, Math.round(Number(windowH.value) || 72)))
  const m = Math.min(50, Math.max(0.5, Number(missMaxKm.value) || 10))
  const h = Math.min(1000, Math.max(1, Number(hbrM.value) || 15))
  submitting.value = true
  try {
    const job = await createScreen({ windowH: w, missMaxKm: m, hbrM: h })
    await loadJobs()
    selectJob(job.id)
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

/* -------------------------------- 数据加载 -------------------------------- */

async function loadJobs() {
  try {
    jobs.value = await listScreens()
    needOrg.value = false
    loadError.value = ''
  } catch (e) {
    if (e instanceof AuthError && e.httpStatus === 403) needOrg.value = true
    else loadError.value = e instanceof Error ? e.message : String(e)
  }
}

async function selectJob(id: number) {
  selectedId.value = id
  detailLoading.value = true
  try {
    detail.value = await getScreen(id)
  } catch {
    detail.value = null
  } finally {
    detailLoading.value = false
  }
}

async function loadAll() {
  loading.value = true
  try {
    await loadJobs()
    if (!selectedId.value && jobs.value.length) await selectJob(jobs.value[0].id)
  } finally {
    loading.value = false
  }
}

/** 有排队/计算中任务时每 3s 轮询，全部落定后停止 */
const hasActive = computed(() => jobs.value.some((j) => j.status === 'queued' || j.status === 'running'))
let pollTimer: number | undefined

function tickPoll() {
  if (!hasActive.value) return
  void loadJobs()
  if (selectedId.value) void selectJob(selectedId.value)
}

onMounted(() => {
  void loadAll()
  pollTimer = window.setInterval(tickPoll, 3000)
})
onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})

/* -------------------------------- 格式化 -------------------------------- */

const STATUS_CLASS: Record<ScreenJobStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'ok',
  failed: 'failed'
}
function statusLabel(s: ScreenJobStatus): MessageKey {
  return `scr.status.${s}` as MessageKey
}
function levelLabel(l: ScreenEvent['level']): MessageKey {
  return `scr.level.${l}` as MessageKey
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
function fmtWhen(v: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}
const fmtPc = (p: number | null) =>
  p === null || !Number.isFinite(p) ? '—' : p.toExponential(2)
const fmtMiss = (m: number | null) =>
  m === null || !Number.isFinite(m) ? '—' : m.toFixed(2)

function pairOf(e: ScreenEvent): string {
  const a = e.primary_name?.trim() || `NORAD ${e.primary_norad}`
  const b = e.secondary_name?.trim() || `NORAD ${e.secondary_norad}`
  return `${a} × ${b}`
}
function pcSourceLabel(e: ScreenEvent): string {
  if (e.pc_source === 'cdm') return `CDM · ${e.cdm_id || ''}`
  return t('scr.pcCore')
}
</script>

<template>
  <div class="screens">
    <!-- 平台账号：无组织，不可用 -->
    <section v-if="needOrg" class="panel hint">
      <p>{{ t('scr.needOrg') }}</p>
    </section>

    <section v-else-if="loadError && !jobs.length" class="panel hint">
      <p>{{ t('ov.loadFail') }}：{{ loadError }}</p>
      <button type="button" class="ghost" @click="loadAll">{{ t('ov.retry') }}</button>
    </section>

    <template v-else>
      <section class="grid">
        <aside class="col-left">
          <!-- 发起筛查 -->
          <div class="panel">
            <header class="panel-h">
              <div>
                <div class="h-title">{{ t('scr.newTitle') }}</div>
                <div class="h-sub">{{ t('scr.newSub') }}</div>
              </div>
            </header>
            <div class="form">
              <label class="field">
                <span class="lbl">{{ t('scr.window') }}</span>
                <input v-model.number="windowH" type="number" min="1" max="168" step="1" />
              </label>
              <label class="field">
                <span class="lbl">{{ t('scr.missMax') }}</span>
                <input v-model.number="missMaxKm" type="number" min="0.5" max="50" step="0.5" />
              </label>
              <label class="field">
                <span class="lbl">{{ t('scr.hbr') }}</span>
                <input v-model.number="hbrM" type="number" min="1" max="1000" step="1" />
              </label>
              <button type="button" class="primary" :disabled="submitting" @click="submit">
                {{ submitting ? t('scr.submitting') : t('scr.submit') }}
              </button>
              <div v-if="submitError" class="err">{{ submitError }}</div>
            </div>
          </div>

          <!-- 任务列表 -->
          <div class="panel jobs">
            <header class="panel-h">
              <div>
                <div class="h-title">{{ t('scr.jobsTitle') }}</div>
                <div class="h-sub">{{ hasActive ? t('scr.autoRefresh') : t('scr.jobsSub') }}</div>
              </div>
              <button type="button" class="ghost" @click="loadAll">{{ t('obj.refresh') }}</button>
            </header>
            <div class="job-list">
              <div v-if="loading && !jobs.length" class="empty">{{ t('obj.loading') }}</div>
              <div v-else-if="!jobs.length" class="empty">{{ t('scr.noJobs') }}</div>
              <button
                v-for="j in jobs"
                :key="j.id"
                type="button"
                class="job"
                :class="{ on: selectedId === j.id }"
                @click="selectJob(j.id)"
              >
                <div class="job-top">
                  <span class="jid">#{{ j.id }}</span>
                  <span class="state" :class="STATUS_CLASS[j.status]">{{ t(statusLabel(j.status)) }}</span>
                  <span class="when">{{ fmtWhen(j.queued_at) }}</span>
                </div>
                <div class="job-meta">
                  <span>{{ t('scr.col.window') }} {{ j.window_h }}h</span>
                  <span>{{ t('scr.col.miss') }} {{ j.miss_max_km }}</span>
                  <span>HBR {{ j.hbr_m }}m</span>
                  <span>{{ t('scr.col.events') }} {{ j.n_events }}</span>
                  <span v-if="j.status === 'done' || j.status === 'failed'">{{ fmtDur(j.duration_ms) }}</span>
                </div>
                <div v-if="j.error_message" class="job-err">{{ j.error_message }}</div>
              </button>
            </div>
          </div>
        </aside>

        <!-- 交会事件 -->
        <section class="panel events">
          <header class="panel-h">
            <div>
              <div class="h-title">
                {{ t('scr.eventsTitle') }}
                <span v-if="detail?.job" class="h-title-id">#{{ detail.job.id }}</span>
              </div>
              <div class="h-sub">
                <template v-if="detail?.job">
                  {{ t('scr.col.primary') }} {{ detail.job.n_primary }} · {{ t('scr.col.secondary') }}
                  {{ detail.job.n_secondary }} · {{ t('scr.col.candidates') }} {{ detail.job.n_candidates }}
                </template>
                <template v-else>{{ t('scr.eventsSub') }}</template>
              </div>
            </div>
          </header>
          <div class="event-scroll">
            <div v-if="detailLoading && !detail" class="empty">{{ t('obj.loading') }}</div>
            <div v-else-if="!detail || !detail.events.length" class="empty">{{ t('scr.noEvents') }}</div>
            <div v-for="e in detail?.events ?? []" :key="e.id" class="event">
              <div class="ev-left">
                <span class="level-pill" :class="e.level">
                  {{ t(levelLabel(e.level)) }}<template v-if="e.diluted">·{{ t('scr.diluted') }}</template>
                </span>
                <div class="ev-names">
                  <div class="pair">{{ pairOf(e) }}</div>
                  <div class="meta">
                    TCA {{ fmtWhen(e.tca) }}
                    <template v-if="e.pc_source === 'cdm'"> · CDM {{ e.cdm_id }}</template>
                  </div>
                </div>
              </div>
              <div class="ev-right">
                <div class="pc">Pc {{ fmtPc(e.pc) }}</div>
                <div class="miss">{{ fmtMiss(e.miss_km) }} km · {{ pcSourceLabel(e) }}</div>
              </div>
            </div>
          </div>
        </section>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
.screens {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
  min-height: 0;
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
.h-title-id { margin-left: 6px; color: var(--text-dim); font-weight: 500; font-size: 11px; }
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

.hint {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  font-size: 13px;
  color: var(--text-muted);
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 10px;
}
.col-left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

/* 表单 */
.form {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field { display: flex; flex-direction: column; gap: 3px; }
.lbl { font-size: 10px; color: var(--text-dim); }
.field input {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: var(--mono);
  outline: none;
}
.field input:focus { border-color: var(--accent); }
.primary {
  appearance: none;
  border: 1px solid rgba(74, 125, 154, 0.5);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 4px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.primary:hover { border-color: var(--accent); }
.primary:disabled { opacity: 0.55; cursor: default; }
.err { font-size: 11px; color: var(--danger); line-height: 1.5; }

/* 任务列表 */
.jobs { flex: 1; }
.job-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.job {
  appearance: none;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  color: var(--text);
}
.job:hover { border-color: var(--border-strong); }
.job.on { border-color: var(--accent); background: var(--accent-soft); }
.job-top { display: flex; align-items: center; gap: 8px; }
.jid { font-family: var(--mono); font-size: 11px; font-weight: 650; }
.when { margin-left: auto; font-size: 10px; color: var(--text-dim); }
.state {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.state.queued { color: var(--text-muted); }
.state.running { color: var(--accent-strong); border-color: rgba(74, 125, 154, 0.4); }
.state.ok { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.state.failed { color: var(--danger); border-color: rgba(196, 91, 91, 0.4); }
.job-meta {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.job-err {
  margin-top: 4px;
  font-size: 10px;
  color: var(--danger);
  line-height: 1.4;
  word-break: break-all;
}
.empty {
  padding: 14px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}

/* 事件 */
.events { flex: 1; }
.event-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.event {
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.ev-left { display: flex; gap: 8px; min-width: 0; }
.level-pill {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 650;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.level-pill.red { color: var(--danger); border-color: rgba(196, 91, 91, 0.5); }
.level-pill.orange { color: var(--warn); border-color: rgba(196, 146, 74, 0.5); }
.level-pill.yellow { color: #d8c86a; border-color: rgba(216, 200, 106, 0.4); }
.ev-names { min-width: 0; }
.pair { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.ev-right { text-align: right; flex: 0 0 auto; }
.pc { font-family: var(--mono); font-size: 11px; font-weight: 600; }
.miss { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
</style>
