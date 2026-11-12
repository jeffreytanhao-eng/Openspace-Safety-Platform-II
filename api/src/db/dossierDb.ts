/**
 * Object-dossier layers on top of the local catalog baseline.
 *
 * Read-time stack (first non-empty field wins):
 *   1. org_object_dossier          — viewer's org only; never shown to platform accounts
 *   2. catalog_object_override     — super-admin per-NORAD
 *   3. catalog_family_profile      — super-admin family (shared; resolved by name prefix)
 *   4. sat_catalog_profile / TLE   — public catalog baseline
 *
 * Family and org data are stored once at the right layer, never copied onto
 * every NORAD row. New catalog members matching a family pick up family fields
 * automatically. Catalog mass / size never writes objects.mass_kg or RCS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import {
  ensureCatalogProfileSchema,
  getCatalogProfile,
  type CatalogProfileDto
} from './catalogProfileDb.js'

const FAMILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`catalog_family\` (
  \`id\`              bigint unsigned NOT NULL AUTO_INCREMENT,
  \`name\`            varchar(80)  NOT NULL,
  \`match_prefixes\`  varchar(255) NOT NULL COMMENT 'Comma-separated name prefixes, case-insensitive',
  \`match_bus\`       varchar(80)  NULL COMMENT 'Optional spacecraft-bus match from the local catalog',
  \`note\`            varchar(160) NULL,
  \`created_at\`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_family_name\` (\`name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Catalog family (prefix / bus membership; profile stored once)'`

const FAMILY_PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`catalog_family_profile\` (
  \`family_id\`       bigint unsigned NOT NULL,
  \`photo_path\`      varchar(255) NULL,
  \`owner\`           varchar(200) NULL,
  \`country\`         varchar(120) NULL,
  \`country_code\`    varchar(16)  NULL,
  \`purpose\`         varchar(160) NULL,
  \`purpose_codes\`   varchar(64)  NULL,
  \`manufacturer\`    varchar(240) NULL,
  \`catalog_size\`    varchar(80)  NULL,
  \`length_m\`        double       NULL,
  \`diameter_m\`      double       NULL,
  \`span_m\`          double       NULL,
  \`updated_by\`      varchar(190) NULL,
  \`updated_at\`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`family_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Super-admin family-shared dossier fields'`

const OBJECT_OVERRIDE_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`catalog_object_override\` (
  \`norad_id\`        int          NOT NULL,
  \`photo_path\`      varchar(255) NULL,
  \`owner\`           varchar(200) NULL,
  \`country\`         varchar(120) NULL,
  \`country_code\`    varchar(16)  NULL,
  \`purpose\`         varchar(160) NULL,
  \`purpose_codes\`   varchar(64)  NULL,
  \`payload\`         varchar(200) NULL,
  \`manufacturer\`    varchar(240) NULL,
  \`catalog_size\`    varchar(80)  NULL,
  \`length_m\`        double       NULL,
  \`diameter_m\`      double       NULL,
  \`span_m\`          double       NULL,
  \`launch_site\`     varchar(200) NULL,
  \`launch_vehicle\`  varchar(120) NULL,
  \`updated_by\`      varchar(190) NULL,
  \`updated_at\`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`norad_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Super-admin per-object dossier fields (not family-wide)'`

const ORG_DOSSIER_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`org_object_dossier\` (
  \`id\`              bigint unsigned NOT NULL AUTO_INCREMENT,
  \`org_id\`          bigint unsigned NOT NULL,
  \`norad_id\`        int          NOT NULL,
  \`photo_path\`      varchar(255) NULL,
  \`owner\`           varchar(200) NULL,
  \`country\`         varchar(120) NULL,
  \`country_code\`    varchar(16)  NULL,
  \`purpose\`         varchar(160) NULL,
  \`purpose_codes\`   varchar(64)  NULL,
  \`payload\`         varchar(200) NULL,
  \`manufacturer\`    varchar(240) NULL,
  \`catalog_size\`    varchar(80)  NULL,
  \`length_m\`        double       NULL,
  \`diameter_m\`      double       NULL,
  \`span_m\`          double       NULL,
  \`launch_site\`     varchar(200) NULL,
  \`launch_vehicle\`  varchar(120) NULL,
  \`updated_by\`      varchar(190) NULL,
  \`updated_at\`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_org_norad_dossier\` (\`org_id\`, \`norad_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='VIP org overlay for a claimed NORAD; same-org users can see'`

/** Fields a super-admin save can push to the family profile (and future members). */
export const FAMILY_SHARED_FIELDS = [
  'owner',
  'country',
  'countryCode',
  'purpose',
  'purposeCodes',
  'manufacturer',
  'catalogSize',
  'lengthM',
  'diameterM',
  'spanM',
  'photoPath'
] as const

