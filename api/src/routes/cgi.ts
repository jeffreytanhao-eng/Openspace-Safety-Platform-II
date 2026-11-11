import { Router } from 'express'
import { config } from '../config.js'
import { pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'
import catalog from './catalog.js'
import satTle from './satTle.js'
import satConstellation from './satConstellation.js'
import ephemerides from './ephemerides.js'
import auth from './auth.js'
import org from './org.js'
import admin from './admin.js'
import jobs from './jobs.js'
import objects from './objects.js'
import overview from './overview.js'
import screens from './screens.js'
import events from './events.js'
import ca from './ca.js'
import cred from './cred.js'
import notify from './notify.js'
import maneuvers from './maneuvers.js'
import documents from './documents.js'
import { getDailyFetchStatus } from '../db/fetchDb.js'
import { isDailyFetchRunning } from '../jobs/dailyFetch.js'

const router = Router()

/** 健康检查：服务存活 + 数据库连通 + 日更上次成功时间（C1） */
router.get('/health', async (_req, res) => {
  const dbUp = await pingDb()
  let dailyFetch: unknown = null
  if (dbUp) {
    try {
      const st = await getDailyFetchStatus()
      dailyFetch = { ...st, running: isDailyFetchRunning() || st.running }
    } catch {
      dailyFetch = null // 批次表未就绪时不影响 health
    }
  }
  res.json(ok({
    status: 'up',
    db: dbUp ? 'up' : 'down',
    daily_fetch: dailyFetch,
    time: new Date().toISOString()
  }))
})

/** 前台运行时配置：静态资源基址 */
router.get('/config', (_req, res) => {
  res.json(ok({ staticBase: config.staticBase }))
})

// Epic A: 组织认证（register/login/me，公开挂载，受保护路由在内部用 requireAuth）
router.use(auth)

// Epic A: 组织资料与配额（内部全部 requireAuth）
router.use(org)

// Epic B: 超管（内部 requireAuth + requireSuperAdmin）
router.use(admin)

// Epic C1: 日更任务（POST 触发 / GET 状态，均 requireAuth + requireSuperAdmin）
router.use(jobs)

// Epic D1: 目标（内部 requireAuth + requireOrg + checkQuota）
router.use(objects)
router.use(overview)
router.use(screens)

// Epic E2: 交会事件（列表/详情公开只读；CDM 导入 requireAuth + 组织）
router.use(events)

// Epic F1: 碰撞参数默认值（GET/PUT /ca/defaults，内部 requireAuth）
router.use(ca)

// Epic C2: 客户自配数据凭证（内部 requireAuth + 组织隔离）
router.use(cred)

// Epic H2: 日报与通知（渠道 CRUD / 测试投递 / 投递审计 / 日报预览与手动出报）
router.use(notify)

// Epic J: 机动候选与再筛查（占位任务：候选管理 + 机动后 10 天防新交会复检）
router.use(maneuvers)

// New catalog helpers (stats / paginated tles / cdms)
router.use(catalog)

// Old-platform compatible public sat routes (reconstructed from jsc + frontend contracts)
router.use('/sat_tle', satTle)
router.use('/sat_constellation', satConstellation)

router.use(documents)
router.use(ephemerides)

export default router
