import { createApp } from './app.js'
import { config } from './config.js'
import { pingDb } from './db/pool.js'

const app = createApp()

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[api] listening on http://0.0.0.0:${config.port}`)
  // 启动时探测一次数据库：失败只提示，不阻塞服务
  void pingDb().then((up) => {
    console.log(`[api] database: ${up ? 'up' : 'down'}`)
  })
})
