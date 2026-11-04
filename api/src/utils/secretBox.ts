/**
 * 客户凭证加密箱（Epic C2）：AES-256-GCM 服务端加密存储。
 * 密钥：env CRED_ENC_KEY（64 hex = 32 字节）；缺省由 JWT_SECRET 派生
 * sha256("osp-cred:" + jwtSecret) —— 本地零配置，生产可显式配置。
 * 密文格式 v1.<iv hex>.<tag hex>.<cipher hex>，篡改时 GCM 校验失败抛错；
 * 明文永不落库、API 永不回传。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'

let cachedKey: Buffer | null = null

function key(): Buffer {
  if (cachedKey) return cachedKey
  const env = (process.env.CRED_ENC_KEY || '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(env)) {
    cachedKey = Buffer.from(env, 'hex')
  } else {
    if (env) console.warn('[secretBox] CRED_ENC_KEY 不是 64 位 hex，回退 JWT_SECRET 派生密钥')
    if (!process.env.JWT_SECRET) {
      console.warn('[secretBox] JWT_SECRET 为随机临时密钥，重启后已存客户凭证将无法解密（生产请配置 CRED_ENC_KEY）')
    }
    cachedKey = crypto.createHash('sha256').update(`osp-cred:${config.jwtSecret}`).digest()
  }
  return cachedKey
}

/** 加密：明文 → v1.<iv>.<tag>.<cipher> */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${enc.toString('hex')}`
}

/** 解密：v1.<iv>.<tag>.<cipher> → 明文；失败抛错（调用方转成用户可读提示） */
export function decryptSecret(payload: string): string {
  const [v, ivHex, tagHex, dataHex] = payload.split('.')
  if (v !== 'v1' || !ivHex || !tagHex || !dataHex) {
    throw new Error('密文格式无效')
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('凭证解密失败（服务端密钥已变更或数据被篡改），请重新录入')
  }
}

/** 掩码提示（状态展示用）：保留首尾各 2 字符 */
export function maskSecret(plain: string): string {
  if (!plain) return ''
  if (plain.length <= 6) return '******'
  return `${plain.slice(0, 2)}****${plain.slice(-2)}`
}
