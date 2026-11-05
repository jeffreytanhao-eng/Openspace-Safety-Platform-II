/**
 * 总览驾驶舱汇总接口（Epic D2）：真实数据聚合，无假随机 KPI。
 * - 组织资产：objects 目标数（平台账号为 0）
 * - 关注事件口径：系统 CDM 快照按 TCA 时间窗统计（E1 后替换为 conjunction_events）
 * - 星历：本地元数据总数 / 仍有效（stop_ms > now）数
 * - 数据源健康：daily_fetch 三源最近批次状态（GP / CDM / AOE）
 */
import { Router, type Request } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { ok, fail } from '../utils/response.js'
import { pool } from '../db/pool.js'
import { requireAuth, type AuthContext } from './auth.js'
import { getDailyFetchStatus } from '../db/fetchDb.js'
import { countScreensToday } from '../db/screenDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

router.get('/overview/summary', requireAuth, async (req: ScopedRequest, res) => {
  try {
    const orgId = req.auth?.user.orgId ? Number(req.auth.user.orgId) : null
    // 与 /cgi/objects 等客户业务接口口径一致：平台账号（无组织）不返回「系统池」半成功视图
    if (!orgId) {
      res.status(403).json(fail(403, '需要组织账号'))
      return
    }

    // 目标数 + 托管 NORAD 集合（平台账号无组织 → 0）
    let owned = 0
    let ownedNorads: number[] = []
    if (orgId) {
      const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
        'SELECT COUNT(*) AS n FROM objects WHERE org_id = ?',
        [orgId]
      )
      owned = Number(rows[0]?.n) || 0
      const [noradRows] = await pool.query<Array<RowDataPacket & { norad_id: number }>>(
        'SELECT norad_id FROM objects WHERE org_id = ?',
        [orgId]
      )
      ownedNorads = noradRows.map((r) => Number(r.norad_id))
    }

    // 星历统计：R1-4 组织化——组织账号只看绑定到本组织目标的星历；平台账号看全量
    const nowMs = Date.now()
    let ephSql = 'SELECT COUNT(*) AS total, SUM(CASE WHEN stop_ms > ? THEN 1 ELSE 0 END) AS fresh FROM ephemeris'
    const ephParams: unknown[] = [nowMs]
    if (orgId) {
      ephSql = `SELECT COUNT(*) AS total, SUM(CASE WHEN e.stop_ms > ? THEN 1 ELSE 0 END) AS fresh
                  FROM ephemeris e JOIN objects o ON o.id = e.bound_object_id
                 WHERE o.org_id = ?`
      ephParams.push(orgId)
    }
    const [ephRows] = await pool.query<Array<RowDataPacket & { total: number; fresh: number }>>(
      ephSql,
      ephParams
    )
    const ephem = {
      total: Number(ephRows[0]?.total) || 0,
      fresh: Number(ephRows[0]?.fresh) || 0
    }

    // 系统 CDM 快照统计（TCA 时间窗；涉及目标）
    const [cdmAll] = await pool.query<Array<RowDataPacket & { n: number }>>(
      'SELECT COUNT(*) AS n FROM sat_cdm'
    )
    const [cdm24] = await pool.query<Array<RowDataPacket & { n: number }>>(
      'SELECT COUNT(*) AS n FROM sat_cdm WHERE tca >= NOW() AND tca < DATE_ADD(NOW(), INTERVAL 24 HOUR)'
    )
    const [cdm7d] = await pool.query<Array<RowDataPacket & { n: number }>>(
      'SELECT COUNT(*) AS n FROM sat_cdm WHERE tca >= NOW() AND tca < DATE_ADD(NOW(), INTERVAL 7 DAY)'
    )
    let involvingOwned = 0
    let ownedCdm: Array<{
      cdm_id: string
      tca: string
      norad_a: number
      name_a: string
      norad_b: number
      name_b: string
      miss_distance_km: number | null
      collision_probability: number | null
    }> = []
    if (ownedNorads.length) {
      const [rows] = await pool.query<Array<RowDataPacket & { n: number }>>(
        `SELECT COUNT(*) AS n FROM sat_cdm
         WHERE norad_a IN (?) OR norad_b IN (?)`,
        [ownedNorads, ownedNorads]
      )
      involvingOwned = Number(rows[0]?.n) || 0
      const [list] = await pool.query<RowDataPacket[]>(
        `SELECT cdm_id, tca, norad_a, name_a, norad_b, name_b, miss_distance_km, collision_probability
         FROM sat_cdm WHERE norad_a IN (?) OR norad_b IN (?)
         ORDER BY tca ASC LIMIT 8`,
        [ownedNorads, ownedNorads]
      )
      ownedCdm = list.map((r) => ({
        cdm_id: String(r.cdm_id),
        tca: String(r.tca),
        norad_a: Number(r.norad_a),
        name_a: String(r.name_a ?? ''),
        norad_b: Number(r.norad_b),
        name_b: String(r.name_b ?? ''),
        miss_distance_km: r.miss_distance_km == null ? null : Number(r.miss_distance_km),
        collision_probability: r.collision_probability == null ? null : Number(r.collision_probability)
      }))
    }
    // R1-4：本组织托管相关的 24h/7d 关注事件（无托管时保持 0，不显示全局数字）
    let orgNext24h = 0
    let orgNext7d = 0
    if (ownedNorads.length) {
      const [o24] = await pool.query<Array<RowDataPacket & { n: number }>>(
        `SELECT COUNT(*) AS n FROM sat_cdm
          WHERE tca >= NOW() AND tca < DATE_ADD(NOW(), INTERVAL 24 HOUR)
            AND (norad_a IN (?) OR norad_b IN (?))`,
        [ownedNorads, ownedNorads]
      )
      const [o7] = await pool.query<Array<RowDataPacket & { n: number }>>(
        `SELECT COUNT(*) AS n FROM sat_cdm
          WHERE tca >= NOW() AND tca < DATE_ADD(NOW(), INTERVAL 7 DAY)
            AND (norad_a IN (?) OR norad_b IN (?))`,
        [ownedNorads, ownedNorads]
      )
      orgNext24h = Number(o24[0]?.n) || 0
      orgNext7d = Number(o7[0]?.n) || 0
    }
    const cdm = {
      total: Number(cdmAll[0]?.n) || 0,
      next24h: Number(cdm24[0]?.n) || 0,
      next7d: Number(cdm7d[0]?.n) || 0,
      involvingOwned,
      orgNext24h,
      orgNext7d,
      ownedCdm
    }

    // 数据源健康（三源最近批次 + 运行中标志）
    const st = await getDailyFetchStatus()
    const sources = (['spacetrack_gp', 'spacetrack_cdm', 'aoe'] as const).map((s) => {
      const b = st.last_batch[s]
      return {
        source: s,
        state: b?.status ?? 'idle',
        last_success: st.last_success[s] ?? null,
        duration_ms: b?.duration_ms ?? null
      }
    })

    // 今日筛查次数（E1：screening_jobs；筛查表未建时兜底 0）
    let screensToday = 0
    if (orgId) {
      try {
        screensToday = await countScreensToday(orgId)
      } catch {
        screensToday = 0
      }
    }

    res.json(
      ok({
        org: req.auth?.org ? { id: req.auth.org.id, name: req.auth.org.name, plan: req.auth.org.plan } : null,
        owned,
        ephem,
        cdm,
        screensToday,
        running: st.running,
        sources
      })
    )
  } catch (e) {
    console.error('[overview] summary failed:', (e as Error).message)
    res.status(500).json(fail(500, '汇总查询失败'))
  }
})

export default router
