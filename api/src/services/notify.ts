/**
 * 通知投递服务（Epic H2）：
 *  - webhook：POST JSON，HMAC-SHA256 签名（X-Osp-Signature），网络错误/429/5xx 指数退避重试 2 次；
 *  - email：SMTP（nodemailer）；SMTP 未配置 → skipped（如实留因，不静默假装成功）。
 * 所有投递结果由调用方落 notify_deliveries 审计。
 */
import crypto from 'node:crypto'
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'
import { fetchWithRetry } from '../utils/httpFetch.js'
import { decryptSecret } from '../utils/secretBox.js'
import type { NotifyChannel, ChannelStatus } from '../db/notifyDb.js'

export interface DeliveryResult {
  status: ChannelStatus
  attempts: number
  statusCode: number | null
  error: string | null
}

/** webhook 密钥解密（secret_enc 密文 → 明文）；无密钥返回空 */
export function channelSecret(ch: NotifyChannel): string {
  if (ch.kind !== 'webhook' || !ch.secret_enc) return ''
  try {
    return JSON.parse(decryptSecret(ch.secret_enc)).secret ?? ''
  } catch {
    return ''
  }
}

/** webhook URL 掩码（保留协议与主机，路径段替换为 ****，查询串整体打码） */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').map((seg) => (seg ? '****' : seg))
    return `${u.protocol}//${u.host}${parts.join('/')}${u.search ? '?****' : ''}`
  } catch {
    return url.length > 12 ? `${url.slice(0, 8)}****` : '****'
  }
}

/** 投递 webhook：JSON POST + 签名头；返回终态（内部已重试） */
export async function deliverWebhook(ch: NotifyChannel, kind: string, payload: unknown): Promise<DeliveryResult> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Osp-Event': kind,
    'X-Osp-Delivery': crypto.randomUUID()
  }
  const secret = channelSecret(ch)
  if (secret) {
    headers['X-Osp-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
  }
  let lastCode: number | null = null
  let lastErr: string | null = null
  let attempts = 0
  try {
    const res = await fetchWithRetry(ch.target, {
      method: 'POST',
      headers,
      body,
      retries: 2,
      timeoutMs: 15_000,
      onAttempt: (n) => { attempts = n }
    })
    lastCode = res.status
    await res.text().catch(() => '')
    return { status: 'success', attempts, statusCode: lastCode, error: null }
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e)
    // 状态码从错误信息解析；attempts 已由 onAttempt 记录实际尝试轮数
    const m = /HTTP (\d{3})/.exec(lastErr)
    if (m) lastCode = Number(m[1])
    if (!attempts) attempts = 1
    return { status: 'failed', attempts, statusCode: lastCode, error: lastErr }
  }
}

let mailer: Transporter | null = null
let mailerKey = ''

function getMailer(): Transporter | null {
  const { host, port, user, pass, secure } = config.smtp
  if (!host) return null
  const key = `${host}:${port}:${user}:${secure}`
  if (!mailer || mailerKey !== key) {
    mailer = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined
    })
    mailerKey = key
  }
  return mailer
}

export function smtpConfigured(): boolean {
  return Boolean(config.smtp.host)
}

/** 投递邮件：SMTP 未配置 → skipped（不视为失败）；SMTP 错误 → failed */
export async function deliverEmail(ch: NotifyChannel, subject: string, text: string): Promise<DeliveryResult> {
  const transport = getMailer()
  if (!transport) {
    return { status: 'skipped', attempts: 0, statusCode: null, error: 'SMTP 未配置（SMTP_HOST 缺失），邮件未发送' }
  }
  try {
    const info = await transport.sendMail({
      from: config.smtp.from || 'openspace@localhost',
      to: ch.target,
      subject,
      text
    })
    return { status: 'success', attempts: 1, statusCode: null, error: info.response ?? null }
  } catch (e) {
    return { status: 'failed', attempts: 1, statusCode: null, error: e instanceof Error ? e.message : String(e) }
  }
}
