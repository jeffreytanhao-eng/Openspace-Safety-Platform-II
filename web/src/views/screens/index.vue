<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import type { MessageKey } from '@/i18n/messages'
import {
  cancelScreen,
  createScreen,
  getScreen,
  listScreens,
  type ScreenEvent,
  type ScreenJob,
  type ScreenJobStatus
} from '@/api/screens'
import { listObjects, syncTle, type ManagedObject, type SyncTleResult } from '@/api/objects'
import { getCaDefaults, getCaProfiles } from '@/api/ca'
import { AuthError } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
/** 平台账号（无组织）：全平台只读视图 */
const isPlatform = computed(() => !auth.org)
/** 基础档不能发起筛查（后端 screen_day=0 兜底），前端直接禁用并提示升级 */
const isVip = computed(() => auth.user?.isVip === true || auth.org?.plan === 'vip')

/** 与后端 SCREEN_MAX_PRIMARY 默认值保持一致；后端为准，超限时以其报错文案提示 */
const MAX_PRIMARY = 50

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

/* --------------------- R0-2：主星分批（大星座避免一次打满队列） --------------------- */

const managed = ref<ManagedObject[]>([])
const managedLoaded = ref(false)
const useSubset = ref(false)
const pickedNorads = ref<number[]>([])
const pickQuery = ref('')
const pickOpen = ref(false)

const managedFiltered = computed(() => {
  const q = pickQuery.value.trim().toLowerCase()
  if (!q) return managed.value
  return managed.value.filter(
    (o) => String(o.norad_id).includes(q) || o.name.toLowerCase().includes(q)
  )
})

async function loadManaged() {
  try {
    managed.value = await listObjects()
    // 超过单任务上限：默认进入分批模式并预选首批，避免直接提交被后端拒绝
    if (managed.value.length > MAX_PRIMARY) {
      useSubset.value = true
      if (!pickedNorads.value.length) {
        pickedNorads.value = managed.value.slice(0, MAX_PRIMARY).map((o) => o.norad_id)
      }
    }
  } catch {
    /* 无组织或接口不可用时留空，提交时由后端错误文案兜底 */
  } finally {
    managedLoaded.value = true
  }
}

function isPicked(norad: number): boolean {
  return pickedNorads.value.includes(norad)
}
function togglePick(norad: number) {
  const i = pickedNorads.value.indexOf(norad)
  if (i >= 0) pickedNorads.value.splice(i, 1)
  else pickedNorads.value.push(norad)
}
/** 全选 = 预选前 MAX_PRIMARY 颗（单任务上限内） */
function pickAll() {
  pickedNorads.value = managed.value.slice(0, MAX_PRIMARY).map((o) => o.norad_id)
}
function pickClear() {
  pickedNorads.value = []
}

/* ------------------------ R0-2：目标根数自检 ------------------------ */

const syncLoading = ref(false)
const syncResult = ref<SyncTleResult | null>(null)
const syncError = ref('')

async function runSyncTle() {
  if (syncLoading.value) return
  syncLoading.value = true
  syncError.value = ''
  try {
    syncResult.value = await syncTle()
    await loadManaged()
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncLoading.value = false
  }
}

/* --------------------- R2-8：数据源（一单一源） --------------------- */

const primarySource = ref<'tle' | 'ephem' | 'aoe'>('tle')
const secondarySource = ref<'catalog' | 'cdm' | 'aoe'>('catalog')

/** 当前主星范围内已绑定星历的目标数（决定「精密星历」选项是否可选） */
const ephemBoundCount = computed(() => {
  const pool =
    useSubset.value && pickedNorads.value.length
      ? managed.value.filter((o) => pickedNorads.value.includes(o.norad_id))
      : managed.value
  return pool.filter((o) => Number(o.bound_ephemerides ?? 0) > 0).length
})

watch(ephemBoundCount, (n) => {
  if (!n && primarySource.value === 'ephem') primarySource.value = 'tle'
})

