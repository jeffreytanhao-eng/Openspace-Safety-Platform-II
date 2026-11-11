import 'dotenv/config'
import crypto from 'node:crypto'

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 后端运行配置：全部来自环境变量（.env / docker compose） */
export const config = {
  port: num(process.env.PORT, 1234),
  /** API 监听地址。默认仅本机，由 nginx 反代；不要改回 0.0.0.0（安全组失效时会把 API 暴露到公网） */
  listenHost: (process.env.API_LISTEN || '127.0.0.1').trim() || '127.0.0.1',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'openspace',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'openspace_safety'
  },
  /** /cgi/config 下发给前端的静态资源基址（COS / 对象存储；空串 = 本地） */
  staticBase: process.env.STATIC_BASE || '',
  /** JWT 签名密钥（认证用）；未设置时用进程内随机密钥兜底（重启后登录态失效） */
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  /** 平台超管 bootstrap（B1）：首次启动且密码非空时创建 platform_super_admin */
  platformAdmin: {
    email: process.env.PLATFORM_ADMIN_EMAIL || 'admin@openspace.local',
    password: process.env.PLATFORM_ADMIN_PASSWORD || ''
  },
  /** Space-Track 系统日更凭据（C1）；缺失时 GP/CDM 源到点失败并留批次痕迹 */
  spaceTrack: {
    user: process.env.SPACETRACK_USER || '',
    pass: process.env.SPACETRACK_PASS || '',
    baseUrl: process.env.SPACETRACK_BASE_URL || 'https://www.space-track.org'
  },
  /** AOE（spacemapper）日更（C1）；token 缺失时跳过该源 */
  aoe: {
    token: process.env.AOE_TOKEN || '',
    baseUrl: process.env.AOE_BASE_URL || 'https://spacemapper.cn'
  },
  /** 每日日更时刻（UTC，'M H * * *' 形式），默认每日 06:00 */
  dailyFetchCron: process.env.DAILY_FETCH_CRON || '0 6 * * *',
  /** 日报生成/投递时刻（UTC，'M H * * *' 形式），默认每日 06:30（在日更之后） */
  dailyReportCron: process.env.DAILY_REPORT_CRON || '30 6 * * *',
  /** 邮件渠道 SMTP（H2 可选）：未配置时 email 渠道投递如实记 skipped */
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true'
  }
}

if (!process.env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET 未设置，已使用随机临时密钥（重启后所有登录态失效）')
}
