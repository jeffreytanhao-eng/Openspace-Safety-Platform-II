<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import { useAuthStore } from '@/stores/auth'
import {
  listLocalEphemerides,
  fetchEphemerisText,
  fetchEphemerisVersionContent,
  uploadEphemerisFile,
  patchEphemerisVisibility,
  deleteEphemeris,
  rebuildEphemerides,
  listEphemerisVersions,
  softDeleteEphemerisVersion,
  fetchAccuracySources,
  postAccuracyCompare,
  type EphListItem,
  type EphVersion,
  type AccuracySourceItem,
  type AccuracyCompareResult,
  type AccuracyKind
} from '@/api/ephemerides'
import { saveEphemerisDocument } from '@/api/documents'
import AccuracyResidualCharts from '@/components/AccuracyResidualCharts.vue'
import CompactPager from '@/components/CompactPager.vue'
import { parseEphemeris } from '@/views/situation/ephem/parse'
import {
  activateEphem,
  activeEphem,
  clearManeuver,
  ephemMetas,
  refreshEphemList
} from '@/views/situation/ephem/useUserEphemeris'
import { ephOpen } from '@/views/situation/scene'
import { putSet, getSet } from '@/views/situation/ephem/store'
import { interpolateAt } from '@/views/situation/ephem/interp'
import { gmstRad } from '@/views/situation/ephem/time'
import { twoBodyPropagate } from '@/views/situation/ephem/screening'
import type { EphemManSegment, EphemSet, Vec3 } from '@/views/situation/ephem/types'
import {
  epochToSegment,
  fmtDvWithSense,
  manBasisLabel,
  manDcTypeLabel,
  manDvVectorPhrase,
  manSpeedSense,
  segmentToEpoch
} from '@/views/situation/ephem/maneuverDisplay'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const loadError = ref('')
const filter = ref('')
const statusFilter = ref<'all' | 'ITC' | 'OCM'>('all')
const selectedId = ref('')
const msg = ref('')
const jumping = ref(false)

/* ---------------- 服务端分页（MySQL 元数据库 → /cgi/ephemerides?page=&q=） ---------------- */

const PAGE_SIZE = 20
const page = ref(1)
/** 'db'/'file' = 后端分页可用；'none' = 后端不可用，回退 legacy 全量 + 客户端分页 */
const serverSource = ref<'db' | 'file' | 'none'>('db')
const serverTotal = ref(0)
const serverTotalPages = ref(1)
/** legacy 回退模式的全量行（后端不可用时一次性拉取，客户端过滤+分页） */
const legacyItems = ref<EphListItem[]>([])
let fetchSeq = 0

/** 当前标签是否走服务端分页（服务端模式含本机 IndexedDB 行去重并列展示） */
const serverActive = computed(() => serverSource.value !== 'none')

/* ---------------- 本机导入星历（IndexedDB）并列展示 ---------------- */

const pad2 = (v: number) => String(v).padStart(2, '0')

function fmtUtc(ms: number, withSec = false) {
  const d = new Date(ms)
  const base = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  return withSec ? `${base}:${pad2(d.getUTCSeconds())}` : base
}

function fmtRange(a: number, b: number) {
  return `${fmtUtc(a)} ~ ${fmtUtc(b)} UTC`
}

/** IndexedDB 导入记录 → 列表行（status=local，与服务器样本并列展示；按导入时间倒序） */
const importedRows = computed<EphListItem[]>(() =>
  ephemMetas.value
    .map((m): EphListItem => ({
      id: m.id,
      objectId: '',
      name: m.name,
      norad: String(m.norad || '—'),
      format: String(m.format).toUpperCase() as EphListItem['format'],
      points: m.points,
      step: m.stepSec ? `${m.stepSec} s` : '—',
      stepSec: m.stepSec,
      range: fmtRange(m.start, m.stop),
      startMs: m.start,
      stopMs: m.stop,
      publishedMs: m.createdAt,
      status: 'local',
      size: t('eph.local'),
      covariance: m.hasCov,
      covFrame: m.hasCov ? m.frame : undefined,
      maneuvers: m.maneuvers?.length || 0,
      maneuverSummary: m.maneuvers?.length ? t('eph.maneuverCount', { n: m.maneuvers.length }) : '',
      maneuverEpochs: (m.maneuvers || []).map((s) => segmentToEpoch(s)),
      updatedAt: new Date(m.createdAt).toLocaleString(),
      originator: t('eph.localImport'),
      file: ''
    }))
    .sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0))
)

/** 卡片标题行右侧的发布时间（UTC 紧凑格式；无发布时间不显示） */
function pubLabel(it: EphListItem): string {
  return it.publishedMs ? fmtUtc(it.publishedMs) : ''
}

function pubTitle(it: EphListItem): string {
  return it.publishedMs ? t('eph.publishedAt', { t: fmtUtc(it.publishedMs, true) }) : ''
}

