<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAuthStore } from '@/stores/auth'
import {
  listObjects,
  lookupObject,
  claimObject,
  batchClaimObjects,
  getOrgQuota,
  getObject,
  updateObject,
  releaseObject,
  bindEphem,
  unbindEphem,
  type ManagedObject,
  type ObjectDetail,
  type LookupResult,
  type ClaimType
} from '@/api/objects'
import { searchCatalogLite, type CatalogLiteRow } from '@/api/objects'
import { listLocalEphemerides, type EphListItem } from '@/api/ephemerides'
import {
  listEvents,
  listRecentCdms,
  type ConjunctionEvent,
  type EventLevel,
  type RecentCdm
} from '@/api/events'
import {
  listManeuvers,
  createManeuver,
  updateManeuver,
  deleteManeuver,
  startRescreen,
  getRescreen,
  type ManeuverPlan,
  type RescreenResult
} from '@/api/maneuvers'
import { AuthError } from '@/api/auth'
import { getCaProfiles, type CaParams } from '@/api/ca'

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
onMounted(() => {
  void load()
  void loadQuota()
})

/* ---- 认领对话框 ---- */
const claimOpen = ref(false)
const claimNorad = ref('')
const claimType = ref<ClaimType>('normal')
const claimForm = ref({ massKg: '', crossSectionM2: '', propulsion: '' })
const preview = ref<LookupResult | null>(null)
const auth = useAuthStore()
/** 平台账号（无组织）：全平台只读视图 */
const isPlatform = computed(() => !auth.org)
/** C0：业主认领仅 VIP（且组织状态正常）可选；其余档位只保留关注 */
const vipClaim = computed(() => auth.org?.plan === 'vip' && auth.org?.status === 'active')
/** 该目标已有授权认领、本组织非 VIP、或不在业主授权范围（C1）时，授权选项不可选 */
const ownerLocked = computed(() => {
  if (!vipClaim.value || preview.value?.owner_claim) return true
  const scope = preview.value?.owner_scope
  return !!scope && !scope.allowed
})
const previewLoading = ref(false)
const claimError = ref('')
const claimNotice = ref('')
const claimQuota = ref(false)
const submitting = ref(false)

function openClaim() {
  claimOpen.value = true
  preview.value = null
  claimError.value = ''
  claimQuota.value = false
  claimNorad.value = ''
  claimType.value = 'normal'
  claimForm.value = { massKg: '', crossSectionM2: '', propulsion: '' }
}
function closeClaim() {
  claimOpen.value = false
}

/* ---------- R2-2 通用编目发现 + 批量认领；R2-3 配额 usage/limit ---------- */

const quotaChip = ref('')
const discQ = ref('')
const discRows = ref<CatalogLiteRow[]>([])
const discPicked = ref<number[]>([])
const discLoading = ref(false)
const discBusy = ref(false)
const discMsg = ref('')

async function loadQuota() {
  try {
    const data = await getOrgQuota()
    const item = data.items.find((x) => x.key === 'objects_max')
    quotaChip.value = item && item.unit === 'count' && item.limit != null ? `${item.usage} / ${item.limit}` : ''
  } catch {
    quotaChip.value = ''
  }
}

async function searchCatalog() {
  const k = discQ.value.trim()
  if (!k) {
    discRows.value = []
    discPicked.value = []
    return
  }
  discLoading.value = true
  discMsg.value = ''
  try {
    const data = await searchCatalogLite(k, 50)
    discRows.value = data.items
    discPicked.value = []
    if (!data.items.length) discMsg.value = t('obj.discNoMatch')
  } catch (e) {
    discMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    discLoading.value = false
  }
}

function toggleDisc(norad: number) {
  const i = discPicked.value.indexOf(norad)
  if (i >= 0) discPicked.value.splice(i, 1)
  else discPicked.value.push(norad)
}

function toggleDiscAll() {
  discPicked.value =
    discPicked.value.length === discRows.value.length ? [] : discRows.value.map((r) => r.norad_id)
}

