<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import {
  getEvent,
  getCdmRaw,
  pcCompare,
  type ConjunctionEvent,
  type CdmMember,
  type TleProfile,
  type EventLevel,
  type PcCompareResult,
  type PcAgreement,
  type PcMethod
} from '@/api/events'
import {
  getCaDefaults,
  recomputeEvent,
  listRecomputeRuns,
  type CaDefaults,
  type RecomputeResult,
  type PcRun,
  type HbrMode,
  type CovMode,
  type Propagator
} from '@/api/ca'
import { AuthError } from '@/api/auth'

const route = useRoute()
const router = useRouter()
const key = computed(() => decodeURIComponent(String(route.params.id || '')))

const loading = ref(true)
const error = ref('')
const event = ref<ConjunctionEvent | null>(null)
const cdms = ref<CdmMember[]>([])
const primary = ref<TleProfile | null>(null)
const secondary = ref<TleProfile | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await getEvent(key.value)
    event.value = resp.event
    cdms.value = resp.cdms ?? []
    primary.value = resp.primary
    secondary.value = resp.secondary
    void runCompare() // 详情就绪后自动比对（onMounted 时 event 尚为 null，不能挂在那里）
    void loadCaContext() // F1：预填组织默认参数 + 拉 run 历史（未登录回落系统缺省）
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    event.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/** Pc 多算法比对（E3）：同源输入由服务端统一 TLE 传播，官方 Pc 仅作对照行 */
type I18nKey = Parameters<ReturnType<typeof useI18n>['t']>[0]
const cmpLoading = ref(false)
const cmpError = ref('')
const cmp = ref<PcCompareResult | null>(null)
const methodKeys: Record<PcMethod, I18nKey> = {
  official: 'pc.cmp.m.official',
  foster: 'pc.cmp.m.foster',
  chan: 'pc.cmp.m.chan',
  alfano: 'pc.cmp.m.alfano'
}
const agreeKeys: Record<PcAgreement, I18nKey> = {
  green: 'pc.cmp.agree.green',
  yellow: 'pc.cmp.agree.yellow',
  red: 'pc.cmp.agree.red'
}
function fmtMs(ms: number): string {
  return ms > 0 && ms < 0.01 ? '<0.01' : ms.toFixed(2)
}
async function runCompare(): Promise<void> {
  if (!event.value) return
  cmpLoading.value = true
  cmpError.value = ''
  try {
    // HBR 取成员 CDM 最新提供的值（缺省由服务端按 15m 兜底）；
    // 官方 Pc / miss / relSpeed 用事件聚合口径作对照行
    const hbr = [...cdms.value].reverse().find((c) => c.hard_body_radius_m !== null)?.hard_body_radius_m ?? undefined
    cmp.value = await pcCompare({
      noradA: event.value.noradA,
      noradB: event.value.noradB,
      tcaMs: new Date(event.value.tca).getTime(),
      hbrM: hbr ?? undefined,
      officialPc: event.value.pc ?? undefined,
      officialMissKm: event.value.missKm ?? undefined,
      officialRelSpeedKms: event.value.relSpeedKmS ?? undefined
    })
  } catch (e) {
    cmpError.value = e instanceof Error ? e.message : String(e)
    cmp.value = null
  } finally {
    cmpLoading.value = false
  }
}

const levelKeys: Record<EventLevel, Parameters<ReturnType<typeof useI18n>['t']>[0]> = {
  red: 'conj.high',
  orange: 'conj.warn',
  yellow: 'conj.watch',
  low: 'conj.low'
}
function levelLabel(lv: EventLevel): string {
  return t(levelKeys[lv])
}
function srcLabel(s: string): string {
  return s === 'customer' ? t('conj.src.customer') : t('conj.src.system')
}
function fmtPc(pc: number | null): string {
  if (pc === null) return '—'
  if (pc === 0) return '0'
  return pc.toExponential(2)
}
function fmtTca(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}
function num(v: number | null, digits = 2, suffix = ''): string {
  return v === null ? '—' : `${v.toFixed(digits)}${suffix}`
}

/** 深链：把交会对与 TCA 时刻带给态势页（E4 消费定位与高亮） */
const situationLink = computed(() => {
  if (!event.value) return '/situation'
  const e = event.value
  return `/situation?conj=${e.noradA}-${e.noradB}&tca=${new Date(e.tca).getTime()}`
})

