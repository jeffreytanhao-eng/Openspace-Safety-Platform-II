import { Router } from 'express'
import { config } from '../config.js'
import { pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'
import catalog from './catalog.js'
import satTle from './satTle.js'
import satConstellation from './satConstellation.js'
import ephemerides from './ephemerides.js'

const router = Router()

/** 健康检查：服务存活 + 数据库连通 */
router.get('/health', async (_req, res) => {
  const dbUp = await pingDb()
  res.json(ok({
    status: 'up',
    db: dbUp ? 'up' : 'down',
    time: new Date().toISOString()
  }))
})

/** 前台运行时配置：静态资源基址 */
router.get('/config', (_req, res) => {
  res.json(ok({ staticBase: config.staticBase }))
})

// New catalog helpers (stats / paginated tles / cdms)
router.use(catalog)

// Old-platform compatible public sat routes (reconstructed from jsc + frontend contracts)
router.use('/sat_tle', satTle)
router.use('/sat_constellation', satConstellation)

router.use(ephemerides)

export default router
