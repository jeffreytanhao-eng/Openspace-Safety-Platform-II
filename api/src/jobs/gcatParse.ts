/**
 * Parsers and display mappers for the public GCAT TSV files.
 * Column names and meanings follow the published catalog documentation
 * (https://planet4589.org/space/gcat/web/cat/cols.html and pcols.html).
 * Do not show this source name in the product UI.
 */
import { normalizeIntlDesig } from '../db/catalogProfileDb.js'

export const GCAT_FILES = {
  satcat: 'satcat.tsv',
  satcat100k: 'satcat100k.tsv',
  psatcat: 'psatcat.tsv',
  orgs: 'orgs.tsv',
  sites: 'sites.tsv',
  launchlog: 'launchlog.tsv'
} as const

export const GCAT_URLS: Record<keyof typeof GCAT_FILES, string> = {
  satcat: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv',
  satcat100k: 'https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv',
  psatcat: 'https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv',
  orgs: 'https://planet4589.org/space/gcat/tsv/tables/orgs.tsv',
  sites: 'https://planet4589.org/space/gcat/tsv/tables/sites.tsv',
  launchlog: 'https://planet4589.org/space/gcat/tsv/derived/launchlog.tsv'
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
}

/** Payload Category codes → English labels (UI may further localize via i18n). */
export const PURPOSE_EN: Record<string, string> = {
  AST: 'Astronomy',
  BIO: 'Biology / life sciences',
  CAL: 'Calibration',
  COM: 'Communications',
  EDU: 'Education',
  EOSCI: 'Earth observing science',
  EW: 'Missile early warning',
  GEOD: 'Geodesy',
  IMG: 'Optical imaging',
  'IMG-R': 'Radar imaging',
  INF: 'Infrastructure',
  MET: 'Meteorology',
  'MET-RO': 'Radio occultation meteorology',
  MGRAV: 'Microgravity',
  MISC: 'Miscellaneous',
  NAV: 'Navigation',
  PLAN: 'Deep-space mission',
  RB: 'Rocket body',
  RV: 'Reentry vehicle',
  SCI: 'Science',
  SIG: 'Signals intelligence',
  SS: 'Human spaceflight',
  TARG: 'Target',
  TECH: 'Technology / training',
  WEAPON: 'Weapon'
}

export function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = v.trim()
  if (!s || s === '-' || s === '--') return null
  return s
}

export function parseNumber(v: string | null | undefined): number | null {
  const s = emptyToNull(v)
  if (!s) return null
  const n = Number(s.replace(/[^\d.eE+-]/g, ''))
  if (!Number.isFinite(n) || n === 0) return null
  return n
}

