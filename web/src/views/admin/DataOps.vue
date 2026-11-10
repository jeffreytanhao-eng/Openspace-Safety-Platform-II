<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  adminDailyFetchStatus,
  adminTriggerDailyFetch,
  adminStarlinkPullGet,
  adminStarlinkPullSave,
  adminStarlinkPullRun,
  type DailyFetchSourceResult,
  type DailyFetchStatus,
  type StarlinkFormat,
  type StarlinkPullStatus
} from '@/api/admin'
import {
  uploadEphemerisFile,
  EphemerisUploadConflictError,
  type EphemUploadConflictInfo
} from '@/api/ephemerides'
import { AuthError } from '@/api/auth'

const st = ref<DailyFetchStatus | null>(null)
const loading = ref(false)
const running = ref(false)
const error = ref('')
const result = ref<Record<string, DailyFetchSourceResult> | null>(null)
const triggeredBy = ref('')

/** 系统日更：Space-Track GP（TLE）、CDM 与 AOE 编目 */
const SOURCES: Array<{ key: string; label: string; note?: string }> = [
  { key: 'spacetrack_gp', label: 'Space-Track GP（TLE）' },
  { key: 'spacetrack_cdm', label: 'Space-Track CDM（交会报文）' },
  { key: 'aoe', label: 'AOE 编目' }
]

const busy = computed(() => running.value || (st.value?.running ?? false))

async function load() {
  loading.value = true
  error.value = ''
  try {
    st.value = await adminDailyFetchStatus()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

async function trigger() {
  if (busy.value) return
  running.value = true
  error.value = ''
  result.value = null
  try {
    const r = await adminTriggerDailyFetch()
    result.value = r.results
    triggeredBy.value = r.triggered_by
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    running.value = false
  }
}

function batchOf(key: string) {
  return st.value?.last_batch?.[key] ?? null
}
function lastOk(key: string): string {
  return st.value?.last_success?.[key] || '—'
}
function statusChip(s: string | undefined): { text: string; cls: string } {
  if (s === 'success') return { text: '成功', cls: 'ok' }
  if (s === 'failed') return { text: '失败', cls: 'bad' }
  if (s === 'running') return { text: '运行中', cls: 'warn' }
  return { text: '无记录', cls: '' }
}

/* ------------------------- 超管导入星历 ------------------------- */

const EPH_FILE_RE = /\.(itc|txt|oem|ocm|e|gz)$/i
const EPH_MAX_MB = 12

type ImportStatus = 'running' | 'added' | 'updated' | 'skipped' | 'error' | 'conflict'
interface ImportResult {
  name: string
  status: ImportStatus
  msg: string
}

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const importVisibility = ref<'public' | 'vip'>('public')
const importing = ref(false)
const importProgress = ref(0)
const importName = ref('')
const importMsg = ref('')
const importResults = ref<ImportResult[]>([])
const conflict = ref<{ files: File[]; index: number; info: EphemUploadConflictInfo } | null>(null)
const batchStat = ref({ added: 0, updated: 0, skipped: 0, failed: 0 })
const batchDropped = ref(0)

function pickFiles() {
  fileInput.value?.click()
}

function pickDir() {
  dirInput.value?.click()
}

function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function visLabel(v: string): string {
  return v === 'private' ? '仅业主本人' : v === 'vip' ? '仅 VIP 可见' : '全部用户可见'
}
function importStatusChip(s: ImportStatus): { text: string; cls: string } {
  if (s === 'added') return { text: '新增', cls: 'ok' }
  if (s === 'updated') return { text: '覆盖更新', cls: 'warn' }
  if (s === 'skipped') return { text: '已跳过', cls: '' }
  if (s === 'error') return { text: '失败', cls: 'bad' }
  if (s === 'conflict') return { text: '待确认', cls: 'warn' }
  return { text: '导入中', cls: '' }
}

/** 选择文件或目录后立即逐个导入（格式/大小不符的条目直接忽略） */
async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const all = Array.from(input.files || [])
  input.value = ''
  if (!all.length || importing.value) return
  const usable = all.filter((f) => EPH_FILE_RE.test(f.name) && f.size <= EPH_MAX_MB * 1024 * 1024)
  const dropped = all.length - usable.length
  if (!usable.length) {
    importMsg.value = `没有可导入的星历文件${dropped ? `（格式/大小不符 ${dropped}）` : ''}`
    return
  }
  importResults.value = []
  importMsg.value = ''
  batchStat.value = { added: 0, updated: 0, skipped: 0, failed: 0 }
  batchDropped.value = dropped
  await runQueue(usable, 0, false)
}

async function runQueue(files: File[], start: number, confirmFirst: boolean) {
  importing.value = true
  for (let i = start; i < files.length; i++) {
    const f = files[i]
    importName.value = f.name
    importProgress.value = Math.round((i / files.length) * 100)
    importResults.value[i] = { name: f.name, status: 'running', msg: '导入中…' }
    try {
      const r = await uploadEphemerisFile(f, f.name, importVisibility.value, {
        confirm: confirmFirst && i === start
      })
      batchStat.value[r.action]++
      importResults.value[i] = {
        name: f.name,
        status: r.action,
        msg: `${r.id} · NORAD ${r.norad} · ${r.range} · ${r.size} · ${visLabel(r.visibility || importVisibility.value)}`
      }
    } catch (e) {
      if (e instanceof EphemerisUploadConflictError) {
        importResults.value[i] = { name: f.name, status: 'conflict', msg: '该目标已有业主上传星历，等待确认覆盖' }
        conflict.value = { files, index: i, info: e.conflict }
        importing.value = false
        return
      }
      batchStat.value.failed++
      importResults.value[i] = { name: f.name, status: 'error', msg: (e as Error)?.message || '导入失败' }
    }
  }
  importProgress.value = 100
  importName.value = ''
  importing.value = false
  const s = batchStat.value
  const parts = [`新增 ${s.added}`, `覆盖更新 ${s.updated}`, `跳过 ${s.skipped}`]
  if (s.failed) parts.push(`失败 ${s.failed}`)
  if (batchDropped.value) parts.push(`忽略 ${batchDropped.value}`)
  importMsg.value = `导入完成：${parts.join(' · ')}`
}

function confirmOverwrite() {
  const c = conflict.value
  if (!c) return
  conflict.value = null
  void runQueue(c.files, c.index, true)
}

function skipConflict() {
  const c = conflict.value
  if (!c) return
  conflict.value = null
  batchStat.value.skipped++
  importResults.value[c.index] = { name: c.files[c.index].name, status: 'skipped', msg: '已跳过，未覆盖业主星历' }
  void runQueue(c.files, c.index + 1, false)
}

/* ------------------------- StarLink 星历拉取 ------------------------- */

const slEnabled = ref(false)
const slCount = ref(10)
const slFormat = ref<StarlinkFormat>('OCM')
const slStatus = ref<StarlinkPullStatus | null>(null)
const slRunning = ref(false)
const slSaving = ref(false)
const slMsg = ref('')
const slErr = ref('')
let slTimer: ReturnType<typeof setTimeout> | null = null

const slBusy = computed(() => slSaving.value || slRunning.value || (slStatus.value?.running ?? false))
const slOk = computed(
  () => (slStatus.value?.added ?? 0) + (slStatus.value?.updated ?? 0) + (slStatus.value?.skipped ?? 0)
)

function fmtIso(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false })
}