/** Fields that stay on the single object (or the org overlay). */
export const OBJECT_ONLY_FIELDS = ['payload', 'launchSite', 'launchVehicle', 'photoPath'] as const

export type FamilySharedKey = (typeof FAMILY_SHARED_FIELDS)[number]
export type ObjectOnlyKey = (typeof OBJECT_ONLY_FIELDS)[number]

export interface DossierFields {
  owner?: string | null
  country?: string | null
  countryCode?: string | null
  purpose?: string | null
  purposeCodes?: string[] | null
  payload?: string | null
  manufacturer?: string | null
  catalogSize?: string | null
  lengthM?: number | null
  diameterM?: number | null
  spanM?: number | null
  launchSite?: string | null
  launchVehicle?: string | null
  photoPath?: string | null
}

export interface DossierMeta {
  canEdit: boolean
  canReset: boolean
  hasOrgOverlay: boolean
  familyId: number | null
  familyName: string | null
  isSuperAdmin: boolean
}

let schemaReady: Promise<boolean> | null = null

export function ensureDossierSchema(): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        if (!(await ensureCatalogProfileSchema())) return false
        await pool.query(FAMILY_SCHEMA)
        await pool.query(FAMILY_PROFILE_SCHEMA)
        await pool.query(OBJECT_OVERRIDE_SCHEMA)
        await pool.query(ORG_DOSSIER_SCHEMA)
        return true
      } catch (e) {
        console.error('[dossier] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // src/db or dist/db → api → repo
  return path.resolve(here, '..', '..', '..')
}

export function catalogPhotosRoot(): string {
  const override = (process.env.CATALOG_PHOTOS_DIR || '').trim()
  if (override) return path.resolve(override)
  return path.resolve(repoRoot(), 'data', 'catalog-photos')
}

function blankToNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function codesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((c) => String(c).trim()).filter(Boolean)
  const s = blankToNull(v)
  return s ? s.split('/').map((c) => c.trim()).filter(Boolean) : []
}

function rowToFields(row: RowDataPacket | null | undefined): DossierFields {
  if (!row) return {}
  return {
    owner: blankToNull(row.owner),
    country: blankToNull(row.country),
    countryCode: blankToNull(row.country_code),
    purpose: blankToNull(row.purpose),
    purposeCodes: codesOf(row.purpose_codes),
    payload: blankToNull(row.payload),
    manufacturer: blankToNull(row.manufacturer),
    catalogSize: blankToNull(row.catalog_size),
    lengthM: numOrNull(row.length_m),
    diameterM: numOrNull(row.diameter_m),
    spanM: numOrNull(row.span_m),
    launchSite: blankToNull(row.launch_site),
    launchVehicle: blankToNull(row.launch_vehicle),
    photoPath: blankToNull(row.photo_path)
  }
}

function firstNonEmpty<T>(...vals: Array<T | null | undefined>): T | null {
  for (const v of vals) {
    if (v == null) continue
    if (typeof v === 'string' && !v.trim()) continue
    if (Array.isArray(v) && v.length === 0) continue
    return v
  }
  return null
}