async function claimPicked() {
  if (!discPicked.value.length) return
  discBusy.value = true
  discMsg.value = ''
  try {
    const r = await batchClaimObjects(discPicked.value)
    const parts: string[] = [t('obj.discDone', { n: r.created.length })]
    const counts: Record<string, number> = {}
    for (const s of r.skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1
    for (const [k, n] of Object.entries(counts)) {
      parts.push(`${t(`obj.discSkip.${k}` as 'obj.discSkip.not_found')} ${n}`)
    }
    discMsg.value = parts.join(' · ')
    discPicked.value = []
    await load()
    await loadQuota()
  } catch (e) {
    discMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    discBusy.value = false
  }
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
    // 已有业主认领 / 非 VIP / 不在授权范围（C1）时，本组织只能做关注
    if (preview.value.owner_claim || ownerLocked.value) claimType.value = 'normal'
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
    const r = await claimObject({
      noradId: preview.value.sat.norad_id,
      claimType: claimType.value,
      // 普通认领不允许维护参数：仅授权认领提交档案字段
      massKg: claimType.value === 'owner' && claimForm.value.massKg !== '' ? Number(claimForm.value.massKg) : null,
      crossSectionM2:
        claimType.value === 'owner' && claimForm.value.crossSectionM2 !== ''
          ? Number(claimForm.value.crossSectionM2)
          : null,
      propulsion: claimType.value === 'owner' ? claimForm.value.propulsion.trim() || undefined : undefined
    })
    claimOpen.value = false
    // 第 5 项：业主认领需超管审核，提交后进入 pending 态
    claimNotice.value = r.pending_review
      ? `业主认领申请已提交（NORAD ${preview.value.sat.norad_id}），等待超管审核通过后方可维护参数与上传星历。`
      : ''
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
/** 仅授权认领（卫星业主）可维护参数与星历绑定 */
const isOwnerClaim = computed(() => selected.value?.claim_type === 'owner')
/** C5：降档/暂停后业主认领冻结为只读（数据保留，不可再维护参数或改绑定） */
const ownerFrozen = computed(() => isOwnerClaim.value && !vipClaim.value)
const ownerEditable = computed(
  () => isOwnerClaim.value && !ownerFrozen.value && (selected.value?.claim_status ?? 'claimed') === 'claimed'
)
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
  resetArchiveAux()
  void loadRelatedEvents(o.norad_id)
  void loadCdmSummary(o.norad_id)
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
    void loadCaParams(d)
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
  await loadBindList()
  await loadManeuvers()
}
function closeDetail() {
  selected.value = null
  mvFormOpen.value = false
  maneuvers.value = []
  mvResults.value = {}
  mvShowResult.value = {}
  resetArchiveAux()
  if (mvTimer) {
    clearTimeout(mvTimer)
    mvTimer = null
  }
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

/* ---- 第 3 项：业主自定义参数（仅认领业主可设置 / 使用，不影响其它用户） ---- */
const caForm = ref({
  hbrMode: 'single' as 'single' | 'both',
  hbrM: 15,
  hbrAM: 15,
  hbrBM: 5,
  acceptedPc: 1e-4,
  acceptedMissKm: 1,
  screenDistanceKm: 10,
  covarianceMode: 'tle-age' as 'tle-age' | 'cdm',
  propagator: 'sgp4' as 'sgp4' | 'numeric',
  windowH: 72,
  stepS: 30,
  foster: true,
  chan: true,
  alfano: false
})
const caHasCustom = ref(false)
const caSaving = ref(false)
const caSaved = ref(false)
const caError = ref('')

function fillCaForm(p: CaParams): void {
  caForm.value = {
    hbrMode: p.hbr_mode,
    hbrM: p.hbr_m,
    hbrAM: p.hbr_a_m ?? 15,
    hbrBM: p.hbr_b_m ?? 5,
    acceptedPc: p.accepted_pc,
    acceptedMissKm: p.accepted_miss_km,
    screenDistanceKm: p.screen_distance_km,
    covarianceMode: p.covariance_mode,
    propagator: p.propagator,
    windowH: p.window_h,
    stepS: p.step_s,
    foster: p.pc_methods.includes('foster'),
    chan: p.pc_methods.includes('chan'),
    alfano: p.pc_methods.includes('alfano')
  }
}

async function loadCaParams(d: ObjectDetail): Promise<void> {
  if (d.claim_type !== 'owner') return
  caHasCustom.value = !!d.ca_params
  caError.value = ''
  caSaved.value = false
  if (d.ca_params) {
    fillCaForm(d.ca_params)
    return
  }
  try {
    const r = await getCaProfiles()
    fillCaForm(r.org_defaults)
  } catch {
    /* 无组织默认时保留表单初值 */
  }
}

async function saveCaParams(): Promise<void> {
  if (!selected.value || caSaving.value) return
  const methods = [caForm.value.foster ? 'foster' : '', caForm.value.chan ? 'chan' : '', caForm.value.alfano ? 'alfano' : '']
    .filter(Boolean)
    .join(',')
  if (!methods) {
    caError.value = t('ca.err.noMethod')
    return
  }
  caSaving.value = true
  caSaved.value = false
  caError.value = ''
  try {
    const d = await updateObject(selected.value.id, {
      params: {
        hbr_mode: caForm.value.hbrMode,
        hbr_m: caForm.value.hbrM,
        hbr_a_m: caForm.value.hbrMode === 'both' ? caForm.value.hbrAM : null,
        hbr_b_m: caForm.value.hbrMode === 'both' ? caForm.value.hbrBM : null,
        accepted_pc: caForm.value.acceptedPc,
        accepted_miss_km: caForm.value.acceptedMissKm,
        screen_distance_km: caForm.value.screenDistanceKm,
        covariance_mode: caForm.value.covarianceMode,
        propagator: caForm.value.propagator,
        window_h: caForm.value.windowH,
        step_s: caForm.value.stepS,
        pc_methods: methods
      }
    })
    selected.value = d
    caHasCustom.value = true
    caSaved.value = true
  } catch (e) {
    caError.value = e instanceof Error ? e.message : String(e)
  } finally {
    caSaving.value = false
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

/* ---- R2-20：目标档案聚合（身份 / 交会 / 星历 / CDM，均只读复用现有接口） ---- */
const noradEph = ref<EphListItem[]>([])
const relEvents = ref<ConjunctionEvent[]>([])
const relLoading = ref(false)
const cdmItems = ref<RecentCdm[]>([])
const cdmLoading = ref(false)

const LEVEL_RANK: Record<string, number> = { red: 4, orange: 3, yellow: 2, low: 1 }

const relWorst = computed<EventLevel | null>(() => {
  let worst: EventLevel | null = null
  for (const e of relEvents.value) {
    if (!worst || (LEVEL_RANK[e.level] ?? 0) > (LEVEL_RANK[worst] ?? 0)) worst = e.level
  }
  return worst
})

const cdmStats = computed(() => {
  let latest = ''
  let maxPc: number | null = null
  for (const r of cdmItems.value) {
    if (r.creation_date && r.creation_date > latest) latest = r.creation_date
    if (r.collision_probability != null && (maxPc == null || r.collision_probability > maxPc)) {
      maxPc = r.collision_probability
    }
  }
  return { count: cdmItems.value.length, latest, maxPc }
})

/** 含 MAN 段的星历（最多列 5 条） */
const manEph = computed(() => noradEph.value.filter((e) => e.maneuvers > 0).slice(0, 5))

const TYPE_KEY: Record<string, Parameters<typeof t>[0]> = {
  PAYLOAD: 'obj.tp.payload',
  DEBRIS: 'obj.tp.debris',
  'ROCKET BODY': 'obj.tp.rocket',
  UNKNOWN: 'obj.tp.unknown'
}

function typeLabel(tp?: string | null): string {
  const key = TYPE_KEY[String(tp || '').toUpperCase()]
  return key ? t(key) : tp || t('obj.tp.unknown')
}

/** 轨道高度显示保留 1 位小数，避免浮点长尾 */
function fmtKm(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1)
}

function resetArchiveAux() {
  noradEph.value = []
  relEvents.value = []
  relLoading.value = false
  cdmItems.value = []
  cdmLoading.value = false
}

/** 近期交会：本目标作为主/次星的 7 天事件（按 TCA 倒序） */
async function loadRelatedEvents(norad: number) {
  relLoading.value = true
  try {
    const data = await listEvents('7d')
    relEvents.value = (data.events ?? [])
      .filter((e) => e.noradA === norad || e.noradB === norad)
      .sort((a, b) => Date.parse(b.tca) - Date.parse(a.tca))
      .slice(0, 6)
  } catch {
    relEvents.value = []
  } finally {
    relLoading.value = false
  }
}

/** CDM 摘要：现有 /catalog/cdms 已按档位历史窗与组织隔离，这里只做 NORAD 过滤 */
async function loadCdmSummary(norad: number) {
  cdmLoading.value = true
  try {
    const data = await listRecentCdms(500)
    cdmItems.value = (data.items ?? []).filter((r) => r.norad_a === norad || r.norad_b === norad)
  } catch {
    cdmItems.value = []
  } finally {
    cdmLoading.value = false
  }
}

async function loadBindList() {
  if (!selected.value) return
  bindLoading.value = true
  bindPick.value = ''
  bindMsg.value = ''
  try {
    const data = await listLocalEphemerides({ q: String(selected.value.norad_id), size: 50 })
    const rows = data.items.filter((it) => it.norad === String(selected.value!.norad_id))
    noradEph.value = rows
    bindList.value = rows.map((it) => ({ id: it.id, name: it.name, norad: it.norad, format: it.format, points: it.points }))
  } catch (e) {
    noradEph.value = []
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

/* ---- 机动计划（Epic J 占位：候选管理 + 机动后 10 天防新交会再筛查） ---- */
const maneuvers = ref<ManeuverPlan[]>([])
const mvLoading = ref(false)
const mvMsg = ref('')
const mvFormOpen = ref(false)
const mvForm = ref({ windowStart: '', windowEnd: '', dvMs: '', direction: '', notes: '' })
const mvSubmitting = ref(false)
const mvBusyId = ref(0)
const mvResults = ref<Record<number, RescreenResult | null>>({})
const mvShowResult = ref<Record<number, boolean>>({})
let mvTimer: ReturnType<typeof setTimeout> | null = null

/** datetime-local 本地时间串（+ms 偏移） */
function localInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function resetMvForm() {
  const now = Date.now()
  mvForm.value = {
    windowStart: localInput(new Date(now + 3600_000)),
    windowEnd: localInput(new Date(now + 3 * 3600_000)),
    dvMs: '',
    direction: '',
    notes: ''
  }
}

async function loadManeuvers() {
  if (!selected.value) return
  mvLoading.value = true
  mvMsg.value = ''
  try {
    const d = await listManeuvers(selected.value.id)
    maneuvers.value = d.items
    // 有进行中的再筛查则恢复轮询
    for (const m of maneuvers.value) {
      if (m.rescreen_job_id && mvResults.value[m.id] === undefined) {
        void pollRescreen(m.id)
      }
    }
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    mvLoading.value = false
  }
}

function openMvForm() {
  mvFormOpen.value = true
  resetMvForm()
}

async function submitMv() {
  if (!selected.value) return
  if (!mvForm.value.windowStart || !mvForm.value.windowEnd) {
    mvMsg.value = t('mv.errWindow')
    return
  }
  mvSubmitting.value = true
  mvMsg.value = ''
  try {
    await createManeuver(selected.value.id, {
      windowStart: new Date(mvForm.value.windowStart).toISOString(),
      windowEnd: new Date(mvForm.value.windowEnd).toISOString(),
      dvMs: mvForm.value.dvMs === '' ? null : Number(mvForm.value.dvMs),
      direction: mvForm.value.direction,
      notes: mvForm.value.notes.trim() || null
    })
    mvFormOpen.value = false
    await loadManeuvers()
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    mvSubmitting.value = false
  }
}

async function setStatus(m: ManeuverPlan, status: ManeuverPlan['status']) {
  if (status === 'cancelled' && !window.confirm(t('mv.cancelConfirm'))) return
  mvBusyId.value = m.id
  mvMsg.value = ''
  try {
    await updateManeuver(m.id, { status })
    await loadManeuvers()
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    mvBusyId.value = 0
  }
}

async function removeMv(m: ManeuverPlan) {
  if (!window.confirm(t('mv.deleteConfirm'))) return
  mvBusyId.value = m.id
  mvMsg.value = ''
  try {
    await deleteManeuver(m.id)
    delete mvResults.value[m.id]
    await loadManeuvers()
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    mvBusyId.value = 0
  }
}

/** 发起机动后再筛查（异步 job，立即进入轮询展示进度） */
async function doRescreen(m: ManeuverPlan) {
  mvBusyId.value = m.id
  mvMsg.value = ''
  try {
    await startRescreen(m.id)
    mvShowResult.value[m.id] = true
    mvResults.value[m.id] = null
    await loadManeuvers()
    void pollRescreen(m.id)
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    mvBusyId.value = 0
  }
}

/** 轮询再筛查结果直至终态（3s 间隔，展示排队/计算进度） */
async function pollRescreen(maneuverId: number) {
  if (mvTimer) clearTimeout(mvTimer)
  try {
    const d = await getRescreen(maneuverId)
    mvResults.value[maneuverId] = d
    if (d.job.status === 'queued' || d.job.status === 'running') {
      mvTimer = setTimeout(() => void pollRescreen(maneuverId), 3000)
    }
  } catch (e) {
    mvMsg.value = e instanceof Error ? e.message : String(e)
  }
}

function toggleResult(m: ManeuverPlan) {
  mvShowResult.value[m.id] = !mvShowResult.value[m.id]
  if (mvShowResult.value[m.id] && mvResults.value[m.id] === undefined) {
    void pollRescreen(m.id)
  }
}

function fmtPcExp(v: number | null): string {
  if (v == null) return '—'
  return v === 0 ? '0' : v.toExponential(2)
}

/** 再筛查最高分级 → i18n 文案 */
function fmtWorstLevel(v: 'red' | 'orange' | 'yellow' | null): string {
  return v ? t(`scr.level.${v}`) : '—'
}

/** R2-19：机动前（来源交会事件）级别的容错显示 */
function lvLabel(v?: string | null): string {
  return v === 'red' || v === 'orange' || v === 'yellow' ? fmtWorstLevel(v) : '—'
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
        <span v-if="isPlatform" class="pill">{{ t('obj.platformReadonly') }}</span>
        <span class="count">{{ filtered.length }} / {{ objects.length }}</span>
        <span v-if="quotaChip" class="count quota" :title="t('obj.quotaChip')">{{ quotaChip }}</span>
        <button v-if="!isPlatform" type="button" class="btn primary" @click="openClaim">{{ t('obj.claim') }}</button>
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
            <th v-if="isPlatform">{{ t('obj.col.org') }}</th>
            <th>{{ t('obj.col.name') }}</th>
            <th>{{ t('obj.col.norad') }}</th>
            <th>{{ t('obj.col.claimType') }}</th>
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
            <td v-if="isPlatform" class="dim">{{ o.org_name || '—' }}</td>
            <td class="name">{{ o.name }}</td>
            <td class="mono">{{ o.norad_id }}</td>
            <td>
              <span class="pill" :class="o.claim_type === 'owner' ? 'fresh' : 'missing'">
                {{ o.claim_type === 'owner' ? t('obj.claimTypeOwner') : t('obj.claimTypeNormal') }}
              </span>
            </td>
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
        <div v-if="claimNotice" class="hint warn">{{ claimNotice }}</div>
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
          <div v-if="preview.owner_claim" class="hint warn">
            {{ preview.owner_claim.isMine ? t('obj.ownerMine') : t('obj.ownerTaken') }}
          </div>
          <div v-if="preview.my_claim" class="hint warn">
            <template v-if="preview.my_claim.claimStatus === 'pending'">
              {{ t('obj.claimPending') }}：{{ t('obj.claimPendingHint') }}
            </template>
            <template v-else-if="preview.my_claim.claimStatus === 'rejected'">
              {{ t('obj.claimRejected') }}<template v-if="preview.my_claim.reviewNote"> · {{ preview.my_claim.reviewNote }}</template>
              <br />{{ t('obj.claimReapply') }}
            </template>
            <template v-else>
              {{
                t('obj.claimMine', {
                  type: preview.my_claim.claimType === 'owner' ? t('obj.claimTypeOwner') : t('obj.claimTypeNormal')
                })
              }}
            </template>
          </div>
          <template v-if="!preview.my_claim || preview.my_claim.claimStatus === 'rejected'">
            <div class="claim-type">
              <label>
                <input v-model="claimType" type="radio" value="normal" />
                <span>{{ t('obj.claimNormal') }}</span>
              </label>
              <label :class="{ disabled: ownerLocked }">
                <input v-model="claimType" type="radio" value="owner" :disabled="ownerLocked" />
                <span>{{ t('obj.claimOwner') }}</span>
              </label>
            </div>
            <div v-if="!vipClaim" class="hint">{{ t('obj.ownerVipOnly') }}</div>
            <template v-else>
              <div v-if="preview.owner_scope && !preview.owner_scope.configured && !preview.owner_claim" class="hint warn">
                {{ t('obj.ownerScopeNone') }}
              </div>
              <div
                v-else-if="preview.owner_scope && preview.owner_scope.configured && !preview.owner_scope.allowed && !preview.owner_claim"
                class="hint warn"
              >
                {{ t('obj.ownerScopeOut') }}
              </div>
            </template>
            <div v-if="claimType === 'owner'" class="form">
              <label><span>{{ t('obj.mass') }}</span><input v-model="claimForm.massKg" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.crossSection') }}</span><input v-model="claimForm.crossSectionM2" type="number" min="0" step="any" /></label>
              <label><span>{{ t('obj.propulsion') }}</span><input v-model="claimForm.propulsion" type="text" maxlength="60" /></label>
              <p class="type-hint">{{ t('obj.ownerHint') }}</p>
              <p class="type-hint">{{ t('obj.dimNote') }}</p>
            </div>
            <p v-else class="type-hint">{{ t('obj.normalHint') }}</p>
            <button type="button" class="btn primary wide" :disabled="submitting" @click="doClaim">
              {{ submitting ? t('obj.saving') : t('obj.claimSubmit') }}
            </button>
          </template>
        </div>

        <!-- R2-2：通用编目发现 + 批量认领（任意名称 / NORAD / 星座标签批次） -->
        <div class="block">
          <div class="bt">{{ t('obj.discover') }}</div>
          <div class="claim-row">
            <input v-model="discQ" type="search" :placeholder="t('obj.discSearch')" @keyup.enter="searchCatalog" />
            <button type="button" class="btn" :disabled="discLoading" @click="searchCatalog">
              {{ discLoading ? t('obj.claiming') : t('obj.discSearchBtn') }}
            </button>
          </div>
          <div v-if="discMsg" class="hint">{{ discMsg }}</div>
          <div v-if="discRows.length" class="disc-head">
            <label class="disc-all">
              <input type="checkbox" :checked="discPicked.length === discRows.length" @change="toggleDiscAll" />
              {{ t('obj.discAll') }}
            </label>
            <button type="button" class="btn primary" :disabled="!discPicked.length || discBusy" @click="claimPicked">
              {{ discBusy ? t('obj.saving') : t('obj.discClaim', { n: discPicked.length }) }}
            </button>
          </div>
          <ul v-if="discRows.length" class="disc-list">
            <li
              v-for="r in discRows"
              :key="r.norad_id"
              :class="{ on: discPicked.includes(r.norad_id) }"
              @click="toggleDisc(r.norad_id)"
            >
              <input type="checkbox" :checked="discPicked.includes(r.norad_id)" @click.stop="toggleDisc(r.norad_id)" />
              <span class="disc-name">{{ r.object_name }}</span>
              <span class="mono dim">{{ r.norad_id }}</span>
              <span class="dim">{{ r.regime || r.object_type || '' }}</span>
            </li>
          </ul>
        </div>
      </div>
    </aside>

    <!-- 档案抽屉 -->
    <aside v-if="selected" class="drawer" @click.self="closeDetail">
      <div class="drawer-panel">
        <header class="dh">
          <div>
            <div class="d-title">
              {{ selected.name }}
              <span class="pill" :class="isOwnerClaim ? 'fresh' : 'missing'">
                {{ isOwnerClaim ? t('obj.claimTypeOwner') : t('obj.claimTypeNormal') }}
              </span>
            </div>
            <div class="d-sub">NORAD {{ selected.norad_id }}<span v-if="selected.sat"> · {{ selected.sat.regime }}</span></div>
          </div>
          <button type="button" class="x" @click="closeDetail">×</button>
        </header>
        <div v-if="detailError" class="hint err">{{ detailError }}</div>
        <div v-if="detailLoading" class="empty-pad">{{ t('obj.loading') }}</div>
        <template v-else>
          <section class="block sec">
            <div class="sec-h"><span class="bt">{{ t('obj.sec.identity') }}</span></div>
            <div class="pv-grid">
              <div><dt>{{ t('obj.col.name') }}</dt><dd>{{ selected.name }}</dd></div>
              <div><dt>{{ t('obj.col.norad') }}</dt><dd class="mono">{{ selected.norad_id }}</dd></div>
              <div><dt>{{ t('obj.type') }}</dt><dd>{{ typeLabel(selected.sat?.object_type) }}</dd></div>
              <div><dt>{{ t('obj.intlDesig') }}</dt><dd class="mono">{{ selected.sat?.intl_desig || t('obj.noData') }}</dd></div>
              <template v-if="selected.sat">
                <div><dt>{{ t('obj.regime') }}</dt><dd>{{ selected.sat.regime || '—' }}</dd></div>
                <div><dt>{{ t('obj.incl') }}</dt><dd class="mono">{{ selected.sat.incl ?? '—' }}</dd></div>
                <div><dt>{{ t('obj.apogee') }}</dt><dd class="mono">{{ fmtKm(selected.sat.apogee) }}</dd></div>
                <div><dt>{{ t('obj.perigee') }}</dt><dd class="mono">{{ fmtKm(selected.sat.perigee) }}</dd></div>
                <div><dt>{{ t('obj.epoch') }}</dt><dd class="mono">{{ selected.sat.epoch || '—' }}</dd></div>
              </template>
            </div>
            <p v-if="!selected.sat" class="empty">{{ t('obj.noData') }}</p>
          </section>

          <section class="block sec">
            <div class="sec-h">
              <span class="bt">{{ t('obj.sec.orgArchive') }}</span>
              <span class="pill" :class="selected.claim_status === 'pending' ? 'missing' : isOwnerClaim ? 'fresh' : 'missing'">
                {{
                  selected.claim_status === 'pending'
                    ? t('obj.claimPending')
                    : isOwnerClaim
                      ? t('obj.claimTypeOwner')
                      : t('obj.claimTypeNormal')
                }}
              </span>
            </div>
            <div v-if="selected.claim_status === 'pending'" class="hint warn">{{ t('obj.claimPendingHint') }}</div>
            <div v-if="!isOwnerClaim" class="hint warn">{{ t('obj.ownerOnly') }}</div>
            <div v-else-if="ownerFrozen" class="hint warn">{{ t('obj.ownerFrozen') }}</div>
            <div class="form">
              <label><span>{{ t('obj.col.name') }}</span><input v-model="editForm.name" type="text" maxlength="100" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('obj.mass') }}</span><input v-model="editForm.massKg" type="number" min="0" step="any" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('obj.crossSection') }}</span><input v-model="editForm.crossSectionM2" type="number" min="0" step="any" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('obj.propulsion') }}</span><input v-model="editForm.propulsion" type="text" maxlength="60" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('obj.acceptedPc') }}</span><input v-model="editForm.acceptedPc" type="number" min="0" step="any" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('obj.acceptedMissKm') }}</span><input v-model="editForm.acceptedMissKm" type="number" min="0" step="any" :disabled="!ownerEditable" /></label>
            </div>
            <p class="type-hint">{{ t('obj.dimNote') }}</p>
            <div class="row-actions">
              <button type="button" class="btn primary" :disabled="saving || !ownerEditable" @click="saveDetail">
                {{ saving ? t('obj.saving') : t('obj.save') }}
              </button>
              <span v-if="saved" class="ok-text">{{ t('obj.saved') }}</span>
            </div>
          </section>

          <!-- 第 3 项：业主自定义参数（仅对认领业主生效，不影响关注/搜到本目标的其它用户） -->
          <section v-if="isOwnerClaim" class="block sec">
            <div class="sec-h">
              <span class="bt">{{ t('obj.caTitle') }}</span>
              <span class="pill" :class="caHasCustom ? 'fresh' : 'missing'">
                {{ caHasCustom ? t('obj.caCustom') : t('obj.caDefault') }}
              </span>
            </div>
            <p class="type-hint">{{ t('obj.caNote') }}</p>
            <div class="form">
              <label>
                <span>{{ t('ca.f.hbrMode') }}</span>
                <span class="radio-row">
                  <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="single" :disabled="!ownerEditable" /> {{ t('ca.single') }}</label>
                  <label class="radio"><input v-model="caForm.hbrMode" type="radio" value="both" :disabled="!ownerEditable" /> {{ t('ca.both') }}</label>
                </span>
              </label>
              <label v-if="caForm.hbrMode === 'single'"><span>{{ t('ca.f.hbr') }} (m)</span><input v-model.number="caForm.hbrM" type="number" min="1" max="1000" step="1" :disabled="!ownerEditable" /></label>
              <template v-else>
                <label><span>HBR A (m)</span><input v-model.number="caForm.hbrAM" type="number" min="0.1" max="1000" step="0.1" :disabled="!ownerEditable" /></label>
                <label><span>HBR B (m)</span><input v-model.number="caForm.hbrBM" type="number" min="0.1" max="1000" step="0.1" :disabled="!ownerEditable" /></label>
              </template>
              <label><span>{{ t('ca.f.acceptedPc') }}</span><input v-model.number="caForm.acceptedPc" type="number" min="1e-9" max="1" step="1e-5" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('ca.f.acceptedMiss') }} (km)</span><input v-model.number="caForm.acceptedMissKm" type="number" min="0.01" max="100" step="0.1" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('ca.f.screenDist') }} (km)</span><input v-model.number="caForm.screenDistanceKm" type="number" min="0.5" max="100" step="0.5" :disabled="!ownerEditable" /></label>
              <label><span>{{ t('ca.f.covMode') }}</span>
                <select v-model="caForm.covarianceMode" :disabled="!ownerEditable">
                  <option value="tle-age">{{ t('ca.covTleAge') }}</option>
                  <option value="cdm">CDM</option>
                </select>
              </label>
              <label><span>{{ t('ca.f.propagator') }}</span>
                <select v-model="caForm.propagator" :disabled="!ownerEditable">
                  <option value="sgp4">SGP4</option>
                  <option value="numeric">{{ t('ca.propNumeric') }}</option>
                </select>
              </label>
              <label><span>{{ t('ca.f.windowStep') }}</span>
                <span class="inline-pair">
                  <input v-model.number="caForm.windowH" type="number" min="1" max="168" step="1" :disabled="!ownerEditable" /> h /
                  <input v-model.number="caForm.stepS" type="number" min="1" max="3600" step="1" :disabled="!ownerEditable" /> s
                </span>
              </label>
              <label>
                <span>{{ t('ca.f.methods') }}</span>
                <span class="radio-row">
                  <label class="radio"><input v-model="caForm.foster" type="checkbox" :disabled="!ownerEditable" /> Foster</label>
                  <label class="radio"><input v-model="caForm.chan" type="checkbox" :disabled="!ownerEditable" /> Chan</label>
                  <label class="radio"><input v-model="caForm.alfano" type="checkbox" :disabled="!ownerEditable" /> Alfano</label>
                </span>
              </label>
            </div>
            <div class="row-actions">
              <button type="button" class="btn primary" :disabled="caSaving || !ownerEditable" @click="saveCaParams">
                {{ caSaving ? t('obj.saving') : t('obj.caSave') }}
              </button>
              <span v-if="caSaved" class="ok-text">{{ t('obj.saved') }}</span>
              <span v-if="caError" class="err-text">{{ caError }}</span>
            </div>
          </section>

          <section class="block sec">
            <div class="sec-h">
              <span class="bt">{{ t('obj.sec.recentConj') }}</span>
              <span v-if="relWorst" class="lv" :class="`lv-${relWorst}`">{{ lvLabel(relWorst) }}</span>
            </div>
            <p v-if="relLoading" class="empty">{{ t('obj.loading') }}</p>
            <ul v-else-if="relEvents.length" class="rel-list">
              <li v-for="e in relEvents" :key="e.key">
                <RouterLink class="rel-row" :to="`/conjunctions/${encodeURIComponent(e.key)}`">
                  <span class="lv" :class="`lv-${e.level}`">{{ lvLabel(e.level) }}</span>
                  <span class="rel-name">{{ e.noradA === selected.norad_id ? e.nameB : e.nameA }}</span>
                  <span class="mono dim">{{ fmtTime(e.tca) }}</span>
                  <span class="mono">{{ e.missKm != null ? `${e.missKm.toFixed(2)} km` : '—' }}</span>
                  <span class="mono">{{ e.pc != null ? e.pc.toExponential(2) : '—' }}</span>
                </RouterLink>
              </li>
            </ul>
            <p v-else class="empty">{{ t('obj.eventsNone') }}</p>
            <RouterLink v-if="relEvents.length" class="more" to="/conjunctions">{{ t('obj.viewAllConj') }}</RouterLink>
          </section>

          <section class="block sec">
            <div class="sec-h">
              <span class="bt">{{ t('obj.sec.ephemManeuver') }}</span>
              <span class="meta">{{ t('obj.ephCount') }} {{ noradEph.length }}</span>
            </div>
            <div v-if="isPlatform" class="hint">{{ t('obj.platformReadonly') }}</div>
            <div v-else-if="!isOwnerClaim" class="hint warn">{{ t('obj.ownerOnlyBind') }}</div>
            <div v-else-if="ownerFrozen" class="hint warn">{{ t('obj.ownerFrozen') }}</div>
            <ul v-if="selected.ephemerides.length">
              <li v-for="e in selected.ephemerides" :key="e.id">
                <div class="li-top">
                  <span class="li-name">{{ e.name }}</span>
                  <button v-if="ownerEditable" type="button" class="mini" @click="doUnbind(e.id)">{{ t('obj.unbind') }}</button>
                </div>
                <span class="meta">{{ e.format }} · {{ e.points }} pts · {{ e.status }}</span>
              </li>
            </ul>
            <p v-else class="empty">{{ t('obj.noBound') }}</p>
            <p v-if="!noradEph.length" class="empty">{{ t('obj.ephNone') }}</p>
            <div v-if="ownerEditable" class="bind-row">
              <select v-model="bindPick">
                <option value="" disabled>{{ bindLoading ? t('obj.loading') : t('obj.bindSelect') }}</option>
                <option v-for="b in bindList" :key="b.id" :value="b.id">{{ b.format }} · {{ b.name }} · {{ b.points }} pts</option>
              </select>
              <button type="button" class="btn" :disabled="!bindPick" @click="doBind">{{ t('obj.bind') }}</button>
            </div>
            <div v-if="bindMsg" class="hint err">{{ bindMsg }}</div>

            <div class="man">
              <div class="sub-t">{{ t('obj.manSeg') }}</div>
              <ul v-if="manEph.length" class="man-list">
                <li v-for="e in manEph" :key="e.id">
                  <RouterLink class="rel-row man-row" :to="`/ephemerides?q=${selected.norad_id}`">
                    <span class="mono">{{ e.format }}</span>
                    <span class="rel-name">{{ e.range }}</span>
                    <span class="mono">MAN × {{ e.maneuvers }}</span>
                  </RouterLink>
                  <p class="meta man-sum">{{ e.maneuverSummary }}</p>
                </li>
              </ul>
              <p v-else class="empty">{{ t('obj.manNone') }}</p>
            </div>
          </section>

          <section class="block sec">
            <div class="sec-h"><span class="bt">{{ t('obj.sec.cdm') }}</span></div>
            <p v-if="cdmLoading" class="empty">{{ t('obj.loading') }}</p>
            <div v-else-if="cdmStats.count" class="pv-grid">
              <div><dt>{{ t('obj.cdmCount') }}</dt><dd class="mono">{{ cdmStats.count }}</dd></div>
              <div><dt>{{ t('obj.cdmLatest') }}</dt><dd class="mono">{{ cdmStats.latest ? fmtTime(cdmStats.latest) : '—' }}</dd></div>
              <div><dt>{{ t('obj.cdmMaxPc') }}</dt><dd class="mono">{{ fmtPcExp(cdmStats.maxPc) }}</dd></div>
            </div>
            <p v-else class="empty">{{ t('obj.cdmNone') }}</p>
          </section>

          <section class="block sec">
            <div class="bt-row sec-h">
              <div class="bt">{{ t('obj.sec.maneuver') }}</div>
              <button v-if="!isPlatform" type="button" class="mini" @click="mvFormOpen ? (mvFormOpen = false) : openMvForm()">
                {{ mvFormOpen ? t('obj.close') : t('mv.add') }}
              </button>
            </div>
            <p class="mv-hint">{{ t('mv.hint') }}</p>

            <div v-if="mvFormOpen" class="form mv-form">
              <label><span>{{ t('mv.winStart') }}</span><input v-model="mvForm.windowStart" type="datetime-local" /></label>
              <label><span>{{ t('mv.winEnd') }}</span><input v-model="mvForm.windowEnd" type="datetime-local" /></label>
              <label><span>{{ t('mv.dv') }}</span><input v-model="mvForm.dvMs" type="number" min="0" step="any" /></label>
              <label><span>{{ t('mv.direction') }}</span>
                <select v-model="mvForm.direction">
                  <option value="">—</option>
                  <option value="prograde">{{ t('mv.dir.prograde') }}</option>
                  <option value="retrograde">{{ t('mv.dir.retrograde') }}</option>
                  <option value="radial">{{ t('mv.dir.radial') }}</option>
                  <option value="cross_track">{{ t('mv.dir.cross_track') }}</option>
                  <option value="other">{{ t('mv.dir.other') }}</option>
                </select>
              </label>
              <label><span>{{ t('mv.notes') }}</span><input v-model="mvForm.notes" type="text" maxlength="500" /></label>
              <button type="button" class="btn primary" :disabled="mvSubmitting" @click="submitMv">
                {{ mvSubmitting ? t('obj.saving') : t('mv.submit') }}
              </button>
            </div>

            <div v-if="mvMsg" class="hint err">{{ mvMsg }}</div>
            <div v-if="mvLoading" class="empty">{{ t('obj.loading') }}</div>
            <ul v-else-if="maneuvers.length" class="mv-list">
              <li v-for="m in maneuvers" :key="m.id" class="mv-item">
                <div class="li-top">
                  <span class="mv-status" :class="`st-${m.status}`">{{ t(`mv.status.${m.status}`) }}</span>
                  <span class="meta">{{ fmtTime(m.window_start) }} → {{ fmtTime(m.window_end) }}</span>
                </div>
                <div class="mv-line">
                  <span v-if="m.dv_m_s != null">ΔV {{ m.dv_m_s }} m/s</span>
                  <span v-if="m.direction">· {{ t(`mv.dir.${m.direction}`) }}</span>
                  <span v-if="m.event_key">· {{ t('mv.srcEvent') }} {{ m.event_level ? `[${m.event_level}] ` : '' }}{{ m.event_key }}</span>
                </div>
                <div v-if="m.notes" class="meta">{{ m.notes }}</div>
                <div class="mv-actions">
                  <button v-if="m.status === 'proposed'" type="button" class="mini" :disabled="mvBusyId === m.id" @click="setStatus(m, 'approved')">{{ t('mv.approve') }}</button>
                  <button v-if="m.status === 'approved'" type="button" class="mini" :disabled="mvBusyId === m.id" @click="setStatus(m, 'executed')">{{ t('mv.execute') }}</button>
                  <button v-if="m.status !== 'cancelled' && m.status !== 'executed'" type="button" class="mini" :disabled="mvBusyId === m.id" @click="setStatus(m, 'cancelled')">{{ t('mv.cancel') }}</button>
                  <button type="button" class="mini" :disabled="mvBusyId === m.id || m.status === 'cancelled'" @click="doRescreen(m)">{{ t('mv.rescreen') }}</button>
                  <button v-if="m.rescreen_job_id" type="button" class="mini" @click="toggleResult(m)">{{ mvShowResult[m.id] ? t('mv.hideResult') : t('mv.viewResult') }}</button>
                  <button type="button" class="mini" :disabled="mvBusyId === m.id" @click="removeMv(m)">{{ t('mv.delete') }}</button>
                </div>

                <!-- 再筛查结果面板（排队/计算中自动轮询） -->
                <div v-if="mvShowResult[m.id]" class="mv-res">
                  <template v-if="mvResults[m.id] === undefined || mvResults[m.id] === null">
                    <div class="meta">{{ t('mv.loading') }}</div>
                  </template>
                  <template v-else-if="mvResults[m.id]!.job.status === 'queued'">
                    <div class="meta">{{ t('mv.jobQueued') }}</div>
                  </template>
                  <template v-else-if="mvResults[m.id]!.job.status === 'running'">
                    <div class="meta">{{ t('mv.jobRunning') }} · {{ Math.round((Date.now() - new Date(mvResults[m.id]!.job.queued_at).getTime()) / 1000) }}s</div>
                  </template>
                  <template v-else-if="mvResults[m.id]!.job.status === 'failed'">
                    <div class="meta err-text">{{ t('mv.jobFailed') }}: {{ mvResults[m.id]!.job.error_message }}</div>
                  </template>
                  <template v-else>
                    <div class="mv-sum">
                      <span>{{ t('mv.jobDone') }} · {{ mvResults[m.id]!.job.duration_ms }}ms</span>
                      <span>{{ t('mv.summaryEvents') }} {{ mvResults[m.id]!.summary.n_events }}</span>
                      <span>{{ t('mv.worstLevel') }}: {{ fmtWorstLevel(mvResults[m.id]!.summary.worst_level) }}</span>
                      <span>{{ t('mv.maxPc') }}: {{ fmtPcExp(mvResults[m.id]!.summary.max_pc) }}</span>
                    </div>
                    <!-- R2-19：机动前后对比（前=来源交会事件，后=本次再筛查结果） -->
                    <div class="mv-cmp">
                      <div class="side">
                        <b>{{ t('mv.before') }}</b>
                        <span v-if="m.event_key">
                          <RouterLink class="link" :to="`/conjunctions/${encodeURIComponent(m.event_key)}`">{{ m.event_key }}</RouterLink>
                          · {{ lvLabel(m.event_level) }}
                        </span>
                        <span v-else>{{ t('mv.noSourceEvent') }}</span>
                      </div>
                      <div class="arrow">→</div>
                      <div class="side">
                        <b>{{ t('mv.after') }}</b>
                        <span>
                          {{ t('mv.summaryEvents') }} {{ mvResults[m.id]!.summary.n_events }} ·
                          {{ t('mv.worstLevel') }} {{ fmtWorstLevel(mvResults[m.id]!.summary.worst_level) }} ·
                          {{ t('mv.maxPc') }} {{ fmtPcExp(mvResults[m.id]!.summary.max_pc) }}
                        </span>
                      </div>
                    </div>
                    <table v-if="mvResults[m.id]!.events.length" class="mv-tbl">
                      <thead>
                        <tr><th>TCA</th><th>{{ t('mv.colSecondary') }}</th><th>Miss(km)</th><th>Pc</th><th>{{ t('mv.colLevel') }}</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="ev in mvResults[m.id]!.events" :key="ev.id">
                          <td class="mono">{{ fmtTime(ev.tca) }}</td>
                          <td>{{ ev.secondary_name }} <span class="mono dim-text">{{ ev.secondary_norad }}</span></td>
                          <td class="mono">{{ ev.miss_km.toFixed(2) }}</td>
                          <td class="mono">{{ fmtPcExp(ev.pc) }}</td>
                          <td><span class="lv" :class="`lv-${ev.level}`">{{ t(`scr.level.${ev.level}`) }}</span></td>
                        </tr>
                      </tbody>
                    </table>
                    <p v-else class="empty">{{ t('mv.noEvents') }}</p>
                  </template>
                </div>
              </li>
            </ul>
            <p v-else class="empty">{{ t('mv.empty') }}</p>
          </section>

          <div class="block actions">
            <RouterLink class="btn" :to="`/ephemerides?q=${selected.norad_id}`">{{ t('obj.openEphem') }}</RouterLink>
            <RouterLink class="btn" to="/conjunctions">{{ t('obj.relatedConj') }}</RouterLink>
            <button v-if="!isPlatform" type="button" class="btn danger" :disabled="releasing" @click="release">{{ t('obj.release') }}</button>
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
.count.quota { color: var(--accent); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
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
.disc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
.disc-all { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); cursor: pointer; }
.disc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.disc-list li {
  display: grid;
  grid-template-columns: 16px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.disc-list li:last-child { border-bottom: 0; }
.disc-list li.on { background: var(--bg-panel-2); }
.disc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.claim-type { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.claim-type label {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-muted); cursor: pointer;
}
.claim-type label.disabled { opacity: 0.5; cursor: not-allowed; }
.type-hint { margin: 0 0 8px; font-size: 10px; line-height: 1.5; color: var(--text-dim); }
.form input:disabled { opacity: 0.6; cursor: not-allowed; }
.form input, .bind-row select {
  appearance: none; border: 1px solid var(--border); background: var(--bg-deep);
  color: var(--text); border-radius: 4px; padding: 7px 9px; font-size: 12px; outline: none;
}
.block { margin-bottom: 14px; }
.bt { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.row-actions { display: flex; align-items: center; gap: 8px; }
.ok-text { font-size: 11px; color: var(--ok); }
/* 第 3 项：业主自定义参数表单 */
.radio-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.radio-row .radio { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.radio-row input { width: auto; }
.inline-pair { display: inline-flex; align-items: center; gap: 4px; }
.inline-pair input[type='number'] { width: 68px; }
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

/* R2-20 目标档案分区 */
.sec { border-top: 1px solid var(--border); padding-top: 10px; }
.sec-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.sec-h .bt { margin-bottom: 0; }
.rel-list, .man-list { margin: 0; padding: 0; list-style: none; }
.rel-list li, .man-list li { padding: 0; border-bottom: 1px solid var(--border); display: block; }
.rel-row {
  display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center;
  gap: 8px; padding: 7px 0; font-size: 11px; color: var(--text-muted); text-decoration: none;
}
.rel-row:hover { background: var(--bg-hover); }
.rel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.more { display: inline-block; margin-top: 6px; font-size: 11px; color: var(--accent, #38bdf8); text-decoration: none; }
.more:hover { text-decoration: underline; }
.man { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 8px; }
.sub-t { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.man-row { grid-template-columns: auto 1fr auto; }
.man-sum { margin: 0 0 6px; line-height: 1.5; }

/* Epic J 机动计划 */
.bt-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.bt-row .bt { margin-bottom: 0; }
.mv-hint { margin: 0 0 8px; font-size: 10px; line-height: 1.5; color: var(--text-dim); }
.mv-form { border: 1px dashed var(--border); border-radius: 6px; padding: 10px; }
.mv-list { margin: 0; padding: 0; list-style: none; }
.mv-item { padding: 9px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
.mv-status {
  font-size: 10px; padding: 1px 7px; border-radius: 3px; border: 1px solid var(--border);
  letter-spacing: 0.03em;
}
.mv-status.st-proposed { color: var(--text-muted); }
.mv-status.st-approved { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.mv-status.st-executed { color: var(--ok); border-color: rgba(90, 154, 120, 0.4); }
.mv-status.st-cancelled { color: var(--text-dim); text-decoration: line-through; }
.mv-line { font-size: 11px; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 4px; }
.mv-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mv-res { margin-top: 4px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.mv-sum { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
/* R2-19 机动前后对比 */
.mv-cmp {
  display: flex; align-items: stretch; gap: 10px; margin: 8px 0 10px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px;
  background: rgba(120, 150, 180, 0.05); font-size: 11px;
}
.mv-cmp .side { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--text-muted); }
.mv-cmp .side b { font-size: 10px; color: var(--text-dim); font-weight: 600; }
.mv-cmp .arrow { display: flex; align-items: center; color: var(--text-dim); }
.mv-cmp .link { color: var(--accent, #38bdf8); text-decoration: none; }
.mv-cmp .link:hover { text-decoration: underline; }
.mv-tbl { width: 100%; border-collapse: collapse; font-size: 10px; }
.mv-tbl th { text-align: left; color: var(--text-dim); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.mv-tbl td { padding: 4px 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); color: var(--text-muted); }
.err-text { color: var(--danger, #d38); }
.dim-text { color: var(--text-dim); }
.lv { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border); }
.lv-red { color: var(--danger, #d38); border-color: rgba(214, 84, 124, 0.45); }
.lv-orange { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.lv-yellow { color: var(--text-muted); }
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
