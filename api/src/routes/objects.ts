﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * 目标路由（Epic D1）：组织认领 NORAD 目标并维护档案。
 * 全部 requireAuth；认领挂 checkQuota('objects_max')（免费档 3 个，超限 403 + 升级提示）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { twoline2satrec } from 'satellite.js'
import { pool } from '../db/pool.js'
import { ok, fail } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import { quotaExceeded } from '../middleware/plan.js'
import { getEffectiveLimits, getUsage } from '../db/planDb.js'
import {
  ensureObjectsSchema,
  listObjectsByOrg,
  listAllObjects,
  getObjectById,
  getObjectOrgName,
  getObjectByOrgNorad,
  getOwnerClaim,
  createObject,
  resubmitObjectClaim,
  upgradeNormalToOwner,
  updateObject,
  updateObjectAlias,
  deleteObject,
  countBoundEphem,
  checkClaimScope,
  normalizeAlias,
  findAliasConflict,
  listOrgAliases,
  type ClaimType,
  type ObjectRow
} from '../db/objectsDb.js'
import {
  ensureCaSchema,
  getCaDefaults,
  getObjectCaParams,
  saveObjectCaParams,
  deleteObjectCaParams,
  caDefaultsToParams,
  mergeCaParams
} from '../db/caDb.js'
import { sanitizeCaPatch } from './ca.js'
import { writeUserAudit } from '../db/adminDb.js'
import { ensurePersonalWorkspace, isVipUser } from '../db/orgDb.js'

const router = Router()

type ScopedRequest = Request & { auth?: AuthContext }

/** 写操作守卫：仅业主认领（卫星业主）可维护档案参数与星历绑定；C5 降档/暂停后冻结为只读 */
function requireOwnerClaim(row: ObjectRow, org: AuthContext['org'], res: Response): boolean {
  if (row.claim_type !== 'owner') {
    res.status(403).json(
      fail(403, '关注仅用于学习/教学/模拟科研，档案参数与星历绑定只能由业主认领（卫星业主）维护')
    )
    return false
  }
  if (row.claim_status !== 'claimed') {
    res.status(403).json(fail(403, '业主认领申请尚未通过超管审核，审核通过后才能维护参数与星历'))
    return false
  }
  if (!org || org.plan !== 'vip' || org.status !== 'active') {
    res.status(403).json(
      fail(403, '组织已降档或暂停，业主认领已冻结为只读（数据保留，恢复 VIP 后可继续维护）')
    )
    return false
  }
  return true
}

/** 只放行组织账号（平台账号无 org 不可目标） */
function requireOrg(req: ScopedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.org || !req.auth.user.orgId) {
    res.status(403).json(fail(403, '需要组织账号'))
    return
  }
  next()
}


function objectAuditLabel(row: { id?: number; name?: string; norad_id?: number; alias?: string | null }): string {
  const name = String(row.alias || row.name || '').trim()
  const bits: string[] = []
  if (name) bits.push(name)
  if (row.norad_id) bits.push(`NORAD ${row.norad_id}`)
  if (row.id) bits.push(`id=${row.id}`)
  return bits.join('，') || '目标'
}


/** 平台账号（超管/运维）：业务页走全平台只读视图 */
function isPlatformAccount(req: ScopedRequest): boolean {
  const role = req.auth?.user.role
  return !!role && role.startsWith('platform_')
}

/**
 * R2-28：无组织普通用户首次关注时自动创建个人工作区（普通档），
 * 让关注有 org 归属；平台账号一律拒绝写操作。
 */
async function ensureBusinessOrg(req: ScopedRequest, res: Response): Promise<boolean> {
  if (req.auth?.org && req.auth.user.orgId) return true
  if (!req.auth) {
    res.status(401).json(fail(401, '未登录'))
    return false
  }
  if (isPlatformAccount(req)) {
    res.status(403).json(fail(403, '平台账号为只读视图，不能认领或关注目标'))
    return false
  }
  const ws = await ensurePersonalWorkspace(req.auth.user.id)
  if (!ws) {
    res.status(503).json(fail(503, '个人工作区创建失败，请稍后重试'))
    return false
  }
  req.auth.user.orgId = ws.org.id
  req.auth.user.role = ws.user.role
  req.auth.org = {
    id: ws.org.id,
    name: ws.org.name,
    plan: ws.org.plan,
    status: ws.org.status,
    trialEndsAt: ws.org.trial_ends_at,
    personal: (ws.org.notes || '').startsWith('auto:personal')
  }
  return true
}

