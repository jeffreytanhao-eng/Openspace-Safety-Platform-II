/**
 * 碰撞参数路由（Epic F1）：
 *  - GET /cgi/ca/defaults   组织默认 CA 参数 + 系统建议值（短理由，双语）；
 *  - PUT /cgi/ca/defaults   保存组织默认（org_admin）。
 *
 * 参数重算本身在 events.ts（POST /cgi/events/:key/recompute），此处只管默认值。
 */
import { Router, type Request, type Response } from 'express'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import {
  ensureCaSchema,
  getCaDefaults,
  upsertCaDefaults,
  listUserCaParams,
  saveUserCaParams,
  deleteUserCaParams,
  caDefaultsToParams,
  mergeCaParams,
  type CaDefaultsPatch,
  type HbrMode,
  type CovMode,
  type Propagator
} from '../db/caDb.js'
import { writeUserAudit } from '../db/adminDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

/* ---------------------- 系统建议值（服务端权威口径） ---------------------- */

export interface CaSuggestion {
  field: string
  value: number | string
  reason: { zh: string; en: string }
}

export const CA_SUGGESTIONS: CaSuggestion[] = [
  { field: 'hbr_mode', value: 'single', reason: { zh: 'CDM 仅提供单一 HBR，单侧合并为通用口径', en: 'CDM carries a single HBR; single combined value is the common case' } },
  { field: 'hbr_m', value: 15, reason: { zh: '卫星+碎片典型包络统计值（CDM HBR 中位数附近）', en: 'Typical sat+debris envelope (near CDM HBR median)' } },
  { field: 'accepted_pc', value: 1e-4, reason: { zh: 'IADC/CARA 常用红色关注阈值 1e-4', en: 'Common red threshold 1e-4 (IADC/CARA practice)' } },
  { field: 'accepted_miss_km', value: 1, reason: { zh: 'LEO 交会 1 km 脱靶量为常规关注线', en: '1 km miss is the common watch line in LEO' } },
  { field: 'screen_distance_km', value: 10, reason: { zh: '粗筛 10 km 阈值兼顾漏筛与算力', en: '10 km prefilter balances misses vs compute' } },
  { field: 'covariance_mode', value: 'tle-age', reason: { zh: '无 CDM 协方差时用根数龄期模型最稳健', en: 'TLE-age model is robust when CDM cov unavailable' } },
  { field: 'propagator', value: 'sgp4', reason: { zh: 'TLE 数据源的标准配套传播器', en: 'Standard companion propagator for TLE data' } },
  { field: 'window_h', value: 72, reason: { zh: '3 天窗覆盖 LEO 交会预报周期', en: '3-day window covers LEO conjunction horizon' } },
  { field: 'step_s', value: 30, reason: { zh: '30 s 步长在 LEO 相对运动下足够细', en: '30 s step resolves LEO relative motion' } },
  { field: 'pc_methods', value: 'foster,chan', reason: { zh: '双算法交叉验证，量大时省算力', en: 'Two-method cross-check keeps compute cheap' } }
]

/* -------------------------------- 路由 -------------------------------- */

