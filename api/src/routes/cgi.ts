import { Router } from 'express'
import { config } from '../config.js'
import { pingDb } from '../db/pool.js'
import { ok } from '../utils/response.js'

const router = Router()

/** 健康检查：服务存活 + 数据库连通性 */
router.get('/health', async (_req, res) => {
  const dbUp = await pingDb()
  res.json(ok({
    status: 'up',
    db: dbUp ? 'up' : 'down',
    time: new Date().toISOString()
  }))
})

/** 前台运行时配置：静态资源基址（前端 scene.ts 读取） */
router.get('/config', (_req, res) => {
  res.json(ok({ staticBase: config.staticBase }))
})

export default router
