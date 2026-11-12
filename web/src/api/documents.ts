/**
 * 我的文档 API。
 */
import { cgiCall, AuthError } from './auth'

function headers(): Record<string, string> {
  try {
    const t = localStorage.getItem('osp-token')
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}

export type DocScope = 'personal' | 'org' | 'pinned'

export interface UserDocument {
  id: string
  title: string
  originalName: string
  size: number
  mime: string
  sourceType: string
  pinned: boolean
  scope: DocScope
  createdAt: string
  createdBy: number
  createdByName: string
  canDelete: boolean
  canUnpin: boolean
  canDownload: boolean
}

export interface DocumentPreview {
  kind: 'text' | 'html' | 'none'
  text: string
  truncated: boolean
}

export interface DocumentDetail extends UserDocument {
  preview: DocumentPreview
}

export interface DocumentsList {
  items: UserDocument[]
  quota: { used: number; max: number | null; scope: 'personal' | 'org' | 'none' }
  viewer: { superAdmin: boolean; canPin: boolean }
}

export function listDocuments(): Promise<DocumentsList> {
  return cgiCall<DocumentsList>({ method: 'GET', url: '/documents', headers: headers() })
}

export function getDocument(id: string): Promise<DocumentDetail> {
  return cgiCall<DocumentDetail>({ method: 'GET', url: `/documents/${encodeURIComponent(id)}`, headers: headers() })
}

export function saveReportDocument(payload: {
  kind: 'summary' | 'events'
  window?: '24h' | '3d' | '7d'
  content: string
}): Promise<UserDocument> {
  return cgiCall<UserDocument>({ method: 'POST', url: '/documents/from-report', data: payload, headers: headers() })
}

export function saveEphemerisDocument(payload: { path: string; name?: string }): Promise<UserDocument> {
  return cgiCall<UserDocument>({ method: 'POST', url: '/documents/from-ephemeris', data: payload, headers: headers() })
}

export function saveEventPackageDocument(payload: {
  format: 'md' | 'html' | 'csv'
  content: string
  titleBase: string
}): Promise<UserDocument> {
  return cgiCall<UserDocument>({ method: 'POST', url: '/documents/from-event-package', data: payload, headers: headers() })
}

export function unpinDocument(id: string): Promise<UserDocument> {
  return cgiCall<UserDocument>({ method: 'POST', url: `/documents/${encodeURIComponent(id)}/unpin`, headers: headers() })
}

export function deleteDocument(id: string): Promise<{ id: string }> {
  return cgiCall<{ id: string }>({ method: 'DELETE', url: `/documents/${encodeURIComponent(id)}`, headers: headers() })
}

export async function fetchDocumentHtml(id: string): Promise<string> {
  const res = await fetch(`/cgi/documents/${encodeURIComponent(id)}/file?inline=1`, { headers: headers() })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { msg?: string }
      if (body?.msg) msg = body.msg
    } catch {
      /* ignore */
    }
    throw new AuthError(msg, res.status, res.status)
  }
  return res.text()
}

export async function downloadDocumentFile(id: string, filename: string): Promise<void> {
  const res = await fetch(`/cgi/documents/${encodeURIComponent(id)}/file`, { headers: headers() })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { msg?: string }
      if (body?.msg) msg = body.msg
    } catch {
      /* ignore */
    }
    throw new AuthError(msg, res.status, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'document'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function pushPinnedDocument(file: File): Promise<UserDocument> {
  const res = await fetch('/cgi/documents/pin', {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-Title': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')),
      'X-Content-Type': file.type || 'application/octet-stream'
    },
    body: file
  })
  const body = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: UserDocument } | null
  if (!res.ok || !body || body.code !== 0 || !body.data) {
    throw new AuthError(body?.msg || '推送置顶文档失败', body?.code ?? res.status, res.status)
  }
  return body.data
}