/** CDM 原文弹层 */
const rawOpen = ref(false)
const rawText = ref('')
const rawTitle = ref('')
const rawLoading = ref(false)
async function showRaw(c: CdmMember): Promise<void> {
  rawTitle.value = c.cdm_id ? `CDM ${c.cdm_id}` : `CDM #${c.id}`
  rawOpen.value = true
  rawLoading.value = true
  rawText.value = ''
  try {
    const r = await getCdmRaw(key.value, c.id)
    // 后端存的是 JSON 包装（format + text/data），展示内部原文更直观
    try {
      const parsed = JSON.parse(r.raw) as { format?: string; text?: string; data?: unknown }
      rawText.value = parsed.text ?? JSON.stringify(parsed.data ?? parsed, null, 2)
    } catch {
      rawText.value = r.raw
    }
  } catch (e) {
    rawText.value = e instanceof Error ? e.message : String(e)
  } finally {
    rawLoading.value = false
  }
}

/* ------------------- 碰撞参数与重算（F1）：仅本次编辑 + run 对比 ------------------- */

interface CaFormState {
  hbrMode: HbrMode
  hbrM: number
  hbrAM: number
  hbrBM: number
  acceptedPc: number
  acceptedMissKm: number
  screenDistanceKm: number
  covarianceMode: CovMode
  propagator: Propagator
  windowH: number
  stepS: number
  methods: { foster: boolean; chan: boolean; alfano: boolean }
}
const caForm = reactive<CaFormState>({
  hbrMode: 'single',
  hbrM: 15,
  hbrAM: 15,
  hbrBM: 5,
  acceptedPc: 1e-4,
  acceptedMissKm: 1,
  screenDistanceKm: 10,
  covarianceMode: 'tle-age',
  propagator: 'sgp4',
  windowH: 72,
  stepS: 30,
  methods: { foster: true, chan: true, alfano: false }
})
const caDefaults = ref<CaDefaults | null>(null)
const caOrgReady = ref(false) // 有组织账号（可重算）

function fillCaForm(d: CaDefaults | null): void {
  if (!d) return
  caForm.hbrMode = d.hbr_mode
  caForm.hbrM = d.hbr_m
  caForm.hbrAM = d.hbr_a_m ?? 15
  caForm.hbrBM = d.hbr_b_m ?? 5
  caForm.acceptedPc = d.accepted_pc
  caForm.acceptedMissKm = d.accepted_miss_km
  caForm.screenDistanceKm = d.screen_distance_km
  caForm.covarianceMode = d.covariance_mode
  caForm.propagator = d.propagator
  caForm.windowH = d.window_h
  caForm.stepS = d.step_s
  const list = d.pc_methods.split(',').map((s) => s.trim())
  caForm.methods.foster = list.includes('foster')
  caForm.methods.chan = list.includes('chan')
  caForm.methods.alfano = list.includes('alfano')
}

/** 重算结果（最新一次） */
const rcLoading = ref(false)
const rcError = ref('')
const rcResult = ref<RecomputeResult | null>(null)
const rcRuns = ref<PcRun[]>([])
const runsOpen = ref(false)

async function loadRuns(): Promise<void> {
  if (!caOrgReady.value) return
  try {
    rcRuns.value = (await listRecomputeRuns(key.value)).runs
  } catch {
    rcRuns.value = []
  }
}

async function loadCaContext(): Promise<void> {
  try {
    const resp = await getCaDefaults()
    caDefaults.value = resp.defaults
    fillCaForm(resp.defaults)
    caOrgReady.value = true
    void loadRuns()
  } catch (e) {
    if (e instanceof AuthError && e.httpStatus === 401) {
      // 未登录：保留系统缺省表单，提示登录后可重算
      caOrgReady.value = false
    } else {
      // 组织账号但非管理员等：默认值仍可读（403 = 平台账号），回落系统缺省
      caOrgReady.value = !(e instanceof AuthError && e.httpStatus === 403)
    }
  }
}

function caMethodsList(): Array<'foster' | 'chan' | 'alfano'> {
  const list: Array<'foster' | 'chan' | 'alfano'> = []
  if (caForm.methods.foster) list.push('foster')
  if (caForm.methods.chan) list.push('chan')
  if (caForm.methods.alfano) list.push('alfano')
  return list
}

