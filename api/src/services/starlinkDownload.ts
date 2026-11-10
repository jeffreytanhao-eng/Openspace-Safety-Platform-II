/**
 * StarLink 公开星历下载：对 GCS 上的 gzip 对象做分段并行拉取，再本地解压。
 * 线上到 api.starlink.com 的单连接很慢（常年几十 KB/s），分段可同时占用多条 TCP。
 * 注意：必须用 https 原样拿回 gzip 字节；全局 fetch 会自动解压，分段后无法拼接。
 */
import https from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { gunzip as gunzipCb } from 'node:zlib'
import { promisify } from 'node:util'

const gunzip = promisify(gunzipCb)

export const STARLINK_UA = 'openspace-safety-api/2.0'

/** 每个文件拆成几段。段数过多会在窄链路上互相争抢。 */
export const RANGE_PARTS = 8
/** 同时下载几个文件（每文件再拆 RANGE_PARTS 段）。 */
export const FILE_CONCURRENCY = 3
const MIN_SIZE_FOR_RANGES = 256 * 1024
const PART_RETRIES = 2

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  keepAliveMsecs: 15_000
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const v = headers[name.toLowerCase()]
  if (Array.isArray(v)) return v[0] ?? ''
  return v ?? ''
}

function parseGzipTotal(headers: IncomingHttpHeaders): number | null {
  const cr = header(headers, 'content-range')
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr)
  return m ? Number(m[1]) : null
}

function objectTag(headers: IncomingHttpHeaders): string {
  return header(headers, 'etag') || header(headers, 'x-goog-generation') || ''
}

async function requestRaw(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        agent,
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

async function requestRawRetry(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  retries = PART_RETRIES
): Promise<RawResponse> {
  let last: Error | undefined
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await requestRaw(url, headers, timeoutMs)
      if (r.status >= 500 || r.status === 429) {
        throw new Error(`HTTP ${r.status}`)
      }
      return r
    } catch (e) {
      last = e as Error
      if (i < retries) await sleep(300 * (i + 1))
    }
  }
  throw last ?? new Error('request failed')
}

const gzipHeaders = {
  'User-Agent': STARLINK_UA,
  Accept: '*/*',
  'Accept-Encoding': 'gzip'
}

async function maybeGunzip(buf: Buffer): Promise<Buffer> {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return await gunzip(buf)
  }
  return buf
}

async function fetchWhole(url: string, timeoutMs: number): Promise<Buffer> {
  const r = await requestRawRetry(url, gzipHeaders, timeoutMs)
  if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`)
  return maybeGunzip(r.body)
}

async function fetchByRanges(url: string, total: number, tag: string, timeoutMs: number): Promise<Buffer> {
  const n = Math.min(RANGE_PARTS, Math.max(2, Math.ceil(total / (128 * 1024))))
  const step = Math.ceil(total / n)
  const parts = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const start = i * step
      const end = Math.min(total, start + step) - 1
      if (start > end) return Buffer.alloc(0)
      const r = await requestRawRetry(
        url,
        { ...gzipHeaders, Range: `bytes=${start}-${end}` },
        Math.max(30_000, Math.floor(timeoutMs / 2))
      )
      if (r.status !== 206) throw new Error(`${url} range ${start}-${end}: HTTP ${r.status}`)
      const expect = end - start + 1
      if (r.body.length !== expect) {
        throw new Error(`${url} range ${start}-${end}: got ${r.body.length}, expected ${expect}`)
      }
      const partTag = objectTag(r.headers)
      if (tag && partTag && partTag !== tag) {
        throw new Error(`${url} changed mid-download (${tag} -> ${partTag})`)
      }
      return r.body
    })
  )
  const raw = Buffer.concat(parts)
  if (raw.length !== total) throw new Error(`${url} assembled ${raw.length}, expected ${total}`)
  return maybeGunzip(raw)
}

/** 下载一份公开星历（或清单），返回解压后的原文。 */
export async function downloadPublicFile(url: string, timeoutMs = 180_000): Promise<Buffer> {
  try {
    const probe = await requestRawRetry(url, { ...gzipHeaders, Range: 'bytes=0-0' }, Math.min(45_000, timeoutMs), 1)
    if (probe.status === 200) return maybeGunzip(probe.body)
    if (probe.status === 206) {
      const total = parseGzipTotal(probe.headers)
      const tag = objectTag(probe.headers)
      if (total && total >= MIN_SIZE_FOR_RANGES) {
        return await fetchByRanges(url, total, tag, timeoutMs)
      }
    }
  } catch (e) {
    console.warn('[starlink] ranged download failed, fallback to single stream:', (e as Error).message)
  }
  return fetchWhole(url, timeoutMs)
}

export function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString('utf8').trimStart()
  return head.startsWith('<')
}
