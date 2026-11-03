<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import {
  listObjects,
  lookupObject,
  claimObject,
  getObject,
  updateObject,
  releaseObject,
  bindEphem,
  unbindEphem,
  type ManagedObject,
  type ObjectDetail,
  type LookupResult
} from '@/api/objects'
import { listLocalEphemerides } from '@/api/ephemerides'
import { AuthError } from '@/api/auth'

const { t } = useI18n()

const q = ref('')
const loading = ref(false)
const loadError = ref('')
const platformBlocked = ref(false)
const objects = ref<ManagedObject[]>([])

const filtered = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return objects.value
  return objects.value.filter(
    (o) => o.name.toLowerCase().includes(s) || String(o.norad_id).includes(s)
  )
})

function fmtPc(v: number | null): string {
  if (v == null) return '—'
  return v === 0 ? '0' : v.toExponential(2)
}
function fmtNum(v: number | null): string {
  return v == null ? '—' : String(v)
}
function fmtTime(s: string): string {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

async function load() {
  loading.value = true
  loadError.value = ''
  platformBlocked.value = false
  try {
    objects.value = await listObjects()
  } catch (e) {
    if (e instanceof AuthError && e.httpStatus === 403) platformBlocked.value = true
    else loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

/* ---- 认领对话框 ---- */
const claimOpen = ref(false)
const claimNorad = ref('')
const claimForm = ref({ massKg: '', crossSectionM2: '', propulsion: '' })
const preview = ref<LookupResult | null>(null)
const previewLoading = ref(false)
const claimError = ref('')
const claimQuota = ref(false)
const submitting = ref(false)

function openClaim() {
  claimOpen.value = true
  preview.value = null
  claimError.value = ''
  claimQuota.value = false
  claimNorad.value = ''
  claimForm.value = { massKg: '', crossSectionM2: '', propulsion: '' }
}
function closeClaim() {
  claimOpen.value = false
}

async function doLookup() {
  const n = Number(claimNorad.value.trim())
  preview.value = null
  claimError.value = ''
  claimQuota.value = false
  if (!Number.isInteger(n) || n <= 0) {
    claimError.value = t('obj.needNumber')
    return
  }
  previewLoading.value = true
  try {
    preview.value = await lookupObject(n)
  } catch (e) {
    claimError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

async function doClaim() {
  if (!preview.value) return
  submitting.value = true
  claimError.value = ''
  claimQuota.value = false
  try {
    await claimObject({
      noradId: preview.value.sat.norad_id,
      massKg: claimForm.value.massKg === '' ? null : Number(claimForm.value.massKg),
      crossSectionM2: claimForm.value.crossSectionM2 === '' ? null : Number(claimForm.value.crossSectionM2),
      propulsion: claimForm.value.propulsion.trim() || undefined
    })
    claimOpen.value = false
    await load()
  } catch (e) {
    if (e instanceof AuthError && e.code === 4030) claimQuota.value = true
    claimError.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

/* ---- 档案抽屉 ---- */
const selected = ref<ObjectDetail | null>(null)
const detailLoading = ref(false)
const editForm = ref<Record<string, string | number>>({ name: '', massKg: '', crossSectionM2: '', propulsion: '', acceptedPc: '', acceptedMissKm: '' })
const saving = ref(false)
const saved = ref(false)
const detailError = ref('')
const releasing = ref(false)

async function openDetail(o: ManagedObject) {
  selected.value = { ...o, sat: null, ephemerides: [] }
  detailError.value = ''
  saved.value = false
  detailLoading.value = true
  try {
    const d = await getObject(o.id)
    selected.value = d
    editForm.value = {
      name: d.name,
      massKg: d.mass_kg == null ? '' : String(d.mass_kg),
      crossSectionM2: d.cross_section_m2 == null ? '' : String(d.cross_section_m2),
      propulsion: d.propulsion || '',
      acceptedPc: d.accepted_pc == null ? '' : String(d.accepted_pc),
      acceptedMissKm: d.accepted_miss_km == null ? '' : String(d.accepted_miss_km)
    }
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
  await loadBindList()
}
function closeDetail() {
  selected.value = null
}

async function saveDetail() {
  if (!selected.value) return
  saving.value = true
  saved.value = false
  detailError.value = ''
  // type=number 的 v-model 会被 Vue 转成 number，这里统一兼容 string | number
  const nOrNull = (v: string | number | null | undefined) => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  try {
    const d = await updateObject(selected.value.id, {
      name: String(editForm.value.name ?? '').trim() || undefined,
      massKg: nOrNull(editForm.value.massKg),
      crossSectionM2: nOrNull(editForm.value.crossSectionM2),
      propulsion: String(editForm.value.propulsion ?? '').trim(),
      acceptedPc: nOrNull(editForm.value.acceptedPc),
      acceptedMissKm: nOrNull(editForm.value.acceptedMissKm)
    })
    selected.value = d
    saved.value = true
    await load()
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function release() {
  if (!selected.value) return
  if (!window.confirm(t('obj.releaseConfirm'))) return
  releasing.value = true
  detailError.value = ''
  try {
    await releaseObject(selected.value.id)
    selected.value = null
    await load()
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    releasing.value = false
  }
}

/* ---- 星历绑定 ---- */
const bindList = ref<Array<{ id: string; name: string; norad: string; format: string; points: number }>>([])
const bindLoading = ref(false)
const bindPick = ref('')
const bindMsg = ref('')

async function loadBindList() {
  if (!selected.value) return
  bindLoading.value = true
  bindPick.value = ''
  bindMsg.value = ''
  try {
    const data = await listLocalEphemerides({ q: String(selected.value.norad_id), size: 50 })
    bindList.value = data.items
      .filter((it) => it.norad === String(selected.value!.norad_id))
      .map((it) => ({ id: it.id, name: it.name, norad: it.norad, format: it.format, points: it.points }))
  } catch (e) {
    bindMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    bindLoading.value = false
  }
}

async function doBind() {
  if (!selected.value || !bindPick.value) return
  bindMsg.value = ''
  try {
    await bindEphem(selected.value.id, bindPick.value)
    const d = await getObject(selected.value.id)
    selected.value = d
    await load()
    await loadBindList()
  } catch (e) {
    bindMsg.value = e instanceof Error ? e.message : String(e)
  }
}

async function doUnbind(ephemId: string) {
  if (!selected.value) return
  bindMsg.value = ''
  try {
    await unbindEphem(selected.value.id, ephemId)
    const d = await getObject(selected.value.id)
    selected.value = d
    await load()
    await loadBindList()
  } catch (e) {
    bindMsg.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('obj.title') }}</h1>
        <p>{{ t('obj.sub') }}</p>
      </div>
      <div class="head-right">
        <span class="count">{{ filtered.length }} / {{ objects.length }}</span>
        <button type="button" class="btn primary" @click="openClaim">{{ t('obj.claim') }}</button>
      </div>
    </header>

    <div v-if="platformBlocked" class="hint">{{ t('obj.platformHint') }}</div>
    <div v-else-if="loadError" class="hint err">{{ loadError }}</div>

    <section v-else class="filters">
      <input v-model="q" type="search" :placeholder="t('obj.search')" />
      <button type="button" class="btn" @click="load">{{ t('obj.refresh') }}</button>
    </section>

    <section v-if="!platformBlocked && !loadError" class="table-wrap">
      <div v-if="loading" class="empty-pad">{{ t('obj.loading') }}</div>
      <table v-else-if="filtered.length">
        <thead>
          <tr>
            <th>{{ t('obj.col.name') }}</th>
            <th>{{ t('obj.col.norad') }}</th>
            <th>{{ t('obj.col.mass') }}</th>
            <th>{{ t('obj.col.cs') }}</th>
            <th>{{ t('obj.col.prop') }}</th>
            <th>{{ t('obj.col.pc') }}</th>
            <th>{{ t('obj.col.miss') }}</th>
            <th>{{ t('obj.col.bound') }}</th>
            <th>{{ t('obj.col.updated') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in filtered" :key="o.id" @click="openDetail(o)">
            <td class="name">{{ o.name }}</td>
            <td class="mono">{{ o.norad_id }}</td>
            <td class="mono">{{ fmtNum(o.mass_kg) }}</td>
            <td class="mono">{{ fmtNum(o.cross_section_m2) }}</td>
            <td>{{ o.propulsion || '—' }}</td>
            <td class="mono">{{ fmtPc(o.accepted_pc) }}</td>
            <td class="mono">{{ fmtNum(o.accepted_miss_km) }}</td>
            <td><span class="pill" :class="o.bound_ephemerides ? 'fresh' : 'missing'">{{ o.bound_ephemerides ?? 0 }}</span></td>
            <td class="dim">{{ fmtTime(o.updated_at) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-pad">{{ t('obj.empty') }}</div>
    </section>

    <!-- 认领对话框 -->
    <aside v-if="claimOpen" class="drawer" @click.self="closeClaim">
      <div class="drawer-panel">
        <header class="dh">
          <div class="d-title">{{ t('obj.claimTitle') }}</div>
          <button type="button" class="x" @click="closeClaim">×</button>
        </header>
        <div class="claim-row">
          <input v-model="claimNorad" class="num" type="text" inputmode="numeric" :placeholder="t('obj.claimNorad')" @keyup.enter="doLookup" />
          <button type="button" class="btn" :disabled="previewLoading" @click="doLookup">
            {{ previewLoading ? t('obj.claiming') : t('obj.claimLookup') }}
          </button>
        </div>
        <div v-if="claimQuota" class="hint warn">{{ t('obj.quotaTip') }}</div>
        <div v-if="claimError" class="hint err">{{ claimError }}</div>
        <div v-if="preview" class="preview">
          <div class="pv-title">{{ preview.sat.object_name }} <span class="mono">NORAD {{ preview.sat.norad_id }}</span></div>
          <div class="pv-grid">
            <div><dt>{{ t('obj.type') }}</dt><dd>{{ preview.sat.object_type || '—' }}</dd></div>
            <div><dt>{{ t('obj.regime') }}</dt><dd>{{ preview.sat.regime || '—' }}</dd></div>
            <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ preview.sat.incl ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.apogee') }}</dt><dd class="mono">{{ preview.sat.apogee ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.perigee') }}</dt><dd class="mono">{{ preview.sat.perigee ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ preview.sat.epoch || '—' }}</dd></div>
          </div>
          <div v-if="preview.claimed_by" class="hint warn">{{ t('obj.claimedByOther') }}</div>
          <template v-else>
            <div class="form">
              <label><span>{{ t('obj.mass') }}</span><input v-model="claimForm.massKg" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.crossSection') }}</span><input v-model="claimForm.crossSectionM2" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.propulsion') }}</span><input v-model="claimForm.propulsion" type="text" maxlength="60" /></label>
            </div>
            <button type="button" class="btn primary wide" :disabled="submitting || !!preview.claimed_by" @click="doClaim">
              {{ submitting ? t('obj.saving') : t('obj.claimSubmit') }}
            </button>
          </template>
        </div>
      </div>
    </aside>

    <!-- 档案抽屉 -->
    <aside v-if="selected" class="drawer" @click.self="closeDetail">
      <div class="drawer-panel">
        <header class="dh">
          <div>
            <div class="d-title">{{ selected.name }}</div>
            <div class="d-sub">NORAD {{ selected.norad_id }}<span v-if="selected.sat"> · {{ selected.sat.regime }}</span></div>
          </div>
          <button type="button" class="x" @click="closeDetail">×</button>
        </header>
        <div v-if="detailError" class="hint err">{{ detailError }}</div>
        <div v-if="detailLoading" class="empty-pad">{{ t('obj.loading') }}</div>
        <template v-else>
          <div v-if="selected.sat" class="pv-grid">
            <div><dt>{{ t('obj.type') }}</dt><dd>{{ selected.sat.object_type || '—' }}</dd></div>
            <div><dt>{{ t('obj.regime') }}</dt><dd>{{ selected.sat.regime || '—' }}</dd></div>
            <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ selected.sat.incl ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.apogee') }}</dt><dd class="mono">{{ selected.sat.apogee ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.perigee') }}</dt><dd class="mono">{{ selected.sat.perigee ?? '—' }}</dd></div>
            <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ selected.sat.epoch || '—' }}</dd></div>
          </div>

          <div class="block">
            <div class="bt">{{ t('obj.archive') }}</div>
            <div class="form">
              <label><span>{{ t('obj.col.name') }}</span><input v-model="editForm.name" type="text" maxlength="100" /></label>
              <label><span>{{ t('obj.mass') }}</span><input v-model="editForm.massKg" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.crossSection') }}</span><input v-model="editForm.crossSectionM2" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.propulsion') }}</span><input v-model="editForm.propulsion" type="text" maxlength="60" /></label>
              <label><span>{{ t('obj.acceptedPc') }}</span><input v-model="editForm.acceptedPc" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.acceptedMissKm') }}</span><input v-model="editForm.acceptedMissKm" type="number" min="0" step="any" /></label>
            </div>
            <div class="row-actions">
              <button type="button" class="btn primary" :disabled="saving" @click="saveDetail">
                {{ saving ? t('obj.saving') : t('obj.save') }}
              </button>
              <span v-if="saved" class="ok-text">{{ t('obj.saved') }}</span>
            </div>
          </div>

          <div class="block">
            <div class="bt">{{ t('obj.boundEphem') }}</div>
            <ul v-if="selected.ephemerides.length">
              <li v-for="e in selected.ephemerides" :key="e.id">
                <div class="li-top">
                  <span class="li-name">{{ e.name }}</span>
                  <button type="button" class="mini" @click="doUnbind(e.id)">{{ t('obj.unbind') }}</button>
                </div>
                <span class="meta">{{ e.format }} · {{ e.points }} pts · {{ e.status }}</span>
              </li>
            </ul>
            <p v-else class="empty">{{ t('obj.noBound') }}</p>
            <div class="bind-row">
              <select v-model="bindPick">
                <option value="" disabled>{{ bindLoading ? t('obj.loading') : t('obj.bindSelect') }}</option>
                <option v-for="b in bindList" :key="b.id" :value="b.id">{{ b.format }} · {{ b.name }} · {{ b.points }} pts</option>
              </select>
              <button type="button" class="btn" :disabled="!bindPick" @click="doBind">{{ t('obj.bind') }}</button>
            </div>
            <div v-if="bindMsg" class="hint err">{{ bindMsg }}</div>
          </div>

          <div class="block actions">
            <RouterLink class="btn" :to="`/ephemerides?q=${selected.norad_id}`">{{ t('obj.openEphem') }}</RouterLink>
            <RouterLink class="btn" to="/conjunctions">{{ t('obj.relatedConj') }}</RouterLink>
            <button type="button" class="btn danger" :disabled="releasing" @click="release">{{ t('obj.release') }}</button>
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 36px;
  min-height: 0;
  position: relative;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; }
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.head-right { display: flex; align-items: center; gap: 10px; }
.count { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.filters input[type='search'] {
  flex: 1;
  min-width: 180px;
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 4px;
  padding: 7px 9px;
  font-size: 12px;
  outline: none;
}
.table-wrap {
  flex: 1; min-height: 0; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th {
  text-align: left; padding: 10px 12px; color: var(--text-dim); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel);
}
td { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
.name { font-weight: 600; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.pill {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border); color: var(--text-muted);
}
.pill.fresh { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.pill.missing { color: var(--text-dim); }
.empty-pad { padding: 28px 12px; text-align: center; font-size: 12px; color: var(--text-dim); }

.drawer {
  position: absolute; inset: 0; background: rgba(0, 0, 0, 0.35);
  display: flex; justify-content: flex-end; z-index: 40;
}
.drawer-panel {
  width: min(440px, 100%); height: 100%; background: var(--bg-panel);
  border-left: 1px solid var(--border); padding: 14px; overflow: auto;
}
.dh { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.d-title { font-size: 15px; font-weight: 650; }
.d-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.x {
  appearance: none; border: 1px solid var(--border); background: transparent;
  color: var(--text-muted); width: 28px; height: 28px; border-radius: 4px; cursor: pointer; font-size: 16px;
}
.claim-row { display: flex; gap: 8px; margin-bottom: 10px; }
.claim-row .num {
  flex: 1; appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 13px; font-family: var(--mono); outline: none;
}
.hint {
  font-size: 12px; padding: 8px 10px; border-radius: 6px; margin-bottom: 10px;
  border: 1px solid var(--border); background: var(--bg-panel-2); color: var(--text-muted);
}
.hint.err { color: var(--danger, #d38); border-color: rgba(214, 84, 124, 0.4); }
.hint.warn { color: var(--warn); border-color: rgba(196, 146, 74, 0.4); }
.preview { margin-top: 4px; }
.pv-title { font-size: 13px; font-weight: 650; margin-bottom: 8px; }
.pv-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 12px; }
.pv-grid div { background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; }
.pv-grid dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.pv-grid dd { margin: 3px 0 0; font-size: 12px; font-weight: 600; }
.form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.form label { display: flex; flex-direction: column; gap: 3px; }
.form label span { font-size: 11px; color: var(--text-dim); }
.form input, .bind-row select {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 12px; outline: none;
}
.block { margin-bottom: 14px; }
.bt { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.row-actions { display: flex; align-items: center; gap: 8px; }
.ok-text { font-size: 11px; color: var(--ok); }
ul { margin: 0; padding: 0; list-style: none; }
li {
  padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px;
}
.li-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.li-name { font-size: 12px; font-weight: 600; }
.mini {
  appearance: none; border: 1px solid var(--border); background: transparent; color: var(--text-muted);
  font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
}
.mini:hover { color: var(--text); background: var(--bg-hover); }
.meta { font-size: 10px; color: var(--text-dim); }
.empty { font-size: 12px; color: var(--text-dim); }
.bind-row { display: flex; gap: 8px; margin-top: 8px; }
.bind-row select { flex: 1; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn {
  border: 1px solid rgba(74, 125, 154, 0.45); background: var(--accent-soft);
  color: var(--text); border-radius: 4px; padding: 7px 10px; font-size: 12px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: rgba(74, 125, 154, 0.35); border-color: rgba(74, 125, 154, 0.7); }
.btn.wide { width: 100%; }
.btn.danger { border-color: rgba(214, 84, 124, 0.5); color: var(--danger, #d38); }
</style>