/** 按此配置重算：生成新 run_id，刷新 run 历史 */
async function runRecompute(): Promise<void> {
  if (!event.value || rcLoading.value) return
  if (!caOrgReady.value) {
    rcError.value = t('ca.detailNeedLogin')
    return
  }
  if (!caMethodsList().length) {
    rcError.value = t('ca.err.noMethod')
    return
  }
  rcLoading.value = true
  rcError.value = ''
  try {
    // 参数解析顺序（服务端）：仅本次表单 > 组织默认 > 系统缺省；生效值回显在 run 参数摘要
    rcResult.value = await recomputeEvent(key.value, {
      hbrMode: caForm.hbrMode,
      hbrM: caForm.hbrM,
      hbrAM: caForm.hbrAM,
      hbrBM: caForm.hbrBM,
      acceptedPc: caForm.acceptedPc,
      acceptedMissKm: caForm.acceptedMissKm,
      screenDistanceKm: caForm.screenDistanceKm,
      covarianceMode: caForm.covarianceMode,
      propagator: caForm.propagator,
      windowH: caForm.windowH,
      stepS: caForm.stepS,
      methods: caMethodsList(),
      // 官方对照口径随请求固化进 run（后续回看时与当次 CDM 状态一致）
      officialPc: event.value.pc,
      officialMissKm: event.value.missKm,
      officialRelSpeedKms: event.value.relSpeedKmS
    })
    void loadRuns()
  } catch (e) {
    rcError.value = e instanceof Error ? e.message : String(e)
    rcResult.value = null
  } finally {
    rcLoading.value = false
  }
}

/** run 判定：Pc 与 miss 相对接受阈值的安全侧/危险侧 */
function runVerdict(
  params: RecomputeResult['run']['params'] | null,
  rows: PcRun['rows']
): { pcExceed: boolean | null; missBelow: boolean | null } {
  if (!params) return { pcExceed: null, missBelow: null }
  const pcs = rows.filter((r) => r.method !== 'official' && !r.disabled && r.pc !== null).map((r) => r.pc as number)
  const pcMax = pcs.length ? Math.max(...pcs) : null
  const miss = rows.find((r) => r.method !== 'official' && !r.disabled && r.missKm !== null)?.missKm ?? null
  return {
    pcExceed: pcMax === null ? null : pcMax >= params.accepted_pc,
    missBelow: miss === null ? null : miss < params.accepted_miss_km
  }
}
function caMethodLabel(m: PcMethod): string {
  return t(methodKeys[m])
}
/** run 内各重算方法的最大 Pc（官方对照行不参与） */
function maxMethodPc(run: PcRun): number | null {
  const pcs = run.rows
    .filter((r) => r.method !== 'official' && !r.disabled && r.pc !== null)
    .map((r) => r.pc as number)
  return pcs.length ? Math.max(...pcs) : null
}
function fmtWhen(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}
</script>