function applyStarlink(c: Awaited<ReturnType<typeof adminStarlinkPullGet>>) {
  slEnabled.value = c.enabled
  slCount.value = c.count
  slFormat.value = c.format
  slStatus.value = c.status
  slRunning.value = c.running
}

async function loadStarlink() {
  slErr.value = ''
  try {
    const c = await adminStarlinkPullGet()
    applyStarlink(c)
    if (c.running) scheduleSlPoll()
  } catch (e) {
    slErr.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  }
}

function scheduleSlPoll() {
  if (slTimer) clearTimeout(slTimer)
  slTimer = setTimeout(async () => {
    try {
      const c = await adminStarlinkPullGet()
      applyStarlink(c)
      if (c.running) {
        scheduleSlPoll()
      } else {
        slMsg.value = '拉取完成'
        slErr.value = ''
      }
    } catch (e) {
      slRunning.value = false
      slErr.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
    }
  }, 2000)
}

async function saveStarlink(): Promise<boolean> {
  slSaving.value = true
  slErr.value = ''
  slMsg.value = ''
  try {
    const c = await adminStarlinkPullSave({
      enabled: slEnabled.value,
      count: Math.max(1, Math.min(500, Math.floor(slCount.value) || 10)),
      format: slFormat.value
    })
    applyStarlink(c)
    slMsg.value = '配置已保存'
    return true
  } catch (e) {
    slErr.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
    return false
  } finally {
    slSaving.value = false
  }
}

/** 手动拉取：先保存当前表单配置（服务端按已保存配置执行），再异步启动并轮询状态 */
async function runStarlink() {
  if (slBusy.value) return
  slMsg.value = ''
  if (!(await saveStarlink())) return
  try {
    const r = await adminStarlinkPullRun()
    slRunning.value = true
    slMsg.value = `已开始拉取：${r.format} × ${r.count}（${r.triggered_by}）`
    scheduleSlPoll()
  } catch (e) {
    slErr.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  }
}

onBeforeUnmount(() => {
  if (slTimer) clearTimeout(slTimer)
})

