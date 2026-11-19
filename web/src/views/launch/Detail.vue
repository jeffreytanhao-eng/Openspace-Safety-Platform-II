<script setup lang="ts">
/**
 * 火箭发射详情（docs/public-api.md 单条详情 + 2D 仿真图）。
 * 数据经后端 /cgi/launches 代理；参数均为推算值，页面底部统一免责声明。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import { getLaunch, launchMapUrl, type LaunchItem, type LaunchText } from '@/api/launches'
import FlagIcon from '@/components/FlagIcon.vue'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()

const id = computed(() => decodeURIComponent(String(route.params.id || '')))
const launch = ref<LaunchItem | null>(null)
const loading = ref(true)
const error = ref('')
const simError = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  simError.value = false
  try {
    launch.value = await getLaunch(id.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    launch.value = null
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** 中英双语字段按当前语言取值，缺失回退另一语言 */
function pick(v?: LaunchText | null): string {
  if (!v) return ''
  return locale.value === 'zh' ? v.zh || v.en : v.en || v.zh || ''
}

const nameText = computed(() => pick(launch.value?.name) || id.value)
const summaryText = computed(() => pick(launch.value?.summary))
const orbitText = computed(() => {
  const o = launch.value?.orbit_type
  if (!o) return '—'
  return pick(o.label) || o.value || '—'
})
const payloadText = computed(() => {
  const p = launch.value?.payload
  if (!p) return '—'
  if (p.status === 'classified') return t('launch.payloadClassified')
  const names = (p.objects ?? []).map((o) => o.name).filter(Boolean)
  if (names.length) return names.join(', ') + (p.truncated ? ' …' : '')
  if (p.status === 'unknown') return t('launch.payloadUnknown')
  return pick(p.summary) || '—'
})
const mapUrl = computed(() => (launch.value ? launchMapUrl(launch.value.id) : ''))

/** 国旗识别线索：接口 country.code 实为「发射场, 国家」全名，拼上中英文国名兜底 */
const countryHint = computed(() => {
  const c = launch.value?.site?.country
  return [c?.code, c?.name?.en, c?.name?.zh].filter(Boolean).join(' ')
})

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC：YYYY-MM-DD HH:mm */
function fmtUtc(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 浏览器本地时区：MM-DD HH:mm UTC+X */
function fmtLocal(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const off = -d.getTimezoneOffset() / 60
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} UTC${off >= 0 ? '+' : ''}${off}`
}

function num(v: number | null | undefined, digits: number, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}${unit}`
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${Math.round(v * 100)}%`
}

function coord(v: number | null | undefined, pos: string, neg: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`
}
</script>

