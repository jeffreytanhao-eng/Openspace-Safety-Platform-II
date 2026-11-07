/**
 * 认证状态（pinia，Epic A3）：token 持久化 + 当前用户/组织。
 * - token 存 localStorage('osp-token')，刷新后 init() 拉取 /auth/me 恢复会话；
 * - 退出仅清本地（JWT 无服务端会话，服务端失效走 token 过期/换密钥）；
 * - 401（会话过期）由调用方捕获 AuthError 后调 clear()。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  TOKEN_KEY,
  authLogin,
  authMe,
  authRegister,
  type AuthOrg,
  type AuthUser,
  type LoginResp
} from '@/api/auth'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(readToken())
  const user = ref<AuthUser | null>(null)
  const org = ref<AuthOrg | null>(null)
  /** 会话恢复是否已完成（AppShell/守卫等待它，避免闪跳登录页） */
  const ready = ref(false)

  function readToken(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  }

  function persist(t: string | null) {
    token.value = t
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }

  function applyAuth(resp: LoginResp) {
    persist(resp.token)
    user.value = resp.user
    org.value = resp.org
  }

  /** 启动恢复会话：有 token 则拉 me，失败清空 */
  async function init(): Promise<void> {
    if (ready.value) return
    const t = token.value
    if (!t) {
      ready.value = true
      return
    }
    try {
      const me = await authMe()
      user.value = me.user
      org.value = me.org
    } catch {
      persist(null)
      user.value = null
      org.value = null
    } finally {
      ready.value = true
    }
  }

  async function login(email: string, password: string): Promise<void> {
    applyAuth(await authLogin(email, password))
  }

  async function register(payload: {
    email: string
    password: string
    displayName?: string
  }): Promise<void> {
    applyAuth(await authRegister(payload))
  }

  function logout(): void {
    persist(null)
    user.value = null
    org.value = null
  }

  function clear(): void {
    logout()
    ready.value = true
  }

  return { token, user, org, ready, init, login, register, logout, clear }
})
