import 'dotenv/config'

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 后端运行配置：全部来自环境变量（.env / docker compose） */
export const config = {
  port: num(process.env.PORT, 1234),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'openspace',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'openspace_safety'
  },
  /** /cgi/config 下发给前端的静态资源基址（COS / 对象存储；空串 = 本地） */
  staticBase: process.env.STATIC_BASE || ''
}
