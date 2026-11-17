/**
 * 全站字号放大模式（「正常 / 大字」）。
 * 大字模式把所有以 px 声明的 font-size 统一 +2px：扫描已加载样式的规则，
 * 生成一份仅在 html.fs-large 下生效的覆盖表，不改变布局几何（不缩放画布/地图）。
 */
const STORAGE_KEY = 'osp-font-large'
const STEP_PX = 2
const PX_RE = /^(\d+(?:\.\d+)?)px$/i

let styleEl: HTMLStyleElement | null = null
let observer: MutationObserver | null = null
let rebuildTimer: number | undefined

export function fontLargeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 把选择器挂到 html.fs-large 之下，保留原有特异性顺序 */
function prefixSelector(sel: string): string {
  return sel
    .split(',')
    .map((part) => {
      const s = part.trim()
      if (!s) return s
      if (s.startsWith('html')) return s.replace(/^html/, 'html.fs-large')
      if (s.startsWith(':root')) return s.replace(/^:root/, 'html.fs-large')
      return `html.fs-large ${s}`
    })
    .filter(Boolean)
    .join(',')
}

function collect(rules: CSSRuleList): string[] {
  const out: string[] = []
  for (const r of Array.from(rules)) {
    const rule = r as CSSRule & {
      selectorText?: string
      style?: CSSStyleDeclaration
      cssRules?: CSSRuleList
      conditionText?: string
    }
    // 分组规则（@media / @supports / @layer）：递归后按需包回条件；
    // 注意 Chrome 里普通样式规则也带空的 cssRules，必须先按 selectorText 区分
    if (!rule.selectorText && rule.cssRules) {
      const inner = collect(rule.cssRules)
      if (!inner.length) continue
      const body = inner.join('')
      if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) {
        out.push(`@media ${rule.conditionText || 'all'}{${body}}`)
      } else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) {
        out.push(`@supports ${rule.conditionText || 'all'}{${body}}`)
      } else {
        out.push(body)
      }
      continue
    }
    if (!rule.selectorText || !rule.style) continue
    const m = PX_RE.exec(rule.style.fontSize || '')
    if (!m) continue
    const px = parseFloat(m[1])
    if (!(px > 0)) continue
    const important = rule.style.getPropertyPriority('font-size') === 'important' ? ' !important' : ''
    out.push(`${prefixSelector(rule.selectorText)}{font-size:${px + STEP_PX}px${important}}`)
  }
  return out
}

function rebuild(): void {
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'osp-font-large'
    document.head.appendChild(styleEl)
  }
  const chunks: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    if (styleEl && sheet.ownerNode === styleEl) continue
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 跨域样式表（字体 CDN 等）不可读，跳过
    }
    if (!rules) continue
    chunks.push(...collect(rules))
  }
  styleEl.textContent = chunks.join('\n')
}

function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer)
  rebuildTimer = window.setTimeout(() => {
    if (document.documentElement.classList.contains('fs-large')) rebuild()
  }, 200)
}

export function applyFontLarge(on: boolean): void {
  const root = document.documentElement
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式下忽略存储失败 */
  }
  if (!on) {
    root.classList.remove('fs-large')
    styleEl?.remove()
    styleEl = null
    observer?.disconnect()
    observer = null
    return
  }
  root.classList.add('fs-large')
  rebuild()
  if (!observer) {
    // 懒加载路由的样式文件后到：监听 head 新增样式，重建覆盖表
    observer = new MutationObserver(scheduleRebuild)
    observer.observe(document.head, { childList: true, subtree: true })
  }
}