export interface CatalogFamily {
  id: number
  name: string
  matchPrefixes: string[]
  matchBus: string | null
}

function parsePrefixes(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function listFamilies(): Promise<CatalogFamily[]> {
  if (!(await ensureDossierSchema())) return []
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, name, match_prefixes, match_bus FROM catalog_family ORDER BY name'
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    matchPrefixes: parsePrefixes(r.match_prefixes),
    matchBus: blankToNull(r.match_bus)
  }))
}

export function nameMatchesPrefixes(name: string | null | undefined, prefixes: string[]): boolean {
  const n = (name || '').trim()
  if (!n || !prefixes.length) return false
  const upper = n.toUpperCase()
  return prefixes.some((p) => p && upper.startsWith(p.trim().toUpperCase()))
}

export async function findFamilyFor(opts: {
  name?: string | null
  bus?: string | null
}): Promise<CatalogFamily | null> {
  const families = await listFamilies()
  const bus = (opts.bus || '').trim().toUpperCase()
  for (const f of families) {
    if (nameMatchesPrefixes(opts.name, f.matchPrefixes)) return f
  }
  if (bus) {
    for (const f of families) {
      if (f.matchBus && f.matchBus.trim().toUpperCase() === bus) return f
    }
  }
  return null
}

/** Known constellation-style prefixes used only when a super-admin first saves a family field. */
const KNOWN_FAMILY_SEEDS: Array<{ name: string; prefixes: string[]; bus?: string }> = [
  { name: 'Starlink', prefixes: ['STARLINK-'] },
  { name: 'Qianfan', prefixes: ['QIANFAN-', 'QIANFAN XINGZUO'], bus: 'Qianfan' },
  { name: 'OneWeb', prefixes: ['ONEWEB-'] },
  { name: 'Iridium', prefixes: ['IRIDIUM '] },
  { name: 'Kuiper', prefixes: ['KUIPER-'] },
  { name: 'GPS', prefixes: ['GPS '] },
  { name: 'BeiDou', prefixes: ['BEIDOU-'] },
  { name: 'GLONASS', prefixes: ['GLONASS-'] },
  { name: 'Galileo', prefixes: ['GSAT0', 'GALILEO '] }
]

export function inferFamilySeed(name: string | null | undefined): { name: string; prefixes: string[]; bus?: string } | null {
  const raw = (name || '').trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  for (const seed of KNOWN_FAMILY_SEEDS) {
    if (nameMatchesPrefixes(raw, seed.prefixes)) return seed
  }
  const m = /^([A-Z][A-Z0-9]{2,})[-_]\d/i.exec(upper)
  if (m) return { name: m[1], prefixes: [`${m[1]}-`] }
  return null
}

