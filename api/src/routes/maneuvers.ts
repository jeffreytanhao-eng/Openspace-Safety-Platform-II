/**
 * 机动候选路由（Epic J 占位任务），挂载于 /cgi：
 *  - GET    /objects/:id/maneuvers      机动候选列表（本组织目标）
 *  - POST   /objects/:id/maneuvers      登记机动候选（proposed；可关联来源交会 event_key）
 *  - PATCH  /maneuvers/:id              更新（状态流转 proposed→approved→executed / cancelled；窗口/ΔV/方向/备注）
 *  - DELETE /maneuvers/:id              删除候选
 *  - POST   /maneuvers/:id/rescreen     机动后再筛查：以当前在编根数对机动窗口结束起 10 天窗口
 *                                       发起单主星防新交会筛查（复用 E1 管线，扣 screen_day 配额）
 *  - GET    /maneuvers/:id/rescreen     查询最近一次再筛查结果（job 状态 + 事件列表 + 摘要）
 *
 * 边界（计划书「仅占位」）：不实现机动引擎（不做 ΔV→轨道推演）；再筛查以日更在编根数为机动后
 * 轨道来源，结果仅代表「当前根数下的防新交会验证」。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import { quotaExceeded } from '../middleware/plan.js'
import { ensureObjectsSchema, getObjectById } from '../db/objectsDb.js'
import {
  ensureManeuverSchema,
  listManeuversByObject,
  getManeuver,
  createManeuver,
  updateManeuver,
  deleteManeuver,
  setRescreenJob,
  type ManeuverRow,
  type ManeuverStatus
} from '../db/maneuverDb.js'
import { createScreenJob, getScreenJob, listJobEvents, type ScreenEventRow } from '../db/screenDb.js'
import { kickScreeningRunner } from '../jobs/screening.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

function requireOrg(req: ScopedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.org || !req.auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  next()
}

/** 两个路由前缀都要过 schema 与鉴权 */
router.use(['/objects/:id/maneuvers', '/maneuvers'], requireAuth, async (req, res, next) => {
  if (!(await ensureObjectsSchema()) || !(await ensureManeuverSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

const STATUSES: ManeuverStatus[] = ['proposed', 'approved', 'executed', 'cancelled']
const DIRECTIONS = ['prograde', 'retrograde', 'radial', 'cross_track', 'other']

/** ISO 时间串 → Date（无效返回 null）；允许 datetime-local 无时区串（按本地时区） */
function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v.trim())
  return Number.isFinite(d.getTime()) ? d : null
}

function parseDv(v: unknown): { ok: true; dv: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, dv: null }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 10000) return { ok: false, error: 'ΔV 需为 0~10000 m/s 的数值' }
  return { ok: true, dv: n }
}

/** 视图：时间转 ISO 便于前端展示 */
function maneuverView(m: ManeuverRow | null): Record<string, unknown> | null {
  if (!m) return null
  return {
    ...m,
    event_tca: m.event_tca ? new Date(m.event_tca).toISOString() : null,
    window_start: new Date(m.window_start).toISOString(),
    window_end: new Date(m.window_end).toISOString(),
    rescreen_at: m.rescreen_at ? new Date(m.rescreen_at).toISOString() : null
  }
}

/* ------------------------------ 列表与登记 ------------------------------ */

/** 机动候选列表（校验目标归属；平台账号可只读查看任意组织目标） */
router.get('/objects/:id/maneuvers', async (req: ScopedRequest, res) => {
  const obj = await getObjectById(Number(req.params.id))
  const platform = !!req.auth?.user.role?.startsWith('platform_')
  if (!req.auth?.org || !req.auth.user.orgId) {
    if (!platform) {
      res.status(403).json(fail(403, '需要组织账号'))
      return
    }
    if (!obj) {
      res.status(404).json(fail(404, '目标不存在'))
      return
    }
    const items = await listManeuversByObject(obj.org_id, obj.id)
    res.json(ok({ items: items.map(maneuverView) }))
    return
  }
  const org = req.auth.org
  if (!obj || obj.org_id !== org.id) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  const items = await listManeuversByObject(org.id, obj.id)
  res.json(ok({ items: items.map(maneuverView) }))
})