function sourceLabel(j: ScreenJob): string {
  const p =
    j.primary_source === 'ephem' ? t('scr.tagEphem') : j.primary_source === 'aoe' ? t('scr.tagAoe') : t('scr.tagTle')
  const s =
    j.secondary_source === 'cdm'
      ? t('scr.tagCdm')
      : j.secondary_source === 'aoe'
        ? t('scr.tagAoe')
        : t('scr.tagCatalog')
  return `${p} × ${s}`
}

async function submit() {
  if (submitting.value) return
  submitError.value = ''
  const w = Math.min(168, Math.max(1, Math.round(Number(windowH.value) || 72)))
  const m = Math.min(50, Math.max(0.5, Number(missMaxKm.value) || 10))
  const h = Math.min(1000, Math.max(1, Number(hbrM.value) || 15))
  const subset = useSubset.value ? pickedNorads.value.slice() : undefined
  if (subset && !subset.length) {
    submitError.value = t('scr.pickNone')
    return
  }
  if (subset && subset.length > MAX_PRIMARY) {
    submitError.value = t('scr.pickHint', { n: MAX_PRIMARY })
    return
  }
  if (primarySource.value === 'ephem' && !ephemBoundCount.value) {
    submitError.value = t('scr.ephemNone')
    return
  }
  submitting.value = true
  try {
    const payloadBase = {
      ...(paramsSource.value === 'default'
        ? { windowH: w, missMaxKm: m, hbrM: h }
        : { paramsSource: paramsSource.value }),
      primaryNorads: subset,
      primarySource: primarySource.value,
      secondarySource: secondarySource.value
    }
    const job = await createScreen(payloadBase)
    await loadJobs()
    selectJob(job.id)
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ R0-3：取消 ------------------------------ */

const cancellingId = ref<number | null>(null)
const cancelError = ref('')

function canCancel(j: ScreenJob): boolean {
  return (j.status === 'queued' || j.status === 'running') && !j.cancel_requested
}

async function askCancel(j: ScreenJob) {
  if (cancellingId.value !== null) return
  if (!window.confirm(t('scr.cancelConfirm'))) return
  cancellingId.value = j.id
  cancelError.value = ''
  try {
    await cancelScreen(j.id)
    await loadJobs()
    if (selectedId.value === j.id) await selectJob(j.id)
  } catch (e) {
    cancelError.value = e instanceof Error ? e.message : String(e)
  } finally {
    cancellingId.value = null
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

function routeJobId(): number | null {
  const raw = route.params.id
  const s = Array.isArray(raw) ? raw[0] : raw
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function selectJob(id: number) {
  selectedId.value = id
  if (routeJobId() !== id) {
    await router.replace({ name: 'screens', params: { id: String(id) } })
  }
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
    await Promise.all([loadJobs(), loadManaged()])
    void prefillFromOrgDefaults()
    const fromRoute = routeJobId()
    if (fromRoute) await selectJob(fromRoute)
    else if (!selectedId.value && jobs.value.length) await selectJob(jobs.value[0].id)
  } finally {
    loading.value = false
  }
}

/**
 * R2-14：用组织 CA 默认预填筛查参数（窗长 / HBR），与设置页保持同一口径。
 * 本次任务仍可手动覆盖；组织未设默认或无组织权限时保留系统建议值。
 */
async function prefillFromOrgDefaults() {
  try {
    const { defaults } = await getCaDefaults()
    if (!defaults) return
    windowH.value = defaults.window_h
    if (Number(defaults.hbr_m) > 0) hbrM.value = Number(defaults.hbr_m)
  } catch {
    // 未登录 / 平台账号无组织：保持系统建议值
  }
}

/* 第 4 项：个人参数组可用性（未配置的组禁用选项） */
const paramsSource = ref<'default' | 'mine1' | 'mine2' | 'target'>('default')
const slotReady = ref<Record<number, boolean>>({ 1: false, 2: false })

async function loadProfiles() {
  try {
    const r = await getCaProfiles()
    slotReady.value = {
      1: !!r.mine.find((x) => x.slot === 1)?.params,
      2: !!r.mine.find((x) => x.slot === 2)?.params
    }
  } catch {
    /* 未登录 / 无组织时只保留默认参数 */
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

watch(
  () => route.params.id,
  (id) => {
    const n = Number(Array.isArray(id) ? id[0] : id)
    if (Number.isInteger(n) && n > 0 && n !== selectedId.value) void selectJob(n)
  }
)

onMounted(() => {
  void loadAll()
  void loadProfiles()
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
  failed: 'failed',
  cancelled: 'cancelled'
}
function statusLabel(s: ScreenJobStatus): MessageKey {
  return `scr.status.${s}` as MessageKey
}
function pct(j: ScreenJob): number {
  const n = Number(j.progress_pct)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
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
                <div v-if="isPlatform" class="pick-hint">{{ t('scr.platformReadonly') }}</div>
              </div>
            </header>
            <div class="form">
              <label class="field">
                <span class="lbl">参数来源</span>
                <select v-model="paramsSource">
                  <option value="default">单位默认</option>
                  <option value="mine1" :disabled="!slotReady[1]">我的参数组 1{{ slotReady[1] ? '' : '（未配置）' }}</option>
                  <option value="mine2" :disabled="!slotReady[2]">我的参数组 2{{ slotReady[2] ? '' : '（未配置）' }}</option>
                  <option value="target">目标自定义参数（业主）</option>
                </select>
              </label>
              <div v-if="paramsSource !== 'default'" class="pick-hint">
                {{
                  paramsSource === 'target'
                    ? '使用业主为该目标保存的自定义参数；仅支持单一主星任务。'
                    : '使用你在设置页保存的自定义参数组，本页窗长/筛查距离/HBR 输入将不再生效。'
                }}
              </div>
              <label class="field">
                <span class="lbl">{{ t('scr.window') }}</span>
                <OspNumberInput v-model="windowH" min="1" max="168" step="1" :disabled="paramsSource !== 'default'" />
              </label>
              <label class="field">
                <span class="lbl">{{ t('scr.missMax') }}</span>
                <OspNumberInput v-model="missMaxKm" min="0.5" max="50" step="0.5" :disabled="paramsSource !== 'default'" />
              </label>
              <label class="field">
                <span class="lbl">{{ t('scr.hbr') }}</span>
                <OspNumberInput v-model="hbrM" min="1" max="1000" step="1" :disabled="paramsSource !== 'default'" />
              </label>

              <!-- R2-8：数据源（一单一源；主星 tle|ephem|aoe，副星 catalog|cdm|aoe） -->
              <label class="field">
                <span class="lbl">{{ t('scr.primarySource') }}</span>
                <select v-model="primarySource">
                  <option value="tle">{{ t('scr.srcTle') }}</option>
                  <option value="ephem" :disabled="!ephemBoundCount">{{ t('scr.srcEphem') }}</option>
                  <option value="aoe">{{ t('scr.srcAoe') }}</option>
                </select>
              </label>
              <div v-if="primarySource === 'ephem'" class="pick-hint">{{ t('scr.ephemHint') }}</div>
              <div v-if="primarySource === 'aoe'" class="pick-hint">{{ t('scr.aoePrimaryHint') }}</div>
              <label class="field">
                <span class="lbl">{{ t('scr.secondarySource') }}</span>
                <select v-model="secondarySource">
                  <option value="catalog">{{ t('scr.srcCatalog') }}</option>
                  <option value="cdm">{{ t('scr.srcCdm') }}</option>
                  <option value="aoe">{{ t('scr.srcAoeCatalog') }}</option>
                </select>
              </label>
              <div v-if="secondarySource === 'cdm'" class="pick-hint">{{ t('scr.cdmHint') }}</div>
              <div v-if="secondarySource === 'aoe'" class="pick-hint">{{ t('scr.aoeSecondaryHint') }}</div>

              <!-- R0-2：主星范围（目标超过单任务上限时分批选择） -->
              <div class="picker">
                <div class="picker-head">
                  <span class="lbl">{{ t('scr.pickPrimary') }}</span>
                  <label v-if="managed.length" class="switch">
                    <input v-model="useSubset" type="checkbox" />
                    <span>{{ t('scr.pickSubset') }}</span>
                  </label>
                </div>
                <template v-if="managed.length">
                  <div class="picker-bar">
                    <span v-if="useSubset" class="muted">
                      {{ t('scr.pickCount', { n: pickedNorads.length, total: managed.length }) }}
                    </span>
                    <span v-else class="muted">{{ t('scr.pickAll') }} · {{ managed.length }}</span>
                    <template v-if="useSubset">
                      <button type="button" class="mini" @click="pickAll">{{ t('scr.pickAllBtn') }}</button>
                      <button type="button" class="mini" @click="pickClear">{{ t('scr.pickClearBtn') }}</button>
                      <button type="button" class="mini" @click="pickOpen = !pickOpen">
                        {{ pickOpen ? '−' : '+' }}
                      </button>
                    </template>
                  </div>
                  <div v-if="useSubset" class="pick-hint">{{ t('scr.pickHint', { n: MAX_PRIMARY }) }}</div>
                  <template v-if="useSubset && pickOpen">
                    <input
                      v-model="pickQuery"
                      class="pick-search"
                      type="text"
                      :placeholder="t('scr.pickSearch')"
                    />
                    <div class="pick-list">
                      <label v-for="o in managedFiltered" :key="o.id" class="pick-item">
                        <input
                          type="checkbox"
                          :checked="isPicked(o.norad_id)"
                          @change="togglePick(o.norad_id)"
                        />
                        <span class="pick-name">{{ o.name }}</span>
                        <span class="pick-norad">{{ o.norad_id }}</span>
                      </label>
                      <div v-if="!managedFiltered.length" class="empty">{{ t('scr.pickNoMatch') }}</div>
                    </div>
                  </template>
                </template>
                <div v-else-if="managedLoaded" class="pick-hint">{{ t('scr.noManaged') }}</div>
              </div>

              <button type="button" class="primary" :disabled="submitting || isPlatform || !isVip" @click="submit">
                {{ submitting ? t('scr.submitting') : t('scr.submit') }}
              </button>
              <div v-if="!isVip && !isPlatform" class="err">{{ t('scr.vipOnly') }}</div>
              <div v-if="submitError" class="err">{{ submitError }}</div>

              <!-- R0-2：根数自检（系统池 TLE 可用性与龄期） -->
              <div class="sync">
                <button type="button" class="ghost" :disabled="syncLoading" @click="runSyncTle">
                  {{ syncLoading ? t('scr.syncing') : t('scr.syncTle') }}
                </button>
                <span
                  v-if="syncResult"
                  class="sync-sum"
                  :class="{ warn: syncResult.missing > 0 || syncResult.stale_7d > 0 }"
                >
                  <template v-if="syncResult.total">
                    {{
                      t('scr.syncTleSummary', {
                        total: syncResult.total,
                        withTle: syncResult.with_tle,
                        missing: syncResult.missing,
                        stale: syncResult.stale_7d
                      })
                    }}
                  </template>
                  <template v-else>{{ t('scr.syncTleEmpty') }}</template>
                </span>
                <span v-if="syncError" class="err">{{ syncError }}</span>
              </div>
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
              <div v-if="cancelError" class="err cancel-err">{{ cancelError }}</div>
              <div
                v-for="j in jobs"
                :key="j.id"
                class="job"
                :class="{ on: selectedId === j.id }"
                role="button"
                tabindex="0"
                @click="selectJob(j.id)"
                @keydown.enter="selectJob(j.id)"
              >
                <div class="job-top">
                  <span class="jid">#{{ j.id }}</span>
                  <span class="state" :class="STATUS_CLASS[j.status]">{{ t(statusLabel(j.status)) }}</span>
                  <span class="when">{{ fmtWhen(j.queued_at) }}</span>
                  <button
                    v-if="canCancel(j) && !isPlatform"
                    type="button"
                    class="cancel"
                    :disabled="cancellingId === j.id"
                    @click.stop="askCancel(j)"
                  >
                    {{ cancellingId === j.id ? t('scr.cancelling') : t('scr.cancel') }}
                  </button>
                  <span v-else-if="j.cancel_requested" class="cancel-pending">{{ t('scr.cancelling') }}</span>
                </div>
                <div class="job-meta">
                  <span>{{ t('scr.col.window') }} {{ j.window_h }}h</span>
                  <span>{{ t('scr.col.miss') }} {{ j.miss_max_km }}</span>
                  <span>HBR {{ j.hbr_m }}m</span>
                  <span class="src-tag">{{ sourceLabel(j) }}</span>
                  <span>{{ t('scr.col.events') }} {{ j.n_events }}</span>
                  <span v-if="j.status !== 'queued' && j.status !== 'cancelled'">
                    {{ t('scr.col.primary') }} {{ j.n_primary }} · {{ t('scr.col.secondary') }}
                    {{ j.n_secondary }}
                  </span>
                  <span v-if="j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'">
                    {{ fmtDur(j.duration_ms) }}
                  </span>
                </div>
                <div v-if="j.status === 'running'" class="job-progress">
                  <div class="bar"><i :style="{ width: `${pct(j)}%` }"></i></div>
                  <div class="prog-note">
                    <span>{{ j.progress_note || t('scr.progress') }}</span>
                    <span>{{ pct(j) }}%</span>
                  </div>
                </div>
                <div v-if="j.error_message" class="job-err">{{ j.error_message }}</div>
              </div>
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
.field .osp-num {
  font-size: 12px;
  font-family: var(--mono);
  align-self: start;
  min-width: 90px;
}
.field .osp-num:focus-within { border-color: var(--accent); }
.field select {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
}
.field select:focus { border-color: var(--accent); }
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

/* 主星分批选择（R0-2） */
.picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.picker-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.switch { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-muted); cursor: pointer; }
.picker-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.muted { font-size: 10px; color: var(--text-dim); }
.mini {
  appearance: none;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  cursor: pointer;
}
.mini:hover { color: var(--accent-strong); border-color: var(--accent); }
.pick-hint { font-size: 10px; color: var(--text-dim); line-height: 1.4; }
.pick-search {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 11px;
  outline: none;
}
.pick-search:focus { border-color: var(--accent); }
.pick-list {
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}
.pick-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
}
.pick-item:hover { background: var(--bg-panel-2); }
.pick-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick-norad { font-family: var(--mono); font-size: 10px; color: var(--text-dim); }
.sync { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sync-sum { font-size: 10px; color: var(--text-dim); line-height: 1.4; }
.sync-sum.warn { color: var(--warn); }

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
.state.cancelled { color: var(--text-dim); border-style: dashed; }
.cancel {
  appearance: none;
  border: 1px solid rgba(196, 91, 91, 0.45);
  background: transparent;
  color: var(--danger);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 9px;
  cursor: pointer;
}
.cancel:hover { background: rgba(196, 91, 91, 0.12); }
.cancel:disabled { opacity: 0.5; cursor: default; }
.cancel-pending { font-size: 9px; color: var(--warn); }
.cancel-err { padding: 4px 8px; }
.job-progress { margin-top: 6px; }
.job-progress .bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  overflow: hidden;
}
.job-progress .bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.4s ease;
}
.prog-note {
  margin-top: 3px;
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.job-meta {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.src-tag {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--accent);
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
