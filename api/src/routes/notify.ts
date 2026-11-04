/**
 * 通知路由（Epic H2 日报与 Webhook），挂载于 /cgi：
 *  - GET    /notify/channels          本组织渠道列表（webhook URL 掩码，密钥不回显）
 *  - POST   /notify/channels          新增渠道（org_admin；webhook URL / email 校验）
 *  - PUT    /notify/channels/:id      更新渠道（org_admin；不带 secret 保持不变，空串清除）
 *  - DELETE /notify/channels/:id      删除渠道（org_admin）
 *  - POST   /notify/channels/:id/test 测试投递（org_admin；结果落审计）
 *  - GET    /notify/deliveries        投递历史（最新在前）
 *  - GET    /notify/report/latest     最新日报（预览）
 *  - GET    /notify/report/:date      指定日期日报（YYYY-MM-DD）
 *  - POST   /notify/report/run        手动生成本组织今日日报并投递（同日覆盖重投）
 *
 * 投递范围：daily 订阅收日报；changes 订阅在有升级/新增高危变化时收分级变化通知
 * （按渠道 min_level 过滤）。调度见 jobs/dailyReport.ts（DAILY_REPORT_CRON，默认 UTC 06:30）。
 */
import { Router, type Request } from 'express'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import {
  ensureNotifySchema,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  listDeliveries,
  getLatestReport,
  getReportByDate,
  recordDelivery,
  markChannelOk,
  markChannelError,
  type ChannelKind,
  type MinLevel,
  type NotifyChannel
} from '../db/notifyDb.js'
import { deliverWebhook, deliverEmail, maskWebhookUrl, channelSecret, smtpConfigured } from '../services/notify.js'
import { encryptSecret } from '../utils/secretBox.js'
import { runDailyReportForOrg } from '../jobs/dailyReport.js'
import { isOrgFlagEnabled } from '../db/planDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

const MIN_LEVELS: MinLevel[] = ['yellow', 'orange', 'red']
const KINDS: ChannelKind[] = ['webhook', 'email']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isAdmin(auth: AuthContext | undefined): boolean {
  return auth?.user.role === 'org_admin' || auth?.user.role === 'platform_super_admin'
}

router.use(['/notify', '/org/notify'], async (_req, res, next) => {
  if (!(await ensureNotifySchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

/** 渠道视图：webhook URL 掩码、密钥只回「是否已设置」 */
function channelView(ch: NotifyChannel): Record<string, unknown> {
  return {
    id: ch.id,
    kind: ch.kind,
    target: ch.kind === 'webhook' ? maskWebhookUrl(ch.target) : ch.target,
    min_level: ch.min_level,
    subscribe: ch.subscribe,
    has_secret: ch.kind === 'webhook' ? Boolean(ch.secret_enc) : false,
    enabled: Boolean(ch.enabled),
    last_ok_at: ch.last_ok_at,
    last_error: ch.last_error,
    created_by: ch.created_by,
    updated_at: ch.updated_at
  }
}

/** 校验并归一渠道入参；返回错误信息或 null。secret 三态：undefined=未提供（编辑时保持），''=清除，字符串=设置 */
function validateBody(body: Record<string, unknown>): { error: string } | { kind: ChannelKind; target: string; min_level: MinLevel; subscribe: string; enabled: boolean; secret: string | undefined } {
  const kind = String(body.kind ?? '')
  if (!KINDS.includes(kind as ChannelKind)) return { error: 'kind 必须为 webhook 或 email' }
  const target = String(body.target ?? '').trim()
  if (!target || target.length > 500) return { error: 'target 不能为空且不超过 500 字' }
  if (kind === 'webhook') {
    try {
      const u = new URL(target)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'webhook URL 仅支持 http/https' }
    } catch {
      return { error: 'webhook URL 格式无效' }
    }
  } else if (!EMAIL_RE.test(target) || target.length > 200) {
    return { error: '邮箱格式不正确' }
  }
  const min_level = String(body.min_level ?? 'yellow')
  if (!MIN_LEVELS.includes(min_level as MinLevel)) return { error: 'min_level 必须为 yellow/orange/red' }
  const rawSubs = Array.isArray(body.subscribe) ? body.subscribe.map((s) => String(s)) : String(body.subscribe ?? 'daily,changes').split(',')
  const subs = [...new Set(rawSubs.map((s) => s.trim()).filter((s) => s === 'daily' || s === 'changes'))]
  if (!subs.length) return { error: '至少订阅一项（daily / changes）' }
  let secret: string | undefined = undefined
  if (kind === 'webhook' && body.secret !== undefined && body.secret !== null) {
    secret = String(body.secret).trim()
    if (secret && secret.length > 200) return { error: '签名密钥不超过 200 字' }
  }
  return { kind: kind as ChannelKind, target, min_level: min_level as MinLevel, subscribe: subs.join(','), enabled: body.enabled === undefined ? true : Boolean(body.enabled), secret }
}

/** 渠道列表（本组织；组织成员可读） */
router.get('/notify/channels', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const items = await listChannels(org.id)
  res.json(ok({ items: items.map(channelView), smtp_configured: smtpConfigured() }))
})

/** 新增渠道（org_admin） */
router.post('/notify/channels', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!isAdmin(auth)) {
    res.status(403).json(fail(403, '仅组织管理员可修改通知配置'))
    return
  }
  const v = validateBody((req.body ?? {}) as Record<string, unknown>)
  if ('error' in v) {
    res.status(400).json(fail(400, v.error))
    return
  }
  const id = await createChannel(auth.org.id, {
    kind: v.kind,
    target: v.target,
    min_level: v.min_level,
    subscribe: v.subscribe,
    secret_enc: v.kind === 'webhook' && v.secret ? encryptSecret(JSON.stringify({ secret: v.secret })) : null,
    enabled: v.enabled
  }, auth.user.email)
  const ch = await getChannel(auth.org.id, id)
  res.json(ok({ channel: ch ? channelView(ch) : null }))
})

