<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAuthStore } from '@/stores/auth'
import { AuthError } from '@/api/auth'
import {
  getCaDefaults,
  putCaDefaults,
  type CaDefaults,
  type CaSuggestion,
  type HbrMode,
  type CovMode,
  type Propagator
} from '@/api/ca'
import {
  listCredentials,
  saveCredential,
  deleteCredential,
  testCredential,
  fetchNow,
  listBatches,
  type CredStatus,
  type OrgBatchRow,
  type CredProvider
} from '@/api/cred'

const { t, isZh } = useI18n()
const auth = useAuthStore()

/** 强类型 i18n 键（动态键统一走此断言） */
type I18nKey = Parameters<ReturnType<typeof useI18n>['t']>[0]

const loading = ref(true)
const needOrg = ref(false)
const loadError = ref('')

/* ------------------------- 表单状态（可编辑列） ------------------------- */

const form = reactive({
  hbr_mode: 'single' as HbrMode,
  hbr_m: 15,
  hbr_a_m: 15,
  hbr_b_m: 5,
  accepted_pc: 1e-4,
  accepted_miss_km: 1,
  screen_distance_km: 10,
  covariance_mode: 'tle-age' as CovMode,
  propagator: 'sgp4' as Propagator,
  window_h: 72,
  step_s: 30,
  methods: { foster: true, chan: true, alfano: false } as Record<'foster' | 'chan' | 'alfano', boolean>
})

/** 已设置值列（组织默认；未设置 → null，显示「未设置（用系统建议值）」） */
const saved = ref<CaDefaults | null>(null)
const suggestions = ref<CaSuggestion[]>([])
const canEdit = computed(() => auth.user?.role === 'org_admin' || auth.user?.role === 'platform_super_admin')
const dirty = ref(false)

