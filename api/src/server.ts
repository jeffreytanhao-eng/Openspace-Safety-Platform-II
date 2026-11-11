import { createApp } from './app.js'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { pingDb } from './db/pool.js'
import { ensureEphemSchema, countRowsDb } from './ephem/ephemDb.js'
import { scanAndIngest, importFromIndexJson } from './ephem/ingest.js'
import { ensureOrgSchema, ensurePlatformAdmin } from './db/orgDb.js'
import { ensureFixedAccounts } from './db/fixedAccounts.js'
import { ensurePlanSchema } from './db/planDb.js'
import { ensureFetchSchema } from './db/fetchDb.js'
import { startDailyFetchScheduler, parseDailyCron } from './jobs/dailyFetch.js'
import { startStarlinkPullScheduler } from './services/pullStarlink.js'
import { startDailyReportScheduler } from './jobs/dailyReport.js'

const app = createApp()

app.listen(config.port, config.listenHost, () => {
  console.log(`[api] listening on http://${config.listenHost}:${config.port}`)
  // 启动时探测一次数据库：失败只提示，不阻塞服务
  void pingDb().then(async (up) => {
    console.log(`[api] database: ${up ? 'up' : 'down'}`)
    if (!up) return
    // 星历元数据库：幂等建表 + 首次从 index.json 迁移 + 增量扫描（后台执行，不阻塞启动）
    if (!(await ensureEphemSchema())) return
    // 组织/用户库表（Epic A）：幂等建表，失败只提示不阻塞启动
    if (!(await ensureOrgSchema())) console.warn('[org] schema not ready (db down?)')
    // 档位默认限额：001_init.sql 建表后表内为空，必须启动即 seed，
    // 否则新组织在访问运营页面前配额为 unlimited（objects_max/screen_day 等失效）
    if (!(await ensurePlanSchema())) console.warn('[plan] schema not ready (db down?)')
    // 日更批次/版本化快照表（Epic C1）+ 每日调度器
    if (await ensureFetchSchema()) startDailyFetchScheduler()
    else console.warn('[fetch] schema not ready, daily-fetch scheduler not started')
    // StarLink 星历拉取调度器（UTC 00:00，配置开启时才执行）
    startStarlinkPullScheduler()
    // 日报调度器（Epic H2）：复用 'M H * * *' 解析；通知表由路由/job 内幂等建表
    startDailyReportScheduler(parseDailyCron, config.dailyReportCron)
    // 平台超管 bootstrap（Epic B1）：凭据来自 .env，首次启动创建
    try {
      if (config.platformAdmin.password) {
        const created = await ensurePlatformAdmin(
          config.platformAdmin.email,
          await bcrypt.hash(config.platformAdmin.password, 10)
        )
        if (created) console.log(`[admin] platform admin created: ${config.platformAdmin.email}`)
      } else {
        console.warn('[admin] PLATFORM_ADMIN_PASSWORD 未设置，跳过平台超管 bootstrap')
      }
    } catch (e) {
      console.error('[admin] platform admin bootstrap failed:', (e as Error).message)
    }
    // 固定测试账号（xingwang / gaoxiao / admin）：每次启动幂等对齐，不随版本与部署变化
    try {
      await ensureFixedAccounts()
    } catch (e) {
      console.error('[test-account] bootstrap failed:', (e as Error).message)
    }
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
