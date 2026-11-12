/**
 * One-shot / refresh ingest for the local public-catalog dossier baseline.
 *
 * Usage (from the api/ directory, loads api/.env via config → dotenv):
 *   npx tsx src/jobs/ingestGcat.ts
 *   npx tsx src/jobs/ingestGcat.ts --download
 *   npx tsx src/jobs/ingestGcat.ts --dir "D:\path\to\data\gcat"
 *
 * Default data directory: <repo>/data/gcat
 * Override with --dir or GCAT_DATA_DIR (a path, not a secret).
 *
 * Does not call Space-Track. Does not write objects.mass_kg / cross_section_m2.
 * Not hooked into the production daily-fetch cron. Weekly refresh is started
 * from server.ts (Monday 00:00 Asia/Shanghai) via gcatRefresh.ts.
 *
 * Source (internal attribution only; do not show in customer-facing product UI):
 *   McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects,
 *   https://planet4589.org/space/gcat
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import '../config.js'
import { ensureCatalogProfileSchema, upsertCatalogProfiles, countCatalogProfiles, type CatalogProfileInsert } from '../db/catalogProfileDb.js'
import { pool } from '../db/pool.js'
import {
  GCAT_FILES,
  GCAT_URLS,
  buildLaunchIndex,
  buildOrgIndex,
  buildSiteIndex,
  emptyToNull,
  formatCatalogSize,
  lookupLaunch,
  normalizePiece,
  parseNumber,
  parseNorad,
  parsePurpose,
  parseTsv,
  parseVagueDate,
  payloadName,
  resolveOrgCodes,
  resolveSite
} from './gcatParse.js'

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // src/jobs or dist/jobs → api → repo
  return path.resolve(here, '..', '..', '..')
}

export function resolveGcatDataDir(cliDir?: string): string {
  if (cliDir && cliDir.trim()) return path.resolve(cliDir.trim())
  const env = (process.env.GCAT_DATA_DIR || '').trim()
  if (env) return path.resolve(env)
  return path.resolve(repoRootFromHere(), 'data', 'gcat')
}

function parseArgs(argv: string[]): { download: boolean; dir?: string } {
  const out: { download: boolean; dir?: string } = { download: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--download') out.download = true
    else if (a === '--dir' && argv[i + 1]) {
      out.dir = argv[++i]
    }
  }
  return out
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  console.log(`[gcat] downloaded ${path.basename(dest)} (${(buf.length / 1024 / 1024).toFixed(1)} MiB)`)
}

async function ensureFiles(dir: string, download: boolean): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  const missing: Array<keyof typeof GCAT_FILES> = []
  for (const key of Object.keys(GCAT_FILES) as Array<keyof typeof GCAT_FILES>) {
    const p = path.join(dir, GCAT_FILES[key])
    if (!fs.existsSync(p)) missing.push(key)
  }
  if (!missing.length && !download) return
  const toFetch = download ? (Object.keys(GCAT_FILES) as Array<keyof typeof GCAT_FILES>) : missing
  if (!toFetch.length) return
  console.log(`[gcat] fetching ${toFetch.length} file(s) from planet4589.org …`)
  for (const key of toFetch) {
    await downloadFile(GCAT_URLS[key], path.join(dir, GCAT_FILES[key]))
  }
}

function readTsv(dir: string, file: string) {
  const p = path.join(dir, file)
  if (!fs.existsSync(p)) throw new Error(`缺少本地目录文件：${p}`)
  const text = fs.readFileSync(p, 'utf8')
  return parseTsv(text)
}

function buildRows(
  satRows: Record<string, string>[],
  satUpdated: string | null,
  psatByJcat: Map<string, Record<string, string>>,
  orgs: ReturnType<typeof buildOrgIndex>,
  sites: ReturnType<typeof buildSiteIndex>,
  launches: ReturnType<typeof buildLaunchIndex>
): CatalogProfileInsert[] {
  const out: CatalogProfileInsert[] = []
  for (const r of satRows) {
    const jcat = emptyToNull(r.JCAT)
    if (!jcat) continue
    const norad = parseNorad(r.Satcat)
    const piece = normalizePiece(r.Piece)
    const owner = resolveOrgCodes(r.Owner, orgs)
    const country = resolveOrgCodes(r.State, orgs)
    const manufacturer = resolveOrgCodes(r.Manufacturer, orgs)
    const psat = psatByJcat.get(jcat)
    const purpose = parsePurpose(psat?.Category)
    const launch = lookupLaunch(jcat, piece, launches)
    const site = resolveSite(launch?.launchSite || null, sites)
    const lengthM = parseNumber(r.Length)
    const diameterM = parseNumber(r.Diameter)
    const spanM = parseNumber(r.Span)
    out.push({
      jcat,
      norad_id: norad,
      piece,
      launch_tag: emptyToNull(r.Launch_Tag),
      sat_type: emptyToNull(r.Type),
      name: emptyToNull(r.Name),
      owner: owner.name,
      owner_code: owner.code,
      country: country.name,
      country_code: country.code,
      purpose: purpose.purpose,
      purpose_codes: purpose.codes,
      payload: payloadName(r.PLName),
      manufacturer: manufacturer.name,
      manufacturer_code: manufacturer.code,
      length_m: lengthM,
      diameter_m: diameterM,
      span_m: spanM,
      catalog_size: formatCatalogSize(lengthM, diameterM, spanM),
      shape: emptyToNull(r.Shape),
      bus: emptyToNull(r.Bus),
      launch_site: site.name,
      launch_site_code: site.code,
      launch_vehicle: launch?.lvType || null,
      launch_date: parseVagueDate(r.LDate),
      catalog_mass_kg: parseNumber(r.Mass) ?? parseNumber(r.TotMass),
      source_updated: satUpdated
    })
  }
  return out
}

export interface GcatIngestResult {
  written: number
  total: number
  sourceUpdated: string | null
  downloaded: boolean
  dir: string
  parsed: {
    satcat: number
    satcat100k: number
    psatcat: number
    orgs: number
    sites: number
    launchlog: number
  }
  elapsedMs: number
}

/** In-process ingest. Does not close the shared pool (safe to call from the API). */
export async function runGcatIngest(opts: { download?: boolean; dir?: string } = {}): Promise<GcatIngestResult> {
  const started = Date.now()
  const download = !!opts.download
  const dir = resolveGcatDataDir(opts.dir)
  console.log(`[gcat] data dir: ${dir}${download ? ' (download)' : ''}`)
  await ensureFiles(dir, download)

  const satA = readTsv(dir, GCAT_FILES.satcat)
  const satB = fs.existsSync(path.join(dir, GCAT_FILES.satcat100k))
    ? readTsv(dir, GCAT_FILES.satcat100k)
    : { rows: [] as Record<string, string>[], updated: null as string | null }
  const psat = readTsv(dir, GCAT_FILES.psatcat)
  const orgsTsv = readTsv(dir, GCAT_FILES.orgs)
  const sitesTsv = readTsv(dir, GCAT_FILES.sites)
  const launchTsv = readTsv(dir, GCAT_FILES.launchlog)

  const psatByJcat = new Map<string, Record<string, string>>()
  for (const r of psat.rows) {
    const id = emptyToNull(r.JCAT)
    if (id) psatByJcat.set(id, r)
  }

  const orgs = buildOrgIndex(orgsTsv.rows)
  const sites = buildSiteIndex(sitesTsv.rows)
  const launches = buildLaunchIndex(launchTsv.rows)

  const satRows = [...satA.rows, ...satB.rows]
  const shortUpdated = (s: string | null) => (s ? s.replace(/^Updated\s+/i, '').trim() : null)
  const sourceUpdated = satB.updated && satA.updated && satB.updated !== satA.updated
    ? `${shortUpdated(satA.updated)}; 100k ${shortUpdated(satB.updated)}`
    : shortUpdated(satA.updated || satB.updated)
  const rows = buildRows(satRows, sourceUpdated, psatByJcat, orgs, sites, launches)

  if (!(await ensureCatalogProfileSchema())) {
    throw new Error('数据库不可用，无法创建 sat_catalog_profile')
  }
  console.log(
    `[gcat] parsed satcat=${satA.rows.length} satcat100k=${satB.rows.length} psatcat=${psat.rows.length} ` +
      `orgs=${orgsTsv.rows.length} sites=${sitesTsv.rows.length} launchlog=${launchTsv.rows.length} → ${rows.length} profiles`
  )
  const written = await upsertCatalogProfiles(rows)
  const total = await countCatalogProfiles()
  console.log(`[gcat] upserted ${written} rows; table now has ${total} rows`)
  return {
    written,
    total,
    sourceUpdated,
    downloaded: download,
    dir,
    parsed: {
      satcat: satA.rows.length,
      satcat100k: satB.rows.length,
      psatcat: psat.rows.length,
      orgs: orgsTsv.rows.length,
      sites: sitesTsv.rows.length,
      launchlog: launchTsv.rows.length
    },
    elapsedMs: Date.now() - started
  }
}

export function gcatFilesPresent(dir?: string): { present: string[]; missing: string[] } {
  const root = resolveGcatDataDir(dir)
  const present: string[] = []
  const missing: string[] = []
  for (const file of Object.values(GCAT_FILES)) {
    if (fs.existsSync(path.join(root, file))) present.push(file)
    else missing.push(file)
  }
  return { present, missing }
}

function isDirectCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = path.normalize(path.resolve(fileURLToPath(import.meta.url)))
    const arg = path.normalize(path.resolve(entry))
    if (self === arg) return true
    // tsx may pass the .ts path while import.meta.url is the same file
    return path.parse(self).name === path.parse(arg).name && path.dirname(self) === path.dirname(arg)
  } catch {
    return false
  }
}

if (isDirectCli() || (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  runGcatIngest({ download: args.download, dir: args.dir })
    .catch((e) => {
      console.error('[gcat] ingest failed:', e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(async () => {
      try {
        await pool.end()
      } catch {
        /* ignore */
      }
    })
}
