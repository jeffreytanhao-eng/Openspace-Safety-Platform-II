import express, { Router, type Request, type Response, type NextFunction } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ok, fail } from '../utils/response.js'
import {
  ephemDbUp,
  listRowsDb,
  listAllRowsDb,
  getRowDb,
  getRowByFileDb,
  getRowBySourceNameDb,
  getRowByNoradFormatDb,
  listRowsByNoradDb,
  listAllKeysDb,
  toListItem,
  listVersionsDb,
  getEphemerisVersionDb,
  softDeleteVersionDb,
  setEphemerisOwnershipDb,
  setEphemerisVisibilityDb,
  deleteRowDb,
  canViewEphemeris,
  type EphemViewer
} from '../ephem/ephemDb.js'
import { EPH_ROOT, scanAndIngest, ingestUploadFile, peekUploadMeta } from '../ephem/ingest.js'
import { compareSources, listAccuracySources } from '../services/accuracyCompare.js'
import { requireAuth } from './auth.js'
import { requireSuperAdmin } from './admin.js'
import { isOrgFlagEnabled } from '../db/planDb.js'
import { quotaExceeded } from '../middleware/plan.js'
import { getOwnerClaim } from '../db/objectsDb.js'

const router = Router()

async function assertCanViewNoradFormat(
  viewer: EphemViewer,
  norad: string,
  format: string | undefined,
  res: Response
): Promise<boolean> {
  if (format === 'ITC' || format === 'OCM') {
    const row = await getRowByNoradFormatDb(norad, format)
    if (!row) {
      if (viewer.superAdmin) return true
      res.status(404).json(fail(404, '未找到该星历'))
      return false
    }
    if (!canViewEphemeris(row, viewer)) {
      res.status(403).json(fail(403, '该星历为业主私有或仅 VIP 可见，无权访问'))
      return false
    }
    return true
  }
  const rows = await listRowsByNoradDb(norad)
  if (!rows.length) {
    if (viewer.superAdmin) return true
    res.status(404).json(fail(404, '未找到该星历'))
    return false
  }
  if (!rows.some((row) => canViewEphemeris(row, viewer))) {
    res.status(403).json(fail(403, '该星历为业主私有或仅 VIP 可见，无权访问'))
    return false
  }
  return true
}

/** index.json 回退模式的 visibility 归一（未知值按 public 处理） */
function visibilityOf(v: unknown): 'public' | 'vip' | 'private' {
  return v === 'private' ? 'private' : v === 'vip' ? 'vip' : 'public'
}

/** 已登录请求 → 星历查看者（精度对比等 requireAuth 接口用） */
function viewerFromAuth(req: Request): EphemViewer {
  const user = req.auth!.user
  const org = req.auth!.org
  return {
    userId: user.id,
    superAdmin: user.role === 'platform_super_admin',
    vip: !!user.isVip || org?.plan === 'vip'
  }
}

function safeResolve(rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) return null
  const full = path.resolve(EPH_ROOT, cleaned)
  if (!full.startsWith(EPH_ROOT)) return null
  return full
}

/* ---------------- index.json 回退（数据库不可用时保持现状功能） ---------------- */

interface IndexItem {
  id: string
  [k: string]: unknown
}

function readIndexFile(): { generatedAt: string | null; items: IndexItem[] } | null {
  const indexPath = path.join(EPH_ROOT, 'index.json')
  if (!fs.existsSync(indexPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      generatedAt?: string
      items: IndexItem[]
    }
    return { generatedAt: raw.generatedAt || null, items: raw.items || [] }
  } catch {
    return null
  }
}

/** index.json 内存过滤 + 切片（格式 / 关键词 / 分页），与 DB 模式同构 */
function pagedFromIndex(items: IndexItem[], q: { format?: string; q?: string; page?: number; size?: number }) {
  let list = items
  if (q.format === 'ITC' || q.format === 'OCM') list = list.filter((it) => it.format === q.format)
  const kw = (q.q || '').trim().toLowerCase()
  if (kw) {
    list = list.filter((it) => {
      const name = String(it.name || '').toLowerCase()
      const norad = String(it.norad || '')
      return name.includes(kw) || norad.includes(kw) || String(it.format || '').toLowerCase().includes(kw)
    })
  }
  const total = list.length
  const size = Math.min(Math.max(q.size || 20, 1), 500)
  const totalPages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(q.page || 1, 1), totalPages)
  const slice = list.slice((page - 1) * size, page * size)
  return { total, page, size, totalPages, slice }
}