/**
 * C0 业主认领闸门：仅 VIP（组织 plan=vip 或用户级 VIP）且组织正常时可业主认领；
 * 普通用户一律 403，仅保留关注。前端禁用按钮不算数，API 强制。
 */
function ownerClaimAllowed(auth: AuthContext | undefined, res: Response): boolean {
  const org = auth?.org
  const vip = !!auth?.user.isVip || org?.plan === 'vip'
  if (!org || !vip || org.status !== 'active') {
    res.status(403).json(fail(403, '仅 VIP 可发起业主认领（当前档位仅支持关注）'))
    return false
  }
  return true
}

/** 全部路由先过 requireAuth，进入业务前确保 schema（限定 /objects 前缀，避免拦截挂在后续的公开路由） */
router.use('/objects', requireAuth, async (req, res, next) => {
  if (!(await ensureObjectsSchema()) || !(await ensureCaSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  next()
})

interface SatTleInfo extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string | null
  regime: string
  epoch: string | null
  incl: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
}

async function satTleOf(noradId: number): Promise<SatTleInfo | null> {
  const [rows] = await pool.query<SatTleInfo[]>(
    `SELECT norad_id, object_name, object_type, intl_desig, regime, epoch, incl, apogee, perigee,
            tle_line1, tle_line2
     FROM sat_tle WHERE norad_id = ? LIMIT 1`,
    [noradId]
  )
  const row = rows[0] ?? null
  if (!row) return null
  // R2-3：TLE 表要素列为空时，回填倾角/近远地点（OMM/GP 同源推导）
  if ((row.incl == null || row.apogee == null || row.perigee == null) && row.tle_line1 && row.tle_line2) {
    try {
      const rec = twoline2satrec(row.tle_line1, row.tle_line2)
      const mu = 398600.4418
      // rec.no 为 rad/min，先换算成 rad/s（与 jobs/screening 的 apsisFromTle 同口径）
      const nRadS = Number(rec.no) / 60
      if (Number.isFinite(nRadS) && nRadS > 0) {
        const aKm = Math.cbrt(mu / (nRadS * nRadS))
        const e = Number(rec.ecco)
        if (Number.isFinite(aKm) && Number.isFinite(e)) {
          const RE = 6378.137
          row.incl = row.incl ?? (Number(rec.inclo) * 180) / Math.PI
          row.apogee = row.apogee ?? aKm * (1 + e) - RE
          row.perigee = row.perigee ?? aKm * (1 - e) - RE
        }
      }
    } catch {
      /* 推导失败保留编目原值 */
    }
  }
  return row
}

/** 认领前预览：NORAD 在编目中的最新信息 */
router.get('/objects/lookup/:noradId', async (req, res) => {
  const norad = Number(req.params.noradId)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const tle = await satTleOf(norad)
  if (!tle) {
    res.status(404).json(fail(404, `编目中未找到 NORAD ${norad}`))
    return
  }
  const orgId = Number(req.auth?.user.orgId || 0)
  const owner = await getOwnerClaim(norad)
  const mine = orgId ? await getObjectByOrgNorad(orgId, norad) : null
  // C1：VIP 组织预览时回显该目标是否在业主授权范围内（前端据此灰显「业主认领」）
  const isVip =
    (!!req.auth?.user.isVip || req.auth?.org?.plan === 'vip') && req.auth?.org?.status === 'active'
  const scope = orgId && isVip ? await checkClaimScope(orgId, norad) : null
  res.json(
    ok({
      sat: tle,
      owner_claim: owner
        ? { id: owner.id, orgId: owner.org_id, isMine: owner.org_id === orgId }
        : null,
      my_claim: mine
        ? {
            id: mine.id,
            claimType: mine.claim_type,
            claimStatus: mine.claim_status,
            reviewNote: mine.review_note,
            alias: mine.alias ?? null
          }
        : null,
      owner_scope: scope ? { configured: scope.configured, allowed: scope.allowed, matched: scope.matched } : null
    })
  )
})

/** 本组织目标列表；平台账号返回全平台只读列表（带所属组织名） */
router.get('/objects', async (req: ScopedRequest, res) => {
  if (!req.auth?.org || !req.auth.user.orgId) {
    if (!isPlatformAccount(req)) {
      // R2-28：无组织普通用户尚未关注任何目标（首次关注时才会创建个人工作区）
      res.json(ok([]))
      return
    }
    const all = await listAllObjects()
    const bound = await countBoundEphem(all.map((o) => o.id))
    res.json(ok(all.map((o) => ({ ...o, bound_ephemerides: bound.get(o.id) ?? 0 }))))
    return
  }
  const orgId = Number(req.auth.user.orgId)
  // 待审核业主申请也返回本组织列表，便于用户看到「待审核」状态（不影响日更/其它只取 claimed 的场景）
  const list = await listObjectsByOrg(orgId, { includePending: true })
  const bound = await countBoundEphem(list.map((o) => o.id))
  res.json(ok(list.map((o) => ({ ...o, bound_ephemerides: bound.get(o.id) ?? 0 }))))
})

/**
 * 认领目标：
 *  - normal 普通认领：学习/教学/模拟科研，可被多组织重复认领，同组织同一目标仅一条；
 *  - owner 授权认领：卫星业主，同一 NORAD 全局仅一条（唯一键兜底）。
 * 冲突语义优先于配额，避免 403 掩盖 409。
 */
router.post('/objects', async (req: ScopedRequest, res) => {
  if (!(await ensureBusinessOrg(req, res))) return
  const orgId = Number(req.auth!.user.orgId)
  const body = req.body as {
    noradId?: unknown
    claimType?: unknown
    massKg?: unknown
    crossSectionM2?: unknown
    propulsion?: unknown
  }
  const norad = Number(body.noradId)
  if (!Number.isInteger(norad) || norad <= 0) {
    res.status(400).json(fail(400, 'NORAD 编号无效'))
    return
  }
  const claimType: ClaimType = body.claimType === 'owner' ? 'owner' : 'normal'
  // R2-27：普通用户 API 层直接拒绝业主认领（不依赖前端按钮禁用）
  if (claimType === 'owner' && !ownerClaimAllowed(req.auth, res)) return
  const tle = await satTleOf(norad)
  if (!tle) {
    res.status(404).json(fail(404, `编目中未找到 NORAD ${norad}，无法认领`))
    return
  }
  const mine = await getObjectByOrgNorad(orgId, norad)
  if (mine && mine.claim_status === 'pending') {
    res.status(409).json(fail(409, '本组织已有待审核的业主认领申请，请等待平台超管审核'))
    return
  }
  if (mine && mine.claim_status === 'claimed') {
    if (mine.claim_type === 'owner') {
      res.status(409).json(fail(409, '本组织已是该目标的业主，无需重复认领'))
      return
    }
    if (claimType === 'normal') {
      res.status(409).json(fail(409, '本组织已关注该目标，无需重复关注'))
      return
    }
  }
  if (claimType === 'owner') {
    const owner = await getOwnerClaim(norad)
    if (owner) {
      res.status(409).json(fail(409, `NORAD ${norad} 已有业主认领（卫星业主），每个目标仅允许一个业主认领`))
      return
    }
    // C1 授权范围：配置了范围才拦截；未配置时放行，业主认领统一走「提交 → 平台超管审核」
    const scope = await checkClaimScope(orgId, norad)
    if (scope.configured && !scope.allowed) {
      res.status(403).json(fail(403, `NORAD ${norad} 不在本组织业主授权范围内，如需扩围请联系平台管理员`))
      return
    }
  }
  const mass = body.massKg === undefined || body.massKg === null || body.massKg === '' ? null : Number(body.massKg)
  const cs = body.crossSectionM2 === undefined || body.crossSectionM2 === null || body.crossSectionM2 === '' ? null : Number(body.crossSectionM2)
  // R2-27：已关注的组织再发起业主认领 → 同行升级为 owner+pending，绝不插入第二行
  if (mine && mine.claim_status === 'claimed' && mine.claim_type === 'normal' && claimType === 'owner') {
    // 升级为业主认领会占用组织认领额度（关注额度同时释放一行），先校验
    const upgradeExceeded = await quotaExceeded('claims_max', req.auth!.org)
    if (upgradeExceeded) {
      res.status(upgradeExceeded.status).json(upgradeExceeded.body)
      return
    }
    const okUpgrade = await upgradeNormalToOwner(mine.id, {
      requestedByUserId: req.auth!.user.id,
      massKg: mass !== null && Number.isFinite(mass) ? mass : null,
      crossSectionM2: cs !== null && Number.isFinite(cs) ? cs : null,
      propulsion: typeof body.propulsion === 'string' ? body.propulsion.slice(0, 60) : ''
    })
    if (!okUpgrade) {
      res.status(409).json(fail(409, '认领冲突：该目标状态已变化，请刷新后重试'))
      return
    }
    const row = await getObjectById(mine.id)
    await writeUserAudit(req.auth, 'object.claim.submit', {
      after: {
        summary: `关注升级为业主认领申请：${objectAuditLabel(row ?? mine)}，待审核`,
        id: row?.id ?? mine.id,
        norad,
        name: row?.name ?? mine.name,
        claimType: 'owner',
        from: 'watch',
        status: 'pending'
      }
    })
    res.json(
      ok({
        ...row,
        sat: tle,
        pending_review: true,
        message: '关注已升级为业主认领申请，等待平台超管审核'
      })
    )
    return
  }
  // 配额按类型拆分：业主认领 → claims_max；关注 → watches_max
  const exceeded = await quotaExceeded(claimType === 'owner' ? 'claims_max' : 'watches_max', req.auth!.org)
  if (exceeded) {
    res.status(exceeded.status).json(exceeded.body)
    return
  }
  try {
    // 曾经被驳回的本组织记录：重置后重新进入审核流（避免唯一键冲突）
    if (mine) {
      const okResubmit = await resubmitObjectClaim(mine.id, {
        claimType,
        requestedByUserId: req.auth!.user.id,
        massKg: mass !== null && Number.isFinite(mass) ? mass : null,
        crossSectionM2: cs !== null && Number.isFinite(cs) ? cs : null,
        propulsion: typeof body.propulsion === 'string' ? body.propulsion.slice(0, 60) : ''
      })
      if (!okResubmit) {
        res.status(409).json(fail(409, '认领冲突：该目标状态已变化，请刷新后重试'))
        return
      }
      const row = await getObjectById(mine.id)
      if (claimType === 'owner') {
        await writeUserAudit(req.auth, 'object.claim.submit', {
          after: {
            summary: `重新提交业主认领申请：${objectAuditLabel(row ?? mine)}，待审核`,
            id: row?.id ?? mine.id,
            norad,
            name: row?.name ?? mine.name,
            claimType: 'owner',
            resubmit: true,
            status: 'pending'
          }
        })
        res.json(
          ok({
            ...row,
            sat: tle,
            pending_review: true,
            message: '认领申请已重新提交，等待平台超管审核'
          })
        )
        return
      }
      await writeUserAudit(req.auth, 'object.watch', {
        after: {
          summary: `关注目标 ${objectAuditLabel(row ?? mine)}`,
          id: row?.id ?? mine.id,
          norad,
          name: row?.name ?? mine.name,
          claimType: 'normal',
          resubmit: true
        }
      })
      res.json(ok({ ...row, sat: tle }))
      return
    }
    const row = await createObject({
      orgId,
      noradId: norad,
      name: tle.object_name || `NORAD ${norad}`,
      claimType,
      // 授权认领（卫星业主）需超管审核：先落 pending，审核通过后才占用全局唯一业主位
      claimStatus: claimType === 'owner' ? 'pending' : 'claimed',
      requestedByUserId: req.auth!.user.id,
      massKg: mass !== null && Number.isFinite(mass) ? mass : null,
      crossSectionM2: cs !== null && Number.isFinite(cs) ? cs : null,
      propulsion: typeof body.propulsion === 'string' ? body.propulsion.slice(0, 60) : ''
    })
    if (claimType === 'owner') {
      await writeUserAudit(req.auth, 'object.claim.submit', {
        after: {
          summary: `提交业主认领申请：${objectAuditLabel(row)}，待审核`,
          id: row.id,
          norad,
          name: row.name,
          claimType: 'owner',
          status: 'pending'
        }
      })
      res.json(
        ok({
          ...row,
          sat: tle,
          pending_review: true,
          message: '认领申请已提交，等待平台超管审核；审核通过后目标才归本用户所有'
        })
      )
      return
    }
    await writeUserAudit(req.auth, 'object.watch', {
      after: {
        summary: `关注目标 ${objectAuditLabel(row)}`,
        id: row.id,
        norad,
        name: row.name,
        claimType: 'normal'
      }
    })
    res.json(ok({ ...row, sat: tle }))
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
      res.status(409).json(fail(409, '认领冲突：本组织已认领，或该目标已有业主认领'))
      return
    }
    console.error('[objects] claim failed:', (e as Error).message)
    res.status(500).json(fail(500, '认领写入失败'))
  }
})

