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
  listJobEvents,
  cancelScreenJob
} from '../db/screenDb.js'
import { pool } from '../db/pool.js'
import { cdmIsolation } from '../services/systemPool.js'
import { kickScreeningRunner, abortActiveScreening } from '../jobs/screening.js'
import type { RowDataPacket } from 'mysql2'

const router = Router()

/** R0-2：单任务主星上限（大星座必须分批，避免一次打满队列/CPU） */
const MAX_PRIMARY = Math.max(1, Number(process.env.SCREEN_MAX_PRIMARY ?? 50))

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

  const body = (req.body ?? {}) as {
    windowH?: unknown
    missMaxKm?: unknown
    hbrM?: unknown
    primaryNorads?: unknown
    primarySource?: unknown
    secondarySource?: unknown
  }
  const numOr = (v: unknown, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  const windowH = Math.min(168, Math.max(1, Math.round(numOr(body.windowH, 72))))
  const missMaxKm = Math.min(50, Math.max(0.5, numOr(body.missMaxKm, 10)))
  const hbrM = Math.min(1000, Math.max(1, numOr(body.hbrM, 15)))

  // R0-2：主星可选子集（大星座分批筛查）；不传则默认全部目标
  let primaryNorads: number[] | undefined
  if (body.primaryNorads !== undefined && body.primaryNorads !== null) {
    if (!Array.isArray(body.primaryNorads)) {
      res.status(400).json(fail(400, 'primaryNorads 必须为 NORAD 数组'))
      return
    }
    const arr = Array.from(
      new Set(
        body.primaryNorads
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
      )
    )
    if (!arr.length) {
      res.status(400).json(fail(400, 'primaryNorads 不含有效 NORAD'))
      return
    }
    if (arr.length > MAX_PRIMARY) {
      res.status(400).json(fail(400, `单次筛查最多 ${MAX_PRIMARY} 颗主星，请分批发起`))
      return
    }
    // 归属校验：只能筛本组织已认领目标
    const [rows] = await pool.query<Array<RowDataPacket & { norad_id: number }>>(
      `SELECT norad_id FROM objects WHERE org_id = ? AND claim_status = 'claimed' AND norad_id IN (?)`,
      [org.id, arr]
    )
    const owned = new Set(rows.map((r) => Number(r.norad_id)))
    const notOwned = arr.filter((n) => !owned.has(n))
    if (notOwned.length) {
      res.status(400).json(fail(400, `以下 NORAD 不在本组织目标内：${notOwned.slice(0, 10).join(', ')}${notOwned.length > 10 ? ' …' : ''}`))
      return
    }
    primaryNorads = arr
  } else {
    // 未指定子集时校验托管规模，避免一次性把整星座打进队列
    const [cntRows] = await pool.query<Array<RowDataPacket & { n: number }>>(
      `SELECT COUNT(*) AS n FROM objects WHERE org_id = ? AND claim_status = 'claimed'`,
      [org.id]
    )
    const total = Number(cntRows[0]?.n ?? 0)
    if (total > MAX_PRIMARY) {
      res.status(400).json(
        fail(
          400,
          `本组织托管 ${total} 颗目标，超过单任务上限 ${MAX_PRIMARY}；请用 primaryNorads 指定一批（建议 ${MAX_PRIMARY} 颗以内）分批检测`
        )
      )
      return
    }
  }

  // R2-8：数据源枚举（一单一源；AOE / Stargaze 本轮不提供可选项）
  const primarySource = body.primarySource === 'ephem' ? 'ephem' : 'tle'
  const secondarySource = body.secondarySource === 'cdm' ? 'cdm' : 'catalog'
  if (body.primarySource !== undefined && !['tle', 'ephem'].includes(String(body.primarySource))) {
    res.status(400).json(fail(400, 'primarySource 仅支持 tle | ephem'))
    return
  }
  if (
    body.secondarySource !== undefined &&
    !['catalog', 'cdm'].includes(String(body.secondarySource))
  ) {
    res.status(400).json(fail(400, 'secondarySource 仅支持 catalog | cdm'))
    return
  }

  // 主星 = 精密星历：所选主星必须先绑定星历（否则明确失败，不静默回退 TLE）
  if (primarySource === 'ephem') {
    const [ephRows] = await pool.query<Array<RowDataPacket & { oid: number }>>(
      `SELECT DISTINCT e.bound_object_id AS oid FROM ephemeris e
         JOIN objects o ON o.id = e.bound_object_id
        WHERE o.org_id = ? AND o.claim_status = 'claimed'${
          primaryNorads ? ' AND o.norad_id IN (?)' : ''
        }`,
      primaryNorads ? [org.id, primaryNorads] : [org.id]
    )
    if (!ephRows.length) {
      res.status(400).json(
        fail(400, '所选主星未绑定精密星历：请先在「星历」页绑定，或改用 TLE 主星源')
      )
      return
    }
  }

  // 副星 = CDM 复核：系统池需已有入站 CDM（C4：本组织上传的也计入，他组织的不可见）
  if (secondarySource === 'cdm') {
    try {
      const iso = cdmIsolation(org.id)
      const [c] = await pool.query<Array<RowDataPacket & { n: number }>>(
        `SELECT COUNT(*) AS n FROM sat_cdm WHERE 1 = 1 ${iso.sql}`,
        iso.params
      )
      if (!Number(c[0]?.n ?? 0)) {
        res.status(400).json(
          fail(400, '系统池暂无 CDM 数据（等待日更或先导入客户 CDM），请改用编目 GP 副星源')
        )
        return
      }
    } catch {
      res.status(400).json(fail(400, 'CDM 表不可用，请改用编目 GP 副星源'))
      return
    }
  }

  const id = await createScreenJob({
    orgId: org.id,
    triggeredBy: req.auth!.user.email,
    windowH,
    missMaxKm,
    hbrM,
    primaryNorads,
    primarySource,
    secondarySource
  })
  kickScreeningRunner()
  const job = await getScreenJob(org.id, id)
  res.json(ok(job))
})

/** R0-3：取消任务（queued 直接取消；running 置取消请求，执行侧 10s 内终止） */
router.post('/screens/:id/cancel', requireOrg, async (req: ScopedRequest, res) => {
  const org = req.auth!.org!
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '任务 ID 无效'))
    return
  }
  const r = await cancelScreenJob(org.id, id)
  if (r === 'gone') {
    res.status(409).json(fail(409, '任务不存在或已结束，无法取消'))
    return
  }
  if (r === 'requested') abortActiveScreening(id)
  const job = await getScreenJob(org.id, id)
  res.json(ok({ cancel: r, job }))
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