onMounted(() => {
  void load()
  void loadStarlink()
})
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>数据运维 · 日更</h1>
        <p class="sub">
          每日定时采集 Space-Track GP（TLE）、CDM 与系统池 AOE 编目。
        </p>
      </div>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
        <button type="button" class="btn primary" :disabled="busy" @click="trigger">
          {{ busy ? '日更运行中…' : '手动触发日更' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="result" class="ok-msg">
      已由 {{ triggeredBy }} 触发：
      <span v-for="(r, k) in result" :key="k" class="res">
        {{ k }} = {{ r.status }}<template v-if="r.status === 'failed'">（{{ r.message }}）</template>
      </span>
    </div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>数据源</th>
            <th>最近批次</th>
            <th>状态</th>
            <th>计数（总 / 新增 / 更新 / 跳过）</th>
            <th>上次成功</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && !st"><td colspan="6" class="empty">加载中…</td></tr>
          <tr v-else-if="!st"><td colspan="6" class="empty">暂无数据</td></tr>
          <tr v-for="s in SOURCES" :key="s.key">
            <td>{{ s.label }}</td>
            <td class="mono">{{ batchOf(s.key)?.id ?? '—' }}</td>
            <td>
              <span class="chip" :class="statusChip(batchOf(s.key)?.status).cls">
                {{ statusChip(batchOf(s.key)?.status).text }}
              </span>
            </td>
            <td class="mono">
              <template v-if="batchOf(s.key)">
                {{ batchOf(s.key)!.total }} / {{ batchOf(s.key)!.inserted }} /
                {{ batchOf(s.key)!.updated }} / {{ batchOf(s.key)!.skipped }}
              </template>
              <template v-else>—</template>
            </td>
            <td class="mono">{{ lastOk(s.key) }}</td>
            <td class="dim">
              <template v-if="batchOf(s.key)?.error_message">{{ batchOf(s.key)!.error_message }}</template>
              <template v-else>{{ s.note || '—' }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <section class="upload-zone sl-zone">
      <div class="uz-row">
        <div class="uz-text">
          <div class="uz-title">StarLink 星历拉取</div>
          <div class="uz-perm">
            开启「每日拉取」后每日 UTC 00:00 自动执行一次；也可随时手动拉取。拉取内容为公开星历，全平台可见。
          </div>
        </div>
        <div class="uz-actions">
          <label class="uz-vis">
            <span>每日拉取</span>
            <select v-model="slEnabled" :disabled="slBusy">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
          </label>
          <label class="uz-vis">
            <span>拉取数量</span>
            <OspNumberInput v-model="slCount" class="sl-num" min="1" max="500" :disabled="slBusy" />
          </label>
          <label class="uz-vis">
            <span>文件类型</span>
            <select v-model="slFormat" :disabled="slBusy">
              <option value="OCM">OCM</option>
              <option value="ITC">ITC</option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="slBusy" @click="saveStarlink">
            {{ slSaving ? '保存中…' : '保存配置' }}
          </button>
          <button type="button" class="btn primary" :disabled="slBusy" @click="runStarlink">
            {{ slRunning || (slStatus?.running ?? false) ? '拉取中…' : '手动拉取' }}
          </button>
        </div>
      </div>
      <p v-if="slErr" class="error inline">{{ slErr }}</p>
      <p v-if="slMsg" class="uz-msg">{{ slMsg }}</p>
      <p v-if="slStatus?.running" class="sl-last sl-progress">
        拉取中：{{ slStatus.processed ?? 0 }}/{{ slStatus.requested }} · 成功 {{ slOk }} · 失败
        {{ slStatus.failed }}<template v-if="slStatus.current"> · 当前 {{ slStatus.current }}</template>
      </p>
      <p v-else-if="slStatus" class="sl-last">
        最近一次：{{ fmtIso(slStatus.startedAt) }} 由 {{ slStatus.triggeredBy }} 触发 · {{ slStatus.format }} ×
        {{ slStatus.requested }}（完成 {{ slStatus.processed ?? 0 }}）→ 新增 {{ slStatus.added }} · 更新
        {{ slStatus.updated }} · 跳过 {{ slStatus.skipped }}<template v-if="slStatus.failed"> · 失败 {{ slStatus.failed }}</template>
        <template v-if="slStatus.finishedAt"> · 完成于 {{ fmtIso(slStatus.finishedAt) }}</template>
      </p>
      <div v-if="slStatus?.errors?.length" class="sl-errors">
        <div v-for="(e, i) in slStatus.errors" :key="i">{{ e }}</div>
      </div>
    </section>

    <section class="upload-zone">
      <div class="uz-row">
        <div class="uz-text">
          <div class="uz-title">导入星历文件 / 目录</div>
          <div class="uz-sub">
            支持 ITC（Starlink MEME）/ CCSDS OCM / OEM · 单文件 ≤ 12 MB · 目录导入自动逐个入库
          </div>
          <div class="uz-perm">
            权限：超管可导入任意目标星历。覆盖业主上传的星历需二次确认；此前超管导入的星历直接覆盖。
          </div>
        </div>
        <div class="uz-actions">
          <label class="uz-vis">
            <span>可见性</span>
            <select v-model="importVisibility" :disabled="importing">
              <option value="public">全部用户可见</option>
              <option value="vip">仅 VIP 用户可见</option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="importing" @click="pickFiles">选择文件</button>
          <button type="button" class="btn" :disabled="importing" @click="pickDir">选择目录</button>
        </div>
      </div>
      <div v-if="importing" class="uz-progress">
        <div class="uz-bar"><i :style="{ width: importProgress + '%' }"></i></div>
        <span class="uz-pname">{{ importName }} · {{ importProgress }}%</span>
      </div>
      <p v-if="importMsg" class="uz-msg">{{ importMsg }}</p>
      <div v-if="importResults.length" class="imp-list">
        <div v-for="(r, i) in importResults" :key="`${r.name}-${i}`" class="imp-row">
          <span class="imp-name" :title="r.name">{{ r.name }}</span>
          <span class="chip" :class="importStatusChip(r.status).cls">{{ importStatusChip(r.status).text }}</span>
          <span class="imp-msg">{{ r.msg }}</span>
        </div>
      </div>
      <input ref="fileInput" type="file" multiple hidden accept=".itc,.txt,.oem,.ocm,.e,.gz" @change="onFilesPicked" />
      <input ref="dirInput" type="file" multiple hidden webkitdirectory @change="onFilesPicked" />
    </section>

    <p class="hint">
      手动触发为同步执行（GP → CDM → AOE 串行），期间接口会等待本次全部源完成；AOE 未配置 token 时其批次会记失败但不影响 GP/CDM。
    </p>

    <div v-if="conflict" class="modal-mask">
      <div class="modal">
        <h3>确认覆盖业主上传的星历</h3>
        <p class="modal-sub">
          目标 NORAD {{ conflict.info.existing.norad }}（{{ conflict.info.existing.format }}）已有业主上传的星历：
        </p>
        <div class="kv">
          <div class="k">星历名称</div>
          <div class="v">{{ conflict.info.existing.name || conflict.info.existing.id }}</div>
          <div class="k">上传者</div>
          <div class="v">{{ conflict.info.existing.uploadedBy || '—' }}</div>
          <div class="k">发布时间</div>
          <div class="v">{{ fmtTime(conflict.info.existing.publishedMs) }}</div>
          <div class="k">当前可见性</div>
          <div class="v">{{ visLabel(conflict.info.existing.visibility) }}</div>
        </div>
        <p class="modal-warn">
          确认后本次导入将替换该目标的星历，原星历从列表移除（历史版本仍保留在版本归档中）。
        </p>
        <div class="modal-actions">
          <button type="button" class="btn" @click="skipConflict">取消并跳过</button>
          <button type="button" class="btn danger" @click="confirmOverwrite">确认覆盖</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
<style scoped lang="scss">
.res {
  margin-right: 10px;
  font-family: var(--mono);
  font-size: 11px;
}
.upload-zone {
  margin-top: 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  padding: 14px;
  background: rgba(74, 125, 154, 0.06);
}
.upload-zone:hover {
  border-color: var(--accent);
}
.uz-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.uz-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.uz-sub {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.uz-perm {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.uz-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.uz-vis {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.uz-vis select {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 6px;
}
.uz-vis .sl-num {
  width: 76px;
  background: var(--bg-panel);
  color: var(--text-muted);
  font-size: 11px;
}
.sl-zone { border-style: solid; }
.sl-last {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
}
.sl-progress { color: #6fb7ff; }
.sl-errors {
  margin-top: 6px;
  max-height: 140px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11px;
  color: #e0b45c;
  line-height: 1.6;
}
.uz-progress {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.uz-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-deep);
  overflow: hidden;
}
.uz-bar i {
  display: block;
  height: 100%;
  background: var(--accent-strong);
  transition: width 0.2s;
}
.uz-pname {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
}
.uz-msg {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--accent-strong);
  line-height: 1.5;
}
.imp-list {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow: auto;
}
.imp-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.imp-name {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.imp-msg {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal {
  width: 460px;
  max-width: calc(100vw - 32px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.modal h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--text);
}
.modal-sub {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.modal .kv {
  margin-bottom: 12px;
}
.modal-warn {
  margin: 0 0 14px;
  font-size: 11px;
  line-height: 1.6;
  color: #e0b45c;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
