/**
 * 站内事件（左下角警铃）：挂在 /cgi 下，全部 requireAuth。
 *  - GET    /notifications       本用户事件列表（最新在前）+ 总数
 *  - DELETE /notifications/:id   删除（消除）一条事件
 */
import { Router } from 'express'
import type { Request } from 'express'
import { fail, ok } from '../utils/response.js'
import { requireAuth, type AuthContext } from './auth.js'
import {
  ensureUserEventSchema,
  listUserEvents,
  countUserEvents,
  deleteUserEvent,
  type UserEventType
} from '../db/userEventDb.js'

type ScopedRequest = Request & { auth?: AuthContext }

const router = Router()

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

router.get('/notifications', requireAuth, async (req: ScopedRequest, res) => {
  if (!(await ensureUserEventSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const userId = Number(req.auth!.user.id)
  const limit = Number(req.query.limit ?? 50)
  const [rows, total] = await Promise.all([listUserEvents(userId, limit), countUserEvents(userId)])
  res.json(
    ok({
      total,
      items: rows.map((r) => ({
        id: Number(r.id),
        eventType: r.event_type as UserEventType,
        payload: parsePayload(r.payload_json),
        createdAt: r.created_at
      }))
    })
  )
})

router.delete('/notifications/:id', requireAuth, async (req: ScopedRequest, res) => {
  if (!(await ensureUserEventSchema())) {
    res.status(503).json(fail(503, '数据库不可用'))
    return
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(fail(400, '事件编号无效'))
    return
  }
  const done = await deleteUserEvent(Number(req.auth!.user.id), id)
  if (!done) {
    res.status(404).json(fail(404, '事件不存在'))
    return
  }
  res.json(ok({ id }))
})

export default router
