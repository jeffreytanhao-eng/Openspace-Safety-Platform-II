<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import {
  listLocalEphemerides,
  fetchEphemerisText,
  type EphListItem
} from '@/api/ephemerides'
import { parseEphemeris } from '@/views/situation/ephem/parse'
import { putSet } from '@/views/situation/ephem/store'
import {
  activateEphem,
  activeEphem,
  clearManeuver
} from '@/views/situation/ephem/useUserEphemeris'
import { ephOpen } from '@/views/situation/scene'
import type { EphemSet, Vec3 } from '@/views/situation/ephem/types'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const items = ref<EphListItem[]>([])
const loading = ref(false)
const loadError = ref('')
const filter = ref('')
const statusFilter = ref<'all' | EphListItem['status'] | 'ITC' | 'OCM'>('all')
const selectedId = ref('')
const msg = ref('')
const jumping = ref(false)

const filtered = computed(() => {
  return items.value.filter((it) => {
    if (statusFilter.value === 'ITC' || statusFilter.value === 'OCM') {
      if (it.format !== statusFilter.value) return false
    } else if (statusFilter.value !== 'all' && it.status !== statusFilter.value) {
      return false
    }
    const s = filter.value.trim().toLowerCase()
    if (!s) return true
    return (
      it.name.toLowerCase().includes(s) ||
      it.norad.includes(s) ||
      it.format.toLowerCase().includes(s)
    )
  })
})

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || filtered.value[0] || null)

watch(
  () => route.query.object,
  (oid) => {
    if (!oid) return
    const hit = items.value.find((e) => e.objectId === String(oid) || e.norad === String(oid))
    if (hit) selectedId.value = hit.id
  }
)

async function reloadList() {
  loading.value = true
  loadError.value = ''
  msg.value = ''
  try {
    const data = await listLocalEphemerides()
    items.value = data.items || []
    if (!selectedId.value && items.value.length) selectedId.value = items.value[0].id
    else if (selectedId.value && !items.value.find((x) => x.id === selectedId.value)) {
      selectedId.value = items.value[0]?.id || ''
    }
    msg.value = `已载入本地星历 ${items.value.length} 条（${data.root}）`
  } catch (e) {
    loadError.value = (e as Error)?.message || '载入星历列表失败'
    items.value = []
  } finally {
    loading.value = false
  }
}

function select(id: string) {
  selectedId.value = id
  msg.value = ''
}

/**
 * 关联至态势：拉取真实星历 → 入库激活 → 跳转 /situation/eph
 * 若有机动摘要则按首个机动时刻施加示意脉冲（橙色机动轨）；否则仅浅蓝主轨。
 */
/** 态势绘制不需要逐点协方差；OCM 全量 cov 会让 IndexedDB 写入/读回很慢甚至失败 */
function stripStatesCovForSituation<T extends { states: { t: number; r: Vec3; v: Vec3; cov?: Float64Array }[] }>(set: T): T {
  return {
    ...set,
    states: set.states.map((s) => ({ t: s.t, r: s.r, v: s.v }))
  }
}

/** 把 index 里的 MAN 历元挂到 EphemSet（parse 已带 maneuvers 时不覆盖） */
function attachMansFromIndex(set: EphemSet, epochs: { t: number; dvMps?: number; duraSec?: number; id?: string }[] | undefined) {
  if (set.maneuvers?.length) return set
  if (!epochs?.length) return set
  const t0 = set.states[0]?.t ?? set.start
  const t1 = set.states[set.states.length - 1]?.t ?? set.stop
  const segs = epochs
    .map((m) => {
      const dura = m.duraSec && m.duraSec > 0 ? m.duraSec : 1
      return {
        t0: m.t,
        t1: m.t + dura * 1000,
        dvMps: m.dvMps,
        id: m.id
      }
    })
    // 与星历窗口有交集即可（MAN 可能略早于 TRAJ_START，会被绘制层裁掉）
    .filter((s) => s.t1 >= t0 && s.t0 <= t1)
  if (segs.length) set.maneuvers = segs
  return set
}