export async function ensureFamilyForName(name: string | null | undefined, bus?: string | null): Promise<CatalogFamily | null> {
  const existing = await findFamilyFor({ name, bus })
  if (existing) return existing
  const seed = inferFamilySeed(name)
  if (!seed) return null
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO catalog_family (name, match_prefixes, match_bus)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       match_prefixes = VALUES(match_prefixes),
       match_bus = COALESCE(VALUES(match_bus), match_bus)`,
    [seed.name, seed.prefixes.join(','), seed.bus ?? null]
  )
  const id = Number(result.insertId)
  if (id) {
    return { id, name: seed.name, matchPrefixes: seed.prefixes, matchBus: seed.bus ?? null }
  }
  return findFamilyFor({ name, bus })
}

async function getFamilyProfile(familyId: number): Promise<DossierFields | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM catalog_family_profile WHERE family_id = ? LIMIT 1',
    [familyId]
  )
  return rows[0] ? rowToFields(rows[0]) : null
}

async function getObjectOverride(noradId: number): Promise<DossierFields | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM catalog_object_override WHERE norad_id = ? LIMIT 1',
    [noradId]
  )
  return rows[0] ? rowToFields(rows[0]) : null
}

async function getOrgDossier(orgId: number, noradId: number): Promise<DossierFields | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM org_object_dossier WHERE org_id = ? AND norad_id = ? LIMIT 1',
    [orgId, noradId]
  )
  return rows[0] ? rowToFields(rows[0]) : null
}

function isPresent<T>(v: T | null | undefined): v is T {
  if (v == null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

function mergeFields(layers: Array<DossierFields | null | undefined>): DossierFields {
  const out: DossierFields = {}
  const keys: Array<keyof DossierFields> = [
    'owner',
    'country',
    'countryCode',
    'purpose',
    'purposeCodes',
    'payload',
    'manufacturer',
    'catalogSize',
    'lengthM',
    'diameterM',
    'spanM',
    'launchSite',
    'launchVehicle',
    'photoPath'
  ]
  // layers[0] is the top of the stack
  for (const key of keys) {
    for (const layer of layers) {
      if (!layer) continue
      const v = layer[key]
      if (isPresent(v as never)) {
        ;(out as Record<string, unknown>)[key] = v
        break
      }
    }
  }
  return out
}

export interface ResolvedDossier {
  profile: CatalogProfileDto
  meta: DossierMeta
  photoPath: string | null
}

export async function resolveDossier(opts: {
  noradId: number
  intlDesig?: string | null
  objectName?: string | null
  orgId?: number | null
  applyOrgOverlay: boolean
  canEdit: boolean
  isSuperAdmin: boolean
  objectId?: number | null
}): Promise<ResolvedDossier> {
  if (!(await ensureDossierSchema())) {
    const baseline = await getCatalogProfile({ noradId: opts.noradId, intlDesig: opts.intlDesig })
    return {
      profile: baseline ?? emptyProfile(),
      meta: {
        canEdit: false,
        canReset: false,
        hasOrgOverlay: false,
        familyId: null,
        familyName: null,
        isSuperAdmin: opts.isSuperAdmin
      },
      photoPath: null
    }
  }

  const baseline = await getCatalogProfile({ noradId: opts.noradId, intlDesig: opts.intlDesig })
  const usedFamily =
    (await findFamilyFor({ name: opts.objectName, bus: baseline?.bus })) ||
    (await findFamilyFor({ name: baseline?.name, bus: baseline?.bus }))
  const familyFields = usedFamily ? await getFamilyProfile(usedFamily.id) : null
  const objectFields = opts.noradId > 0 ? await getObjectOverride(opts.noradId) : null
  const orgFields =
    opts.applyOrgOverlay && opts.orgId ? await getOrgDossier(opts.orgId, opts.noradId) : null
  const hasOrgOverlay = !!(orgFields && Object.values(orgFields).some((v) => isPresent(v as never)))

  const merged = mergeFields([
    opts.applyOrgOverlay ? orgFields : null,
    objectFields,
    familyFields,
    baselineToFields(baseline)
  ])

  const profile = fieldsToProfile(baseline, merged, opts.objectId)
  return {
    profile,
    meta: {
      canEdit: opts.canEdit,
      canReset: opts.canEdit && !opts.isSuperAdmin && hasOrgOverlay,
      hasOrgOverlay,
      familyId: usedFamily?.id ?? null,
      familyName: usedFamily?.name ?? null,
      isSuperAdmin: opts.isSuperAdmin
    },
    photoPath: merged.photoPath ?? null
  }
}

function emptyProfile(): CatalogProfileDto {
  return {
    name: null,
    owner: null,
    ownerCode: null,
    country: null,
    countryCode: null,
    purpose: null,
    purposeCodes: [],
    payload: null,
    manufacturer: null,
    catalogSize: null,
    lengthM: null,
    diameterM: null,
    spanM: null,
    launchSite: null,
    launchSiteCode: null,
    launchVehicle: null,
    launchDate: null,
    shape: null,
    bus: null,
    catalogMassKg: null,
    photoUrl: null
  }
}

function baselineToFields(b: CatalogProfileDto | null): DossierFields {
  if (!b) return {}
  return {
    owner: b.owner,
    country: b.country,
    countryCode: b.countryCode,
    purpose: b.purpose,
    purposeCodes: b.purposeCodes,
    payload: b.payload,
    manufacturer: b.manufacturer,
    catalogSize: b.catalogSize,
    lengthM: b.lengthM,
    diameterM: b.diameterM,
    spanM: b.spanM,
    launchSite: b.launchSite,
    launchVehicle: b.launchVehicle,
    photoPath: null
  }
}

function fieldsToProfile(baseline: CatalogProfileDto | null, merged: DossierFields, objectId?: number | null): CatalogProfileDto {
  const base = baseline ?? emptyProfile()
  const photoUrl =
    merged.photoPath && objectId
      ? `/cgi/objects/${objectId}/dossier-photo`
      : merged.photoPath && !objectId
        ? null
        : null
  return {
    ...base,
    owner: firstNonEmpty(merged.owner, base.owner),
    country: firstNonEmpty(merged.country, base.country),
    countryCode: firstNonEmpty(merged.countryCode, base.countryCode),
    purpose: firstNonEmpty(merged.purpose, base.purpose),
    purposeCodes: (merged.purposeCodes && merged.purposeCodes.length ? merged.purposeCodes : base.purposeCodes) || [],
    payload: firstNonEmpty(merged.payload, base.payload),
    manufacturer: firstNonEmpty(merged.manufacturer, base.manufacturer),
    catalogSize: firstNonEmpty(merged.catalogSize, base.catalogSize),
    lengthM: firstNonEmpty(merged.lengthM, base.lengthM),
    diameterM: firstNonEmpty(merged.diameterM, base.diameterM),
    spanM: firstNonEmpty(merged.spanM, base.spanM),
    launchSite: firstNonEmpty(merged.launchSite, base.launchSite),
    launchVehicle: firstNonEmpty(merged.launchVehicle, base.launchVehicle),
    photoUrl: merged.photoPath ? photoUrl : null
  }
}

export function sanitizeDossierPatch(raw: Record<string, unknown>): DossierFields {
  const str = (k: string): string | null | undefined => {
    if (!(k in raw)) return undefined
    if (raw[k] == null) return null
    const s = String(raw[k]).trim()
    return s ? s.slice(0, 240) : null
  }
  const num = (k: string): number | null | undefined => {
    if (!(k in raw)) return undefined
    if (raw[k] == null || raw[k] === '') return null
    const n = Number(raw[k])
    return Number.isFinite(n) ? n : null
  }
  const codes = (k: string): string[] | null | undefined => {
    if (!(k in raw)) return undefined
    if (raw[k] == null || raw[k] === '') return null
    const arr = codesOf(raw[k])
    return arr.length ? arr : null
  }
  return {
    owner: str('owner'),
    country: str('country'),
    countryCode: str('countryCode')?.slice(0, 16) ?? (raw.countryCode === undefined ? undefined : null),
    purpose: str('purpose'),
    purposeCodes: codes('purposeCodes') ?? codes('purpose'),
    payload: str('payload'),
    manufacturer: str('manufacturer'),
    catalogSize: str('catalogSize')?.slice(0, 80) ?? (raw.catalogSize === undefined ? undefined : null),
    lengthM: num('lengthM'),
    diameterM: num('diameterM'),
    spanM: num('spanM'),
    launchSite: str('launchSite'),
    launchVehicle: str('launchVehicle')
  }
}

function splitFamilyAndObject(patch: DossierFields): { family: DossierFields; object: DossierFields } {
  const family: DossierFields = {}
  const object: DossierFields = {}
  const famSet = new Set<string>(FAMILY_SHARED_FIELDS)
  const objSet = new Set<string>(['payload', 'launchSite', 'launchVehicle'])
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (famSet.has(k)) (family as Record<string, unknown>)[k] = v
    if (objSet.has(k)) (object as Record<string, unknown>)[k] = v
  }
  return { family, object }
}

function toDbCols(fields: DossierFields): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (fields.owner !== undefined) out.owner = fields.owner
  if (fields.country !== undefined) out.country = fields.country
  if (fields.countryCode !== undefined) out.country_code = fields.countryCode
  if (fields.purpose !== undefined) out.purpose = fields.purpose
  if (fields.purposeCodes !== undefined) out.purpose_codes = fields.purposeCodes?.join('/') ?? null
  if (fields.payload !== undefined) out.payload = fields.payload
  if (fields.manufacturer !== undefined) out.manufacturer = fields.manufacturer
  if (fields.catalogSize !== undefined) out.catalog_size = fields.catalogSize
  if (fields.lengthM !== undefined) out.length_m = fields.lengthM
  if (fields.diameterM !== undefined) out.diameter_m = fields.diameterM
  if (fields.spanM !== undefined) out.span_m = fields.spanM
  if (fields.launchSite !== undefined) out.launch_site = fields.launchSite
  if (fields.launchVehicle !== undefined) out.launch_vehicle = fields.launchVehicle
  if (fields.photoPath !== undefined) out.photo_path = fields.photoPath
  return out
}

async function upsertRow(table: string, keyCols: Record<string, unknown>, fields: DossierFields, updatedBy: string): Promise<void> {
  const cols = { ...toDbCols(fields), updated_by: updatedBy }
  if (!Object.keys(toDbCols(fields)).length && fields.photoPath === undefined) return
  const all: Record<string, unknown> = { ...keyCols, ...cols }
  const names = Object.keys(all)
  const placeholders = names.map(() => '?').join(', ')
  const updates = Object.keys(cols)
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(', ')
  await pool.query(
    `INSERT INTO \`${table}\` (${names.map((n) => `\`${n}\``).join(', ')})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    names.map((n) => all[n])
  )
}

