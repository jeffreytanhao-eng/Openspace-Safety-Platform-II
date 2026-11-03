/**
 * 档位配额中间件（Epic A2，供 D1/E1 等业务路由组合使用）。
 *
 * - checkQuota(feature)：requireAuth 之后挂载；用量 ≥ 生效限额 → 403 + code 4030 + 升级文案；
 * - requirePlan(min...)：当前组织档位不在白名单 → 403 + code 4031；
 * - 超限与档位拒绝均写服务端日志（计划书验收「日志可查」）。
 */
import type { NextFunction, Request, Response } from 'express'
import { ensurePlanSchema, getEffectiveLimits, getUsage, FEATURE_KEYS } from '../db/planDb.js'
import type { SafeUser, SafeOrg } from '../routes/auth.js'

/** 配额超限业务码（HTTP 仍 403，前端按 code 识别弹升级提示） */
export const QUOTA_EXCEEDED = 4030
/** 档位不足业务码 */
export const PLAN_FORBIDDEN = 4031

const LABELS = new Map(FEATURE_KEYS.map((f) => [f.key, f.label]))

interface ScopedRequest extends Request {
  auth?: { user: SafeUser; org: SafeOrg | null }
}

/** 用量配额校验（挂载顺序：requireAuth → checkQuota） */
export function checkQuota(feature: string) {
  return async (req: ScopedRequest, res: Response, next: NextFunction): Promise<void> => {
    const org = req.auth?.org
    if (!org) {
      res.status(403).json({ code: PLAN_FORBIDDEN, msg: '平台账号不占用组织配额', data: null })
      return
    }
    if (!(await ensurePlanSchema())) {
      res.status(503).json({ code: 503, msg: '数据库不可用', data: null })
      return
    }
    const limits = await getEffectiveLimits(org.id, org.plan)
    const limit = limits.find((l) => l.feature === feature)?.limit
    if (limit === undefined) {
      // 未登记的功能键：不拦（缺省放行），但日志留痕便于发现漏配
      console.warn(`[plan] no limit configured for feature=${feature} org=${org.id}`)
      next()
      return
    }
    const usage = await getUsage(org.id, feature)
    if (usage >= limit) {
      const label = LABELS.get(feature) ?? feature
      console.warn(`[plan] quota exceeded: org=${org.id} plan=${org.plan} feature=${feature} usage=${usage}/${limit}`)
      res.status(403).json({
        code: QUOTA_EXCEEDED,
        msg: `已达${label}上限（${usage}/${limit}），请升级档位`,
        data: { feature, usage, limit, plan: org.plan }
      })
      return
    }
    next()
  }
}

/** 档位白名单校验（挂载顺序：requireAuth → requirePlan） */
export function requirePlan(minPlans: Array<'free' | 'normal' | 'vip'>) {
  return (req: ScopedRequest, res: Response, next: NextFunction): void => {
    const org = req.auth?.org
    if (!org) {
      res.status(403).json({ code: PLAN_FORBIDDEN, msg: '平台账号不适用组织档位', data: null })
      return
    }
    if (!minPlans.includes(org.plan)) {
      console.warn(`[plan] plan forbidden: org=${org.id} plan=${org.plan} need=${minPlans.join('|')}`)
      res.status(403).json({
        code: PLAN_FORBIDDEN,
        msg: `当前档位（${org.plan}）不支持该功能，请升级`,
        data: { plan: org.plan, required: minPlans }
      })
      return
    }
    next()
  }
}
