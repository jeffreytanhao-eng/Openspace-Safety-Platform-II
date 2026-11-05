/**
 * 客户数据凭证路由（Epic C2），挂载于 /cgi/org/credentials：
 *  - GET    /                两 provider 凭据状态（仅掩码，不回明文）
 *  - PUT    /:provider       保存/更新凭据（org_admin；AES-256-GCM 密文落库）
 *  - DELETE /:provider       清除凭据（org_admin）
 *  - POST   /:provider/test  连通性探测（Space-Track 登录 / AOE 列表），更新 last_ok_at/last_error
 *  - POST   /:provider/fetch 组织队列拉取（spacetrack kind=gp|cdm；aoe 固定）→
 *                            org_fetch_batches 审计记条数 + org_snapshots 组织私有落库（不写 system_pool）
 *  - GET    /batches         本组织拉取批次历史（最新在前）
 * 可见范围：拉取按本组织目标 NORAD 过滤；凭据/批次/快照均带 org_id 隔离。
 */
import { Router, type Request } from 'express'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type SafeUser, type SafeOrg } from './auth.js'
import { listObjectsByOrg } from '../db/objectsDb.js'
import { decryptSecret, encryptSecret, maskSecret } from '../utils/secretBox.js'
import {
  CRED_PROVIDERS,
  ensureCredSchema,
  getCredential,
  listCredStatus,
  listOrgBatches,
  markCredentialError,
  markCredentialOk,
  upsertCredential,
  deleteCredential,
  startOrgBatch,
  finishOrgBatch,
  type CredProvider,
  type OrgFetchKind
} from '../db/credDb.js'
import { SpaceTrackClient, type SpaceTrackCreds } from '../services/spaceTrackClient.js'
import { runOrgGpFetch, runOrgCdmFetch, runOrgAoeFetch, extractList } from '../services/orgFetch.js'
import { config } from '../config.js'
import { fetchJson } from '../utils/httpFetch.js'

const router = Router()

interface ScopedRequest extends Request {
  auth?: { user: SafeUser; org: SafeOrg | null }
}

interface CredPayload {
  username?: string
  secret?: string
}

function parseStored(plain: string): CredPayload {
  try {
    return JSON.parse(plain) as CredPayload
  } catch {
    return { secret: plain }
  }
}

function isProvider(p: string): p is CredProvider {
  return (CRED_PROVIDERS as string[]).includes(p)
}

const ZERO = { total: 0, inserted: 0, updated: 0, skipped: 0 }

/** 本组织目标 NORAD 去重列表（拉取可见范围） */
async function scopedNorads(orgId: number): Promise<number[]> {
  const objs = await listObjectsByOrg(orgId)
  return [...new Set(objs.map((o) => Number(o.norad_id)).filter((n) => Number.isFinite(n) && n > 0))]
}