/**
 * R0-2：目标根数同步自检（系统池 GP 直连，筛查 worker 与详情页同源）。
 * 返回每颗目标的 TLE 可用性与龄期，便于筛查前定位「有目标但缺根数」。
 */
router.post('/objects/sync-tle', requireOrg, async (req: ScopedRequest, res) => {
  const orgId = Number(req.auth!.user.orgId)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT o.id, o.norad_id, o.name, t.epoch, t.tle_line1, t.tle_line2
       FROM objects o
       LEFT JOIN sat_tle t ON t.norad_id = o.norad_id AND t.is_active = 1
      WHERE o.org_id = ? AND o.claim_status = 'claimed'
      ORDER BY o.norad_id`,
    [orgId]
  )
  const now = Date.now()
  const MISSING_MS = 7 * 86400_000
  let withTle = 0
  let stale = 0
  let oldest: number | null = null
  let newest: number | null = null
  const missing: number[] = []
  const items = rows.map((r) => {
    const epoch = r.epoch ? new Date(r.epoch as Date | string).getTime() : null
    const okTle = !!(r.tle_line1 && r.tle_line2 && epoch)
    if (okTle) {
      withTle++
      if (now - (epoch as number) > MISSING_MS) stale++
      oldest = oldest === null ? (epoch as number) : Math.min(oldest, epoch as number)
      newest = newest === null ? (epoch as number) : Math.max(newest, epoch as number)
    } else {
      missing.push(Number(r.norad_id))
    }
    return {
      id: Number(r.id),
      norad_id: Number(r.norad_id),
      name: String(r.name ?? ''),
      has_tle: okTle,
      epoch_ms: epoch,
      age_days: epoch ? Math.round(((now - epoch) / 86400_000) * 10) / 10 : null
    }
  })
  res.json(
    ok({
      total: rows.length,
      with_tle: withTle,
      missing: missing.length,
      missing_norads: missing.slice(0, 50),
      stale_7d: stale,
      oldest_epoch_ms: oldest,
      newest_epoch_ms: newest,
      items: items.slice(0, 500)
    })
  )
})

/**
 * R2-2：批量认领（通用能力：任意编目检索结果 / 名称标签批次）。
 * 冲突与配额逐条裁剪：已在本组织 / 编目缺失 / 配额不足分别返回，不整体失败；
 * 普通认领允许多组织重复，因此不存在「已被他组织」跳过。
 */
router.post('/objects/batch-claim', async (req: ScopedRequest, res) => {
  if (!(await ensureBusinessOrg(req, res))) return
  const orgId = Number(req.auth!.user.orgId)
  const raw = (req.body as { norads?: unknown })?.norads
  const norads = [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ].slice(0, 500)
  if (!norads.length) {
    res.status(400).json(fail(400, '请选择要认领的 NORAD'))
    return
  }
  if (!(await ensureObjectsSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  // 批量认领即批量关注，占用组织关注额度
  const limits = await getEffectiveLimits(orgId, req.auth!.org!.plan)
  const limit = limits.find((l) => l.feature === 'watches_max')?.limit ?? null
  const usage = await getUsage(orgId, 'watches_max')
  let remaining = limit == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(limit) - Number(usage))

  const [satRows] = await pool.query<
    Array<RowDataPacket & { norad_id: number; object_name: string }>
  >(
    `SELECT norad_id, object_name FROM sat_tle
      WHERE norad_id IN (?) AND tle_line1 <> '' AND tle_line2 <> ''`,
    [norads]
  )
  const satMap = new Map(satRows.map((r) => [Number(r.norad_id), String(r.object_name ?? '')]))
  // 多组织可重复认领（普通认领），批量认领只需判断本组织是否已有
  const [owned] = await pool.query<Array<RowDataPacket & { norad_id: number }>>(
    `SELECT norad_id FROM objects WHERE org_id = ? AND norad_id IN (?)`,
    [orgId, norads]
  )
  const ownedSet = new Set(owned.map((r) => Number(r.norad_id)))

  const created: Array<{ id: number; norad_id: number; name: string }> = []
  const skipped: Array<{ norad: number; reason: string }> = []
  for (const norad of norads) {
    if (!satMap.has(norad)) {
      skipped.push({ norad, reason: 'not_found' })
      continue
    }
    if (ownedSet.has(norad)) {
      skipped.push({ norad, reason: 'already_mine' })
      continue
    }
    if (remaining <= 0) {
      skipped.push({ norad, reason: 'quota' })
      continue
    }
    try {
      const row = await createObject({
        orgId,
        noradId: norad,
        name: satMap.get(norad) || `NORAD ${norad}`
      })
      created.push({ id: row.id, norad_id: row.norad_id, name: row.name })
      remaining--
    } catch {
      skipped.push({ norad, reason: 'error' })
    }
  }
  if (created.length) {
    await writeUserAudit(req.auth, 'object.watch.batch', {
      after: {
        summary: `批量关注 ${created.length} 个目标` + (skipped.length ? `，跳过 ${skipped.length} 个` : ''),
        count: created.length,
        created: created.slice(0, 50),
        skippedCount: skipped.length,
        skipped: skipped.slice(0, 20)
      }
    })
  }
  res.json(
    ok({
      created,
      skipped,
      quota: {
        plan: req.auth!.org!.plan,
        usage: Number(usage) + created.length,
        limit,
        remaining: limit == null ? null : remaining
      }
    })
  )
})

/** 批量取消关注：仅本组织 claim_type=normal；业主认领必须走详情单独释放，此处跳过。 */
router.post('/objects/batch-unwatch', requireOrg, async (req: ScopedRequest, res) => {
  const orgId = Number(req.auth!.user.orgId)
  const rawIds = (req.body as { ids?: unknown })?.ids
  const ids = [
    ...new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ].slice(0, 500)
  if (!ids.length) {
    res.status(400).json(fail(400, '请选择要取消关注的目标'))
    return
  }
  const [rows] = await pool.query<Array<RowDataPacket & { id: number; org_id: number; claim_type: string; name: string; norad_id: number }>>(
    `SELECT id, org_id, claim_type, name, norad_id FROM objects WHERE id IN (?)`,
    [ids]
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const released: number[] = []
  const skipped: Array<{ id: number; reason: string }> = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || Number(row.org_id) !== orgId) {
      skipped.push({ id, reason: 'not_found' })
      continue
    }
    if (String(row.claim_type) !== 'normal') {
      skipped.push({ id, reason: 'owner' })
      continue
    }
    try {
      await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE bound_object_id = ?', [id])
      await deleteObjectCaParams(id)
      await deleteObject(id)
      released.push(id)
    } catch {
      skipped.push({ id, reason: 'error' })
    }
  }
  if (released.length) {
    const releasedRows = released.map((id) => {
      const r = byId.get(id)
      return { id, norad: r?.norad_id, name: r?.name }
    })
    await writeUserAudit(req.auth, 'object.unwatch.batch', {
      after: {
        summary: `批量取消关注 ${released.length} 个目标` + (skipped.length ? `，跳过 ${skipped.length} 个` : ''),
        count: released.length,
        ids: released,
        objects: releasedRows.slice(0, 50),
        skippedCount: skipped.length,
        skipped: skipped.slice(0, 20)
      }
    })
  }
  res.json(ok({ released, skipped }))
})

/** 本组织认领/关注目标的别名表（仅当前组织；无组织或平台跨组织视图返回空） */
router.get('/objects/aliases', async (req: ScopedRequest, res) => {
  if (!req.auth?.org || !req.auth.user.orgId) {
    res.json(ok([]))
    return
  }
  const items = await listOrgAliases(Number(req.auth.user.orgId))
  res.json(ok(items))
})

/** 目标详情：档案 + 最新轨道要素 + 绑定星历（平台账号只读任意组织目标） */
router.get('/objects/:id', async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  const platform = isPlatformAccount(req)
  if (!platform && row.org_id !== Number(req.auth?.user.orgId)) {
    res.status(403).json(fail(403, '无权查看其他组织的目标'))
    return
  }
  const sat = await satTleOf(row.norad_id)
  const [ephems] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, norad, format, points, published_at, status FROM ephemeris
     WHERE bound_object_id = ? ORDER BY published_at DESC LIMIT 50`,
    [id]
  )
  // 目标级自定义参数（仅业主维护；随详情返回给本组织界面展示）
  const caParams = await getObjectCaParams(id)
  const orgName = platform ? await getObjectOrgName(row.org_id) : ''
  const includeAlias = !platform || Number(req.auth?.user.orgId || 0) === row.org_id
  res.json(ok({ ...row, alias: includeAlias ? (row.alias ?? null) : null, sat, ephemerides: ephems, ca_params: caParams, org_name: orgName }))
})

