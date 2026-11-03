/**
 * 日更任务路由（Epic C1）：
 *  - POST /cgi/jobs/daily-fetch        超管手动触发（同步跑完返回各源结果）
 *  - GET  /cgi/jobs/daily-fetch/status 各源最近批次 + 上次成功时间
 */
import { Router, type Request } from 'express'
import { requireAuth } from './auth.js'
import { requireSuperAdmin } from './admin.js'
import { ok, fail } from '../utils/response.js'
import { ensureFetchSchema, getDailyFetchStatus } from '../db/fetchDb.js'
import { runDailyFetch, isDailyFetchRunning } from '../jobs/dailyFetch.js'

const router = Router()

type ScopedRequest = Request & { auth?: import('./auth.js').AuthContext }

router.post('/jobs/daily-fetch', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (isDailyFetchRunning()) {
    res.status(409).json(fail(409, '日更任务正在运行中，请稍后再试'))
    return
  }
  const triggeredBy = `manual:${req.auth?.user.email ?? 'unknown'}`
  try {
    const { results } = await runDailyFetch(triggeredBy)
    res.json(ok({ triggered_by: triggeredBy, results }))
  } catch (e) {
    console.error('[jobs/daily-fetch]', e)
    res.status(500).json(fail(500, (e as Error).message || '日更任务失败'))
  }
})

router.get('/jobs/daily-fetch/status', requireAuth, requireSuperAdmin, async (_req, res) => {
  if (!(await ensureFetchSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  try {
    const st = await getDailyFetchStatus()
    res.json(ok({ ...st, running: isDailyFetchRunning() || st.running }))
  } catch (e) {
    console.error('[jobs/daily-fetch/status]', e)
    res.status(500).json(fail(500, (e as Error).message || '查询失败'))
  }
})

export default router