/** 登记机动候选 */
router.post('/objects/:id/maneuvers', requireOrg, async (req: ScopedRequest, res) => {
  const org = req.auth!.org!
  const obj = await getObjectById(Number(req.params.id))
  if (!obj || obj.org_id !== org.id) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const ws = parseDate(b.windowStart)
  const we = parseDate(b.windowEnd)
  if (!ws || !we) {
    res.status(400).json(fail(400, 'windowStart / windowEnd 必须为有效时间'))
    return
  }
  if (we.getTime() <= ws.getTime()) {
    res.status(400).json(fail(400, 'windowEnd 必须晚于 windowStart'))
    return
  }
  if (we.getTime() - ws.getTime() > 30 * 24 * 3600_000) {
    res.status(400).json(fail(400, '机动窗口不超过 30 天'))
    return
  }
  const dv = parseDv(b.dvMs)
  if (!dv.ok) {
    res.status(400).json(fail(400, dv.error))
    return
  }
  const direction = String(b.direction ?? '')
  if (direction && !DIRECTIONS.includes(direction)) {
    res.status(400).json(fail(400, `direction 必须为 ${DIRECTIONS.join(' / ')}`))
    return
  }
  const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 500) || null : null
  const eventKey = typeof b.eventKey === 'string' ? b.eventKey.trim().slice(0, 64) || null : null
  const eventTca = parseDate(b.eventTca)
  const eventLevel = typeof b.eventLevel === 'string' && ['red', 'orange', 'yellow'].includes(b.eventLevel) ? b.eventLevel : null

  const row = await createManeuver({
    orgId: org.id,
    objectId: obj.id,
    noradId: obj.norad_id,
    objectName: obj.name,
    eventKey,
    eventTca,
    eventLevel,
    windowStart: ws,
    windowEnd: we,
    dvMs: dv.dv,
    direction,
    notes,
    createdBy: req.auth!.user.email
  })
  res.json(ok(maneuverView(row)))
})

/* ------------------------------ 更新与删除 ------------------------------ */

/** 通用归属校验：返回候选或已写响应 */
async function loadOwned(req: ScopedRequest, res: Response): Promise<ReturnType<typeof getManeuver>> {
  const org = req.auth!.org!
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '候选 ID 无效'))
    return null
  }
  const m = await getManeuver(org.id, id)
  if (!m) {
    res.status(404).json(fail(404, '机动候选不存在'))
    return null
  }
  return m
}

router.patch('/maneuvers/:id', requireOrg, async (req: ScopedRequest, res) => {
  const m = await loadOwned(req, res)
  if (!m) return
  if (m.status === 'cancelled') {
    res.status(409).json(fail(409, '已取消的候选不可再修改'))
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: Parameters<typeof updateManeuver>[2] = {}

  if (b.status !== undefined) {
    const s = String(b.status)
    if (!STATUSES.includes(s as ManeuverStatus)) {
      res.status(400).json(fail(400, `status 必须为 ${STATUSES.join(' / ')}`))
      return
    }
    patch.status = s as ManeuverStatus
  }
  if (b.windowStart !== undefined) {
    const ws = parseDate(b.windowStart)
    if (!ws) {
      res.status(400).json(fail(400, 'windowStart 无效'))
      return
    }
    patch.windowStart = ws
  }
  if (b.windowEnd !== undefined) {
    const we = parseDate(b.windowEnd)
    if (!we) {
      res.status(400).json(fail(400, 'windowEnd 无效'))
      return
    }
    patch.windowEnd = we
  }
  const wsFinal = patch.windowStart ?? new Date(m.window_start)
  const weFinal = patch.windowEnd ?? new Date(m.window_end)
  if (weFinal.getTime() <= wsFinal.getTime()) {
    res.status(400).json(fail(400, 'windowEnd 必须晚于 windowStart'))
    return
  }
  if (weFinal.getTime() - wsFinal.getTime() > 30 * 24 * 3600_000) {
    res.status(400).json(fail(400, '机动窗口不超过 30 天'))
    return
  }
  if (b.dvMs !== undefined) {
    const dv = parseDv(b.dvMs)
    if (!dv.ok) {
      res.status(400).json(fail(400, dv.error))
      return
    }
    patch.dvMs = dv.dv
  }
  if (b.direction !== undefined) {
    const d = String(b.direction)
    if (d && !DIRECTIONS.includes(d)) {
      res.status(400).json(fail(400, `direction 必须为 ${DIRECTIONS.join(' / ')}`))
      return
    }
    patch.direction = d
  }
  if (b.notes !== undefined) {
    patch.notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 500) || null : null
  }
  await updateManeuver(req.auth!.org!.id, m.id, patch)
  res.json(ok(maneuverView(await getManeuver(req.auth!.org!.id, m.id))))
})