/** 档案编辑 */
router.patch('/objects/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权修改其他组织的目标'))
    return
  }
  if (!requireOwnerClaim(row, req.auth!.org, res)) return
  const b = req.body as Record<string, unknown>
  const numOrNull = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const existingCa = await getObjectCaParams(id)
  await updateObject(id, {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : undefined,
    massKg: numOrNull(b.massKg),
    crossSectionM2: numOrNull(b.crossSectionM2),
    propulsion: typeof b.propulsion === 'string' ? b.propulsion.slice(0, 60) : undefined,
    acceptedPc: numOrNull(b.acceptedPc),
    acceptedMissKm: numOrNull(b.acceptedMissKm)
  })
  // 目标级自定义参数：仅授权认领业主可保存，且只对该业主生效（按 object_id 存储，不影响其它用户）
  const rawParams = b.params
  let caChanged = false
  let savedCa = existingCa
  if (rawParams && typeof rawParams === 'object') {
    const { patch: caPatch, error } = sanitizeCaPatch(rawParams as Record<string, unknown>)
    if (error) {
      res.status(400).json(fail(400, error))
      return
    }
    const defaults = await getCaDefaults(row.org_id)
    const params = mergeCaParams(existingCa ?? caDefaultsToParams(defaults), caPatch)
    await saveObjectCaParams(id, row.org_id, params, req.auth!.user.email)
    savedCa = params
    caChanged = true
  }
  const updated = await getObjectById(id)
  const caNow = savedCa ?? (await getObjectCaParams(id))
  const action = caChanged ? 'object.ca_params.set' : 'object.update'
  await writeUserAudit(req.auth, action, {
    before: {
      name: row.name,
      massKg: row.mass_kg,
      crossSectionM2: row.cross_section_m2,
      propulsion: row.propulsion,
      acceptedPc: row.accepted_pc,
      acceptedMissKm: row.accepted_miss_km,
      params: existingCa
    },
    after: {
      summary: caChanged
        ? `更新目标定制参数 ${objectAuditLabel(updated ?? row)}`
        : `更新目标档案 ${objectAuditLabel(updated ?? row)}`,
      id,
      norad: row.norad_id,
      name: updated?.name ?? row.name,
      massKg: updated?.mass_kg,
      crossSectionM2: updated?.cross_section_m2,
      propulsion: updated?.propulsion,
      acceptedPc: updated?.accepted_pc,
      acceptedMissKm: updated?.accepted_miss_km,
      params: caNow
    }
  })
  res.json(ok({ ...(updated ?? row), ca_params: caNow }))
})