<template>
  <div v-if="loading" class="page"><section class="state">{{ t('obj.loading') }}</section></div>
  <div v-else-if="!launch" class="page">
    <p class="state error">{{ error || t('launch.notFound') }}</p>
    <button type="button" class="btn" @click="router.push('/')">{{ t('launch.back') }}</button>
  </div>
  <div v-else class="page">
    <header class="head">
      <button type="button" class="link" @click="router.push('/')">{{ t('launch.back') }}</button>
      <h1>
        <FlagIcon :code="countryHint" />
        <span>{{ nameText }}</span>
      </h1>
      <p>
        {{ t('launch.net') }} {{ fmtUtc(launch.net) }} UTC
        <template v-if="launch.launch_service_provider"> · {{ launch.launch_service_provider }}</template>
        <template v-if="pick(launch.site?.country?.name)"> · {{ pick(launch.site?.country?.name) }}</template>
      </p>
    </header>

    <section class="kpi">
      <div class="card">
        <div class="k">{{ t('launch.net') }} · UTC</div>
        <div class="v mono sm">{{ fmtUtc(launch.net) }}</div>
        <div v-if="launch.window?.end" class="sub mono">{{ t('launch.window') }} → {{ fmtUtc(launch.window.end) }}</div>
      </div>
      <div class="card">
        <div class="k">{{ t('launch.local') }}</div>
        <div class="v mono sm">{{ fmtLocal(launch.net) }}</div>
      </div>
      <div class="card">
        <div class="k">{{ t('launch.status') }}</div>
        <div class="v sm">{{ pick(launch.status?.label) || '—' }}</div>
        <div v-if="launch.status?.probability != null" class="sub">P {{ pct(launch.status.probability) }}</div>
      </div>
      <div class="card">
        <div class="k">{{ t('launch.orbit') }}</div>
        <div class="v sm">{{ orbitText }}</div>
      </div>
    </section>

    <section class="panel">
      <div class="site-row">
        <div>
          <div class="ph">{{ t('launch.site') }}</div>
          <dl class="kv">
            <div><dt>{{ t('launch.country') }}</dt><dd>{{ pick(launch.site?.country?.name) || '—' }}</dd></div>
            <div><dt>{{ t('launch.site') }}</dt><dd>{{ pick(launch.site?.launch_site) || '—' }}</dd></div>
            <div><dt>{{ t('launch.pad') }}</dt><dd>{{ pick(launch.site?.pad) || '—' }}</dd></div>
            <div>
              <dt>Lat / Lon</dt>
              <dd class="mono">{{ coord(launch.site?.latitude, 'N', 'S') }} · {{ coord(launch.site?.longitude, 'E', 'W') }}</dd>
            </div>
          </dl>
        </div>
        <div>
          <div class="ph">{{ t('launch.rocket') }}</div>
          <dl class="kv">
            <div><dt>{{ t('launch.rocket') }}</dt><dd>{{ launch.rocket || '—' }}</dd></div>
            <div><dt>{{ t('launch.provider') }}</dt><dd>{{ launch.launch_service_provider || '—' }}</dd></div>
            <div><dt>{{ t('launch.missionType') }}</dt><dd>{{ pick(launch.mission_type) || '—' }}</dd></div>
            <div><dt>{{ t('launch.payload') }}</dt><dd>{{ payloadText }}</dd></div>
          </dl>
        </div>
      </div>
      <div class="ph">{{ t('launch.summary') }}</div>
      <p class="text">{{ summaryText || '—' }}</p>
    </section>

    <section class="panel">
      <div class="ph">{{ t('launch.estimate') }}</div>
      <dl v-if="launch.estimate" class="kv est">
        <div><dt>{{ t('launch.azimuth') }}</dt><dd class="mono">{{ num(launch.estimate.azimuth_deg, 1, '°') }}</dd></div>
        <div><dt>{{ t('launch.inclination') }}</dt><dd class="mono">{{ num(launch.estimate.inclination_deg, 2, '°') }}</dd></div>
        <div><dt>{{ t('launch.family') }}</dt><dd>{{ launch.estimate.orbit_family_inferred || '—' }}</dd></div>
        <div><dt>{{ t('launch.altitude') }}</dt><dd class="mono">{{ num(launch.estimate.altitude_km, 0, ' km') }}</dd></div>
        <div><dt>{{ t('launch.confidence') }}</dt><dd class="mono">{{ pct(launch.estimate.confidence) }}</dd></div>
      </dl>
      <p v-else class="dim">—</p>
    </section>

    <section v-if="launch.initial_orbit" class="panel">
      <div class="ph">{{ t('launch.orbitPanel') }} · {{ launch.initial_orbit.model }} · {{ t('launch.epoch') }} {{ fmtUtc(launch.initial_orbit.epoch) }} UTC</div>
      <dl class="kv el">
        <div><dt>{{ t('launch.el.a') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.a_km, 1, ' km') }}</dd></div>
        <div><dt>{{ t('launch.el.ecc') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.ecc, 5) }}</dd></div>
        <div><dt>{{ t('launch.el.inc') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.inc_deg, 2, '°') }}</dd></div>
        <div><dt>{{ t('launch.el.raan') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.raan_deg, 2, '°') }}</dd></div>
        <div><dt>{{ t('launch.el.argp') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.argp_deg, 2, '°') }}</dd></div>
        <div><dt>{{ t('launch.el.ma') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.mean_anomaly_deg, 2, '°') }}</dd></div>
        <div><dt>{{ t('launch.el.n') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.n_rev_day, 4) }}</dd></div>
        <div><dt>{{ t('launch.el.period') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.period_min, 2, ' min') }}</dd></div>
        <div><dt>{{ t('launch.el.alt') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.alt_km, 1, ' km') }}</dd></div>
        <div><dt>{{ t('launch.el.apogee') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.apogee_km, 1, ' km') }}</dd></div>
        <div><dt>{{ t('launch.el.perigee') }}</dt><dd class="mono">{{ num(launch.initial_orbit.elements.perigee_km, 1, ' km') }}</dd></div>
      </dl>
      <div v-if="launch.initial_orbit.tle?.length" class="tle">
        <div class="ph">{{ t('launch.tle') }}</div>
        <pre>{{ launch.initial_orbit.tle.join('\n') }}</pre>
      </div>
    </section>

    <section class="panel sim">
      <div class="ph">{{ t('launch.simulation') }}</div>
      <img
        v-if="!simError"
        :src="mapUrl"
        :alt="t('launch.simulation')"
        loading="lazy"
        @error="simError = true"
      />
      <p v-else class="dim">{{ t('launch.simMissing') }}</p>
    </section>

    <p class="disclaimer">{{ t('launch.disclaimer') }}</p>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; overflow: auto; padding: 12px 14px 28px;
  display: flex; flex-direction: column; gap: 10px;
}
.head { display: flex; flex-direction: column; gap: 2px; }
.link {
  appearance: none; border: none; background: transparent; color: var(--accent-strong);
  font-size: 12px; cursor: pointer; padding: 0; margin-bottom: 4px; align-self: flex-start;
}
h1 {
  margin: 0; font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap;
}
h1 :deep(.flag) { width: 22px; height: 15px; }
.head p { margin: 3px 0 0; font-size: 11px; color: var(--text-dim); }

.kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.card {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px;
}
.k { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.v { margin-top: 4px; font-size: 18px; font-weight: 650; color: var(--text); }
.v.sm { font-size: 13px; }
.sub { margin-top: 2px; font-size: 10px; color: var(--text-dim); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.site-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.panel {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
}
.ph {
  font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em;
  margin: 0 0 6px;
}
.ph:not(:first-child) { margin-top: 12px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0; }
.kv.el { grid-template-columns: repeat(4, 1fr); }
.kv.est { grid-template-columns: repeat(5, 1fr); }
.kv div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px;
  min-width: 0;
}
.kv dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.kv dd {
  margin: 3px 0 0; font-size: 12px; font-weight: 600;
  word-break: normal; overflow-wrap: break-word; hyphens: none;
}
.text { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-muted); }
.dim { color: var(--text-dim); font-size: 12px; }
.tle { margin-top: 10px; }
.tle pre {
  margin: 0 0 2px; padding: 6px 8px; background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 4px; font-family: var(--mono); font-size: 10px; color: var(--text-muted);
  white-space: pre-wrap; word-break: break-all;
}
.sim img {
  display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-deep);
}
.disclaimer {
  margin: 0; padding-top: 6px; font-size: 10px; line-height: 1.5; color: var(--text-dim);
  border-top: 1px dashed var(--border);
}
.state { padding: 16px; font-size: 12px; color: var(--text-dim); }
.state.error { color: var(--danger); }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  align-self: flex-start;
}
.btn:hover { color: var(--text); }
@media (max-width: 960px) {
  .site-row { grid-template-columns: 1fr; }
  .kv.el, .kv.est { grid-template-columns: repeat(2, 1fr); }
  .kpi { grid-template-columns: repeat(2, 1fr); }
}
</style>