/** 更新渠道（org_admin）：不带 secret 保持不变；secret='' 清除 */
router.put('/notify/channels/:id', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!isAdmin(auth)) {
    res.status(403).json(fail(403, '仅组织管理员可修改通知配置'))
    return
  }
  const id = Number(req.params.id)
  const ch = await getChannel(auth.org.id, id)
  if (!ch) {
    res.status(404).json(fail(404, '渠道不存在'))
    return
  }
  const v = validateBody((req.body ?? {}) as Record<string, unknown>)
  if ('error' in v) {
    res.status(400).json(fail(400, v.error))
    return
  }
  let secretEnc: string | null | undefined
  if (v.kind === 'webhook') {
    if (v.secret === undefined) secretEnc = undefined // 保持
    else if (v.secret === '') secretEnc = null // 清除
    else secretEnc = encryptSecret(JSON.stringify({ secret: v.secret }))
  }
  await updateChannel(auth.org.id, id, {
    kind: v.kind,
    target: v.target,
    min_level: v.min_level,
    subscribe: v.subscribe,
    secret_enc: secretEnc,
    enabled: v.enabled
  })
  const after = await getChannel(auth.org.id, id)
  res.json(ok({ channel: after ? channelView(after) : null }))
})

/** 删除渠道（org_admin） */
router.delete('/notify/channels/:id', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!isAdmin(auth)) {
    res.status(403).json(fail(403, '仅组织管理员可修改通知配置'))
    return
  }
  const id = Number(req.params.id)
  const ch = await getChannel(auth.org.id, id)
  if (!ch) {
    res.status(404).json(fail(404, '渠道不存在'))
    return
  }
  await deleteChannel(auth.org.id, id)
  res.json(ok({ deleted: id }))
})