/** GET /cgi/ephemerides — 星历列表（支持分页 / 格式 / 关键词；DB 不可用回退 index.json） */
router.get('/ephemerides', requireAuth, async (req: Request, res: Response) => {
  const q = {
    format: req.query.format ? String(req.query.format) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    page: req.query.page != null ? Number(req.query.page) || 1 : undefined,
    size: req.query.size != null ? Number(req.query.size) || 20 : 20
  }
  const paged = q.page != null
  const wantKeys = req.query.keys === '1'
  // 第 6 项：私有星历仅上传业主与超管可见；VIP 星历仅 VIP 账号可见
  const viewer = viewerFromAuth(req)

  if (await ephemDbUp()) {
    try {
      if (paged) {
        const { total, rows } = await listRowsDb(q, viewer)
        const size = Math.min(Math.max(q.size || 20, 1), 500)
        const data: Record<string, unknown> = {
          root: 'data/ephemerides',
          generatedAt: new Date().toISOString(),
          source: 'db',
          items: rows.map(toListItem),
          total,
          page: Math.min(Math.max(q.page || 1, 1), Math.max(1, Math.ceil(total / size))),
          size,
          totalPages: Math.max(1, Math.ceil(total / size))
        }
        if (wantKeys) data.allKeys = await listAllKeysDb(viewer)
        res.json(ok(data))
        return
      }
      // legacy 全量模式（态势页内置样本通道）：上限 5000 防超大响应
      const rows = await listAllRowsDb(5000, viewer)
      res.json(
        ok({
          root: 'data/ephemerides',
          generatedAt: new Date().toISOString(),
          source: 'db',
          items: rows.map(toListItem),
          truncated: rows.length >= 5000
        })
      )
      return
    } catch (e) {
      console.error('[ephem] db list failed, fallback to index.json:', (e as Error).message)
    }
  }

  const idx = readIndexFile()
  if (!idx) {
    res.status(404).json(fail(404, '星历目录未初始化'))
    return
  }
  // index.json 快照同样按可见性裁剪（私有 / VIP 星历对外不可见）
  const visibleItems = idx.items.filter((it) =>
    canViewEphemeris(
      {
        visibility: visibilityOf(it.visibility),
        ownerUserId: it.ownerUserId == null ? null : Number(it.ownerUserId)
      },
      viewer
    )
  )
  if (paged) {
    const p = pagedFromIndex(visibleItems, q)
    res.json(
      ok({
        root: 'data/ephemerides',
        generatedAt: idx.generatedAt,
        source: 'file',
        items: p.slice,
        total: p.total,
        page: p.page,
        size: p.size,
        totalPages: p.totalPages,
        ...(wantKeys ? { allKeys: visibleItems.map((it) => `${it.norad}|${it.format}`) } : {})
      })
    )
    return
  }
  res.json(
    ok({
      root: 'data/ephemerides',
      generatedAt: idx.generatedAt,
      source: 'file',
      items: visibleItems
    })
  )
})

/**
 * GET /cgi/ephemerides/file?path=itc/FOO.txt.gz
 * Returns gunzipped text (Content-Type: text/plain) for preview / situation ingest.
 * Optional ?download=1 keeps Content-Disposition attachment of the .gz.
 */