export async function saveSuperAdminDossier(opts: {
  noradId: number
  objectName?: string | null
  bus?: string | null
  patch: DossierFields
  updatedBy: string
}): Promise<{ familyId: number | null; familyName: string | null }> {
  if (!(await ensureDossierSchema())) throw new Error('档案层数据表不可用')
  const { family, object } = splitFamilyAndObject(opts.patch)
  let familyRow: CatalogFamily | null = null
  const familyHas = Object.values(family).some((v) => v !== undefined)
  if (familyHas) {
    familyRow = await ensureFamilyForName(opts.objectName, opts.bus)
    if (familyRow) {
      await upsertRow('catalog_family_profile', { family_id: familyRow.id }, family, opts.updatedBy)
    } else {
      // No family membership — keep the shared-looking fields on the object override.
      Object.assign(object, family)
    }
  }
  const objectHas = Object.values(object).some((v) => v !== undefined)
  if (objectHas) {
    await upsertRow('catalog_object_override', { norad_id: opts.noradId }, object, opts.updatedBy)
  }
  return { familyId: familyRow?.id ?? null, familyName: familyRow?.name ?? null }
}

export async function saveOrgDossier(opts: {
  orgId: number
  noradId: number
  patch: DossierFields
  updatedBy: string
}): Promise<void> {
  if (!(await ensureDossierSchema())) throw new Error('档案层数据表不可用')
  const patch = { ...opts.patch }
  // VIP may not write identity/orbit; launch date is not in DossierFields. OK.
  await upsertRow('org_object_dossier', { org_id: opts.orgId, norad_id: opts.noradId }, patch, opts.updatedBy)
}

