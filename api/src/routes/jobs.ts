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
import {
  ensureStarlinkSchema,
  getStarlinkPullConfig,
  getStarlinkPullStatus,
  saveStarlinkPullConfig,
  type StarlinkFormat
} from '../db/starlinkDb.js'
import { runStarlinkPull, isStarlinkPullRunning } from '../services/pullStarlink.js'

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

/* ------------------------- StarLink 星历拉取 ------------------------- */

const STARLINK_FORMATS: StarlinkFormat[] = ['OCM', 'ITC']

/** 读取配置 + 最近一次拉取状态 */
router.get('/jobs/starlink-pull', requireAuth, requireSuperAdmin, async (_req, res) => {
  if (!(await ensureStarlinkSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const [config, status] = await Promise.all([getStarlinkPullConfig(), getStarlinkPullStatus()])
  res.json(ok({ ...config, status, running: isStarlinkPullRunning() || (status?.running ?? false) }))
})

/** 保存配置：每日拉取开关 / 拉取数量 / 文件类型 */
router.put('/jobs/starlink-pull', requireAuth, requireSuperAdmin, async (req, res) => {
  const body = (req.body || {}) as { enabled?: unknown; count?: unknown; format?: unknown }
  const count = Number(body.count)
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    res.status(400).json(fail(400, '拉取数量需在 1–500 之间'))
    return
  }
  const format = String(body.format || 'OCM').toUpperCase() as StarlinkFormat
  if (!STARLINK_FORMATS.includes(format)) {
    res.status(400).json(fail(400, '文件类型仅支持 OCM / ITC'))
    return
  }
  try {
    await saveStarlinkPullConfig({ enabled: body.enabled === true, count: Math.floor(count), format })
    const [config, status] = await Promise.all([getStarlinkPullConfig(), getStarlinkPullStatus()])
    res.json(ok({ ...config, status, running: isStarlinkPullRunning() || (status?.running ?? false) }))
  } catch (e) {
    console.error('[jobs/starlink-pull] save failed:', (e as Error).message)
    res.status(500).json(fail(500, '保存失败'))
  }
})

/** 手动拉取：异步启动（50×5MB 级下载耗时较长），页面轮询 GET 状态 */
router.post('/jobs/starlink-pull/run', requireAuth, requireSuperAdmin, async (req: ScopedRequest, res) => {
  if (isStarlinkPullRunning()) {
    res.status(409).json(fail(409, 'StarLink 星历拉取正在运行中，请稍后再试'))
    return
  }
  if (!(await ensureStarlinkSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const cfg = await getStarlinkPullConfig()
  const triggeredBy = `manual:${req.auth?.user.email ?? 'unknown'}`
  void runStarlinkPull({ count: cfg.count, format: cfg.format, triggeredBy }).catch((e) => {
    console.error('[jobs/starlink-pull] run failed:', (e as Error).message)
  })
  res.json(ok({ started: true, triggered_by: triggeredBy, count: cfg.count, format: cfg.format }))
})

export default router