router.get('/ephemerides/file', requireAuth, async (req: Request, res: Response) => {
  const rel = String(req.query.path || '')
  const full = safeResolve(rel)
  if (!full || !fs.existsSync(full)) {
    res.status(404).json(fail(404, '文件不存在'))
    return
  }
  const viewer = viewerFromAuth(req)
  if (await ephemDbUp()) {
    try {
      const row = await getRowByFileDb(rel.replace(/\\/g, '/'))
      if (row && !canViewEphemeris(row, viewer)) {
        res.status(403).json(fail(403, '该星历为业主私有或仅 VIP 可见，无权访问'))
        return
      }
    } catch {
      res.status(503).json(fail(503, '星历元数据查询失败，无法校验权限'))
      return
    }
  }
  try {
    const buf = fs.readFileSync(full)
    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`)
      res.send(buf)
      return
    }
    const text = full.toLowerCase().endsWith('.gz')
      ? zlib.gunzipSync(buf).toString('utf8')
      : buf.toString('utf8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Ephemeris-Path', rel.replace(/\\/g, '/'))
    res.send(text)
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取星历文件失败'))
  }
})

/** GET /cgi/ephemerides/meta/:id — one row by id（DB 优先，回退 index.json） */
router.get('/ephemerides/meta/:id', requireAuth, async (req: Request, res: Response) => {
  const viewer = viewerFromAuth(req)
  if (await ephemDbUp()) {
    try {
      const row = await getRowDb(req.params.id)
      if (row) {
        if (!canViewEphemeris(row, viewer)) {
          res.status(403).json(fail(403, '该星历为业主私有或仅 VIP 可见，无权访问'))
          return
        }
        res.json(ok(toListItem(row)))
        return
      }
    } catch {
      /* 回退 index.json */
    }
  }
  const idx = readIndexFile()
  const hit = idx?.items.find((it) => it.id === req.params.id)
  if (!hit) {
    res.status(404).json(fail(404, '未找到该星历'))
    return
  }
  if (
    !canViewEphemeris(
      {
        visibility: visibilityOf(hit.visibility),
        ownerUserId: hit.ownerUserId == null ? null : Number(hit.ownerUserId)
      },
      viewer
    )
  ) {
    res.status(403).json(fail(403, '该星历为业主私有或仅 VIP 可见，无权访问'))
    return
  }
  res.json(ok(hit))
})

/**
 * POST /cgi/ephemerides/upload?name=<原始文件名>[&visibility=public|vip|private][&confirm=1]
 * 单文件原始字节流上传（前端逐文件顺序上传以展示进度），服务端识别格式 → 分片落盘 → 解析入库。
 *
 * 第 6 项权限口径：超管可上传任意目标星历，可见性可选 public（全部用户）/ vip（仅 VIP）；
 * 若会覆盖业主上传的同目标星历，返回 409 要求带 confirm=1 二次确认；覆盖超管自己导入的直接覆盖。
 * VIP 组织仅可上传**已生效业主认领**目标的星历（默认 private，可显式改为 public 全平台只读可见）。
 */
router.post(
  '/ephemerides/upload',
  requireAuth,
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  expressRaw12mb,
  async (req: Request, res: Response) => {
    const name = String(req.query.name || '')
    const buf = req.body as Buffer
    if (!name || !buf?.length) {
      res.status(400).json(fail(400, '缺少文件名或文件内容'))
      return
    }
    const user = req.auth!.user
    const org = req.auth!.org
    const isSuper = user.role === 'platform_super_admin'
    const meta = peekUploadMeta(name, buf)
    if (!meta) {
      res.status(400).json(fail(400, '无法从文件识别 NORAD 编号，无法校验上传权限'))
      return
    }
    const { norad } = meta
    // 非超管：必须是 VIP 组织，且该 NORAD 已被本组织生效业主认领
    if (!isSuper) {
      if (!org || org.plan !== 'vip' || org.status !== 'active') {
        res.status(403).json(fail(403, '仅 VIP 组织可上传星历，且只能上传已认领目标的星历'))
        return
      }
      const claim = await getOwnerClaim(Number(norad))
      if (!claim || claim.org_id !== org.id) {
        res.status(403).json(fail(403, `NORAD ${norad} 未被本组织业主认领，无法上传其星历`))
        return
      }
    }
    // Epic I 计量全量：登录组织受 ephem_upload_day 生效限额约束
    if (org) {
      const exceeded = await quotaExceeded('ephem_upload_day', org)
      if (exceeded) {
        res.status(exceeded.status).json(exceeded.body)
        return
      }
    }
    const rawVis = String(req.query.visibility || '')
    let visibility: 'public' | 'vip' | 'private'
    if (isSuper) {
      if (rawVis && rawVis !== 'public' && rawVis !== 'vip') {
        res.status(400).json(fail(400, '超管导入的可见性仅支持 public / vip'))
        return
      }
      visibility = rawVis === 'vip' ? 'vip' : 'public'
      // 覆盖保护：同目标（NORAD+格式）或同名文件已有业主上传的星历 → 需显式确认
      const targetId = `${meta.format.toLowerCase()}-${norad}`
      const byId = await getRowDb(targetId)
      const byName = await getRowBySourceNameDb(name)
      const ownerRow = [byId, byName].find((r) => r && r.ownerUserId != null) || null
      const confirmed = req.query.confirm === '1' || req.query.confirm === 'true'
      if (ownerRow && !confirmed) {
        res.status(409).json({
          code: 409,
          msg: '该目标已有业主上传的星历，覆盖前需确认',
          data: {
            needConfirm: true,
            existing: {
              id: ownerRow.id,
              name: ownerRow.name,
              norad: ownerRow.norad,
              format: ownerRow.format,
              uploadedBy: ownerRow.uploadedBy,
              ownerUserId: ownerRow.ownerUserId,
              visibility: ownerRow.visibility,
              publishedMs: ownerRow.publishedMs,
              updatedAt: ownerRow.updatedAt
            }
          }
        })
        return
      }
    } else {
      if (rawVis && rawVis !== 'public' && rawVis !== 'private') {
        res.status(400).json(fail(400, 'visibility 仅支持 public / private'))
        return
      }
      visibility = rawVis === 'public' ? 'public' : 'private'
    }
    try {
      const r = await ingestUploadFile(name, buf, user.email, { overwriteSameName: isSuper })
      await setEphemerisOwnershipDb(r.id, {
        ownerUserId: isSuper ? null : user.id,
        ownerOrgId: isSuper ? null : org?.id ?? null,
        visibility,
        uploadedBy: user.email
      })
      res.json(ok({ ...r, visibility }))
    } catch (e) {
      res.status(400).json(fail(400, (e as Error).message || '上传入库失败'))
    }
  }
)

/** PATCH /cgi/ephemerides/:id — 切换可见性（仅上传业主本人 / 超管） */
router.patch('/ephemerides/:id', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：星历可见性需要 MySQL'))
    return
  }
  const visibility = String((req.body as { visibility?: string })?.visibility || '')
  if (visibility !== 'public' && visibility !== 'private') {
    res.status(400).json(fail(400, 'visibility 仅支持 public / private'))
    return
  }
  try {
    const row = await getRowDb(req.params.id)
    if (!row) {
      res.status(404).json(fail(404, '未找到该星历'))
      return
    }
    const user = req.auth!.user
    const isSuper = user.role === 'platform_super_admin'
    if (!isSuper && row.ownerUserId !== user.id) {
      res.status(403).json(fail(403, '只能修改自己上传的星历可见性'))
      return
    }
    await setEphemerisVisibilityDb(row.id, visibility)
    res.json(ok({ id: row.id, visibility }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '更新星历可见性失败'))
  }
})

/** DELETE /cgi/ephemerides/:id — 删除元数据行与物理文件（仅上传业主本人 / 超管） */
router.delete('/ephemerides/:id', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：删除星历需要 MySQL'))
    return
  }
  try {
    const row = await getRowDb(req.params.id)
    if (!row) {
      res.status(404).json(fail(404, '未找到该星历'))
      return
    }
    const user = req.auth!.user
    const isSuper = user.role === 'platform_super_admin'
    if (!isSuper && row.ownerUserId !== user.id) {
      res.status(403).json(fail(403, '只能删除自己上传的星历'))
      return
    }
    const deleted = await deleteRowDb(row.id)
    const full = safeResolve(row.file)
    if (full && fs.existsSync(full)) {
      try {
        fs.unlinkSync(full)
      } catch (e) {
        console.warn('[ephem] unlink failed:', (e as Error).message)
      }
    }
    res.json(ok({ id: row.id, deleted: !!deleted }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '删除星历失败'))
  }
})

/**
 * POST /cgi/ephemerides/rebuild?force=1 — 扫描 data/ephemerides 入库并导出 index.json；
 * force 清表全量重解析。运维级操作：仅平台超管可调用。
 */
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/ephemerides/rebuild', requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true'
    const r = await scanAndIngest({ exportJson: true, force })
    res.json(ok(r))
  } catch (e) {
    res.status(503).json(fail(503, (e as Error).message || '扫描入库失败'))
  }
})

/* --------------------- G1 星历版本归档 --------------------- */

/**
 * GET /cgi/ephemerides/versions?norad=&format=&page=&size=&includeDeleted=1
 * 版本历史分页（append 账本；默认只列未软删，includeDeleted=1 连同软删行一并返回）
 */
router.get('/ephemerides/versions', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const viewer = viewerFromAuth(req)
    const norad = req.query.norad ? String(req.query.norad) : undefined
    const format = req.query.format ? String(req.query.format) : undefined
    if (!norad && !viewer.superAdmin) {
      res.status(400).json(fail(400, '请指定 norad'))
      return
    }
    if (norad && !(await assertCanViewNoradFormat(viewer, norad, format, res))) return
    const size = Math.min(Math.max(Number(req.query.size) || 20, 1), 200)
    const page = Math.max(Number(req.query.page) || 1, 1)
    const { total, rows } = await listVersionsDb({
      norad,
      format,
      page,
      size,
      includeDeleted: req.query.includeDeleted === '1' || req.query.includeDeleted === 'true'
    })
    res.json(
      ok({
        items: rows,
        total,
        page,
        size,
        totalPages: Math.max(1, Math.ceil(total / size))
      })
    )
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '查询版本历史失败'))
  }
})

/** GET /cgi/ephemerides/versions/:id/content — 按版本回放星历全文（gunzip 文本，审计/比对用） */
router.get('/ephemerides/versions/:id/content', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const ver = await getEphemerisVersionDb(Number(req.params.id) || 0)
    if (!ver) {
      res.status(404).json(fail(404, '版本不存在'))
      return
    }
    if (!(await assertCanViewNoradFormat(viewerFromAuth(req), ver.norad, ver.format, res))) return
    const full = safeResolve(ver.file)
    if (!full || !fs.existsSync(full)) {
      res.status(404).json(fail(404, '版本文件缺失'))
      return
    }
    const buf = fs.readFileSync(full)
    const text = full.toLowerCase().endsWith('.gz')
      ? zlib.gunzipSync(buf).toString('utf8')
      : buf.toString('utf8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Ephem-Version-Sha', ver.sha256)
    res.send(text)
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '读取版本文件失败'))
  }
})

/** DELETE /cgi/ephemerides/versions/:id — 软删版本（行与文件均保留，仅标记 deleted_at；需登录） */
router.delete('/ephemerides/versions/:id', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：版本归档需要 MySQL'))
    return
  }
  try {
    const id = Number(req.params.id) || 0
    const done = await softDeleteVersionDb(id)
    if (!done) {
      res.status(404).json(fail(404, '版本不存在或已删除'))
      return
    }
    res.json(ok({ id, deletedAt: Date.now() }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '软删版本失败'))
  }
})

/* --------------------- G2 精度对比 --------------------- */

/**
 * GET /cgi/ephemerides/accuracy/sources?norad=38117
 * 列出该 NORAD 可参与精度对比的源：OCM 星历（ephemeris）+ 系统 TLE + AOE 历算。
 */
router.get('/ephemerides/accuracy/sources', requireAuth, async (req: Request, res: Response) => {
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：精度对比需要 MySQL'))
    return
  }
  try {
    const sources = await listAccuracySources(String(req.query.norad || ''), viewerFromAuth(req))
    res.json(ok({ norad: String(req.query.norad || ''), sources }))
  } catch (e) {
    res.status(500).json(fail(500, (e as Error).message || '查询对比源失败'))
  }
})

/**
 * POST /cgi/ephemerides/accuracy/compare
 * body: { norad, a: {kind:'ocm'|'tle'|'aoe', id?}, b: {...}, maxPoints? }
 * 重叠时段 RTN 残差：radial/along/cross RMS + 总 RMS + 最大/平均偏差 + 抽稀残差点列。
 */
router.post('/ephemerides/accuracy/compare', requireAuth, async (req: Request, res: Response) => {
  // Epic I 功能开关：accuracy_compare_enabled 关闭的组织拒绝使用精度对比
  const authOrg = (req as import('express').Request & { auth?: { org?: { id: number } | null } }).auth?.org
  if (!(await isOrgFlagEnabled(authOrg?.id ?? null, 'accuracy_compare_enabled'))) {
    res.status(403).json(fail(403, '该功能未对您的组织开放（精度对比）'))
    return
  }
  if (!(await ephemDbUp())) {
    res.status(503).json(fail(503, '数据库不可用：精度对比需要 MySQL'))
    return
  }
  const body = req.body as {
    norad?: string | number
    a?: { kind?: string; id?: string }
    b?: { kind?: string; id?: string }
    maxPoints?: number
  }
  const norad = String(body.norad || '')
  if (!/^\d{1,6}$/.test(norad)) {
    res.status(400).json(fail(400, '缺少有效的 NORAD 编号'))
    return
  }
  const kinds = ['ocm', 'tle', 'aoe']
  const descOf = (d?: { kind?: string; id?: string }) => {
    const kind = kinds.includes(String(d?.kind)) ? (d!.kind as 'ocm' | 'tle' | 'aoe') : null
    return kind ? { kind, id: d?.id } : null
  }
  const a = descOf(body.a)
  const b = descOf(body.b)
  if (!a || !b) {
    res.status(400).json(fail(400, '请选择两个对比源（kind = ocm | tle | aoe）'))
    return
  }
  try {
    const r = await compareSources(norad, a, b, Number(body.maxPoints) || 240, viewerFromAuth(req))
    res.json(ok(r))
  } catch (e) {
    res.status(422).json(fail(422, (e as Error).message || '精度对比计算失败'))
  }
})

/** express.raw 中间件（12MB 与前端单文件上限一致） */
function expressRaw12mb(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: '*/*', limit: '12mb', inflate: true })(req, res, next)
}

export default router