router.delete('/maneuvers/:id', requireOrg, async (req: ScopedRequest, res) => {
  const m = await loadOwned(req, res)
  if (!m) return
  await deleteManeuver(req.auth!.org!.id, m.id)
  res.json(ok({ deleted: m.id }))
})

/* ------------------------------ 机动后再筛查 ------------------------------ */

/** 再筛查窗口：机动窗口结束起 10 天（计划书「后续 7–10 天防新交会」取上限） */
const RESCREEN_WINDOW_H = 240
const RESCREEN_MISS_KM = 10
const RESCREEN_HBR_M = 15

/** 发起再筛查（异步任务；扣 screen_day 配额，与普通筛查同池排队） */
router.post('/maneuvers/:id/rescreen', requireOrg, async (req: ScopedRequest, res) => {
  const org = req.auth!.org!
  const m = await loadOwned(req, res)
  if (!m) return
  if (m.status === 'cancelled') {
    res.status(409).json(fail(409, '已取消的候选不可发起再筛查'))
    return
  }
  const exceeded = await quotaExceeded('screen_day', org)
  if (exceeded) {
    res.status(exceeded.status).json(exceeded.body)
    return
  }
  // 窗口起点：机动窗口结束（未来机动=预演起点）；已过期则以当前时刻起算
  const endMs = new Date(m.window_end).getTime()
  const startMs = Math.max(Date.now(), endMs)
  const jobId = await createScreenJob({
    orgId: org.id,
    triggeredBy: `${req.auth!.user.email} (rescreen#${m.id})`,
    windowH: RESCREEN_WINDOW_H,
    missMaxKm: RESCREEN_MISS_KM,
    hbrM: RESCREEN_HBR_M,
    primaryNorads: [m.norad_id],
    startMs
  })
  await setRescreenJob(org.id, m.id, jobId)
  kickScreeningRunner()
  const job = await getScreenJob(org.id, jobId)
  res.json(ok({ job, maneuver: maneuverView(await getManeuver(org.id, m.id)) }))
})

/** 再筛查结果：job 状态 + 事件列表 + 摘要（事件数 / 最高分级 / 最高 Pc） */
router.get('/maneuvers/:id/rescreen', requireOrg, async (req: ScopedRequest, res) => {
  const org = req.auth!.org!
  const m = await loadOwned(req, res)
  if (!m) return
  if (!m.rescreen_job_id) {
    res.status(404).json(fail(404, '尚未发起再筛查'))
    return
  }
  const job = await getScreenJob(org.id, m.rescreen_job_id)
  if (!job) {
    res.status(404).json(fail(404, '再筛查任务不存在'))
    return
  }
  let events: ScreenEventRow[] = []
  if (job.status === 'done') {
    events = await listJobEvents(job.id, 200)
  }
  const LEVEL_RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1 }
  let worstLevel: string | null = null
  let maxPc: number | null = null
  for (const e of events) {
    if (!worstLevel || (LEVEL_RANK[e.level] ?? 0) > (LEVEL_RANK[worstLevel] ?? 0)) worstLevel = e.level
    if (e.pc != null && (maxPc == null || e.pc > maxPc)) maxPc = e.pc
  }
  res.json(
    ok({
      job,
      events,
      summary: { n_events: events.length, worst_level: worstLevel, max_pc: maxPc },
      maneuver: maneuverView(await getManeuver(org.id, m.id))
    })
  )
})

export default router