/** 设置/清除本组织别名：仅认领或关注中的本组织目标；官方名称不变 */
router.patch('/objects/:id/alias', async (req: ScopedRequest, res) => {
  if (!(await ensureBusinessOrg(req, res))) return
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (
    !row ||
    row.org_id !== Number(req.auth!.user.orgId) ||
    (row.claim_status !== 'claimed' && row.claim_status !== 'pending')
  ) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  const parsed = normalizeAlias((req.body as { alias?: unknown }).alias)
  if (!parsed.ok) {
    res.status(400).json(fail(400, parsed.error))
    return
  }
  if (parsed.value) {
    const conflict = await findAliasConflict(row.org_id, parsed.value, row.id)
    if (conflict) {
      res.status(409).json(fail(409, `别名「${parsed.value}」已被本组织目标 NORAD ${conflict.norad_id} 使用`))
      return
    }
  }
  try {
    const updated = await updateObjectAlias(id, parsed.value)
    const cleared = !parsed.value
    await writeUserAudit(req.auth, cleared ? 'object.alias.clear' : 'object.alias.set', {
      before: { alias: row.alias ?? null },
      after: {
        summary: cleared
          ? `清除组织别名 ${objectAuditLabel(row)}`
          : `设置组织别名 ${objectAuditLabel(row)} → ${parsed.value}`,
        id,
        norad: row.norad_id,
        name: row.name,
        alias: parsed.value
      }
    })
    res.json(ok({ ...(updated ?? row), alias: parsed.value }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '保存别名失败'))
  }
})

