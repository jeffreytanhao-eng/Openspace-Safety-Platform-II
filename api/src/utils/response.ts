/** 统一响应结构：{ code: 0, msg: 'ok', data } */
export interface ApiResponse<T> {
  code: number
  msg: string
  data: T | null
}

export function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, msg: 'ok', data }
}

export function fail(code: number, msg: string): ApiResponse<never> {
  return { code, msg, data: null }
}