function applyDefaults(d: CaDefaults | null): void {
  saved.value = d
  dirty.value = false
  if (!d) return
  form.hbr_mode = d.hbr_mode
  form.hbr_m = d.hbr_m
  form.hbr_a_m = d.hbr_a_m ?? 15
  form.hbr_b_m = d.hbr_b_m ?? 5
  form.accepted_pc = d.accepted_pc
  form.accepted_miss_km = d.accepted_miss_km
  form.screen_distance_km = d.screen_distance_km
  form.covariance_mode = d.covariance_mode
  form.propagator = d.propagator
  form.window_h = d.window_h
  form.step_s = d.step_s
  const list = d.pc_methods.split(',').map((s) => s.trim())
  form.methods.foster = list.includes('foster')
  form.methods.chan = list.includes('chan')
  form.methods.alfano = list.includes('alfano')
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const resp = await getCaDefaults()
    suggestions.value = resp.suggestions ?? []
    applyDefaults(resp.defaults)
    needOrg.value = false
    void loadCred() // C2: 凭据区随页面加载（失败不影响 CA 面板）
  } catch (e) {
    if (e instanceof AuthError && (e.httpStatus === 401 || e.httpStatus === 403)) needOrg.value = true
    else loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

/* ------------------------- 保存 ------------------------- */

const saving = ref(false)
const saveMsg = ref('')
const saveError = ref('')

function methodsStr(): string {
  const list: string[] = []
  if (form.methods.foster) list.push('foster')
  if (form.methods.chan) list.push('chan')
  if (form.methods.alfano) list.push('alfano')
  return list.join(',')
}

async function save(): Promise<void> {
  if (!canEdit.value || saving.value) return
  if (!methodsStr()) {
    saveError.value = t('ca.err.noMethod')
    return
  }
  saving.value = true
  saveError.value = ''
  saveMsg.value = ''
  try {
    const resp = await putCaDefaults({
      hbr_mode: form.hbr_mode,
      hbr_m: form.hbr_m,
      hbr_a_m: form.hbr_mode === 'both' ? form.hbr_a_m : null,
      hbr_b_m: form.hbr_mode === 'both' ? form.hbr_b_m : null,
      accepted_pc: form.accepted_pc,
      accepted_miss_km: form.accepted_miss_km,
      screen_distance_km: form.screen_distance_km,
      covariance_mode: form.covariance_mode,
      propagator: form.propagator,
      window_h: form.window_h,
      step_s: form.step_s,
      pc_methods: methodsStr()
    })
    applyDefaults(resp.defaults)
    saveMsg.value = t('ca.saved')
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

/* ------------------------- 建议值映射 ------------------------- */

function suggestionOf(field: string): CaSuggestion | null {
  return suggestions.value.find((s) => s.field === field) ?? null
}
function sugValue(field: string): string {
  const s = suggestionOf(field)
  if (!s) return '—'
  if (field === 'pc_methods') return String(s.value).split(',').map((m) => t(`ca.method.${m}` as I18nKey)).join(' + ')
  return String(s.value)
}
function sugReason(field: string): string {
  const s = suggestionOf(field)
  if (!s) return ''
  return isZh.value ? s.reason.zh : s.reason.en
}
function savedOrDash(get: () => number | string | null): string {
  if (!saved.value) return t('ca.notSet')
  const v = get()
  return v === null || v === undefined || v === '' ? '—' : String(v)
}
function savedHbr(): string {
  if (!saved.value) return t('ca.notSet')
  const d = saved.value
  if (d.hbr_mode === 'both') {
    return `${d.hbr_a_m ?? '—'} + ${d.hbr_b_m ?? '—'} m (A/B)`
  }
  return `${d.hbr_m} m`
}
function savedMethods(): string {
  if (!saved.value) return t('ca.notSet')
  return saved.value.pc_methods.split(',').map((m) => t(`ca.method.${m.trim()}` as I18nKey)).join(' + ')
}
function savedUpdated(): string {
  return saved.value ? saved.value.updated_at.replace('T', ' ').slice(0, 16) : ''
}
function onEdit(): void {
  dirty.value = true
  saveMsg.value = ''
}

/* ------------------------- 数据凭证（C2） ------------------------- */

const PROVIDERS: CredProvider[] = ['spacetrack', 'aoe']

const credItems = ref<CredStatus[]>([])
const credBatches = ref<OrgBatchRow[]>([])
const credBatchesLoaded = ref(false)
const credEditMode = reactive<Record<CredProvider, boolean>>({ spacetrack: false, aoe: false })
const credForm = reactive({
  spacetrack: { username: '', password: '' },
  aoe: { token: '' }
})
const credBusy = reactive<Record<string, boolean>>({})
const credMsg = reactive<Record<CredProvider, string>>({ spacetrack: '', aoe: '' })
const credErr = reactive<Record<CredProvider, string>>({ spacetrack: '', aoe: '' })

function credOf(p: CredProvider): CredStatus | null {
  return credItems.value.find((c) => c.provider === p) ?? null
}
function isBusy(p: CredProvider, action: string): boolean {
  return !!credBusy[`${p}:${action}`]
}
function setBusy(p: CredProvider, action: string, v: boolean): void {
  credBusy[`${p}:${action}`] = v
}
function clearCredHint(p: CredProvider): void {
  credMsg[p] = ''
  credErr[p] = ''
}
function failOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function loadCred(): Promise<void> {
  try {
    const resp = await listCredentials()
    credItems.value = resp.items
    void loadBatches()
  } catch {
    /* 凭据区加载失败不影响 CA 面板 */
  }
}

async function loadBatches(): Promise<void> {
  try {
    const resp = await listBatches(20)
    credBatches.value = resp.batches
    credBatchesLoaded.value = true
  } catch {
    /* 批次历史加载失败不阻断 */
  }
}

async function onSaveCred(p: CredProvider): Promise<void> {
  if (isBusy(p, 'save')) return
  clearCredHint(p)
  const st = credForm.spacetrack
  const token = credForm.aoe.token.trim()
  if ((p === 'spacetrack' && (!st.username.trim() || !st.password)) || (p === 'aoe' && !token)) {
    credErr[p] = t('cred.err.missing')
    return
  }
  setBusy(p, 'save', true)
  try {
    if (p === 'spacetrack') await saveCredential(p, { username: st.username.trim(), password: st.password })
    else await saveCredential(p, { token })
    st.username = ''
    st.password = ''
    credForm.aoe.token = ''
    credEditMode[p] = false
    credMsg[p] = t('cred.saved')
    await loadCred()
  } catch (e) {
    credErr[p] = failOf(e)
  } finally {
    setBusy(p, 'save', false)
  }
}

async function onTestCred(p: CredProvider): Promise<void> {
  if (isBusy(p, 'test')) return
  clearCredHint(p)
  setBusy(p, 'test', true)
  try {
    const r = await testCredential(p)
    if (r.ok) credMsg[p] = t('cred.testOk', { ms: r.latency_ms ?? 0 })
    else credErr[p] = `${t('cred.testFail')}: ${r.error ?? ''}`
    await loadCred() // 刷新 last_ok_at / last_error
  } catch (e) {
    credErr[p] = failOf(e)
  } finally {
    setBusy(p, 'test', false)
  }
}

async function onFetchCred(p: CredProvider, kind?: 'gp' | 'cdm'): Promise<void> {
  const action = `fetch:${kind ?? p}` // gp / cdm / aoe 分别计数
  if (isBusy(p, action)) return
  clearCredHint(p)
  setBusy(p, action, true)
  try {
    const r = await fetchNow(p, kind)
    credMsg[p] = t('cred.fetchDone', {
      total: r.total,
      inserted: r.inserted,
      skipped: r.skipped,
      scoped: r.scoped_targets
    })
    await loadCred()
  } catch (e) {
    credErr[p] = failOf(e)
    await loadBatches() // 失败批次已留痕，刷新审计表
  } finally {
    setBusy(p, action, false)
  }
}

async function onDeleteCred(p: CredProvider): Promise<void> {
  if (isBusy(p, 'del')) return
  if (!window.confirm(t('cred.clearConfirm'))) return
  clearCredHint(p)
  setBusy(p, 'del', true)
  try {
    await deleteCredential(p)
    credEditMode[p] = false
    credMsg[p] = t('cred.deleted')
    await loadCred()
  } catch (e) {
    credErr[p] = failOf(e)
  } finally {
    setBusy(p, 'del', false)
  }
}

function fmtTime(s: string | null): string {
  return s ? s.replace('T', ' ').slice(0, 16) : '—'
}
function fmtDur(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}
</script>

<template>
  <div class="settings">
    <!-- 平台/未登录：无组织，不可用 -->
    <section v-if="needOrg" class="panel hint">
      <p>{{ t('ca.needOrg') }}</p>
    </section>

    <section v-else-if="loadError && !suggestions.length" class="panel hint">
      <p>{{ t('ov.loadFail') }}：{{ loadError }}</p>
      <button type="button" class="ghost" @click="load">{{ t('ov.retry') }}</button>
    </section>

    <template v-else>
      <header class="page-h">
        <h1>{{ t('ca.title') }}</h1>
        <p>{{ t('ca.sub') }}</p>
      </header>

      <!-- CA 默认参数：三列（已设置 | 系统建议 | 可编辑） -->
      <section class="panel">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('ca.defaultsTitle') }}</div>
            <div class="h-sub">
              {{ t('ca.defaultsSub') }}
              <template v-if="savedUpdated()"> · {{ t('ca.updatedBy') }} {{ savedUpdated() }} ({{ saved?.updated_by }})</template>
            </div>
          </div>
          <button v-if="canEdit" type="button" class="primary" :disabled="saving || loading" @click="save">
            {{ saving ? t('ca.saving') : t('ca.save') }}
          </button>
          <span v-else class="ro-tag">{{ t('ca.readOnly') }}</span>
        </header>

        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>{{ t('ca.col.param') }}</th>
                <th>{{ t('ca.col.saved') }}</th>
                <th>{{ t('ca.col.suggest') }}</th>
                <th class="edit-col">{{ t('ca.col.edit') }}</th>
              </tr>
            </thead>
            <tbody>
              <!-- HBR 模式 -->
              <tr>
                <td>{{ t('ca.f.hbrMode') }}</td>
                <td class="mono">{{ saved ? (saved.hbr_mode === 'both' ? t('ca.both') : t('ca.single')) : t('ca.notSet') }}</td>
                <td>
                  <div class="sug">{{ t('ca.single') }}</div>
                  <div class="why">{{ sugReason('hbr_mode') }}</div>
                </td>
                <td class="edit-col">
                  <label class="radio"><input v-model="form.hbr_mode" type="radio" value="single" :disabled="!canEdit" @change="onEdit" /> {{ t('ca.single') }}</label>
                  <label class="radio"><input v-model="form.hbr_mode" type="radio" value="both" :disabled="!canEdit" @change="onEdit" /> {{ t('ca.both') }}</label>
                </td>
              </tr>
              <!-- HBR 值 -->
              <tr>
                <td>{{ t('ca.f.hbr') }}</td>
                <td class="mono">{{ savedHbr() }}</td>
                <td>
                  <div class="sug">{{ sugValue('hbr_m') }} m</div>
                  <div class="why">{{ sugReason('hbr_m') }}</div>
                </td>
                <td class="edit-col">
                  <template v-if="form.hbr_mode === 'single'">
                    <input v-model.number="form.hbr_m" type="number" min="1" max="1000" step="1" :disabled="!canEdit" @input="onEdit" /> m
                  </template>
                  <template v-else>
                    <input v-model.number="form.hbr_a_m" type="number" min="0.1" max="1000" step="0.1" :disabled="!canEdit" @input="onEdit" /> (A)
                    <input v-model.number="form.hbr_b_m" type="number" min="0.1" max="1000" step="0.1" :disabled="!canEdit" @input="onEdit" /> (B) m
                    <span class="why">{{ t('ca.hbrCombine') }}</span>
                  </template>
                </td>
              </tr>
              <!-- 接受 Pc -->
              <tr>
                <td>{{ t('ca.f.acceptedPc') }}</td>
                <td class="mono">{{ savedOrDash(() => saved?.accepted_pc?.toExponential(0) ?? null) }}</td>
                <td>
                  <div class="sug">{{ sugValue('accepted_pc') }}</div>
                  <div class="why">{{ sugReason('accepted_pc') }}</div>
                </td>
                <td class="edit-col">
                  <input v-model.number="form.accepted_pc" type="number" min="1e-9" max="1" step="1e-5" :disabled="!canEdit" @input="onEdit" />
                </td>
              </tr>
              <!-- 接受最小脱靶 -->
              <tr>
                <td>{{ t('ca.f.acceptedMiss') }}</td>
                <td class="mono">{{ savedOrDash(() => (saved ? `${saved.accepted_miss_km} km` : null)) }}</td>
                <td>
                  <div class="sug">{{ sugValue('accepted_miss_km') }} km</div>
                  <div class="why">{{ sugReason('accepted_miss_km') }}</div>
                </td>
                <td class="edit-col">
                  <input v-model.number="form.accepted_miss_km" type="number" min="0.01" max="100" step="0.1" :disabled="!canEdit" @input="onEdit" /> km
                </td>
              </tr>
              <!-- 筛查距离阈值 -->
              <tr>
                <td>{{ t('ca.f.screenDist') }}</td>
                <td class="mono">{{ savedOrDash(() => (saved ? `${saved.screen_distance_km} km` : null)) }}</td>
                <td>
                  <div class="sug">{{ sugValue('screen_distance_km') }} km</div>
                  <div class="why">{{ sugReason('screen_distance_km') }}</div>
                </td>
                <td class="edit-col">
                  <input v-model.number="form.screen_distance_km" type="number" min="0.5" max="100" step="0.5" :disabled="!canEdit" @input="onEdit" /> km
                </td>
              </tr>
              <!-- 协方差模式 -->
              <tr>
                <td>{{ t('ca.f.covMode') }}</td>
                <td class="mono">{{ saved ? (saved.covariance_mode === 'cdm' ? 'CDM' : t('ca.covTleAge')) : t('ca.notSet') }}</td>
                <td>
                  <div class="sug">{{ t('ca.covTleAge') }}</div>
                  <div class="why">{{ sugReason('covariance_mode') }}</div>
                </td>
                <td class="edit-col">
                  <select v-model="form.covariance_mode" :disabled="!canEdit" @change="onEdit">
                    <option value="tle-age">{{ t('ca.covTleAge') }}</option>
                    <option value="cdm">CDM</option>
                  </select>
                </td>
              </tr>
              <!-- 传播器 -->
              <tr>
                <td>{{ t('ca.f.propagator') }}</td>
                <td class="mono">{{ saved ? saved.propagator.toUpperCase() : t('ca.notSet') }}</td>
                <td>
                  <div class="sug">SGP4</div>
                  <div class="why">{{ sugReason('propagator') }}</div>
                </td>
                <td class="edit-col">
                  <select v-model="form.propagator" :disabled="!canEdit" @change="onEdit">
                    <option value="sgp4">SGP4</option>
                    <option value="numeric">{{ t('ca.propNumeric') }}</option>
                  </select>
                </td>
              </tr>
              <!-- 时间窗 / 步长 -->
              <tr>
                <td>{{ t('ca.f.windowStep') }}</td>
                <td class="mono">{{ saved ? `${saved.window_h} h / ${saved.step_s} s` : t('ca.notSet') }}</td>
                <td>
                  <div class="sug">{{ sugValue('window_h') }} h / {{ sugValue('step_s') }} s</div>
                  <div class="why">{{ sugReason('window_h') }}；{{ sugReason('step_s') }}</div>
                </td>
                <td class="edit-col">
                  <input v-model.number="form.window_h" type="number" min="1" max="168" step="1" :disabled="!canEdit" @input="onEdit" /> h /
                  <input v-model.number="form.step_s" type="number" min="1" max="3600" step="1" :disabled="!canEdit" @input="onEdit" /> s
                </td>
              </tr>
              <!-- Pc 方法勾选 -->
              <tr>
                <td>{{ t('ca.f.methods') }}</td>
                <td class="mono">{{ savedMethods() }}</td>
                <td>
                  <div class="sug">{{ sugValue('pc_methods') }}</div>
                  <div class="why">{{ sugReason('pc_methods') }}</div>
                </td>
                <td class="edit-col">
                  <label class="radio"><input v-model="form.methods.foster" type="checkbox" :disabled="!canEdit" @change="onEdit" /> Foster</label>
                  <label class="radio"><input v-model="form.methods.chan" type="checkbox" :disabled="!canEdit" @change="onEdit" /> Chan</label>
                  <label class="radio"><input v-model="form.methods.alfano" type="checkbox" :disabled="!canEdit" @change="onEdit" /> Alfano</label>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="saveMsg" class="ok-msg">{{ saveMsg }}</p>
        <p v-if="saveError" class="err">{{ saveError }}</p>
        <p class="note">{{ t('ca.defaultsNote') }}</p>
      </section>

      <!-- 数据凭证（C2）：组织自配 Space-Track / AOE，服务端加密存储 -->
      <section class="panel">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('cred.title') }}</div>
            <div class="h-sub">{{ t('cred.sub') }}</div>
          </div>
          <span v-if="!canEdit" class="ro-tag">{{ t('ca.readOnly') }}</span>
        </header>

        <div class="cred-cards">
          <div v-for="p in PROVIDERS" :key="p" class="cred-card">
            <div class="cred-head">
              <div class="cred-name">
                <span class="pname">{{ p === 'spacetrack' ? 'Space-Track' : 'AOE (spacemapper)' }}</span>
                <span class="badge" :class="credOf(p)?.configured ? 'on' : 'off'">
                  {{ credOf(p)?.configured ? t('cred.configured') : t('cred.notConfigured') }}
                </span>
              </div>
              <div v-if="canEdit" class="cred-ops">
                <template v-if="!credEditMode[p]">
                  <button type="button" class="ghost" @click="credEditMode[p] = true; clearCredHint(p)">
                    {{ credOf(p)?.configured ? t('cred.replace') : t('cred.enter') }}
                  </button>
                  <button
                    type="button"
                    class="ghost"
                    :disabled="!credOf(p)?.configured || isBusy(p, 'test')"
                    @click="onTestCred(p)"
                  >
                    {{ isBusy(p, 'test') ? t('cred.testing') : t('cred.test') }}
                  </button>
                </template>
                <template v-else>
                  <button type="button" class="primary" :disabled="isBusy(p, 'save')" @click="onSaveCred(p)">
                    {{ isBusy(p, 'save') ? t('cred.saving') : t('cred.save') }}
                  </button>
                  <button type="button" class="ghost" @click="credEditMode[p] = false; clearCredHint(p)">
                    {{ t('cred.cancel') }}
                  </button>
                </template>
              </div>
            </div>

            <div class="cred-status">
              <span v-if="credOf(p)?.configured" class="mono">{{ t('cred.masked') }}: {{ credOf(p)?.masked || '******' }}</span>
              <span>{{ t('cred.lastOk') }}: {{ fmtTime(credOf(p)?.last_ok_at ?? null) }}</span>
              <span v-if="credOf(p)?.last_error" class="errline">{{ t('cred.lastError') }}: {{ credOf(p)?.last_error }}</span>
              <span v-if="credOf(p)?.updated_at" class="dim">
                {{ t('cred.updatedAt') }}: {{ fmtTime(credOf(p)?.updated_at ?? null) }}（{{ credOf(p)?.updated_by }}）
              </span>
            </div>

            <!-- 录入表单（org_admin） -->
            <div v-if="credEditMode[p] && canEdit" class="cred-form">
              <template v-if="p === 'spacetrack'">
                <label>
                  <span>{{ t('cred.username') }}</span>
                  <input v-model="credForm.spacetrack.username" type="text" autocomplete="off" spellcheck="false" @input="clearCredHint(p)" />
                </label>
                <label>
                  <span>{{ t('cred.password') }}</span>
                  <input v-model="credForm.spacetrack.password" type="password" autocomplete="new-password" @input="clearCredHint(p)" />
                </label>
              </template>
              <template v-else>
                <label>
                  <span>{{ t('cred.token') }}</span>
                  <input v-model="credForm.aoe.token" type="password" autocomplete="new-password" spellcheck="false" @input="clearCredHint(p)" />
                </label>
              </template>
            </div>

            <!-- 组织队列拉取（org_admin）：GP / CDM / AOE -->
            <div v-if="canEdit && !credEditMode[p]" class="cred-fetch">
              <template v-if="p === 'spacetrack'">
                <button
                  type="button"
                  class="ghost"
                  :disabled="!credOf(p)?.configured || isBusy(p, 'fetch:gp')"
                  @click="onFetchCred(p, 'gp')"
                >
                  {{ isBusy(p, 'fetch:gp') ? t('cred.fetching') : t('cred.fetchGp') }}
                </button>
                <button
                  type="button"
                  class="ghost"
                  :disabled="!credOf(p)?.configured || isBusy(p, 'fetch:cdm')"
                  @click="onFetchCred(p, 'cdm')"
                >
                  {{ isBusy(p, 'fetch:cdm') ? t('cred.fetching') : t('cred.fetchCdm') }}
                </button>
              </template>
              <button
                type="button"
                class="ghost"
                :disabled="!credOf(p)?.configured || isBusy(p, 'fetch:aoe')"
                @click="onFetchCred(p)"
              >
                {{ isBusy(p, 'fetch:aoe') ? t('cred.fetching') : t('cred.fetchAoe') }}
              </button>
              <button
                type="button"
                class="ghost danger"
                :disabled="!credOf(p)?.configured || isBusy(p, 'del')"
                @click="onDeleteCred(p)"
              >
                {{ t('cred.clear') }}
              </button>
            </div>

            <p v-if="credMsg[p]" class="ok-msg">{{ credMsg[p] }}</p>
            <p v-if="credErr[p]" class="err">{{ credErr[p] }}</p>
          </div>
        </div>

        <!-- 组织拉取批次（审计记条数） -->
        <div class="cred-batches">
          <div class="bt-title">{{ t('cred.batchesTitle') }}</div>
          <div class="tbl bt-tbl">
            <table>
              <thead>
                <tr>
                  <th>{{ t('cred.col.started') }}</th>
                  <th>{{ t('cred.col.provider') }}</th>
                  <th>{{ t('cred.col.kind') }}</th>
                  <th>{{ t('cred.col.status') }}</th>
                  <th>{{ t('cred.col.counts') }}</th>
                  <th>{{ t('cred.col.duration') }}</th>
                  <th>{{ t('cred.col.by') }}</th>
                  <th>{{ t('cred.col.error') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in credBatches" :key="b.id">
                  <td class="mono">{{ fmtTime(b.started_at) }}</td>
                  <td>{{ b.provider === 'spacetrack' ? 'Space-Track' : 'AOE' }}</td>
                  <td class="mono">{{ t(`cred.kind.${b.kind}` as I18nKey) }}</td>
                  <td>
                    <span class="badge" :class="b.status === 'success' ? 'on' : b.status === 'failed' ? 'bad' : 'off'">
                      {{ t(`cred.st.${b.status}` as I18nKey) }}
                    </span>
                  </td>
                  <td class="mono">{{ b.total }} / {{ b.inserted }} / {{ b.updated }} / {{ b.skipped }}</td>
                  <td class="mono">{{ fmtDur(b.duration_ms) }}</td>
                  <td class="dim">{{ b.triggered_by }}</td>
                  <td class="dim">{{ b.error_message || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="credBatchesLoaded && !credBatches.length" class="dim bt-empty">{{ t('cred.batchesEmpty') }}</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
.settings {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
}
.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.panel-h {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border);
}
.h-title { font-size: 13px; font-weight: 650; color: var(--text); }
.h-sub { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
.page-h {
  padding: 2px 0 0;
  h1 { margin: 0; font-size: 15px; font-weight: 650; }
  p { margin: 3px 0 0; font-size: 11px; color: var(--text-dim); }
}
.hint {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  font-size: 13px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
}
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
.primary {
  appearance: none;
  border: 1px solid rgba(74, 125, 154, 0.5);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.primary:hover { border-color: var(--accent); }
.primary:disabled { opacity: 0.55; cursor: default; }
.ro-tag {
  font-size: 10px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 6px;
  white-space: nowrap;
}

.tbl { overflow-x: auto; padding: 0 14px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th {
  text-align: left;
  padding: 9px 10px;
  color: var(--text-dim);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  color: var(--text-muted);
}
td:first-child { color: var(--text); font-weight: 600; white-space: nowrap; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.sug { font-family: var(--mono); color: var(--text); }
.why { margin-top: 2px; font-size: 10px; color: var(--text-dim); max-width: 260px; }
.edit-col { white-space: nowrap; }
.edit-col input[type='number'],
.edit-col select {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 11px;
  font-family: var(--mono);
  outline: none;
  width: 90px;
}
.edit-col input:focus, .edit-col select:focus { border-color: var(--accent); }
.edit-col input:disabled, .edit-col select:disabled { opacity: 0.6; }
.radio { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 11px; }
.numInput { width: 90px; }
.ok-msg { margin: 8px 14px 0; font-size: 11px; color: var(--ok, #63b463); }
.err { margin: 8px 14px 0; font-size: 11px; color: var(--danger); }
.note { margin: 8px 14px 12px; font-size: 10px; color: var(--text-dim); }

/* 数据凭证（C2） */
.cred-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 4px;
}
.cred-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cred-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.cred-name { display: flex; align-items: center; gap: 8px; }
.pname { font-size: 12px; font-weight: 650; color: var(--text); }
.badge {
  font-size: 10px;
  border-radius: 3px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.badge.on { color: var(--ok, #63b463); border-color: rgba(99, 180, 99, 0.4); }
.badge.off { color: var(--text-dim); }
.badge.bad { color: var(--danger); border-color: rgba(220, 90, 90, 0.4); }
.cred-ops { display: flex; gap: 6px; flex-wrap: wrap; }
.cred-status {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-muted);
}
.errline { color: var(--danger); }
.cred-form {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-dim);
  }
  input {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--bg-deep);
    color: var(--text);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 11px;
    font-family: var(--mono);
    outline: none;
    width: 220px;
  }
  input:focus { border-color: var(--accent); }
}
.cred-fetch { display: flex; gap: 6px; flex-wrap: wrap; }
.ghost.danger:hover { color: var(--danger); border-color: var(--danger); }
.cred-card .ok-msg,
.cred-card .err { margin: 0; }
.cred-batches {
  padding: 6px 14px 12px;
  .bt-title { font-size: 11px; color: var(--text-dim); margin: 4px 0 6px; }
  .bt-empty { font-size: 11px; margin: 4px 0 0; }
  .bt-tbl { padding: 0; }
  td, th { white-space: normal; }
}
.dim { color: var(--text-dim); font-size: 10px; }
</style>
