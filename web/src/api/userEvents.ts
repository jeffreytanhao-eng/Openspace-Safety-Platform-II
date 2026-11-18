/**
 * 站内事件 API（左下角警铃）：/cgi/notifications
 */
import { cgiCall } from './auth'

export type UserEventType =
  | 'claim.approved'
  | 'claim.rejected'
  | 'screen.done'
  | 'screen.failed'
  | 'report.delivered'
  | 'report.failed'

export interface UserEventItem {
  id: number
  eventType: UserEventType
  payload: Record<string, unknown>
  createdAt: string
}

export interface UserEventList {
  total: number
  items: UserEventItem[]
}

export function listUserEvents(limit = 50): Promise<UserEventList> {
  return cgiCall<UserEventList>({ method: 'GET', url: '/notifications', params: { limit } })
}

export function deleteUserEvent(id: number): Promise<{ id: number }> {
  return cgiCall<{ id: number }>({ method: 'DELETE', url: `/notifications/${id}` })
}
