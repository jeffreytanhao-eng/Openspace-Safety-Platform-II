import { createApp } from './app.js'
import { config } from './config.js'
import { pingDb } from './db/pool.js'
import { ensureEphemSchema, countRowsDb } from './ephem/ephemDb.js'
import { scanAndIngest, importFromIndexJson } from './ephem/ingest.js'

const app = createApp()

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[api] listening on http://0.0.0.0:${config.port}`)
  // 启动时探测一次数据库：失败只提示，不阻塞服务
  void pingDb().then(async (up) => {
    console.log(`[api] database: ${up ? 'up' : 'down'}`)
    if (!up) return
    // 星历元数据库：幂等建表 + 首次从 index.json 迁移 + 增量扫描（后台执行，不阻塞启动）
    if (!(await ensureEphemSchema())) return
    void (async () => {
      try {
        if ((await countRowsDb()) === 0) {
          const { imported } = await importFromIndexJson()
          if (imported) console.log(`[ephem] migrated ${imported} rows from index.json`)
        }
        const r = await scanAndIngest({ exportJson: true })
        console.log(
          `[ephem] scan done: added=${r.added} updated=${r.updated} skipped=${r.skipped} removed=${r.removed} total=${r.total}`
        )
      } catch (e) {
        console.error('[ephem] startup ingest failed:', (e as Error).message)
      }
    })()
  })
})