router.use('/', async (_req, res, next) => {
  if (!(await ensureCredSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

/** 凭据状态：configured + 掩码 + 探测健康（解密仅为生成掩码，失败则掩码置空） */
router.get('/org/credentials', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const rows = await listCredStatus(org.id)
  const byProvider = new Map(rows.map((r) => [r.provider, r]))
  const items = CRED_PROVIDERS.map((provider) => {
    const r = byProvider.get(provider)
    let masked = ''
    if (r) {
      try {
        masked = maskSecret(parseStored(decryptSecret(r.ciphertext)).secret || '')
      } catch {
        masked = ''
      }
    }
    return {
      provider,
      configured: Boolean(r),
      masked,
      last_ok_at: r?.last_ok_at ?? null,
      last_error: r?.last_error ?? null,
      updated_by: r?.updated_by ?? '',
      updated_at: r?.updated_at ?? null
    }
  })
  res.json(ok({ items }))
})

/** 保存凭据（org_admin）：spacetrack 需 username+password；aoe 需 token */
router.put('/org/credentials/:provider', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (auth.user.role !== 'org_admin') {
    res.status(403).json(fail(403, '仅组织管理员可修改数据凭证'))
    return
  }
  const provider = String(req.params.provider || '')
  if (!isProvider(provider)) {
    res.status(404).json(fail(404, '未知数据源'))
    return
  }
  const body = (req.body || {}) as { username?: unknown; password?: unknown; token?: unknown }
  let username = ''
  let secret = ''
  if (provider === 'spacetrack') {
    username = String(body.username ?? '').trim()
    secret = String(body.password ?? '').trim()
    if (!username || username.length > 128 || !secret || secret.length > 256) {
      res.status(400).json(fail(400, '请填写 Space-Track 用户名与密码（各不超过 128/256 字符）'))
      return
    }
  } else {
    secret = String(body.token ?? '').trim()
    if (!secret || secret.length > 256) {
      res.status(400).json(fail(400, '请填写 AOE Token（不超过 256 字符）'))
      return
    }
  }
  await upsertCredential(auth.org.id, provider, encryptSecret(JSON.stringify({ username, secret })), auth.user.email)
  res.json(ok({ saved: true, provider }))
})

/** 清除凭据（org_admin） */
router.delete('/org/credentials/:provider', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  if (auth.user.role !== 'org_admin') {
    res.status(403).json(fail(403, '仅组织管理员可修改数据凭证'))
    return
  }
  const provider = String(req.params.provider || '')
  if (!isProvider(provider)) {
    res.status(404).json(fail(404, '未知数据源'))
    return
  }
  await deleteCredential(auth.org.id, provider)
  res.json(ok({ deleted: true, provider }))
})

/** 连通性探测：Space-Track 登录 / AOE 列表请求；结果写回 last_ok_at / last_error */
router.post('/org/credentials/:provider/test', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const provider = String(req.params.provider || '')
  if (!isProvider(provider)) {
    res.status(404).json(fail(404, '未知数据源'))
    return
  }
  const cred = await getCredential(org.id, provider)
  if (!cred) {
    res.status(400).json(fail(400, '尚未配置该数据源的凭证'))
    return
  }
  const t0 = Date.now()
  try {
    const payload = parseStored(decryptSecret(cred.ciphertext))
    if (provider === 'spacetrack') {
      const client = new SpaceTrackClient({ username: payload.username || '', password: payload.secret || '' })
      await client.login()
    } else {
      const base = config.aoe.baseUrl.replace(/\/$/, '')
      const aoePayload = await fetchJson<unknown>(`${base}/cgi/orbital/aoe/list?channel=KY&format=json`, {
        headers: { Authorization: `Bearer ${payload.secret || ''}`, 'User-Agent': 'openspace-safety-api/2.0' },
        timeoutMs: 30_000,
        retries: 0
      })
      // AOE 对无效 Token 也返回 HTTP 200 + {code:1, data:null}：必须校验数据非空
      if (!extractList(aoePayload).length) {
        const o = aoePayload && typeof aoePayload === 'object' ? (aoePayload as Record<string, unknown>) : {}
        throw new Error(`AOE 未返回数据${o.msg ? `：${String(o.msg)}` : '（Token 可能无效）'}`)
      }
    }
    await markCredentialOk(org.id, provider)
    res.json(ok({ ok: true, latency_ms: Date.now() - t0 }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markCredentialError(org.id, provider, msg)
    res.json(ok({ ok: false, error: msg, latency_ms: Date.now() - t0 }))
  }
})

/** 组织队列拉取：kind=gp|cdm（spacetrack）/ aoe 固定；批次审计 + 组织私有快照 */
router.post('/org/credentials/:provider/fetch', requireAuth, async (req: ScopedRequest, res) => {
  const auth = req.auth
  if (!auth?.org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const provider = String(req.params.provider || '')
  if (!isProvider(provider)) {
    res.status(404).json(fail(404, '未知数据源'))
    return
  }
  const body = (req.body || {}) as { kind?: unknown }
  let kind: OrgFetchKind
  if (provider === 'spacetrack') {
    kind = body.kind === 'cdm' ? 'cdm' : body.kind === 'gp' ? 'gp' : ('' as OrgFetchKind)
    if (kind !== 'gp' && kind !== 'cdm') {
      res.status(400).json(fail(400, '请指定拉取内容：gp（两行根数）或 cdm（交会报文）'))
      return
    }
  } else {
    kind = 'aoe'
  }

  const norads = await scopedNorads(auth.org.id)
  if (!norads.length) {
    res.status(400).json(fail(400, '请先认领目标，再拉取数据'))
    return
  }
  const cred = await getCredential(auth.org.id, provider)
  if (!cred) {
    res.status(400).json(fail(400, '尚未配置该数据源的凭证'))
    return
  }

  const batchId = await startOrgBatch(auth.org.id, provider, kind, `org:${auth.user.email}`)
  let payload: CredPayload
  try {
    payload = parseStored(decryptSecret(cred.ciphertext))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finishOrgBatch(batchId, 'failed', ZERO, msg)
    await markCredentialError(auth.org.id, provider, msg)
    res.status(409).json(fail(409, `${msg}（批次 #${batchId} 已留痕）`))
    return
  }

  try {
    const creds: SpaceTrackCreds = { username: payload.username || '', password: payload.secret || '' }
    const counts =
      provider === 'spacetrack'
        ? kind === 'gp'
          ? await runOrgGpFetch(auth.org.id, norads, creds)
          : await runOrgCdmFetch(auth.org.id, norads, creds)
        : await runOrgAoeFetch(auth.org.id, norads, payload.secret || '')
    await finishOrgBatch(batchId, 'success', counts)
    await markCredentialOk(auth.org.id, provider)
    res.json(ok({ batch_id: batchId, kind, scoped_targets: norads.length, ...counts }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finishOrgBatch(batchId, 'failed', ZERO, msg)
    await markCredentialError(auth.org.id, provider, msg)
    res.status(502).json(fail(502, `拉取失败：${msg}（批次 #${batchId} 已留痕）`))
  }
})

/** 本组织拉取批次历史（审计；最新在前） */
router.get('/org/credentials/batches', requireAuth, async (req: ScopedRequest, res) => {
  const org = req.auth?.org
  if (!org) {
    res.status(404).json(fail(404, '平台账号无所属组织'))
    return
  }
  const limit = Number(req.query.limit) || 20
  const runs = await listOrgBatches(org.id, limit)
  res.json(ok({ batches: runs }))
})

export default router