async function openInSituation() {
  const row = selected.value
  if (!row) return
  jumping.value = true
  msg.value = `正在载入 ${row.name}（${row.format}）…`
  try {
    const body = await fetchEphemerisText(row.file)
    const parsed = parseEphemeris(body, { fileName: row.file, name: row.name, norad: Number(row.norad) || undefined })
    if (!parsed.ok || !parsed.set) throw new Error(parsed.error || '星历解析失败')
    let set = parsed.set
    set.id = `local-${row.id}`
    set.source = 'builtin'
    set.name = row.name
    if (!set.norad && row.norad) set.norad = Number(row.norad)
    if (set.format === 'ocm' || set.states.length > 4000) {
      set = stripStatesCovForSituation(set)
    }
    // MAN 开线段：优先 parseOcm 结果，否则用 index.maneuverEpochs
    set = attachMansFromIndex(set, row.maneuverEpochs)
    await putSet(set)
    await activateEphem(set.id)
    if (!activeEphem.value || activeEphem.value.id !== set.id) {
      throw new Error('星历激活失败（本机缓存写入/读回异常，请重试）')
    }
    clearManeuver()

    ephOpen.value = true
    await router.push({
      path: '/situation/eph',
      query: { ephId: row.id, norad: row.norad, format: row.format }
    })
    msg.value = `已跳转态势 · ${row.name}`
  } catch (e) {
    msg.value = (e as Error)?.message || '跳转态势失败'
  } finally {
    jumping.value = false
  }
}

