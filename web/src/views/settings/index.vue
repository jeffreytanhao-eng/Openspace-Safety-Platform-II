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

      <!-- 数据凭证（C2）：灰显占位 -->
      <section class="panel">
        <header class="panel-h">
          <div>
            <div class="h-title">{{ t('ca.credTitle') }}</div>
            <div class="h-sub">{{ t('ca.credSub') }}</div>
          </div>
          <span class="ro-tag">{{ t('ca.comingSoon') }}</span>
        </header>
        <div class="cred-place">
          <div class="cred-row"><span>Space-Track</span><span class="dim">{{ t('ca.comingSoon') }}</span></div>
          <div class="cred-row"><span>AOE</span><span class="dim">{{ t('ca.comingSoon') }}</span></div>
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

.cred-place { padding: 8px 14px 12px; display: flex; flex-direction: column; gap: 6px; }
.cred-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.dim { color: var(--text-dim); font-size: 10px; }
</style>
