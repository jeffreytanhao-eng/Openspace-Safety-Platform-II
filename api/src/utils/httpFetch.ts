/** HTTP 工具：原生 fetch + 指数退避重试；Space-Track 用简易 cookie jar 维持会话 */

const DEFAULT_TIMEOUT_MS = 60_000

export interface FetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  retries?: number
  timeoutMs?: number
  /** 每次请求前调用，用于附加会话 cookie */
  cookie?: () => string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function once(url: string, opts: FetchOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.cookie) {
    const c = opts.cookie()
    if (c) headers.Cookie = c
  }
  return await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: 'follow'
  })
}

/** 带重试的 fetch：仅对网络错误与 429/5xx 重试，最多 `retries` 次（指数退避） */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await once(url, opts)
      if (res.ok) return res
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`)
      } else {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`)
      }
    } catch (e) {
      lastErr = e
      // AbortError / 网络错误 / 429 / 5xx 都走重试
    }
    if (attempt < retries) await sleep(1000 * 2 ** attempt)
  }
  throw lastErr instanceof Error ? lastErr : new Error('请求失败')
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers ?? {}) }
  })
  return (await res.json()) as T
}

/**
 * 极简 Cookie Jar（Space-Track 登录后靠 cookie 维持会话）。
 * Node 22 的 fetch 提供 headers.getSetCookie()。
 */
export class CookieJar {
  private cookies = new Map<string, string>()

  absorb(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const item of list) {
      const kv = item.split(';')[0]
      const idx = kv.indexOf('=')
      if (idx <= 0) continue
      const name = kv.slice(0, idx).trim()
      const value = kv.slice(idx + 1).trim()
      if (!name) continue
      if (!value || /^(deleted|null)$/i.test(value)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get size(): number {
    return this.cookies.size
  }
}