onMounted(() => {
  void reloadList()
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('eph.title') }}</h1>
        <p>{{ t('eph.subLive') }}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading" @click="reloadList">{{ t('eph.reload') }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!selected || jumping"
          @click="openInSituation"
        >{{ t('eph.toSituation') }}</button>
      </div>
    </header>

    <section class="upload-zone" @click="msg = t('eph.uploadHint')">
      <div class="uz-title">{{ t('eph.uzTitleLive') }}</div>
      <div class="uz-sub">{{ t('eph.uzSubLive') }}</div>
    </section>

    <section class="split">
      <aside class="list-pane">
        <div class="list-tools">
          <input v-model="filter" type="search" :placeholder="t('eph.filter')" />
          <div class="seg">
            <button type="button" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">{{ t('eph.all') }}</button>
            <button type="button" :class="{ on: statusFilter === 'ITC' }" @click="statusFilter = 'ITC'">ITC</button>
            <button type="button" :class="{ on: statusFilter === 'OCM' }" @click="statusFilter = 'OCM'">OCM</button>
            <button type="button" :class="{ on: statusFilter === 'local' }" @click="statusFilter = 'local'">{{ t('eph.local') }}</button>
          </div>
        </div>
        <div v-if="loading" class="list-empty">载入中…</div>
        <div v-else-if="loadError" class="list-empty err">{{ loadError }}</div>
        <div v-else-if="!filtered.length" class="list-empty">无匹配星历</div>
        <div v-else class="list">
          <button
            v-for="it in filtered"
            :key="it.id"
            type="button"
            class="row"
            :class="{ on: it.id === selected?.id }"
            @click="select(it.id)"
          >
            <div class="row-top">
              <span class="name">{{ it.name }}</span>
              <span class="st" :class="it.status">{{ it.status }}</span>
            </div>
            <div class="row-meta">NORAD {{ it.norad }} · {{ it.format }} · {{ it.size }}</div>
          </button>
        </div>
      </aside>

      <section class="preview">
        <header class="prev-h">
          <div class="h-title">{{ t('eph.preview') }}</div>
          <div v-if="selected" class="h-sub">{{ selected.name }} · NORAD {{ selected.norad }}</div>
        </header>
        <div v-if="selected" class="prev-body">
          <dl class="kv">
            <div><dt>{{ t('eph.format') }}</dt><dd>{{ selected.format }}</dd></div>
            <div><dt>{{ t('eph.points') }}</dt><dd>{{ selected.points.toLocaleString() }}</dd></div>
            <div><dt>{{ t('eph.step') }}</dt><dd>{{ selected.step }}</dd></div>
            <div><dt>{{ t('eph.validity') }}</dt><dd>{{ selected.range }}</dd></div>
            <div><dt>{{ t('eph.status') }}</dt><dd><span class="st" :class="selected.status">{{ selected.status }}</span></dd></div>
            <div>
              <dt>{{ t('eph.covariance') }}</dt>
              <dd>{{ selected.covariance ? `${t('eph.yes')}${selected.covFrame ? ' · ' + selected.covFrame : ''}` : t('eph.none') }}</dd>
            </div>
            <div><dt>{{ t('eph.maneuver') }}</dt><dd>{{ selected.maneuverSummary || t('eph.none') }}</dd></div>
            <div><dt>{{ t('eph.updated') }}</dt><dd>{{ selected.updatedAt }}</dd></div>
            <div><dt>{{ t('eph.originator') }}</dt><dd>{{ selected.originator || '—' }}</dd></div>
            <div><dt>Linked object</dt><dd>{{ selected.name }}</dd></div>
            <div><dt>{{ t('eph.file') }}</dt><dd class="mono">{{ selected.file }}</dd></div>
          </dl>

          <div class="actions-row">
            <button type="button" class="btn primary wide" :disabled="jumping" @click="openInSituation">
              {{ jumping ? '…' : t('eph.toSituation') }}
            </button>
            <p class="hint">{{ t('eph.toSituationHint') }}</p>
          </div>

          <p v-if="msg" class="msg">{{ msg }}</p>
          <p class="note">{{ t('eph.liveNote') }}</p>
        </div>
        <div v-else class="prev-body">
          <p class="note">{{ loadError || '请选择左侧星历' }}</p>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px 36px; min-height: 0;
}
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { border-color: rgba(74, 125, 154, 0.5); background: var(--accent-soft); color: var(--text); }
.btn.wide { width: 100%; padding: 10px 12px; font-weight: 650; }
.upload-zone {
  border: 1px dashed var(--border-strong); border-radius: 8px; padding: 14px;
  background: rgba(74, 125, 154, 0.06); cursor: pointer; text-align: center;
}
.upload-zone:hover { border-color: var(--accent); }
.uz-title { font-size: 13px; font-weight: 600; color: var(--text); }
.uz-sub { margin-top: 4px; font-size: 11px; color: var(--text-dim); }
.split { flex: 1; min-height: 0; display: grid; grid-template-columns: 340px 1fr; gap: 10px; }
.list-pane, .preview {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  display: flex; flex-direction: column; min-height: 0;
}
.list-tools { padding: 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.list-tools input {
  width: 100%; appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 12px; outline: none;
}
.seg { display: flex; flex-wrap: wrap; gap: 4px; }
.seg button {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep); color: var(--text-muted);
  font-size: 10px; padding: 3px 7px; border-radius: 3px; cursor: pointer;
}
.seg button.on { border-color: rgba(74, 125, 154, 0.5); background: var(--accent-soft); color: var(--text); }
.list { flex: 1; overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.list-empty { padding: 20px 12px; font-size: 12px; color: var(--text-dim); text-align: center; }
.list-empty.err { color: var(--danger); }
.row {
  appearance: none; text-align: left; border: 1px solid transparent; background: transparent;
  color: var(--text); border-radius: 6px; padding: 8px 10px; cursor: pointer;
}
.row:hover { background: var(--bg-hover); }
.row.on { background: var(--accent-soft); border-color: rgba(74, 125, 154, 0.35); }
.row-top { display: flex; justify-content: space-between; gap: 8px; }
.name { font-size: 12px; font-weight: 600; }
.st {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px;
}
.st.synced { color: var(--ok); border-color: rgba(90, 154, 120, 0.35); }
.st.local { color: var(--accent-strong); border-color: rgba(74, 125, 154, 0.4); }
.st.stale { color: var(--warn); border-color: rgba(196, 146, 74, 0.35); }
.st.uploading { color: var(--text-muted); }
.st.error { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.row-meta { margin-top: 3px; font-size: 10px; color: var(--text-dim); }
.prev-h { padding: 12px; border-bottom: 1px solid var(--border); }
.h-title { font-size: 13px; font-weight: 650; }
.h-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.prev-body { padding: 12px; overflow: auto; }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
.kv div { background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
.kv dt { font-size: 10px; color: var(--text-dim); margin: 0; }
.kv dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--text); word-break: break-all; }
.kv dd.mono { font-family: var(--mono); font-size: 10px; font-weight: 500; }
.actions-row { margin-bottom: 10px; }
.hint { margin: 8px 0 0; font-size: 11px; color: var(--text-dim); line-height: 1.45; }
.msg { margin: 12px 0 0; font-size: 12px; color: var(--accent-strong); }
.note { margin: 12px 0 0; font-size: 11px; color: var(--text-dim); line-height: 1.5; }
@media (max-width: 960px) {
  .split { grid-template-columns: 1fr; }
  .kv { grid-template-columns: repeat(2, 1fr); }
}
</style>
