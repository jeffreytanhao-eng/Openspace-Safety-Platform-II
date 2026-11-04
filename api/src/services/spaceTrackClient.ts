/**
 * Space-Track 客户端：登录（cookie 会话）+ 查询 JSON。
 * 凭据：构造函数可传入（C2 客户自配凭证走组织队列）；缺省回落 .env 的
 * SPACETRACK_USER / SPACETRACK_PASS（C1 系统日更）。
 */
import { config } from '../config.js'
import { CookieJar, fetchWithRetry } from '../utils/httpFetch.js'

export interface SpaceTrackCreds {
  username: string
  password: string
}

export class SpaceTrackClient {
  jar = new CookieJar()
  loggedIn = false

  constructor(private creds?: SpaceTrackCreds) {}

  async login(): Promise<void> {
    if (this.loggedIn) return
    const user = this.creds?.username || config.spaceTrack.user
    const pass = this.creds?.password || config.spaceTrack.pass
    if (!user || !pass) {
      throw new Error('Space-Track 凭据缺失（未配置 SPACETRACK_USER / SPACETRACK_PASS，也未传入客户凭证）')
    }
    const url = `${config.spaceTrack.baseUrl.replace(/\/$/, '')}/ajaxauth/login`
    const body = new URLSearchParams({
      identity: user,
      password: pass
    }).toString()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'openspace-safety-api/2.0'
        },
        body,
        signal: AbortSignal.timeout(60_000)
      })
    } catch (e) {
      throw new Error(`Space-Track 登录请求失败：${e instanceof Error ? e.message : String(e)}`)
    }
    this.jar.absorb(res)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Space-Track 登录失败：HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    // 登录失败时 Space-Track 返回 200 + { "Login": "Failed" } 或 HTML 提示
    if (/"Login"\s*:\s*"Failed"/i.test(text) || /failed/i.test(text.slice(0, 500))) {
      throw new Error('Space-Track 登录失败：账号或密码错误')
    }
    if (this.jar.size === 0) {
      console.warn('[spacetrack] 登录响应未返回 cookie，后续查询可能被拒绝')
    }
    this.loggedIn = true
  }

  async getJson<T>(path: string): Promise<T> {
    await this.login()
    const url = `${config.spaceTrack.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'openspace-safety-api/2.0' },
      cookie: () => this.jar.header(),
      retries: 3,
      timeoutMs: 180_000
    })
    return (await res.json()) as T
  }
}