export function parseNorad(satcat: string | null | undefined): number {
  const s = emptyToNull(satcat)
  if (!s || !/^\d+$/.test(s)) return 0
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** VagueDate → YYYY-MM-DD, or YYYY-MM when the day is not given. */
export function parseVagueDate(raw: string | null | undefined): string | null {
  const s = emptyToNull(raw)
  if (!s) return null
  const m = /^(\d{4})\s+([A-Za-z]{3})(?:\s+(\d{1,2}))?/.exec(s)
  if (!m) {
    const y = /^(\d{4})$/.exec(s)
    return y ? y[1] : null
  }
  const month = MONTHS[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()]
  if (!month) return m[1]
  if (!m[3]) return `${m[1]}-${month}`
  return `${m[1]}-${month}-${String(Number(m[3])).padStart(2, '0')}`
}

export function parseTsv(text: string): { header: string[]; rows: Record<string, string>[]; updated: string | null } {
  const lines = text.split(/\r?\n/)
  let updated: string | null = null
  let header: string[] | null = null
  const rows: Record<string, string>[] = []
  for (const line of lines) {
    if (!line) continue
    if (/^#\s*Updated\b/i.test(line)) {
      updated = line.replace(/^#\s*/, '').trim()
      continue
    }
    if (!header) {
      const raw = line.startsWith('#') ? line.slice(1) : line
      header = raw.split('\t').map((h) => h.trim())
      continue
    }
    if (line.startsWith('#')) continue
    const parts = line.split('\t')
    const rec: Record<string, string> = {}
    for (let i = 0; i < header.length; i++) {
      rec[header[i]] = (parts[i] ?? '').trim()
    }
    rows.push(rec)
  }
  return { header: header || [], rows, updated }
}

export interface OrgRec {
  code: string
  type: string
  shortName: string | null
  name: string | null
  shortEName: string | null
  eName: string | null
}

export function pickOrgName(org: OrgRec | undefined, code: string): string | null {
  if (!org) return emptyToNull(code)
  const isCountry = org.type === 'CY' || org.type.startsWith('CY')
  if (isCountry) {
    return emptyToNull(org.shortEName) || emptyToNull(org.eName) || emptyToNull(org.name) || emptyToNull(org.shortName) || code
  }
  return emptyToNull(org.eName) || emptyToNull(org.shortEName) || emptyToNull(org.name) || emptyToNull(org.shortName) || code
}

export function buildOrgIndex(rows: Record<string, string>[]): Map<string, OrgRec> {
  const map = new Map<string, OrgRec>()
  for (const r of rows) {
    const code = emptyToNull(r.Code)
    if (!code) continue
    const rec: OrgRec = {
      code,
      type: r.Type || '',
      shortName: emptyToNull(r.ShortName),
      name: emptyToNull(r.Name),
      shortEName: emptyToNull(r.ShortEName),
      eName: emptyToNull(r.EName)
    }
    // Prefer a still-open interval when codes repeat (TStop empty / '-').
    const prev = map.get(code)
    if (!prev || emptyToNull(r.TStop) == null) map.set(code, rec)
  }
  return map
}

export function resolveOrgCodes(raw: string | null, orgs: Map<string, OrgRec>): { code: string | null; name: string | null } {
  const s = emptyToNull(raw)
  if (!s) return { code: null, name: null }
  const codes = s.split(/[/,;]+/).map((c) => c.trim()).filter(Boolean)
  const names: string[] = []
  const kept: string[] = []
  for (const c of codes) {
    const name = pickOrgName(orgs.get(c), c)
    if (name) names.push(name)
    kept.push(c)
  }
  return { code: kept.join('/') || null, name: names.join(' / ') || null }
}

export interface SiteRec {
  site: string
  code: string | null
  shortEName: string | null
  eName: string | null
  name: string | null
  shortName: string | null
}

export function buildSiteIndex(rows: Record<string, string>[]): { bySite: Map<string, SiteRec>; byCode: Map<string, SiteRec> } {
  const bySite = new Map<string, SiteRec>()
  const byCode = new Map<string, SiteRec>()
  for (const r of rows) {
    const site = emptyToNull(r.Site)
    if (!site) continue
    const rec: SiteRec = {
      site,
      code: emptyToNull(r.Code),
      shortEName: emptyToNull(r.ShortEName),
      eName: emptyToNull(r.EName),
      name: emptyToNull(r.Name),
      shortName: emptyToNull(r.ShortName)
    }
    bySite.set(site, rec)
    if (rec.code) byCode.set(rec.code, rec)
  }
  return { bySite, byCode }
}

export function resolveSite(code: string | null, index: { bySite: Map<string, SiteRec>; byCode: Map<string, SiteRec> }): {
  code: string | null
  name: string | null
} {
  const s = emptyToNull(code)
  if (!s) return { code: null, name: null }
  const rec = index.bySite.get(s) || index.byCode.get(s)
  if (!rec) return { code: s, name: s }
  const name = rec.shortEName || rec.eName || rec.name || rec.shortName || s
  return { code: rec.site, name }
}

export function formatCatalogSize(lengthM: number | null, diameterM: number | null, spanM: number | null): string | null {
  const parts: string[] = []
  if (lengthM != null && diameterM != null) parts.push(`${fmtDim(lengthM)} × ${fmtDim(diameterM)} m`)
  else if (lengthM != null) parts.push(`${fmtDim(lengthM)} m`)
  else if (diameterM != null) parts.push(`${fmtDim(diameterM)} m`)
  const body = Math.max(lengthM || 0, diameterM || 0)
  if (spanM != null && spanM > body + 0.05) {
    parts.push(`span ${fmtDim(spanM)} m`)
  }
  return parts.length ? parts.join(', ') : null
}

function fmtDim(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export function parsePurpose(category: string | null | undefined): { codes: string | null; purpose: string | null } {
  const s = emptyToNull(category)
  if (!s) return { codes: null, purpose: null }
  const tokens = s.split('/').map((tok) => tok.trim()).filter(Boolean)
  const codes: string[] = []
  const labels: string[] = []
  for (const tok of tokens) {
    // Trailing * = secret orbit flag; trailing ? = uncertain. Strip for the code key.
    const code = tok.replace(/[*?]+$/g, '')
    if (!code) continue
    codes.push(code)
    labels.push(PURPOSE_EN[code] || code)
  }
  return { codes: codes.join('/') || null, purpose: labels.join(' / ') || null }
}

export function payloadName(plName: string | null | undefined): string | null {
  const s = emptyToNull(plName)
  if (!s) return null
  const u = s.toUpperCase()
  if (u.startsWith('[UNID') || u.startsWith('RCS ')) return null
  return s
}

export function normalizePiece(raw: string | null | undefined): string | null {
  return normalizeIntlDesig(raw)
}

export interface LaunchRec {
  jcat: string
  piece: string | null
  launchTag: string | null
  lvType: string | null
  launchSite: string | null
}

export function buildLaunchIndex(rows: Record<string, string>[]): { byJcat: Map<string, LaunchRec>; byPiece: Map<string, LaunchRec> } {
  const byJcat = new Map<string, LaunchRec>()
  const byPiece = new Map<string, LaunchRec>()
  for (const r of rows) {
    const jcat = emptyToNull(r.JCAT)
    if (!jcat) continue
    const rec: LaunchRec = {
      jcat,
      piece: normalizePiece(r.Piece),
      launchTag: emptyToNull(r.Launch_Tag),
      lvType: emptyToNull(r.LV_Type),
      launchSite: emptyToNull(r.Launch_Site)
    }
    if (!byJcat.has(jcat)) byJcat.set(jcat, rec)
    if (rec.piece && !byPiece.has(rec.piece)) byPiece.set(rec.piece, rec)
  }
  return { byJcat, byPiece }
}

export function lookupLaunch(jcat: string, piece: string | null, index: ReturnType<typeof buildLaunchIndex>): LaunchRec | null {
  return index.byJcat.get(jcat) || (piece ? index.byPiece.get(piece) || null : null)
}