/** legacy 行池：服务器全量 + 本机导入去重合并（后端不可用回退时使用；同 NORAD+格式 服务器优先） */
const allItems = computed<EphListItem[]>(() => {
  const seen = new Set<string>()
  for (const it of legacyItems.value) seen.add(`${it.norad}|${it.format}`)
  const locals = importedRows.value.filter((it) => {
    const key = `${it.norad}|${it.format}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...legacyItems.value, ...locals]
})

/* ---------------- 导入星历文件 / 目录 ---------------- */

const IMPORTED_KEY = 'eph-imported-files'
const fileInput = ref<HTMLInputElement>()
const dirInput = ref<HTMLInputElement>()
const importMsg = ref('')
/** 已导入文件名（本机 localStorage 记录，目录导入时自动跳过） */
const importedNames = new Set<string>((() => {
  try {
    return JSON.parse(localStorage.getItem(IMPORTED_KEY) || '[]') as string[]
  } catch {
    return []
  }
})())

function pickFiles() {
  fileInput.value?.click()
}

function pickDir() {
  dirInput.value?.click()
}

const EPH_FILE_RE = /\.(itc|txt|oem|ocm|e|json|gz)$/i
const EPH_MAX_MB = 12

const upBusy = ref(false)
const upProgress = ref(0)
const upName = ref('')

/* ---------------- 第 6 项：星历归属 / 可见性 ---------------- */
const auth = useAuthStore()
/** 上传默认可见性（业主默认仅自己可见；超管默认全平台可见） */
const upVisibility = ref<'public' | 'private'>('private')
const visBusy = ref(false)
const visMsg = ref('')
const delBusy = ref(false)

/** 仅超管与 VIP 组织账号可上传星历（基础用户不可上传，后端同样 403 兜底） */
const canUpload = computed(
  () =>
    auth.user?.role === 'platform_super_admin' ||
    auth.user?.isVip === true ||
    auth.org?.plan === 'vip'
)

/** 当前登录用户是否为该星历上传业主 */
function isMine(it: EphListItem | null | undefined): boolean {
  return !!it && it.ownerUserId != null && it.ownerUserId === auth.user?.id
}

/** 仅上传业主本人与超管可改可见性 / 删除 */
function canManage(it: EphListItem | null | undefined): boolean {
  if (!it) return false
  return auth.user?.role === 'platform_super_admin' || isMine(it)
}

async function setVisibility(v: 'public' | 'private') {
  const it = selected.value
  if (!it || !canManage(it) || visBusy.value) return
  visBusy.value = true
  visMsg.value = ''
  try {
    await patchEphemerisVisibility(it.id, v)
    it.visibility = v
    const row = serverRows.value.find((r) => r.id === it.id)
    if (row) row.visibility = v
    visMsg.value = v === 'public' ? t('eph.visSetPublic') : t('eph.visSetPrivate')
  } catch (e) {
    visMsg.value = (e as Error)?.message || t('eph.setFail')
  } finally {
    visBusy.value = false
  }
}

function visibilityText(v: EphListItem['visibility']): string {
  return v === 'private' ? t('eph.visPrivate') : v === 'vip' ? t('eph.visVip') : t('eph.visPublic')
}

async function removeSelected() {
  const it = selected.value
  if (!it || !canManage(it) || delBusy.value) return
  if (!window.confirm(t('eph.deleteConfirm', { name: it.name }))) return
  delBusy.value = true
  visMsg.value = ''
  try {
    await deleteEphemeris(it.id)
    selectedId.value = ''
    await fetchServerPage()
    importMsg.value = t('eph.deleted', { name: it.name })
  } catch (e) {
    visMsg.value = (e as Error).message || t('eph.deleteFail')
  } finally {
    delBusy.value = false
  }
}

/** 逐文件顺序上传到服务端入库（MySQL 元数据 + 分片落盘），完成后刷新列表回第一页 */
async function onFilesPicked(e: Event) {
  if (!canUpload.value) return
  const input = e.target as HTMLInputElement
  const all = Array.from(input.files || [])
  input.value = ''
  if (!all.length) return
  const usable = all.filter((f) => EPH_FILE_RE.test(f.name) && f.size <= EPH_MAX_MB * 1024 * 1024)
  const fresh = usable.filter((f) => !importedNames.has(f.name))
  const skippedDup = usable.length - fresh.length
  const dropped = all.length - usable.length
  if (!fresh.length) {
    importMsg.value = t('eph.noNewFiles', {
      dup: skippedDup,
      extra: dropped ? t('eph.noNewFilesExtra', { n: dropped }) : ''
    })
    return
  }
  upBusy.value = true
  upProgress.value = 0
  const stat = { added: 0, updated: 0, skipped: 0, failed: 0 }
  let lastErr = ''
  try {
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i]
      upName.value = f.name
      importMsg.value = t('eph.importing', { i: i + 1, n: fresh.length, name: f.name })
      try {
        const r = await uploadEphemerisFile(f, f.name, auth.user ? upVisibility.value : undefined)
        stat[r.action]++
        importedNames.add(f.name)
      } catch (err) {
        stat.failed++
        lastErr = (err as Error)?.message || t('eph.unknownError')
      }
      upProgress.value = Math.round(((i + 1) / fresh.length) * 100)
    }
    try {
      localStorage.setItem(IMPORTED_KEY, JSON.stringify([...importedNames]))
    } catch {
      /* 存储不可用时仅本次会话内去重 */
    }
    const parts = [
      t('eph.statAdded', { n: stat.added }),
      t('eph.statUpdated', { n: stat.updated }),
      t('eph.statSkipped', { n: stat.skipped + skippedDup })
    ]
    if (dropped) parts.push(t('eph.statIgnored', { n: dropped }))
    if (stat.failed) parts.push(t('eph.statFailed', { n: stat.failed, err: lastErr }))
    importMsg.value = t('eph.importDone', { parts: parts.join(' · ') })
    // 上传成功后刷新服务端列表并回到第一页
    page.value = 1
    await fetchServerPage()
  } finally {
    upBusy.value = false
  }
}

/** 客户端过滤（legacy 回退模式使用；服务端模式由后端 q/format 过滤） */
const clientFiltered = computed(() => {
  return allItems.value.filter((it) => {
    if (statusFilter.value === 'ITC' || statusFilter.value === 'OCM') {
      if (it.format !== statusFilter.value) return false
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

/* ---------------- 列表分页（每页 20 条；服务端分页优先，后端不可用回退客户端分页） ---------------- */

/** 服务端模式下当前页的行 */
const serverRows = ref<EphListItem[]>([])

/** 实际展示行：服务端模式=当前页行；否则=客户端过滤池 */
const displayItems = computed<EphListItem[]>(() =>
  serverActive.value ? serverRows.value : clientFiltered.value
)

const totalPagesView = computed(() => {
  if (serverActive.value) return Math.max(1, serverTotalPages.value)
  return Math.max(1, Math.ceil(clientFiltered.value.length / PAGE_SIZE))
})

const paged = computed(() => {
  if (serverActive.value) return displayItems.value
  const p = Math.min(page.value, totalPagesView.value)
  return clientFiltered.value.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
})

/** 拉取服务端一页（带竞态保护；后端不可用自动回退 legacy 全量 + 客户端分页） */
async function fetchServerPage() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const format =
      statusFilter.value === 'ITC' || statusFilter.value === 'OCM' ? statusFilter.value : undefined
    const data = await listLocalEphemerides({
      page: page.value,
      size: PAGE_SIZE,
      format,
      q: filter.value.trim() || undefined
    })
    if (seq !== fetchSeq) return
    serverSource.value = data.source || 'file'
    serverRows.value = data.items || []
    serverTotal.value = data.total ?? serverRows.value.length
    serverTotalPages.value = data.totalPages ?? 1
  } catch {
    if (seq !== fetchSeq) return
    // 后端不可用 → 一次性拉全量（legacy 模式），客户端过滤 + 分页
    serverSource.value = 'none'
    serverRows.value = []
    try {
      const all = await listLocalEphemerides()
      if (seq !== fetchSeq) return
      legacyItems.value = all.items || []
    } catch {
      if (seq === fetchSeq) legacyItems.value = []
    }
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

let fetchTimer: ReturnType<typeof setTimeout> | undefined
/** 搜索/筛选防抖：输入时避免每键一次请求 */
function scheduleFetch() {
  if (fetchTimer) clearTimeout(fetchTimer)
  fetchTimer = setTimeout(() => void fetchServerPage(), 250)
}

watch([filter, statusFilter], () => {
  page.value = 1
  if (serverActive.value) scheduleFetch()
})

watch(page, () => {
  if (serverActive.value) void fetchServerPage()
})

/**
 * 选中行：当前页内精确匹配 → 跨页保留的缓存行（翻页不丢预览）→ 当页首行
 */
const selectedRow = ref<EphListItem | null>(null)
const selected = computed(() => {
  const pool = displayItems.value
  return pool.find((i) => i.id === selectedId.value) || selectedRow.value || pool[0] || null
})

// 自动选中当页首行时同步 selectedId，保证高亮一致
watch(selected, (row) => {
  if (row && row.id !== selectedId.value) selectedId.value = row.id
})

watch(
  () => route.query.object,
  async (oid) => {
    if (!oid) return
    const key = String(oid)
    if (serverActive.value) {
      // 服务端分页模式：用 q 精确搜索定位（命中 norad / objectId / name）
      try {
        const data = await listLocalEphemerides({ page: 1, size: PAGE_SIZE, q: key })
        const hits = data.items || []
        const hit = hits.find((e) => e.objectId === key || e.norad === key) || hits[0]
        if (hit) {
          selectedId.value = hit.id
          selectedRow.value = hit
        }
      } catch {
        /* 服务端不可用时忽略深链定位 */
      }
      return
    }
    const hit = allItems.value.find((e) => e.objectId === key || e.norad === key)
    if (hit) {
      selectedId.value = hit.id
      selectedRow.value = hit
      // 深链目标可能不在第 1 页：定位到其所在页码
      const idx = clientFiltered.value.findIndex((i) => i.id === hit.id)
      if (idx >= 0) page.value = Math.floor(idx / PAGE_SIZE) + 1
    }
  },
  // immediate：整页直达 /ephemerides?object=xxx 时 query 已存在，无变化也要定位
  { immediate: true }
)

/** 刷新：先触发服务端扫描 data/ephemerides 目录（新拷入未入库的星历自动导入），再重载列表 */
async function refreshServer() {
  loading.value = true
  try {
    const r = await rebuildEphemerides()
    importMsg.value = t('eph.dirChecked', { a: r.added, u: r.updated, s: r.skipped })
  } catch {
    /* 后端不可用时仅刷新现有列表 */
  } finally {
    await reloadList()
  }
}

async function reloadList() {
  loadError.value = ''
  msg.value = ''
  try {
    if (serverActive.value) {
      await fetchServerPage()
    }
    if (!selectedId.value) {
      const first = displayItems.value[0] || null
      selectedId.value = first?.id || ''
      selectedRow.value = first
    }
  } catch (e) {
    loadError.value = (e as Error)?.message || t('eph.loadListFail')
    legacyItems.value = []
  } finally {
    loading.value = false
  }
}

function select(id: string) {
  selectedId.value = id
  selectedRow.value = displayItems.value.find((i) => i.id === id) || selectedRow.value
  msg.value = ''
}

/**
 * 关联至态势：拉取真实星历 → 入库激活 → 跳转 /situation/eph
 * 若有机动摘要则按首个机动时刻施加示意脉冲（橙色机动轨）；否则仅浅蓝主轨。
 */
/** 态势绘制不需要逐点协方差；OCM 全量 cov 会让 IndexedDB 写入/读回很慢甚至失败 */
function stripStatesCovForSituation<T extends { states: { t: number; r: Vec3; v: Vec3; cov?: Float64Array }[]; hasCov?: boolean }>(set: T): T {
  const hadCov = set.states.some((s) => !!s.cov) || set.hasCov === true
  return {
    ...set,
    hasCov: hadCov,
    states: set.states.map((s) => ({ t: s.t, r: s.r, v: s.v }))
  }
}

/** 把 index 里的 MAN 历元挂到 EphemSet（parse 已带 maneuvers 时不覆盖） */
function attachMansFromIndex(set: EphemSet, epochs: { t: number; dvMps?: number; duraSec?: number; id?: string; accX?: number; accY?: number; accZ?: number; refFrame?: string; basis?: string; dcType?: string; purpose?: string; deviceId?: string; extras?: Record<string, string> }[] | undefined) {
  if (set.maneuvers?.length) return set
  if (!epochs?.length) return set
  const t0 = set.states[0]?.t ?? set.start
  const t1 = set.states[set.states.length - 1]?.t ?? set.stop
  const segs = epochs
    .map((m) => epochToSegment(m))
    // 与星历窗口有交集即可（MAN 可能略早于 TRAJ_START，会被绘制层裁掉）
    .filter((s) => s.t1 >= t0 && s.t0 <= t1)
  if (segs.length) set.maneuvers = segs
  return set
}

function previewAuthError(e: unknown, action: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/\b401\b/.test(raw) || /未登录/.test(raw)) {
    return t('eph.err401', { action })
  }
  if (/\b403\b/.test(raw) || /无权|没有权限|权限不足/.test(raw)) {
    return t('eph.err403', { action })
  }
  if (/\b404\b/.test(raw)) {
    return t('eph.err404', { action })
  }
  return t('eph.errOther', { action, err: raw })
}

function fileNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() || 'ephemeris.txt'
  return base.replace(/\.gz$/i, '') || 'ephemeris.txt'
}

/** 把已认证拉取的明文放到新标签预览；同步打开空白页避免拦截，仍被拦则改为下载 */
function openPreviewText(text: string, filename: string, tab: Window | null): 'tab' | 'download' {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const laterRevoke = () => { setTimeout(() => URL.revokeObjectURL(url), 60_000) }
  if (tab && !tab.closed) {
    try { tab.opener = null } catch { /* ignore */ }
    tab.location.replace(url)
    laterRevoke()
    return 'tab'
  }
  const fallback = window.open(url, '_blank')
  if (fallback) {
    try { fallback.opener = null } catch { /* ignore */ }
    laterRevoke()
    return 'tab'
  }
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  laterRevoke()
  return 'download'
}

function viewRawFile() {
  const f = selected.value?.file
  if (!f) return
  // 接口需登录：同步打开空白标签，拉完带凭证的明文后再换成 blob: 预览（token 不进 URL）
  const tab = window.open('', '_blank')
  saveDocsMsg.value = ''
  void (async () => {
    try {
      const body = await fetchEphemerisText(f)
      const name = fileNameFromPath(f)
      const how = openPreviewText(body, name, tab)
      if (how === 'download') {
        saveDocsMsg.value = t('eph.downloadInstead', { name })
      }
    } catch (e) {
      if (tab && !tab.closed) tab.close()
      saveDocsMsg.value = previewAuthError(e, t('eph.actionViewRaw'))
    }
  })()
}

const saveDocsBusy = ref(false)
const saveDocsMsg = ref('')

async function saveToMyDocs() {
  const row = selected.value
  if (!row?.file) {
    saveDocsMsg.value = t('eph.saveDocsNoFile')
    return
  }
  saveDocsBusy.value = true
  saveDocsMsg.value = ''
  try {
    const saved = await saveEphemerisDocument({ path: row.file, name: row.name })
    saveDocsMsg.value = t('eph.saveDocsDone', { name: saved.title })
  } catch (e) {
    saveDocsMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saveDocsBusy.value = false
  }
}

async function openInSituation() {
  const row = selected.value
  if (!row) return
  // 本机导入行：无服务器文件，直接从 IndexedDB 激活
  if (!row.file) {
    jumping.value = true
    msg.value = t('eph.loadingJump', { name: row.name, fmt: row.format })
    try {
      await activateEphem(row.id)
      if (!activeEphem.value || activeEphem.value.id !== row.id) {
        throw new Error(t('eph.activateFailCache'))
      }
      clearManeuver()
      ephOpen.value = true
      await router.push({ path: '/situation' })
      msg.value = t('eph.jumped', { name: row.name })
    } catch (e) {
      msg.value = (e as Error)?.message || t('eph.jumpFail')
    } finally {
      jumping.value = false
    }
    return
  }
  jumping.value = true
  msg.value = t('eph.loadingJump', { name: row.name, fmt: row.format })
  try {
    const body = await fetchEphemerisText(row.file)
    const parsed = parseEphemeris(body, { fileName: row.file, name: row.name, norad: Number(row.norad) || undefined })
    if (!parsed.ok || !parsed.set) throw new Error(parsed.error || t('eph.parseFail'))
    let set = parsed.set
    // 与态势「星历分析」面板内置样本同 ID（builtin[-ocm]-<norad>）→ 跳转后面板卡片可正确高亮
    set.id = row.format === 'OCM' ? `builtin-ocm-${row.norad}` : `builtin-${row.norad}`
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
      throw new Error(t('eph.activateFailWrite'))
    }
    clearManeuver()

    ephOpen.value = true
    await router.push({
      path: '/situation/eph',
      query: { ephId: row.id, norad: row.norad, format: row.format }
    })
    msg.value = t('eph.jumped', { name: row.name })
  } catch (e) {
    msg.value = (e as Error)?.message || t('eph.jumpFail')
  } finally {
    jumping.value = false
  }
}

/* ---------------- 机动信息（时间 / duration / 经纬度表格） ---------------- */

interface ManRow {
  t0: number
  t1: number
  duraSec: number
  lat: string
  lon: string
  dvMps?: number
  acc?: [number, number, number]
  refFrame?: string
  basis?: string
  dcType?: string
  purpose?: string
  id?: string
  dirText: string
  dvText: string
}
const manRows = ref<ManRow[]>([])
const manLoading = ref(false)
const manCache = new Map<string, ManRow[]>()
const expandedMan = ref<number | null>(null)

function toggleManExpand(i: number) {
  expandedMan.value = expandedMan.value === i ? null : i
}

const tMan = (key: string, params?: Record<string, string | number>) => t(key as never, params)
function basisText(basis?: string) { return manBasisLabel(basis, tMan) }
function dcText(dc?: string) { return manDcTypeLabel(dc, tMan) }

/** 纬度 → 「北纬 x.x° / 南纬 x.x°」 */
function fmtLat(lat: number): string {
  return `${lat >= 0 ? t('geo.n') : t('geo.s')} ${Math.abs(lat).toFixed(2)}°`
}

/** 经度 → 「东经 x.x° / 西经 x.x°」 */
function fmtLon(lon: number): string {
  return `${lon >= 0 ? t('geo.e') : t('geo.w')} ${Math.abs(lon).toFixed(2)}°`
}

/** ECI 位置 → 大地经纬度（GMST 旋转、球形近似；与态势机动面板同口径） */
function eciToLatLon(r: Vec3, tMs: number): { lat: number; lon: number } {
  const lat = (Math.atan2(r[2], Math.hypot(r[0], r[1])) * 180) / Math.PI
  let lon = ((Math.atan2(r[1], r[0]) - gmstRad(tMs)) * 180) / Math.PI
  lon = ((lon + 540) % 360) - 180
  return { lat, lon }
}

/** 单次机动行：窗口内直接插值；窗口外（OCM 的 MAN 常早于首点）用最近端点二体推进近似 */
function manRowOf(set: EphemSet, seg: Pick<EphemManSegment, 't0' | 't1' | 'dvMps' | 'acc' | 'refFrame' | 'basis' | 'dcType' | 'purpose' | 'id'> & { duraSec?: number }): ManRow {
  const t0 = seg.t0
  const duraSec = seg.duraSec != null ? seg.duraSec : Math.max(1, Math.round((seg.t1 - seg.t0) / 1000))
  let r: Vec3 | null = null
  let v: Vec3 | null = null
  const st = interpolateAt(set.states, t0)
  if (st) {
    r = st.r
    v = st.v
  } else if (set.states.length) {
    const s0 = set.states[0]
    const sN = set.states[set.states.length - 1]
    const base = t0 < s0.t ? s0 : sN
    const prop = twoBodyPropagate(base.r, base.v, (t0 - base.t) / 1000)
    if (prop) {
      r = prop.r
      v = prop.v
    }
  }
  const ll = r ? eciToLatLon(r, t0) : null
  const sense = r && v && seg.acc ? manSpeedSense(r, v, seg.acc, seg.refFrame) : null
  return {
    t0,
    t1: seg.t1 ?? (t0 + duraSec * 1000),
    duraSec,
    lat: ll ? fmtLat(ll.lat) : '—',
    lon: ll ? fmtLon(ll.lon) : '—',
    dvMps: seg.dvMps,
    acc: seg.acc,
    refFrame: seg.refFrame,
    basis: seg.basis,
    dcType: seg.dcType,
    purpose: seg.purpose,
    id: seg.id,
    dirText: manDvVectorPhrase(seg, r, v),
    dvText: fmtDvWithSense(seg.dvMps, sense, tMan)
  }
}

/** 选中行变化 → 拉取星历并计算每次机动的经纬度（按 id 缓存） */
watch(
  selected,
  async (row) => {
    manRows.value = []
    expandedMan.value = null
    if (!row || !row.maneuverEpochs?.length) return
    const hit = manCache.get(row.id)
    if (hit) {
      manRows.value = hit
      return
    }
    manLoading.value = true
    try {
      let set: EphemSet | null = null
      if (row.file) {
        const body = await fetchEphemerisText(row.file)
        const parsed = parseEphemeris(body, {
          fileName: row.file,
          name: row.name,
          norad: Number(row.norad) || undefined
        })
        if (parsed.ok) set = parsed.set || null
      } else {
        set = (await getSet(row.id)) || null
      }
      if (set?.states.length) {
        // 与态势页同源：优先用解析结果里的 MAN 段；索引无解析值时回退 maneuverEpochs
        const segs: EphemManSegment[] = set.maneuvers?.length
          ? set.maneuvers
          : row.maneuverEpochs.map((m) => epochToSegment(m))
        const rows = segs.map((m) => manRowOf(set as EphemSet, m))
        manRows.value = rows
        manCache.set(row.id, rows)
      }
    } catch {
      /* 计算失败时表格退化为「无」 */
    } finally {
      manLoading.value = false
    }
  },
  { immediate: true }
)

/* ---------------- G1 版本归档（选中行的版本历史：append 账本 + 软删） ---------------- */

const VER_PAGE_SIZE = 10
const verItems = ref<EphVersion[]>([])
const verTotal = ref(0)
const verPage = ref(1)
const verTotalPages = ref(1)
const verLoading = ref(false)
const verErr = ref('')
const verMsg = ref('')
const verBusyId = ref(0)
let verSeq = 0

/** 服务端行才有版本归档（本机导入行 file 为空 → 无） */
const verAvailable = computed(() => !!selected.value?.file)

function fmtVerTime(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? fmtUtc(ms, true) : iso
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 拉取选中行的版本历史（按 NORAD+格式 精确匹配，倒序分页） */
async function fetchVersions() {
  const row = selected.value
  if (!row?.file || !/^\d+$/.test(row.norad)) {
    verItems.value = []
    verTotal.value = 0
    verTotalPages.value = 1
    verErr.value = ''
    return
  }
  const seq = ++verSeq
  verLoading.value = true
  verErr.value = ''
  try {
    const data = await listEphemerisVersions({
      norad: row.norad,
      format: row.format === 'ITC' || row.format === 'OCM' ? row.format : undefined,
      page: verPage.value,
      size: VER_PAGE_SIZE
    })
    if (seq !== verSeq) return
    verItems.value = data.items || []
    verTotal.value = data.total
    verTotalPages.value = data.totalPages
    verPage.value = data.page
  } catch (e) {
    if (seq !== verSeq) return
    verErr.value = (e as Error)?.message || t('eph.verLoadFail')
    verItems.value = []
  } finally {
    if (seq === verSeq) verLoading.value = false
  }
}

watch(selected, () => {
  verPage.value = 1
  verMsg.value = ''
  saveDocsMsg.value = ''
  void fetchVersions()
  void fetchAccSources()
})

watch(verPage, () => {
  void fetchVersions()
})

/** 新标签回放该版本全文（服务端 gunzip，与「查看原文件」同模式；带登录凭证，token 不进 URL） */
function viewVer(v: EphVersion) {
  const tab = window.open('', '_blank')
  verMsg.value = ''
  void (async () => {
    try {
      const body = await fetchEphemerisVersionContent(v.id)
      const name = `ephemeris-version-${v.id}.txt`
      const how = openPreviewText(body, name, tab)
      if (how === 'download') {
        verMsg.value = t('eph.downloadInstead', { name })
      }
    } catch (e) {
      if (tab && !tab.closed) tab.close()
      verMsg.value = previewAuthError(e, t('eph.actionViewVer'))
    }
  })()
}

/** 软删版本（行与文件均保留；需登录，未登录时报 401 提示） */
async function delVer(v: EphVersion) {
  if (verBusyId.value) return
  if (!window.confirm(t('eph.verDeleteConfirm', { id: v.id, t: fmtVerTime(v.createdAt) }))) return
  verBusyId.value = v.id
  verMsg.value = ''
  try {
    await softDeleteEphemerisVersion(v.id)
    verMsg.value = t('eph.verDeleted', { id: v.id })
    await fetchVersions()
  } catch (e) {
    verMsg.value = (e as Error)?.message || t('eph.deleteFail')
  } finally {
    verBusyId.value = 0
  }
}

/* ---------------- G2 精度对比（选中 OCM vs TLE/AOE 的重叠时段 RTN 残差） ---------------- */

const accLoading = ref(false)
const accErr = ref('')
const accSources = ref<AccuracySourceItem[]>([])
/** 源 B 下拉 key：`${kind}:${id}` */
const accBSel = ref('')
const accResult = ref<AccuracyCompareResult | null>(null)
const accBusy = ref(false)
let accSeq = 0

/** 只有服务端 OCM 星历可作基准源 A（本机导入 / ITC 暂不支持） */
const accAvailable = computed(
  () => !!selected.value && selected.value.format === 'OCM' && /^\d+$/.test(selected.value.norad)
)

function accKey(s: AccuracySourceItem): string {
  return `${s.kind}:${s.id}`
}

function parseAccKey(key: string): { kind: AccuracyKind; id?: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  const kind = key.slice(0, i) as AccuracyKind
  const id = key.slice(i + 1)
  if (!['ocm', 'tle', 'aoe'].includes(kind)) return null
  return { kind, id: kind === 'ocm' ? id : undefined }
}

/** 拉取该 NORAD 的可用对比源；默认源 B 优先系统 TLE，其次 AOE，再其他 OCM */
async function fetchAccSources() {
  accResult.value = null
  accErr.value = ''
  const row = selected.value
  if (!accAvailable.value || !row) {
    accSources.value = []
    accBSel.value = ''
    return
  }
  const seq = ++accSeq
  accLoading.value = true
  try {
    const list = await fetchAccuracySources(row.norad)
    if (seq !== accSeq) return
    accSources.value = list
    const pick =
      list.find((s) => s.kind === 'tle') ||
      list.find((s) => s.kind === 'aoe') ||
      list.find((s) => s.kind === 'ocm' && s.id !== row.id) ||
      list[0]
    accBSel.value = pick ? accKey(pick) : ''
    if (!list.length) accErr.value = t('acc.noSources')
  } catch (e) {
    if (seq !== accSeq) return
    accSources.value = []
    accBSel.value = ''
    accErr.value = (e as Error)?.message || t('eph.accLoadFail')
  } finally {
    if (seq === accSeq) accLoading.value = false
  }
}

async function runCompare() {
  const row = selected.value
  if (!row || accBusy.value) return
  const b = parseAccKey(accBSel.value)
  if (!b) {
    accErr.value = t('acc.noSources')
    return
  }
  accBusy.value = true
  accErr.value = ''
  try {
    accResult.value = await postAccuracyCompare({ norad: row.norad, a: { kind: 'ocm', id: row.id }, b })
  } catch (e) {
    accErr.value = (e as Error)?.message || t('eph.accCalcFail')
    accResult.value = null
  } finally {
    accBusy.value = false
  }
}

/** CSV 完整时间戳（含年份，UTC） */
function accIso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

/** 导出对比 CSV（BOM + 注释头摘要 + 逐点残差，复用 H1 事件包同套路） */
function downloadAccCsv() {
  const r = accResult.value
  if (!r) return
  const lines: string[] = []
  lines.push('# Openspace Safety · G2 精度对比（RTN 残差摘要）')
  lines.push('# 免责声明：RTN 残差由开源 SGP4/OCM 解析核计算，仅供作业参考，非认证精度评定产品。')
  lines.push(`# NORAD: ${r.norad}`)
  lines.push(`# A(基准): ${r.a.kind.toUpperCase()} ${r.a.label} epoch=${r.a.epochMs ? accIso(r.a.epochMs) : 'NA'}`)
  lines.push(`# B: ${r.b.kind.toUpperCase()} ${r.b.label} epoch=${r.b.epochMs ? accIso(r.b.epochMs) : 'NA'}`)
  lines.push(`# Overlap(UTC): ${accIso(r.overlap.startMs)} -> ${accIso(r.overlap.stopMs)}`)
  lines.push(`# Samples: ${r.samples}`)
  lines.push(
    `# RMS(km): radial=${r.rms.radialKm.toExponential(4)}, along=${r.rms.alongKm.toExponential(4)}, cross=${r.rms.crossKm.toExponential(4)}, total=${r.rms.totalKm.toExponential(4)}, max=${r.rms.maxKm.toExponential(4)}, mean=${r.rms.meanKm.toExponential(4)}`
  )
  if (r.warnings.length) {
    for (const w of r.warnings) lines.push(`# Warning: ${w}`)
  }
  const hasSigma = r.points.some((p) => p.sigmaRadialKm != null || p.sigmaAlongKm != null || p.sigmaCrossKm != null)
  if (r.covarianceModel === 'tle-age' || hasSigma) {
    lines.push('# Covariance: tle-age (screening age-based sigma; not independent truth)')
  }
  if (r.a.startMs || r.b.startMs) {
    lines.push(`# A start=${r.a.startMs ? accIso(r.a.startMs) : 'NA'} · B start=${r.b.startMs ? accIso(r.b.startMs) : 'NA'}`)
  }
  lines.push(
    hasSigma
      ? '# t(UTC),radial_km,along_km,cross_km,dist_km,sigma_radial_km,sigma_along_km,sigma_cross_km,maha_radial,maha_along,maha_cross'
      : '# t(UTC),radial_km,along_km,cross_km,dist_km'
  )
  const maha = (err: number, sig: number | undefined): string => {
    if (sig === undefined || !(sig > 0) || !Number.isFinite(err)) return ''
    return (Math.abs(err) / sig).toExponential(6)
  }
  for (const p of r.points) {
    const base = `${accIso(p.tMs)},${p.radialKm.toExponential(6)},${p.alongKm.toExponential(6)},${p.crossKm.toExponential(6)},${p.distKm.toExponential(6)}`
    if (!hasSigma) {
      lines.push(base)
      continue
    }
    lines.push(
      `${base},${p.sigmaRadialKm ?? ''},${p.sigmaAlongKm ?? ''},${p.sigmaCrossKm ?? ''},${maha(p.radialKm, p.sigmaRadialKm)},${maha(p.alongKm, p.sigmaAlongKm)},${maha(p.crossKm, p.sigmaCrossKm)}`
    )
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n'
  const name = `OSP-Accuracy-${r.norad}-${r.a.kind}x${r.b.kind}-${new Date(r.overlap.startMs).toISOString().slice(0, 10)}.csv`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

onMounted(() => {
  void reloadList()
  void refreshEphemList()
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
        <button type="button" class="btn" :disabled="loading" @click="refreshServer">{{ t('eph.reload') }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!selected || jumping"
          @click="openInSituation"
        >{{ t('eph.toSituation') }}</button>
      </div>
    </header>

    <section class="upload-zone" :class="{ disabled: !canUpload }">
      <div class="uz-row">
        <div class="uz-text">
          <div class="uz-title">{{ t('eph.importTitle') }}</div>
          <div class="uz-sub">{{ t('eph.importSub') }}</div>
          <div v-if="!canUpload" class="uz-perm warn">{{ t('eph.uploadDenied') }}</div>
          <div v-else class="uz-perm">{{ t('eph.importPerm') }}</div>
        </div>
        <div class="uz-actions">
          <label v-if="auth.user" class="uz-vis">
            <span>{{ t('eph.visibility') }}</span>
            <select v-model="upVisibility" :disabled="!canUpload">
              <option value="private">{{ t('eph.visPrivate') }}</option>
              <option value="public">{{ t('eph.visPublic') }}</option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="upBusy || !canUpload" @click="pickFiles">{{ t('eph.pickFiles') }}</button>
          <button type="button" class="btn" :disabled="upBusy || !canUpload" @click="pickDir">{{ t('eph.pickDir') }}</button>
        </div>
      </div>
      <div v-if="upBusy" class="uz-progress">
        <div class="uz-bar"><i :style="{ width: upProgress + '%' }"></i></div>
        <span class="uz-pname">{{ upName }} · {{ upProgress }}%</span>
      </div>
      <p v-if="importMsg" class="uz-msg">{{ importMsg }}</p>
      <input ref="fileInput" type="file" multiple hidden accept=".itc,.txt,.oem,.ocm,.e,.json,.gz" @change="onFilesPicked" />
      <input ref="dirInput" type="file" multiple hidden webkitdirectory @change="onFilesPicked" />
    </section>

    <section class="split">
      <aside class="list-pane">
        <div class="list-tools">
          <input v-model="filter" type="search" :placeholder="t('eph.filter')" />
          <div class="seg">
            <button type="button" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">{{ t('eph.all') }}</button>
            <button type="button" :class="{ on: statusFilter === 'ITC' }" @click="statusFilter = 'ITC'">ITC</button>
            <button type="button" :class="{ on: statusFilter === 'OCM' }" @click="statusFilter = 'OCM'">OCM</button>
          </div>
        </div>
        <div v-if="loading" class="list-empty">{{ t('eph.loadingList') }}</div>
        <div v-else-if="loadError" class="list-empty err">{{ loadError }}</div>
        <div v-else-if="!paged.length" class="list-empty">{{ t('eph.noMatch') }}</div>
        <div v-else class="list">
          <button
            v-for="it in paged"
            :key="it.id"
            type="button"
            class="row"
            :class="{ on: it.id === selected?.id }"
            @click="select(it.id)"
          >
            <div class="row-top">
              <span class="name">{{ it.name }}</span>
              <span class="pub" :title="pubTitle(it)">{{ pubLabel(it) }}</span>
              <span class="st" :class="it.status">{{ it.status }}</span>
            </div>
            <div class="row-meta">NORAD {{ it.norad }} · {{ it.size }}</div>
            <div class="row-tags">
              <span class="tg" :class="{ ocm: it.format === 'OCM' }">{{ it.format }}</span>
              <span v-if="it.ownerUserId" class="tg up" :title="it.uploadedBy || ''">{{ t('eph.userUploaded') }}</span>
              <span v-if="it.maneuvers > 0" class="tg man">{{ t('eph.maneuverCount', { n: it.maneuvers }) }}</span>
              <span class="tg" :class="{ cov: it.covariance }">{{ it.covariance ? t('eph.hasCov') : t('eph.noCov') }}</span>
              <span v-if="it.visibility === 'private'" class="tg priv">{{ t('eph.visPrivate') }}</span>
              <span v-if="it.visibility === 'vip'" class="tg vip">{{ t('eph.visVip') }}</span>
            </div>
          </button>
        </div>
        <div v-if="!loading && !loadError && paged.length" class="pager">
          <CompactPager v-model:page="page" :total-pages="totalPagesView" :disabled="loading" />
        </div>
      </aside>

      <section class="preview">
        <header class="prev-h">
          <div class="h-title">{{ t('eph.preview') }}</div>
          <div v-if="selected" class="h-sub">{{ selected.name }} · NORAD {{ selected.norad }}</div>
        </header>
        <div v-if="selected" class="prev-body">
          <div class="vis-bar">
            <span class="vis-label">{{ t('eph.visibility') }}</span>
            <span class="vis-badge" :class="(selected.visibility ?? 'public')">
              {{ visibilityText(selected.visibility) }}
            </span>
            <template v-if="canManage(selected)">
              <button type="button" :disabled="visBusy || (selected.visibility ?? 'public') === 'public'" @click="setVisibility('public')">{{ t('eph.visPublic') }}</button>
              <button type="button" :disabled="visBusy || (selected.visibility ?? 'public') === 'private'" @click="setVisibility('private')">{{ t('eph.visPrivate') }}</button>
              <button type="button" class="danger" :disabled="delBusy" @click="removeSelected">{{ delBusy ? t('eph.deleting') : t('eph.deleteEph') }}</button>
            </template>
            <span v-if="visMsg" class="vis-msg">{{ visMsg }}</span>
          </div>
          <dl class="kv">
            <div class="span2"><dt>{{ t('eph.name') }}</dt><dd>{{ selected.name }}</dd></div>
            <div class="span2"><dt>NORAD ID</dt><dd class="mono">{{ selected.norad }}</dd></div>
            <div><dt>{{ t('eph.format') }}</dt><dd>{{ selected.format }}</dd></div>
            <div><dt>{{ t('eph.points') }}</dt><dd>{{ selected.points.toLocaleString() }}</dd></div>
            <div><dt>{{ t('eph.step') }}</dt><dd>{{ selected.step }}</dd></div>
            <div><dt>{{ t('eph.validity') }}</dt><dd>{{ selected.range }}</dd></div>
            <div><dt>{{ t('eph.status') }}</dt><dd><span class="st" :class="selected.status">{{ selected.status }}</span></dd></div>
            <div>
              <dt>{{ t('eph.covariance') }}</dt>
              <dd :class="{ ok: selected.covariance }">{{ selected.covariance ? `${t('eph.yes')}${selected.covFrame ? ' · ' + selected.covFrame : ''}` : t('eph.none') }}</dd>
            </div>
            <div><dt>{{ t('eph.updated') }}</dt><dd>{{ selected.updatedAt }}</dd></div>
            <div class="span-all"><dt>{{ t('eph.origin') }}</dt><dd>{{ selected.originator || '—' }}<span v-if="selected.ownerUserId" class="tg up" :title="selected.uploadedBy || ''">{{ t('eph.userUploaded') }}<template v-if="selected.uploadedBy"> · {{ selected.uploadedBy }}</template></span></dd></div>
            <div class="span-all"><dt>{{ t('eph.file') }}</dt><dd class="mono file-row"><span>{{ selected.file || t('eph.localImport') }}</span><span class="file-actions"><button v-if="selected.file" type="button" class="view-raw" :disabled="saveDocsBusy" @click="saveToMyDocs">{{ saveDocsBusy ? t('eph.saveDocsBusy') : t('eph.saveToDocs') }}</button><button v-if="selected.file" type="button" class="view-raw" :title="t('eph.viewRawTip')" @click="viewRawFile">{{ t('eph.viewRaw') }}</button></span></dd><p v-if="saveDocsMsg" class="save-docs-msg">{{ saveDocsMsg }}</p></div>
          </dl>

          <div class="man-block">
            <div class="man-head">
              <span class="man-title">{{ t('eph.manTitle') }}</span>
              <span class="man-count">{{ manRows.length ? t('eph.maneuverCount', { n: manRows.length }) : (manLoading ? t('eph.calculating') : t('eph.none')) }}</span>
            </div>
            <table v-if="manRows.length" class="man-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{{ t('eph.timeUtc') }}</th>
                  <th>{{ t('eph.duration') }}</th>
                  <th>{{ t('eph.dv') }}</th>
                  <th class="dir-head">{{ t('eph.direction') }} <span class="uvw-hint">{{ t('eph.uvwHint') }}</span></th>
                  <th>{{ t('eph.purpose') }}</th>
                  <th :title="t('eph.latLonDerived')">{{ t('eph.lat') }}</th>
                  <th :title="t('eph.latLonDerived')">{{ t('eph.lon') }}</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="(m, i) in manRows" :key="i">
                  <tr
                    class="man-primary"
                    :class="{ open: expandedMan === i }"
                    :aria-expanded="expandedMan === i"
                    @click="toggleManExpand(i)"
                  >
                    <td>{{ i + 1 }}</td>
                    <td class="mono">{{ fmtUtc(m.t0, true) }}</td>
                    <td>{{ m.duraSec }} s</td>
                    <td class="mono">{{ m.dvText }}</td>
                    <td class="mono dir-cell">{{ m.dirText }}</td>
                    <td>{{ m.purpose || '—' }}</td>
                    <td :title="t('eph.latLonDerived')">{{ m.lat }}</td>
                    <td :title="t('eph.latLonDerived')">{{ m.lon }}</td>
                  </tr>
                  <tr v-if="expandedMan === i" class="man-detail">
                    <td colspan="8">
                      <span>{{ t('eph.endTime') }} {{ fmtUtc(m.t1, true) }}</span>
                      <span>{{ t('eph.basis') }} {{ basisText(m.basis) }}</span>
                      <span>{{ t('eph.dcType') }} {{ dcText(m.dcType) }}</span>
                      <span>{{ t('eph.manId') }} {{ m.id || '—' }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <p v-else class="man-none">{{ manLoading ? t('eph.calculating') : t('eph.none') }}</p>
          </div>

          <div class="ver-block">
            <div class="ver-head">
              <span class="ver-title">{{ t('eph.verTitle') }}</span>
              <span class="ver-count">{{ verLoading && !verItems.length ? t('eph.loadingList') : t('eph.verCount', { n: verTotal }) }}</span>
            </div>
            <template v-if="verAvailable">
              <p v-if="verErr" class="ver-err">{{ verErr }}</p>
              <table v-else-if="verItems.length" class="ver-table">
                <thead>
                  <tr><th>#</th><th>{{ t('eph.verArchived') }}</th><th>{{ t('eph.verPublish') }}</th><th>{{ t('eph.verSource') }}</th><th>SHA-256</th><th>{{ t('eph.verSize') }}</th><th>{{ t('eph.verOps') }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="v in verItems" :key="v.id">
                    <td class="mono">{{ v.id }}</td>
                    <td class="mono">{{ fmtVerTime(v.createdAt) }}</td>
                    <td class="mono">{{ v.publishedMs ? fmtUtc(v.publishedMs) : '—' }}</td>
                    <td>
                      <span class="ver-src" :class="v.source">{{ v.source === 'upload' ? t('eph.verUpload') : t('eph.verScan') }}</span>
                      <span v-if="v.uploadedBy && v.uploadedBy !== 'system' && v.uploadedBy !== 'anonymous'" class="ver-by" :title="v.uploadedBy">{{ v.uploadedBy }}</span>
                    </td>
                    <td class="mono" :title="v.sha256">{{ v.sha256.slice(0, 10) }}…</td>
                    <td>{{ fmtBytes(v.rawBytes) }}</td>
                    <td class="ver-ops">
                      <button type="button" class="ver-btn" @click="viewVer(v)">{{ t('eph.view') }}</button>
                      <button type="button" class="ver-btn del" :disabled="verBusyId === v.id" @click="delVer(v)">{{ t('eph.deleteOne') }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="ver-none">{{ verLoading ? t('eph.loadingList') : t('eph.verEmpty') }}</p>
              <div v-if="verTotalPages > 1" class="ver-pager">
                <button type="button" :disabled="verPage <= 1" @click="verPage--">‹</button>
                <span>{{ verPage }}/{{ verTotalPages }}</span>
                <button type="button" :disabled="verPage >= verTotalPages" @click="verPage++">›</button>
              </div>
            </template>
            <p v-else class="ver-none">{{ t('eph.verLocalNone') }}</p>
            <p v-if="verMsg" class="ver-msg">{{ verMsg }}</p>
          </div>

          <!-- G2 精度对比：选中 OCM 作基准 A，与 TLE/AOE/另一份 OCM 做重叠时段 RTN 残差 -->
          <div class="acc-block">
            <div class="ver-head">
              <span class="acc-title">{{ t('acc.title') }}</span>
              <span class="acc-sub">{{ t('acc.sub') }}</span>
            </div>
            <p v-if="!accAvailable" class="ver-none">{{ t('acc.needOcm') }}</p>
            <template v-else>
              <div class="acc-form">
                <span class="acc-a" :title="selected?.name">{{ t('acc.baseline') }}: OCM {{ selected?.name }}</span>
                <span class="acc-vs">{{ t('acc.vs') }}</span>
                <select v-model="accBSel" class="acc-select" :disabled="accLoading || !accSources.length">
                  <option v-if="!accSources.length" value="">—</option>
                  <option v-for="s in accSources" :key="accKey(s)" :value="accKey(s)">{{ s.label }}</option>
                </select>
                <button type="button" class="ver-btn acc-run" :disabled="accBusy || !accBSel" @click="runCompare">
                  {{ accBusy ? t('acc.running') : t('acc.run') }}
                </button>
              </div>
              <p v-if="accLoading && !accResult" class="ver-none">{{ t('acc.running') }}</p>
              <p v-else-if="accErr" class="ver-err">{{ accErr }}</p>
              <template v-else-if="accResult">
                <AccuracyResidualCharts :result="accResult" />
                <p v-for="(w, i) in accResult.warnings" :key="i" class="acc-warn">{{ w }}</p>
                <button type="button" class="ver-btn" :disabled="accBusy" @click="downloadAccCsv">{{ t('acc.csv') }}</button>
                <p class="acc-note">{{ t('acc.note') }}</p>
                <p class="acc-note">{{ t('acc.chartNote') }}</p>
              </template>
              <p v-else class="ver-none">—</p>
            </template>
          </div>

          <div class="actions-row">
            <button type="button" class="btn primary wide" :disabled="jumping" @click="openInSituation">
              {{ jumping ? '…' : t('eph.toSituation') }}
            </button>
            <p class="hint">{{ t('eph.toSituationHint') }}</p>
          </div>

          <p v-if="msg" class="msg">{{ msg }}</p>
        </div>
        <div v-else class="prev-body">
          <p class="note">{{ loadError || t('eph.selectLeft') }}</p>
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
  background: rgba(74, 125, 154, 0.06);
}
.upload-zone:hover { border-color: var(--accent); }
/* 基础用户不可上传：整块置灰（按钮/下拉均已禁用） */
.upload-zone.disabled { opacity: 0.6; }
.upload-zone.disabled:hover { border-color: var(--border-strong); }
.uz-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.uz-actions { display: flex; gap: 6px; flex: none; }
.uz-progress { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
.uz-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--bg-deep); overflow: hidden; }
.uz-bar i { display: block; height: 100%; background: var(--accent-strong); transition: width 0.2s; }
.uz-pname { flex: none; font-size: 10px; color: var(--text-dim); }
.uz-msg { margin: 8px 0 0; font-size: 11px; color: var(--accent-strong); line-height: 1.5; }
.uz-title { font-size: 13px; font-weight: 600; color: var(--text); }
.uz-sub { margin-top: 4px; font-size: 11px; color: var(--text-dim); }
.uz-perm { margin-top: 6px; font-size: 11px; color: var(--text-muted); }
.uz-perm.warn { color: #e0b45c; }
.uz-vis { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); }
.uz-vis select {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 6px;
}
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
/* 分页条：一行压缩（页码链接 + 当前页/总页数 + 跳转，不显示总条数） */
.pager {
  border-top: 1px solid var(--border); padding: 6px 10px;
  flex: none; min-width: 0;
}
.row {
  appearance: none; text-align: left; border: 1px solid transparent; background: transparent;
  color: var(--text); border-radius: 6px; padding: 8px 10px; cursor: pointer;
}
.row:hover { background: var(--bg-hover); }
.row.on { background: var(--accent-soft); border-color: rgba(74, 125, 154, 0.35); }
.row-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.name { font-size: 12px; font-weight: 600; }
/* 发布时间（OCM CREATION_DATE / ITC CREATED）：标题行右侧、LOCAL 徽标左侧 */
.pub { flex: 1; text-align: right; font-size: 9px; color: var(--text-dim); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
/* 彩色标签（与态势「星历分析」面板 .ep-tag 同款配色） */
.row-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
.tg {
  flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  color: #9dbbdd; background: rgba(110, 160, 230, 0.16); border: 1px solid rgba(110, 160, 230, 0.22);
}
.tg.ocm { color: #ffb46f; background: rgba(255, 150, 50, 0.14); border-color: rgba(255, 160, 60, 0.36); }
.tg.man { color: #ffc98a; background: rgba(255, 170, 70, 0.12); border-color: rgba(255, 170, 80, 0.3); }
.tg.cov { color: #6fe0c0; background: rgba(80, 220, 180, 0.12); border-color: rgba(80, 220, 180, 0.28); }
.tg.priv { color: #c9a8ff; background: rgba(150, 110, 255, 0.14); border-color: rgba(150, 110, 255, 0.34); }
.tg.vip { color: #e0b45c; background: rgba(224, 180, 92, 0.14); border-color: rgba(224, 180, 92, 0.34); }
/* 用户上传标识（VIP 账号上传的星历） */
.tg.up { color: #6fb7ff; background: rgba(80, 150, 255, 0.14); border-color: rgba(90, 160, 255, 0.36); }
.prev-h { padding: 12px; border-bottom: 1px solid var(--border); }
.h-title { font-size: 13px; font-weight: 650; }
.h-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.prev-body { padding: 12px; overflow: auto; }
/* 第 6 项：可见性与删除 */
.vis-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; margin-bottom: 10px;
  border: 1px solid var(--border); border-radius: 6px; background: rgba(255, 255, 255, 0.02);
  font-size: 11px;
}
.vis-label { color: var(--text-dim); }
.vis-badge { padding: 1px 7px; border-radius: 3px; border: 1px solid var(--border); }
.vis-badge.public { color: #6fe0c0; border-color: rgba(80, 220, 180, 0.3); }
.vis-badge.private { color: #c9a8ff; border-color: rgba(150, 110, 255, 0.34); }
.vis-badge.vip { color: #e0b45c; border-color: rgba(224, 180, 92, 0.4); }
.vis-bar button {
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-muted); font-size: 11px; padding: 3px 8px; cursor: pointer;
}
.vis-bar button:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
.vis-bar button:disabled { opacity: 0.45; cursor: default; }
.vis-bar button.danger { color: var(--danger); border-color: rgba(220, 90, 90, 0.4); }
.vis-msg { color: var(--accent-strong); }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
.kv div { background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
.kv dt { font-size: 10px; color: var(--text-dim); margin: 0; }
.kv dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--text); word-break: break-all; }
.kv dd.mono { font-family: var(--mono); font-size: 12px; font-weight: 600; }
.kv dd.ok { color: var(--ok); }
/* 文件行：路径文本 + 右侧「查看原文件」小按钮 */
.kv dd.file-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kv dd.file-row > span:first-child { flex: 1; min-width: 0; }
.file-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.save-docs-msg { margin: 6px 0 0; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.view-raw {
  flex: none;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--accent, #7fb0ff);
  background: rgba(127, 176, 255, 0.08);
  border: 1px solid rgba(127, 176, 255, 0.45);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.view-raw:hover { background: rgba(127, 176, 255, 0.18); border-color: rgba(127, 176, 255, 0.7); }
.kv .span2 { grid-column: span 2; }
.kv .span-all { grid-column: 1 / -1; }
.man-block {
  margin: 0 0 14px; border: 1px solid rgba(255, 180, 84, 0.55);
  background: rgba(255, 180, 84, 0.06); padding: 10px 12px; border-radius: 6px;
}
.man-head { display: flex; align-items: baseline; gap: 8px; }
.man-title { font-size: 11px; color: rgba(255, 180, 84, 0.85); }
.man-count { font-size: 12px; font-weight: 650; color: #ffd9a0; }
.man-table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 11px; }
.man-table th {
  text-align: left; font-weight: 500; color: var(--text-dim);
  border-bottom: 1px solid var(--border); padding: 4px 10px 4px 0; white-space: nowrap;
}
.man-table th.dir-head { white-space: normal; line-height: 1.35; }
.man-table th .uvw-hint,
.uvw-hint { font-size: 9px; font-weight: 400; color: #8a93a6; margin-left: 6px; }
.man-table td { padding: 4px 10px 4px 0; border-bottom: 1px dashed var(--border); color: var(--text); }
.man-table tr:last-child td { border-bottom: none; }
.man-table td.mono { font-family: var(--mono); font-size: 10px; }
.man-table td.dir-cell { white-space: normal; line-height: 1.45; max-width: 24em; }
.man-table tr.man-primary { cursor: pointer; }
.man-table tr.man-primary:hover td { background: rgba(255, 180, 84, 0.08); }
.man-table tr.man-primary.open td { border-bottom-style: dotted; }
.man-table tr.man-detail td {
  padding: 2px 10px 8px 0; font-size: 10px; color: var(--text-dim);
  border-bottom: 1px dashed var(--border);
}
.man-table tr.man-detail span { margin-right: 14px; white-space: nowrap; }
.man-none { margin: 8px 0 0; font-size: 12px; color: var(--text-dim); }
/* 版本历史（G1 归档账本：蓝青色调与机动块区分） */
.ver-block {
  margin: 0 0 14px; border: 1px solid rgba(110, 160, 230, 0.45);
  background: rgba(110, 160, 230, 0.06); padding: 10px 12px; border-radius: 6px;
}
.ver-head { display: flex; align-items: baseline; gap: 8px; }
.ver-title { font-size: 11px; color: rgba(140, 180, 235, 0.9); }
.ver-count { font-size: 12px; font-weight: 650; color: #bcd6f2; }
.ver-table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 11px; }
.ver-table th {
  text-align: left; font-weight: 500; color: var(--text-dim);
  border-bottom: 1px solid var(--border); padding: 4px 8px 4px 0; white-space: nowrap;
}
.ver-table td { padding: 4px 8px 4px 0; border-bottom: 1px dashed var(--border); color: var(--text); }
.ver-table tr:last-child td { border-bottom: none; }
.ver-table td.mono { font-family: var(--mono); font-size: 10px; }
.ver-src { font-size: 9px; line-height: 1; padding: 2px 5px; border-radius: 3px; border: 1px solid; }
.ver-src.upload { color: #9dbbdd; background: rgba(110, 160, 230, 0.16); border-color: rgba(110, 160, 230, 0.22); }
.ver-src.scan { color: #6fe0c0; background: rgba(80, 220, 180, 0.12); border-color: rgba(80, 220, 180, 0.28); }
.ver-by {
  margin-left: 4px; font-size: 9px; color: var(--text-dim); max-width: 110px;
  display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
}
.ver-ops { white-space: nowrap; }
.ver-btn {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text-muted); font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 3px; cursor: pointer;
}
.ver-btn:hover:not(:disabled) { border-color: rgba(74, 125, 154, 0.5); color: var(--text); }
.ver-btn.del:hover:not(:disabled) { border-color: rgba(196, 91, 91, 0.5); color: var(--danger); }
.ver-btn:disabled { opacity: 0.5; cursor: default; }
.ver-none { margin: 8px 0 0; font-size: 12px; color: var(--text-dim); }
.ver-err { margin: 8px 0 0; font-size: 12px; color: var(--danger); }
.ver-msg { margin: 8px 0 0; font-size: 11px; color: var(--accent-strong); }
.ver-pager { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-dim); }
.ver-pager button {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text-muted); font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 3px; cursor: pointer;
}
.ver-pager button:disabled { opacity: 0.4; cursor: default; }
/* 精度对比（G2：青绿色调与版本历史蓝调区分） */
.acc-block {
  margin: 0 0 14px; border: 1px solid rgba(90, 200, 170, 0.45);
  background: rgba(90, 200, 170, 0.06); padding: 10px 12px; border-radius: 6px;
}
.acc-title { font-size: 11px; color: rgba(120, 220, 190, 0.9); }
.acc-sub { font-size: 10px; color: var(--text-dim); }
.acc-form { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.acc-a {
  font-size: 11px; color: var(--text); max-width: 320px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.acc-vs { font-size: 10px; color: var(--text-dim); }
.acc-select {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); font-size: 11px; padding: 4px 8px; border-radius: 4px; max-width: 300px;
}
.acc-select:disabled { opacity: 0.5; }
.acc-run { border-color: rgba(90, 200, 170, 0.5); color: #7ce0c2; }
.acc-meta { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 8px; font-size: 11px; color: var(--text-dim); }
.acc-meta .mono { font-family: var(--mono); font-size: 10px; color: var(--text); }
.acc-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
.acc-kpi {
  border: 1px solid var(--border); background: var(--bg-deep); border-radius: 4px;
  padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.acc-kpi span { font-size: 9px; color: var(--text-dim); white-space: nowrap; }
.acc-kpi b { font-family: var(--mono); font-size: 11px; font-weight: 650; color: var(--text); white-space: nowrap; }
.acc-warn { margin: 8px 0 0; font-size: 11px; color: var(--warn); }
.acc-note { margin: 8px 0 0; font-size: 10px; color: var(--text-dim); line-height: 1.45; }
.actions-row { margin-bottom: 10px; }
.hint { margin: 8px 0 0; font-size: 11px; color: var(--text-dim); line-height: 1.45; }
.msg { margin: 12px 0 0; font-size: 12px; color: var(--accent-strong); }
.note { margin: 12px 0 0; font-size: 11px; color: var(--text-dim); line-height: 1.5; }
@media (max-width: 960px) {
  .split { grid-template-columns: 1fr; }
  .kv { grid-template-columns: repeat(2, 1fr); }
  .kv .span2 { grid-column: 1 / -1; }
  .acc-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