<template>
  <div v-if="loading" class="page"><section class="state">{{ t('obj.loading') }}</section></div>
  <div v-else-if="!event" class="page">
    <p class="state error">{{ error || t('conj.notFound') }}</p>
    <button type="button" class="btn" @click="router.push('/conjunctions')">{{ t('conj.backList') }}</button>
  </div>
  <div v-else class="page">
    <header class="head">
      <div>
        <button type="button" class="link" @click="router.push('/conjunctions')">{{ t('conj.back') }}</button>
        <h1>
          <span class="pill" :class="event.level">{{ levelLabel(event.level) }}</span>
          {{ event.nameA || `NORAD ${event.noradA}` }} × {{ event.nameB || `NORAD ${event.noradB}` }}
        </h1>
        <p>
          TCA {{ fmtTca(event.tca) }} UTC · {{ t('conj.col.cdm') }} {{ event.cdmCount }}
          <template v-if="event.tcaSpanH > 0"> · {{ t('conj.span') }} {{ event.tcaSpanH }}h</template>
          · {{ event.sources.map(srcLabel).join(' + ') }}
        </p>
      </div>
      <div class="actions">
        <a class="btn primary" :href="situationLink" @click.prevent="router.push(situationLink)">
          {{ t('conj.openSituation') }}
        </a>
      </div>
    </header>

    <section class="kpi">
      <div class="card">
        <div class="k">{{ t('conj.col.pc') }}</div>
        <div class="v mono">{{ fmtPc(event.pc) }}</div>
        <div class="sub">{{ event.pcSource ? srcLabel(event.pcSource) : '—' }}</div>
      </div>
      <div class="card"><div class="k">{{ t('conj.missDist') }}</div><div class="v mono">{{ num(event.missKm, 3) }} km</div></div>
      <div class="card"><div class="k">{{ t('conj.relVel') }}</div><div class="v mono">{{ num(event.relSpeedKmS, 2) }} km/s</div></div>
      <div class="card"><div class="k">TCA</div><div class="v mono sm">{{ fmtTca(event.tca) }}</div></div>
    </section>

    <section class="grid">
      <aside class="panel">
        <div class="ph">{{ t('conj.primaryObj') }}</div>
        <div class="obj-name">{{ primary?.object_name || `NORAD ${event.noradA}` }}</div>
        <dl v-if="primary" class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ primary.norad_id }}</dd></div>
          <div><dt>{{ t('obj.type') }}</dt><dd>{{ primary.object_type }}</dd></div>
          <div><dt>{{ t('obj.regime') }}</dt><dd>{{ primary.regime }}</dd></div>
          <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ primary.epoch ? fmtTca(String(primary.epoch)) : '—' }}</dd></div>
          <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ num(primary.incl, 2, '°') }}</dd></div>
          <div><dt>{{ t('conj.perigee') }}</dt><dd class="mono">{{ num(primary.perigee, 0) }}</dd></div>
          <div><dt>{{ t('conj.apogee') }}</dt><dd class="mono">{{ num(primary.apogee, 0) }}</dd></div>
          <div><dt>{{ t('conj.period') }}</dt><dd class="mono">{{ num(primary.period, 1) }}</dd></div>
        </dl>
        <p v-else class="dim">{{ t('conj.notFound') }}</p>
        <RouterLink class="btn" to="/objects">{{ t('conj.viewObjects') }}</RouterLink>
      </aside>

      <aside class="panel">
        <div class="ph">{{ t('conj.secondaryObj') }}</div>
        <div class="obj-name">{{ secondary?.object_name || `NORAD ${event.noradB}` }}</div>
        <dl v-if="secondary" class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ secondary.norad_id }}</dd></div>
          <div><dt>{{ t('obj.type') }}</dt><dd>{{ secondary.object_type }}</dd></div>
          <div><dt>{{ t('obj.regime') }}</dt><dd>{{ secondary.regime }}</dd></div>
          <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ secondary.epoch ? fmtTca(String(secondary.epoch)) : '—' }}</dd></div>
          <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ num(secondary.incl, 2, '°') }}</dd></div>
          <div><dt>{{ t('conj.perigee') }}</dt><dd class="mono">{{ num(secondary.perigee, 0) }}</dd></div>
          <div><dt>{{ t('conj.apogee') }}</dt><dd class="mono">{{ num(secondary.apogee, 0) }}</dd></div>
          <div><dt>{{ t('conj.period') }}</dt><dd class="mono">{{ num(secondary.period, 1) }}</dd></div>
        </dl>
        <p v-else class="dim">{{ t('conj.notFound') }}</p>
        <RouterLink v-if="secondary" class="btn" to="/objects">{{ t('conj.viewObjects') }}</RouterLink>
      </aside>

      <section class="panel wide">
        <div class="ph">{{ t('conj.timeline') }}</div>
        <div class="tl">
          <table>
            <thead>
              <tr>
                <th>{{ t('conj.col.tca') }}</th>
                <th>{{ t('conj.col.pc') }}</th>
                <th>{{ t('conj.col.miss') }}</th>
                <th>{{ t('conj.relVel') }}</th>
                <th>{{ t('conj.hbr') }}</th>
                <th>{{ t('conj.originator') }}</th>
                <th>{{ t('conj.created') }}</th>
                <th>{{ t('conj.col.source') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in cdms" :key="c.id">
                <td class="mono">{{ fmtTca(c.tca) }}</td>
                <td class="mono">{{ fmtPc(c.collision_probability) }}</td>
                <td class="mono">{{ num(c.miss_distance_km, 2) }}</td>
                <td class="mono">{{ num(c.rel_speed_km_per_s, 2) }}</td>
                <td class="mono">{{ num(c.hard_body_radius_m, 2) }}</td>
                <td>{{ c.originator || '—' }}</td>
                <td class="mono">{{ c.creation_date ? fmtTca(c.creation_date) : '—' }}</td>
                <td><span class="pill" :class="c.source === 'customer' ? 'yellow' : 'low'">{{ srcLabel(c.source) }}</span></td>
                <td><button type="button" class="btn sm" @click="showRaw(c)">{{ t('conj.raw') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="note">{{ t('conj.note') }}</p>
      </section>

      <section class="panel wide">
        <div class="ph cmp-head">
          <span>{{ t('pc.cmp.title') }}</span>
          <span v-if="cmp" class="lamp" :class="cmp.agreement">
            <i class="dot"></i>{{ t(agreeKeys[cmp.agreement]) }}
          </span>
          <button type="button" class="btn sm" :disabled="cmpLoading" @click="runCompare">
            {{ t('pc.cmp.run') }}
          </button>
        </div>
        <p class="note">{{ t('pc.cmp.desc') }}</p>
        <p v-if="cmpError" class="state error inline">{{ cmpError }}</p>
        <div v-else-if="cmpLoading" class="dim">{{ t('obj.loading') }}</div>
        <div v-else-if="cmp" class="tl">
          <table>
            <thead>
              <tr>
                <th>{{ t('pc.cmp.col.method') }}</th>
                <th>{{ t('conj.col.pc') }}</th>
                <th>{{ t('conj.col.miss') }}</th>
                <th>{{ t('conj.col.tca') }}</th>
                <th>{{ t('conj.hbr') }} (m)</th>
                <th>{{ t('pc.cmp.col.cov') }}</th>
                <th>{{ t('pc.cmp.col.ms') }} (ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in cmp.rows" :key="r.method" :class="{ off: r.disabled }">
                <td>
                  {{ t(methodKeys[r.method]) }}
                  <span v-if="r.disabled" class="dim">— {{ r.note }}</span>
                </td>
                <td class="mono strong">{{ fmtPc(r.pc) }}</td>
                <td class="mono">{{ num(r.missKm, 3) }}</td>
                <td class="mono">{{ fmtTca(r.tca) }}</td>
                <td class="mono">{{ num(r.hbrM, 1) }}</td>
                <td>{{ r.covSource === 'tle-age' ? t('pc.cmp.cov.tleAge') : r.covSource === 'cdm' ? t('pc.cmp.cov.cdm') : '—' }}</td>
                <td class="mono">{{ r.method === 'official' ? '—' : fmtMs(r.ms) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="note">
            <template v-if="cmp.plane">
              {{ t('pc.cmp.inPlane') }} {{ cmp.plane.inPlaneKm.toFixed(3) }} km ·
              {{ t('conj.relVel') }} {{ cmp.plane.relSpeedKms.toFixed(2) }} km/s
            </template>
            <template v-if="cmp.cov">
              · {{ t('pc.cmp.sigmaT') }} {{ cmp.cov.sigmaT.map((x) => x.toFixed(1)).join(' / ') }} km ·
              {{ t('pc.cmp.age') }} {{ cmp.cov.ageHours.map((x) => x.toFixed(1)).join(' / ') }} h
            </template>
          </p>
        </div>
      </section>
      <!-- F1：碰撞参数与重算（仅本次 + run 对比） -->
      <section class="panel wide">
        <div class="ph">
          <span>{{ t('ca.detailTitle') }}</span>
          <span class="dim-tag">{{ t('ca.onceOnly') }}</span>
          <button type="button" class="btn primary sm" :disabled="rcLoading || !caOrgReady" @click="runRecompute">
            {{ rcLoading ? t('ca.recomputing') : t('ca.recompute') }}
          </button>
        </div>
        <p class="note">{{ t('ca.detailDesc') }}</p>

        <!-- 参数编辑（仅本次） -->
        <div class="ca-form">
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.hbrMode') }}</span>
            <span class="row">
              <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="single" /> {{ t('ca.single') }}</label>
              <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="both" /> {{ t('ca.both') }}</label>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ caForm.hbrMode === 'both' ? `${t('ca.f.hbr')} (A / B)` : t('ca.f.hbr') }}</span>
            <span v-if="caForm.hbrMode === 'both'" class="row">
              <input v-model.number="caForm.hbrAM" type="number" min="0.1" max="1000" step="0.1" /> /
              <input v-model.number="caForm.hbrBM" type="number" min="0.1" max="1000" step="0.1" /> m
            </span>
            <span v-else class="row">
              <input v-model.number="caForm.hbrM" type="number" min="1" max="1000" step="1" /> m
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.acceptedPc') }}</span>
            <span class="row"><input v-model.number="caForm.acceptedPc" type="number" min="1e-9" max="1" step="1e-5" /></span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.acceptedMiss') }}</span>
            <span class="row"><input v-model.number="caForm.acceptedMissKm" type="number" min="0.01" max="100" step="0.1" /> km</span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.screenDist') }}</span>
            <span class="row"><input v-model.number="caForm.screenDistanceKm" type="number" min="0.5" max="100" step="0.5" /> km</span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.covMode') }}</span>
            <span class="row">
              <select v-model="caForm.covarianceMode">
                <option value="tle-age">{{ t('ca.covTleAge') }}</option>
                <option value="cdm">CDM</option>
              </select>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.propagator') }}</span>
            <span class="row">
              <select v-model="caForm.propagator">
                <option value="sgp4">SGP4</option>
                <option value="numeric">{{ t('ca.propNumeric') }}</option>
              </select>
            </span>
          </label>
          <label class="cf field">
            <span class="lbl">{{ t('ca.f.windowStep') }}</span>
            <span class="row">
              <input v-model.number="caForm.windowH" type="number" min="1" max="168" step="1" /> h /
              <input v-model.number="caForm.stepS" type="number" min="1" max="3600" step="1" /> s
            </span>
          </label>
          <div class="cf field">
            <span class="lbl">{{ t('ca.f.methods') }}</span>
            <span class="row">
              <label class="radio"><input v-model="caForm.methods.foster" type="checkbox" /> Foster</label>
              <label class="radio"><input v-model="caForm.methods.chan" type="checkbox" /> Chan</label>
              <label class="radio"><input v-model="caForm.methods.alfano" type="checkbox" /> Alfano</label>
            </span>
          </div>
          <div class="cf field">
            <span class="lbl">{{ t('ca.f.orgDefaults') }}</span>
            <span class="row org-link">
              <template v-if="caDefaults">
                {{ caDefaults.updated_at.replace('T', ' ').slice(0, 16) }} ({{ caDefaults.updated_by }})
              </template>
              <template v-else-if="caOrgReady">{{ t('ca.notSet') }}</template>
              <template v-else>—</template>
              <RouterLink to="/settings">{{ t('ca.goSettings') }}</RouterLink>
            </span>
          </div>
        </div>

        <p v-if="!caOrgReady" class="note warn">{{ t('ca.detailNeedLogin') }}</p>
        <p v-if="rcError" class="state error inline">{{ rcError }}</p>

        <!-- 最新 run 结果 -->
        <template v-if="rcResult">
          <div class="rc-head">
            <span class="run-chip">{{ t('ca.runId') }} #{{ rcResult.run.id }}</span>
            <span v-if="rcResult.run.params" class="mono dim">
              HBR {{ rcResult.run.params.hbr_m }}m · {{ t('ca.f.acceptedPc') }} {{ rcResult.run.params.accepted_pc.toExponential(0) }} ·
              {{ t('ca.f.acceptedMiss') }} {{ rcResult.run.params.accepted_miss_km }}km
            </span>
            <span class="lamp" :class="rcResult.agreement"><i class="dot"></i>{{ t(agreeKeys[rcResult.agreement]) }}</span>
          </div>
          <p v-if="rcResult.notes.length" class="note warn">{{ rcResult.notes.join(' · ') }}</p>
          <p v-if="rcResult.disableNote" class="note warn">{{ rcResult.disableNote }}</p>
          <div class="tl">
            <table>
              <thead>
                <tr>
                  <th>{{ t('pc.cmp.col.method') }}</th>
                  <th>{{ t('conj.col.pc') }}</th>
                  <th>{{ t('conj.col.miss') }}</th>
                  <th>{{ t('conj.hbr') }} (m)</th>
                  <th>{{ t('pc.cmp.col.cov') }}</th>
                  <th>{{ t('pc.cmp.col.ms') }} (ms)</th>
                  <th>{{ t('ca.verdict') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rcResult.rows" :key="r.method" :class="{ off: r.disabled }">
                  <td>{{ caMethodLabel(r.method) }}<span v-if="r.disabled" class="dim">— {{ r.note }}</span></td>
                  <td class="mono strong">{{ fmtPc(r.pc) }}</td>
                  <td class="mono">{{ num(r.missKm, 3) }}</td>
                  <td class="mono">{{ num(r.hbrM, 1) }}</td>
                  <td>{{ r.covSource === 'tle-age' ? t('pc.cmp.cov.tleAge') : r.covSource === 'cdm' ? t('pc.cmp.cov.cdm') : '—' }}</td>
                  <td class="mono">{{ r.method === 'official' ? '—' : fmtMs(r.ms) }}</td>
                  <td v-if="r.method === 'official'" class="dim">—</td>
                  <td v-else class="mono">
                    <span v-if="r.pc !== null && rcResult.run.params" :class="r.pc >= rcResult.run.params.accepted_pc ? 'vd-bad' : 'vd-ok'">
                      {{ r.pc >= rcResult.run.params.accepted_pc ? t('ca.pcExceed') : t('ca.pcOk') }}
                    </span>
                    <span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="rcResult.plane && rcResult.run.params" class="note">
            <span :class="rcResult.plane.inPlaneKm < rcResult.run.params.accepted_miss_km ? 'vd-bad' : 'vd-ok'">
              {{ rcResult.plane.inPlaneKm < rcResult.run.params.accepted_miss_km ? t('ca.missBelow') : t('ca.missOk') }}
            </span>
            ({{ t('pc.cmp.inPlane') }} {{ rcResult.plane.inPlaneKm.toFixed(3) }} km /
            {{ t('ca.f.acceptedMiss') }} {{ rcResult.run.params.accepted_miss_km }} km)
          </p>
        </template>

        <!-- run 历史（旧 run 对比） -->
        <div class="runs-head">
          <button type="button" class="btn sm" @click="runsOpen = !runsOpen">
            {{ runsOpen ? '▾' : '▸' }} {{ t('ca.runHistory') }} ({{ rcRuns.length }})
          </button>
        </div>
        <div v-if="runsOpen" class="tl">
          <div v-if="!caOrgReady" class="note">{{ t('ca.detailNeedLogin') }}</div>
          <div v-else-if="!rcRuns.length" class="note">{{ t('ca.noRuns') }}</div>
          <table v-else>
            <thead>
              <tr>
                <th>run_id</th>
                <th>{{ t('ca.col.time') }}</th>
                <th>{{ t('ca.col.by') }}</th>
                <th>HBR</th>
                <th>{{ t('conj.col.pc') }} ({{ t('ca.col.official') }} / {{ t('ca.methodsMax') }})</th>
                <th>{{ t('pc.cmp.agreement') }}</th>
                <th>{{ t('ca.verdict') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in rcRuns" :key="run.id">
                <td class="mono strong">#{{ run.id }}</td>
                <td class="mono">{{ fmtWhen(run.created_at) }}</td>
                <td>{{ run.triggered_by }}</td>
                <td class="mono">{{ run.params?.hbr_m ?? '—' }} m</td>
                <td class="mono">
                  {{ fmtPc(run.rows.find((r) => r.method === 'official')?.pc ?? null) }} /
                  {{ fmtPc(maxMethodPc(run)) }}
                </td>
                <td>
                  <span v-if="run.agreement" class="lamp" :class="run.agreement"><i class="dot"></i></span>
                  <span v-else>—</span>
                </td>
                <td class="mono">
                  <template v-if="runVerdict(run.params, run.rows).pcExceed !== null">
                    <span :class="runVerdict(run.params, run.rows).pcExceed ? 'vd-bad' : 'vd-ok'">
                      {{ runVerdict(run.params, run.rows).pcExceed ? t('ca.pcExceed') : t('ca.pcOk') }}
                    </span>
                    <span v-if="runVerdict(run.params, run.rows).missBelow !== null" :class="runVerdict(run.params, run.rows).missBelow ? 'vd-bad' : 'vd-ok'">
                      · {{ runVerdict(run.params, run.rows).missBelow ? t('ca.missBelow') : t('ca.missOk') }}
                    </span>
                  </template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>

    <!-- 原文弹层 -->
    <div v-if="rawOpen" class="modal-mask" @click.self="rawOpen = false">
      <div class="modal">
        <div class="mh">{{ rawTitle }}</div>
        <pre class="raw">{{ rawLoading ? t('obj.loading') : rawText }}</pre>
        <div class="mfoot">
          <button type="button" class="btn" @click="rawOpen = false">{{ t('conj.backList') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; overflow: auto; padding: 12px 14px 40px;
  display: flex; flex-direction: column; gap: 12px;
}
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.link {
  appearance: none; border: none; background: transparent; color: var(--accent-strong);
  font-size: 12px; cursor: pointer; padding: 0; margin-bottom: 6px;
}
h1 {
  margin: 0; font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.actions { display: flex; gap: 6px; }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  display: inline-block; text-decoration: none;
}
.btn:hover { color: var(--text); }
.btn.primary { color: var(--accent-strong); border-color: var(--accent-strong); }
.btn.sm { padding: 3px 8px; font-size: 11px; }
.pill {
  font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-muted); font-weight: 650;
}
.pill.red { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.pill.orange { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.pill.yellow { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pill.low { color: var(--text-dim); }

.kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.card {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
}
.k { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.v { margin-top: 4px; font-size: 18px; font-weight: 650; color: var(--text); }
.v.sm { font-size: 13px; }
.sub { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.panel {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
}
.panel.wide { grid-column: 1 / -1; }
.ph { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.obj-name { font-size: 14px; font-weight: 650; margin-bottom: 10px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
.kv div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
}
.kv dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.kv dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; }
.dim { color: var(--text-dim); font-size: 12px; }

.tl { overflow-x: auto; }
.tl table { width: 100%; border-collapse: collapse; font-size: 11px; }
.tl th {
  text-align: left; padding: 8px 10px; color: var(--text-dim); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.tl td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tl td.strong { font-weight: 650; }
.tl tr.off td { color: var(--text-dim); }
.cmp-head { display: flex; align-items: center; gap: 10px; }
.lamp {
  display: inline-flex; align-items: center; gap: 5px; font-size: 10px; text-transform: none;
  letter-spacing: 0; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border);
}
.lamp .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.lamp.green .dot { background: var(--ok, #63b463); }
.lamp.yellow .dot { background: var(--watch); }
.lamp.red .dot { background: var(--danger); }
.state.inline { margin: 8px 0 0; padding: 8px 10px; display: block; }
.note { margin: 10px 0 0; font-size: 10px; color: var(--text-dim); }
.note.warn { color: var(--warn); }

/* F1 碰撞参数与重算 */
.dim-tag {
  font-size: 9px; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 3px; padding: 1px 5px; white-space: nowrap;
}
.btn.primary.sm { margin-left: auto; }
.ca-form {
  margin-top: 10px; display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 8px 14px; align-items: end;
}
.ca-form .field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ca-form .lbl { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em; }
.ca-form .row { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); flex-wrap: wrap; }
.ca-form input[type='number'],
.ca-form select {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 4px 6px; font-size: 11px;
  font-family: var(--mono); outline: none; width: 76px;
}
.ca-form input:focus, .ca-form select:focus { border-color: var(--accent); }
.radio { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-muted); }
.org-link { gap: 8px; }
.org-link a { color: var(--accent-strong); font-size: 11px; text-decoration: none; }
.org-link a:hover { text-decoration: underline; }
.rc-head { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.run-chip {
  font-family: var(--mono); font-size: 11px; font-weight: 650; color: var(--accent-strong);
  border: 1px solid rgba(74, 125, 154, 0.4); border-radius: 3px; padding: 2px 8px;
}
.rc-head .dim { font-size: 10px; }
.runs-head { margin-top: 12px; }
.vd-ok { color: var(--ok, #63b463); font-size: 10px; }
.vd-bad { color: var(--danger); font-size: 10px; }
@media (max-width: 1280px) {
  .ca-form { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
}
@media (max-width: 900px) {
  .ca-form { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
}

.state {
  flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-dim); font-size: 12px;
}
.state.error { color: var(--danger); }

.modal-mask {
  position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: 720px; max-width: 100%; max-height: 84vh; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 10px; padding: 16px;
}
.mh { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
.raw {
  margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-all;
  background: var(--bg-deep); border: 1px solid var(--border); border-radius: 6px; padding: 10px;
  font-size: 11px; font-family: var(--mono); color: var(--text);
}
.mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
