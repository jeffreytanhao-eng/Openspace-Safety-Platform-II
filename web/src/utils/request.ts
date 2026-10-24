/**
 * 前台接口请求封装（极简版）
 *
 * 后端统一响应 { code, msg, data }，接口前缀 /cgi：
 *   · 开发环境由 Vite 代理到 127.0.0.1:1234；
 *   · 生产环境由 nginx 反代到 api 容器。
 * 请求失败一律 reject，由调用方决定是否提示（3D 现场不被弹窗打断）。
 */
import axios, { type AxiosRequestConfig } from 'axios'

export interface ApiResult<T = unknown> {
  code: number
  msg: string
  data: T
}

/** 调用 /cgi 接口并解包 data（code !== 0 抛错） */
export async function httpCgi<T>(cfg: AxiosRequestConfig): Promise<T> {
  const res = await axios.request<ApiResult<T>>({
    baseURL: '/cgi',
    timeout: 30000,
    ...cfg
  })
  const body = res.data
  if (!body || body.code !== 0) throw new Error(body?.msg || '请求失败')
  return body.data
}