router.use('/ca/defaults', requireAuth, async (req, res, next) => {
  if (!(await ensureCaSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

// 第 3/4 项：个人参数档案（仅本人可见可用）
router.use('/ca/profiles', requireAuth, async (_req, res, next) => {
  if (!(await ensureCaSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

/** 组织默认 CA 参数（未设置过 → defaults=null，前端回落系统建议值；平台账号只读系统建议值） */
router.get('/ca/defaults', (req: ScopedRequest, res) => {
  void (async () => {
    if (!req.auth?.org) {
      res.json(ok({ defaults: null, suggestions: CA_SUGGESTIONS, platform: true }))
      return
    }
    const defaults = await getCaDefaults(req.auth.org.id)
    res.json(ok({ defaults, suggestions: CA_SUGGESTIONS }))
  })().catch((e) => res.status(500).json(fail(500, (e as Error).message)))
})

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** 校验 CA 参数补丁（组织默认 / 用户两组 / 目标自定义共用）；非法枚举返回 error */
export function sanitizeCaPatch(b: Record<string, unknown>): { patch: CaDefaultsPatch; error?: string } {
  const patch: CaDefaultsPatch = {}
  if (b.hbr_mode !== undefined) {
    const m = String(b.hbr_mode)
    if (m !== 'single' && m !== 'both') return { patch, error: 'hbr_mode 仅支持 single / both' }
    patch.hbr_mode = m as HbrMode
  }
  if (b.hbr_m !== undefined) patch.hbr_m = clamp(b.hbr_m, 1, 1000, 15)
  if (b.hbr_a_m !== undefined) patch.hbr_a_m = b.hbr_a_m === null ? null : clamp(b.hbr_a_m, 0.1, 1000, 15)
  if (b.hbr_b_m !== undefined) patch.hbr_b_m = b.hbr_b_m === null ? null : clamp(b.hbr_b_m, 0.1, 1000, 15)
  if (b.accepted_pc !== undefined) patch.accepted_pc = clamp(b.accepted_pc, 1e-9, 1, 1e-4)
  if (b.accepted_miss_km !== undefined) patch.accepted_miss_km = clamp(b.accepted_miss_km, 0.01, 100, 1)
  if (b.screen_distance_km !== undefined) patch.screen_distance_km = clamp(b.screen_distance_km, 0.5, 100, 10)
  if (b.covariance_mode !== undefined) {
    const m = String(b.covariance_mode)
    if (m !== 'tle-age' && m !== 'cdm') return { patch, error: 'covariance_mode 仅支持 tle-age / cdm' }
    patch.covariance_mode = m as CovMode
  }
  if (b.propagator !== undefined) {
    const m = String(b.propagator)
    if (m !== 'sgp4' && m !== 'numeric') return { patch, error: 'propagator 仅支持 sgp4 / numeric' }
    patch.propagator = m as Propagator
  }
  if (b.window_h !== undefined) patch.window_h = Math.round(clamp(b.window_h, 1, 168, 72))
  if (b.step_s !== undefined) patch.step_s = Math.round(clamp(b.step_s, 1, 3600, 30))
  if (b.pc_methods !== undefined) {
    const allowed = new Set(['foster', 'chan', 'alfano'])
    const list = String(b.pc_methods)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => allowed.has(s))
    if (!list.length) return { patch, error: '至少勾选一个 Pc 方法' }
    patch.pc_methods = [...new Set(list)].join(',')
  }
  return { patch }
}

/** 保存组织默认参数（org_admin）；仅校验传入字段 */
router.put('/ca/defaults', (req: ScopedRequest, res) => {
  void (async () => {
    const auth = req.auth
    if (!auth?.org || !auth.user.orgId) {
      res.status(403).json(fail(403, '需要组织账号'))
      return
    }
    if (auth.user.role !== 'org_admin' && auth.user.role !== 'platform_super_admin') {
      res.status(403).json(fail(403, '仅组织管理员可修改默认参数'))
      return
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const { patch, error } = sanitizeCaPatch(b)
    if (error) {
      res.status(400).json(fail(400, error))
      return
    }

    const before = await getCaDefaults(auth.org.id)
    const defaults = await upsertCaDefaults(auth.org.id, patch, auth.user.email)
    console.log(`[ca] defaults saved org=${auth.org.id} by=${auth.user.email} fields=${Object.keys(patch).join(',') || 'none'}`)
    const fields = Object.keys(patch).join(', ') || 'none'
    await writeUserAudit(auth, 'ca.defaults.update', {
      before,
      after: {
        summary: `更新组织默认 CA 参数（${fields}）`,
        patch,
        defaults
      }
    })
    res.json(ok({ defaults }))
  })().catch((e) => res.status(500).json(fail(500, (e as Error).message)))
})

/* ------------------- 用户自有参数（每个用户两组，互不可见） ------------------- */

/** GET /cgi/ca/profiles → 组织默认（平台账号为系统默认）+ 当前用户两组自有参数（未配置为 null） */
router.get('/ca/profiles', (req: ScopedRequest, res) => {
  void (async () => {
    const orgId = req.auth?.org?.id ?? null
    const [orgDefaults, mine] = await Promise.all([
      orgId ? getCaDefaults(orgId) : Promise.resolve(null),
      listUserCaParams(req.auth!.user.id)
    ])
    res.json(
      ok({
        org_defaults: caDefaultsToParams(orgDefaults),
        suggestions: CA_SUGGESTIONS,
        mine,
        platform: !orgId
      })
    )
  })().catch((e) => res.status(500).json(fail(500, (e as Error).message)))
})

/** PUT /cgi/ca/profiles/:slot → 保存本人第 1/2 组参数（在组织默认上覆盖传入字段） */
router.put('/ca/profiles/:slot', (req: ScopedRequest, res) => {
  void (async () => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json(fail(401, '需要登录'))
      return
    }
    const slot = Number(req.params.slot)
    if (slot !== 1 && slot !== 2) {
      res.status(400).json(fail(400, 'slot 仅支持 1 / 2'))
      return
    }
    const { patch, error } = sanitizeCaPatch((req.body ?? {}) as Record<string, unknown>)
    if (error) {
      res.status(400).json(fail(400, error))
      return
    }
    const orgDefaults = auth.org ? await getCaDefaults(auth.org.id) : null
    const existing = (await listUserCaParams(auth.user.id)).find((s) => s.slot === slot)?.params ?? null
    const params = mergeCaParams(caDefaultsToParams(orgDefaults), patch)
    await saveUserCaParams(auth.user.id, slot, params)
    console.log(`[ca] user params saved user=${auth.user.id} slot=${slot} fields=${Object.keys(patch).join(',') || 'none'}`)
    const fields = Object.keys(patch).join(', ') || 'none'
    await writeUserAudit(auth, 'ca.profile.set', {
      before: existing,
      after: {
        summary: `保存个人定制参数组 ${slot}（${fields}）`,
        slot,
        patch,
        params
      }
    })
    res.json(ok({ slot, params }))
  })().catch((e) => res.status(500).json(fail(500, (e as Error).message)))
})

/** DELETE /cgi/ca/profiles/:slot → 删除本人某组参数（回到使用默认参数） */
router.delete('/ca/profiles/:slot', (req: ScopedRequest, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json(fail(401, '需要登录'))
      return
    }
    const slot = Number(req.params.slot)
    if (slot !== 1 && slot !== 2) {
      res.status(400).json(fail(400, 'slot 仅支持 1 / 2'))
      return
    }
    const existing = (await listUserCaParams(req.auth.user.id)).find((s) => s.slot === slot)?.params ?? null
    await deleteUserCaParams(req.auth.user.id, slot)
    await writeUserAudit(req.auth, 'ca.profile.clear', {
      before: existing,
      after: { summary: `清除个人定制参数组 ${slot}，改回默认`, slot, deleted: true }
    })
    res.json(ok({ slot, deleted: true }))
  })().catch((e) => res.status(500).json(fail(500, (e as Error).message)))
})

export default router
