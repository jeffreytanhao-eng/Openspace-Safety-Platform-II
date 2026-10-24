import type { EphemFormat } from './types'

/**
 * 根据文本头部特征判断星历格式。
 * 只做轻量特征匹配，不做完整解析，便于在 Worker 里先分流。
 */
export function detectFormat(text: string): EphemFormat | null {
  if (!text) return null
  // 只看前 20 行，避免大文件全文扫描
  const head = text.slice(0, 8192)
  if (/CCSDS_OEM_VERS/i.test(head)) return 'oem'
  if (/CCSDS_OCM_VERS/i.test(head)) return 'ocm'

  const lines = head.split(/\r?\n/)
  let hasStart = false
  let hasUvw = false
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^ephemeris_start\s*:/i.test(line)) hasStart = true
    if (/^UVW\b/i.test(line) || /\bUVW\b/.test(line)) hasUvw = true
    // 首行 created: 也是 ITC 的典型特征
    if (i === 0 && /^created\s*:/i.test(line) && hasUvw) return 'itc'
  }
  if (hasStart) return 'itc'
  if (hasUvw && /^created\s*:/im.test(head)) return 'itc'
  return null
}
