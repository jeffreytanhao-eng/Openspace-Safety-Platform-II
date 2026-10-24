import mysql from 'mysql2/promise'
import { config } from '../config.js'

/**
 * mysql2 连接池。
 * 采用惰性连接：数据库不可用时服务仍可正常启动，
 * /cgi/health 会如实返回 db:'down'，不会导致进程退出。
 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 3000,
  enableKeepAlive: true
})

/** 探测数据库是否可用（超时/连接失败一律返回 false） */
export async function pingDb(): Promise<boolean> {
  try {
    const conn = await pool.getConnection()
    try {
      await conn.ping()
      return true
    } finally {
      conn.release()
    }
  } catch {
    return false
  }
}
