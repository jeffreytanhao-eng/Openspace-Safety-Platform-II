import express from 'express'
import cors from 'cors'
import compression from 'compression'
import cgiRouter from './routes/cgi.js'
import { fail } from './utils/response.js'

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.use(cors())
  app.use(compression())
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: true }))

  // 接口统一前缀 /cgi
  app.use('/cgi', cgiRouter)

  // 静态文件（后续上传资源使用；目录不存在时由 nginx/反代兜底）
  app.use('/uploads', express.static('uploads', { fallthrough: true }))

  app.use((_req, res) => {
    res.status(404).json(fail(404, 'Not Found'))
  })

  // 统一错误处理
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] unhandled error:', err)
    res.status(500).json(fail(500, 'Internal Server Error'))
  })

  return app
}
