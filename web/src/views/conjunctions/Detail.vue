<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
