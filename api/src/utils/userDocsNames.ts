/**
 * 我的文档展示文件名：{base}_{yyyyMMdd-HHmmss}{ext}
 * 冲突时追加 -2、-3。时间一律按 Asia/Shanghai，禁止路径字符。
 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

export function shanghaiStamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '00'
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`
}

export function formatShanghaiDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

export function sanitizeBase(raw: string): string {
  let s = String(raw || '').trim()
  s = s.replace(/\\/g, '/').split('/').pop() || ''
  s = s.replace(ILLEGAL, '_').replace(/_+/g, '_').replace(/^[_\s.]+|[_\s.]+$/g, '')
  if (!s) s = 'document'
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

export function splitFilename(name: string): { base: string; ext: string } {
  const raw = String(name || '').trim().replace(/\\/g, '/')
  const baseName = raw.split('/').pop() || 'document'
  const lower = baseName.toLowerCase()
  const compound = ['.txt.gz', '.tar.gz', '.csv.gz', '.json.gz']
  for (const c of compound) {
    if (lower.endsWith(c)) {
      return { base: sanitizeBase(baseName.slice(0, -c.length)), ext: c }
    }
  }
  const dot = baseName.lastIndexOf('.')
  if (dot <= 0) return { base: sanitizeBase(baseName), ext: '' }
  return { base: sanitizeBase(baseName.slice(0, dot)), ext: baseName.slice(dot).toLowerCase() }
}

export function buildDocumentTitle(
  base: string,
  stamp: string,
  ext: string,
  existing: Iterable<string>
): string {
  const cleanBase = sanitizeBase(base)
  const cleanExt = !ext ? '' : ext.startsWith('.') ? ext : `.${ext}`
  const taken = new Set(existing)
  const first = `${cleanBase}_${stamp}${cleanExt}`
  if (!taken.has(first)) return first
  for (let n = 2; n < 1000; n++) {
    const name = `${cleanBase}_${stamp}-${n}${cleanExt}`
    if (!taken.has(name)) return name
  }
  return `${cleanBase}_${stamp}-${Date.now()}${cleanExt}`
}

/** 置顶等需要干净展示名时使用：不加时间戳，重名追加 -2、-3。 */
export function uniquifyExactTitle(desired: string, existing: Iterable<string>): string {
  const clean = sanitizeBase(desired)
  const taken = new Set(existing)
  if (!taken.has(clean)) return clean
  for (let n = 2; n < 1000; n++) {
    const name = `${clean}-${n}`
    if (!taken.has(name)) return name
  }
  return `${clean}-${Date.now()}`
}

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.gz')) return 'application/gzip'
  return fallback
}