export async function resetOrgDossier(orgId: number, noradId: number): Promise<boolean> {
  if (!(await ensureDossierSchema())) return false
  const [result] = await pool.query<ResultSetHeader>(
    'DELETE FROM org_object_dossier WHERE org_id = ? AND norad_id = ?',
    [orgId, noradId]
  )
  return result.affectedRows > 0
}

const PHOTO_MAX = 8 * 1024 * 1024
const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

export function photoExtension(mime: string, filename?: string | null): string | null {
  const m = PHOTO_EXT[(mime || '').toLowerCase()]
  if (m) return m
  const n = (filename || '').toLowerCase()
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return '.jpg'
  if (n.endsWith('.png')) return '.png'
  if (n.endsWith('.webp')) return '.webp'
  if (n.endsWith('.gif')) return '.gif'
  return null
}

export function savePhotoFile(opts: { kind: 'family' | 'object' | 'org'; id: number | string; buffer: Buffer; ext: string }): string {
  if (opts.buffer.length > PHOTO_MAX) throw new Error('照片超过 8 MB')
  const dir = path.join(catalogPhotosRoot(), opts.kind, String(opts.id))
  fs.mkdirSync(dir, { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}${opts.ext}`
  const rel = path.posix.join(opts.kind, String(opts.id), name)
  const abs = path.join(catalogPhotosRoot(), opts.kind, String(opts.id), name)
  fs.writeFileSync(abs, opts.buffer)
  return rel.replace(/\\/g, '/')
}

export function resolvePhotoAbs(rel: string | null | undefined): string | null {
  const s = blankToNull(rel)
  if (!s) return null
  if (s.includes('..') || path.isAbsolute(s)) return null
  const root = path.resolve(catalogPhotosRoot())
  const abs = path.resolve(root, s)
  if (!abs.startsWith(root)) return null
  return fs.existsSync(abs) ? abs : null
}

export async function saveSuperAdminPhoto(opts: {
  noradId: number
  objectName?: string | null
  bus?: string | null
  buffer: Buffer
  mime: string
  filename?: string | null
  updatedBy: string
  objectOnly?: boolean
}): Promise<{ photoPath: string; familyId: number | null }> {
  const ext = photoExtension(opts.mime, opts.filename)
  if (!ext) throw new Error('仅支持 JPEG / PNG / WebP / GIF 照片')
  if (!(await ensureDossierSchema())) throw new Error('档案层数据表不可用')
  if (!opts.objectOnly) {
    const family = await ensureFamilyForName(opts.objectName, opts.bus)
    if (family) {
      const photoPath = savePhotoFile({ kind: 'family', id: family.id, buffer: opts.buffer, ext })
      await upsertRow('catalog_family_profile', { family_id: family.id }, { photoPath }, opts.updatedBy)
      return { photoPath, familyId: family.id }
    }
  }
  const photoPath = savePhotoFile({ kind: 'object', id: opts.noradId, buffer: opts.buffer, ext })
  await upsertRow('catalog_object_override', { norad_id: opts.noradId }, { photoPath }, opts.updatedBy)
  return { photoPath, familyId: null }
}

export async function saveOrgPhoto(opts: {
  orgId: number
  noradId: number
  buffer: Buffer
  mime: string
  filename?: string | null
  updatedBy: string
}): Promise<string> {
  const ext = photoExtension(opts.mime, opts.filename)
  if (!ext) throw new Error('仅支持 JPEG / PNG / WebP / GIF 照片')
  if (!(await ensureDossierSchema())) throw new Error('档案层数据表不可用')
  const photoPath = savePhotoFile({ kind: 'org', id: `${opts.orgId}-${opts.noradId}`, buffer: opts.buffer, ext })
  await upsertRow('org_object_dossier', { org_id: opts.orgId, norad_id: opts.noradId }, { photoPath }, opts.updatedBy)
  return photoPath
}

export { firstNonEmpty }
