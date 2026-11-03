/**
 * 筛查任务路由（Epic E1）：
 *  - POST /cgi/screens        发起筛查（queued → runner 异步执行），配额 screen_day；
 *  - GET  /cgi/screens        任务列表（本组织）；
 *  - GET  /cgi/screens/:id    任务详情 + 事件列表（conjunction_events）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import { quotaExceeded } from '../middleware/plan.js'
import {
  ensureScreenSchema,
  createScreenJob,
  listScreenJobs,
  getScreenJob,
  listJobEvents
} from '../db/screenDb.js'
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

router.use('/screens', requireAuth, async (req, res, next) => {
  if (!(await ensureScreenSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

/** 发起筛查任务（异步：queued → running → done/failed） */
router.post('/screens', requireOrg, async (req: ScopedRequest, res) => {
  const org = req.auth!.org!
  // 配额：冲突语义不存在（新建任务），可直接查
  const exceeded = await quotaExceeded('screen_day', org)
  if (exceeded) {
    res.status(exceeded.status).json(exceeded.body)
    return
  }

  const body = (req.body ?? {}) as { windowH?: unknown; missMaxKm?: unknown; hbrM?: unknown }
  const numOr = (v: unknown, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  const windowH = Math.min(168, Math.max(1, Math.round(numOr(body.windowH, 72))))
  const missMaxKm = Math.min(50, Math.max(0.5, numOr(body.missMaxKm, 10)))
  const hbrM = Math.min(1000, Math.max(1, numOr(body.hbrM, 15)))

  const id = await createScreenJob({
    orgId: org.id,
    triggeredBy: req.auth!.user.email,
    windowH,
    missMaxKm,
    hbrM
  })
  kickScreeningRunner()
  const job = await getScreenJob(org.id, id)
  res.json(ok(job))
})

/** 任务列表（本组织，最新在前） */
router.get('/screens', requireOrg, async (req: ScopedRequest, res) => {
  const jobs = await listScreenJobs(req.auth!.org!.id)
  res.json(ok(jobs))
})

/** 任务详情 + 事件列表 */
router.get('/screens/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '任务 ID 无效'))
    return
  }
  const job = await getScreenJob(req.auth!.org!.id, id)
  if (!job) {
    res.status(404).json(fail(404, '筛查任务不存在'))
    return
  }
  const events = await listJobEvents(id)
  res.json(ok({ job, events }))
})

export default router