/** 测试投递（org_admin）：发送 mini 样例，结果落审计并刷新渠道健康状态 */
router.post('/notify/channels/:id/test', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!isAdmin(auth)) {
    res.status(403).json(fail(403, '仅组织管理员可修改通知配置'))
    return
  }
  const id = Number(req.params.id)
  const ch = await getChannel(auth.org.id, id)
  if (!ch) {
    res.status(404).json(fail(404, '渠道不存在'))
    return
  }
  const payload = {
    event: 'test',
    org: auth.org.name,
    sample: {
      date: new Date().toISOString().slice(0, 10),
      note: 'Openspace Safety 通知测试投递',
      counts: { red: 0, orange: 1, yellow: 2, low: 5 },
      disclaimer: '作业辅助非认证 CARA，不作为唯一决策依据。'
    }
  }
  // Epic I 功能开关：webhook_enabled 关闭的组织，Webhook 测试投递同样跳过（留审计）
  if (ch.kind === 'webhook' && !(await isOrgFlagEnabled(ch.org_id, 'webhook_enabled'))) {
    await recordDelivery({
      org_id: ch.org_id,
      channel_id: ch.id,
      kind: 'test',
      status: 'skipped',
      attempts: 0,
      status_code: null,
      error: '组织已禁用 Webhook 投递（webhook_enabled=false）',
      payload_json: JSON.stringify(payload).slice(0, 10000)
    })
    res.json(ok({ status: 'skipped', attempts: 0, status_code: null, error: '组织已禁用 Webhook 投递（webhook_enabled=false）' }))
    return
  }
  const result =
    ch.kind === 'webhook'
      ? await deliverWebhook(ch, 'test', payload)
      : await deliverEmail(ch, `[Openspace Safety] 通知测试 · ${auth.org.name}`, dailyTestText(auth.org.name))
  await recordDelivery({
    org_id: ch.org_id,
    channel_id: ch.id,
    kind: 'test',
    status: result.status,
    attempts: result.attempts,
    status_code: result.statusCode,
    error: result.error,
    payload_json: JSON.stringify(payload)
  })
  if (result.status === 'success') await markChannelOk(ch.id)
  else await markChannelError(ch.id, result.error ?? 'failed')
  res.json(ok({ status: result.status, attempts: result.attempts, status_code: result.statusCode, error: result.error }))
})

function dailyTestText(orgName: string): string {
  return [
    `[Openspace Safety] 通知测试 · ${orgName}`,
    '',
    '这是一条测试投递。若收到本消息，说明渠道配置可用。',
    '',
    '免责声明：作业辅助非认证 CARA，不作为唯一决策依据。'
  ].join('\n')
}

/** 投递历史（本组织，最新在前） */
router.get('/notify/deliveries', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const limit = Number(req.query.limit ?? 20)
  const rows = await listDeliveries(org.id, Number.isFinite(limit) ? limit : 20)
  res.json(ok({ deliveries: rows }))
})

/** 最新日报（预览；无组织账号 404） */
router.get('/notify/report/latest', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const row = await getLatestReport(org.id)
  if (!row) {
    res.status(404).json(fail(404, '尚无日报（可点「立即生成」手动出报）'))
    return
  }
  res.json(ok({ report_date: dateStr(row.report_date), scope: row.scope, created_at: row.created_at, payload: safeJson(row.payload_json) }))
})

/** 指定日期日报 */
router.get('/notify/report/:date', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const date = String(req.params.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json(fail(400, '日期格式应为 YYYY-MM-DD'))
    return
  }
  const row = await getReportByDate(org.id, date)
  if (!row) {
    res.status(404).json(fail(404, '该日期无日报'))
    return
  }
  res.json(ok({ report_date: dateStr(row.report_date), scope: row.scope, created_at: row.created_at, payload: safeJson(row.payload_json) }))
})

/** 手动生成本组织今日日报并投递（org_admin；同日覆盖重投） */
router.post('/notify/report/run', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (!isAdmin(auth)) {
    res.status(403).json(fail(403, '仅组织管理员可手动生成日报'))
    return
  }
  try {
    const r = await runDailyReportForOrg(auth.org.id, auth.org.name, `manual:${auth.user.email}`)
    res.json(ok(r))
  } catch (e) {
    console.error('[notify/report/run]', e)
    const msg = (e as Error).message || '日报生成失败'
    // 功能开关关闭属可预期业务拒绝，返回 403 而非 500
    const status = msg.includes('未对您的组织开放') ? 403 : 500
    res.status(status).json(fail(status, msg))
  }
})

/** mysql2 的 DATE 列运行时为按本地时区解析的 Date 对象；取本地日期分量还原 YYYY-MM-DD 字面值 */
function dateStr(d: unknown): string {
  if (typeof d === 'string') return d.slice(0, 10)
  const dt = d instanceof Date ? d : new Date(d as string | Date)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
}

export default router