/** 释放认领 */
router.delete('/objects/:id', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权释放其他组织的目标'))
    return
  }
  const releaseAction = row.claim_type === 'owner' ? 'object.claim.release' : 'object.unwatch'
  const releaseSummary =
    row.claim_type === 'owner'
      ? `释放认领 ${objectAuditLabel(row)}`
      : `取消关注 ${objectAuditLabel(row)}`
  await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE bound_object_id = ?', [id])
  await deleteObjectCaParams(id)
  await deleteObject(id)
  await writeUserAudit(req.auth, releaseAction, {
    before: { id: row.id, norad: row.norad_id, name: row.name, claimType: row.claim_type, status: row.claim_status },
    after: { summary: releaseSummary, released: id, norad: row.norad_id, name: row.name, claimType: row.claim_type }
  })
  res.json(ok({ released: id }))
})

/** 星历绑定：校验星历 NORAD 与目标一致 + 目标归属 */
router.post('/objects/:id/bind-ephem', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(403).json(fail(403, '无权操作其他组织的目标'))
    return
  }
  if (!requireOwnerClaim(row, req.auth!.org, res)) return
  const ephemId = String((req.body as { ephemId?: unknown }).ephemId ?? '').trim()
  if (!ephemId) {
    res.status(400).json(fail(400, '缺少 ephemId'))
    return
  }
  const [eph] = await pool.query<RowDataPacket[]>(
    'SELECT id, norad, name FROM ephemeris WHERE id = ? LIMIT 1',
    [ephemId]
  )
  if (!eph[0]) {
    res.status(404).json(fail(404, '星历不存在'))
    return
  }
  if (Number(eph[0].norad) !== row.norad_id) {
    res.status(400).json(fail(400, `星历 NORAD ${eph[0].norad} 与目标 NORAD ${row.norad_id} 不一致，拒绝绑定`))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = ? WHERE id = ?', [id, ephemId])
  await writeUserAudit(req.auth, 'object.ephem.bind', {
    after: {
      summary: `绑定星历 ${ephemId} 到 ${objectAuditLabel(row)}`,
      objectId: id,
      norad: row.norad_id,
      name: row.name,
      ephemId,
      ephemName: eph[0].name ?? null
    }
  })
  res.json(ok({ bound: ephemId, to: id }))
})

/** 星历解绑 */
router.post('/objects/:id/unbind-ephem', requireOrg, async (req: ScopedRequest, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) ? await getObjectById(id) : null
  if (!row || row.org_id !== Number(req.auth!.user.orgId)) {
    res.status(404).json(fail(404, '目标不存在'))
    return
  }
  if (!requireOwnerClaim(row, req.auth!.org, res)) return
  const ephemId = String((req.body as { ephemId?: unknown }).ephemId ?? '').trim()
  if (!ephemId) {
    res.status(400).json(fail(400, '缺少 ephemId'))
    return
  }
  await pool.query('UPDATE ephemeris SET bound_object_id = NULL WHERE id = ? AND bound_object_id = ?', [ephemId, id])
  await writeUserAudit(req.auth, 'object.ephem.unbind', {
    after: {
      summary: `解绑星历 ${ephemId}（${objectAuditLabel(row)}）`,
      objectId: id,
      norad: row.norad_id,
      name: row.name,
      ephemId
    }
  })
  res.json(ok({ unbound: ephemId }))
})

export default router
