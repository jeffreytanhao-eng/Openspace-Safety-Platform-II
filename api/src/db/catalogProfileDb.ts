/**
 * Local public-catalog dossier baseline.
 *
 * Source (internal attribution only; do not surface the catalog name in product UI):
 *   McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects,
 *   https://planet4589.org/space/gcat
 *
 * Rows are filled by `npm run ingest:gcat` from on-disk TSV files. Request
 * handlers only read this table — never fetch a remote catalog, and never
 * copy catalog_mass_kg / dimensions into objects.mass_kg or cross_section_m2.
 */
import { pool } from './pool.js'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`sat_catalog_profile\` (
  \`jcat\`              varchar(16)  NOT NULL,
  \`norad_id\`          int          NOT NULL DEFAULT 0,
  \`piece\`             varchar(32)  NULL,
  \`launch_tag\`        varchar(32)  NULL,
  \`sat_type\`          varchar(16)  NULL,
  \`name\`              varchar(160) NULL,
  \`owner\`             varchar(200) NULL,
  \`owner_code\`        varchar(32)  NULL,
  \`country\`           varchar(120) NULL,
  \`country_code\`      varchar(16)  NULL,
  \`purpose\`           varchar(160) NULL,
  \`purpose_codes\`     varchar(64)  NULL,
  \`payload\`           varchar(200) NULL,
  \`manufacturer\`      varchar(240) NULL,
  \`manufacturer_code\` varchar(64)  NULL,
  \`length_m\`          double       NULL,
  \`diameter_m\`        double       NULL,
  \`span_m\`            double       NULL,
  \`catalog_size\`      varchar(80)  NULL,
  \`shape\`             varchar(80)  NULL,
  \`bus\`               varchar(80)  NULL,
  \`launch_site\`       varchar(200) NULL,
  \`launch_site_code\`  varchar(32)  NULL,
  \`launch_vehicle\`    varchar(120) NULL,
  \`launch_date\`       varchar(16)  NULL,
  \`catalog_mass_kg\`   double       NULL,
  \`source_updated\`    varchar(128) NULL,
  \`ingested_at\`       datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`jcat\`),
  KEY \`idx_norad\` (\`norad_id\`),
  KEY \`idx_piece\` (\`piece\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Public-catalog dossier baseline (local GCAT cache)'`

let schemaReady: Promise<boolean> | null = null


async function migrateCatalogProfileSchema(): Promise<void> {
  const [cols] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH AS len
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'sat_catalog_profile'`
  )
  const source = cols.find((c) => String(c.COLUMN_NAME) === 'source_updated')
  if (source && Number(source.len) < 128) {
    await pool.query('ALTER TABLE sat_catalog_profile MODIFY source_updated varchar(128) NULL')
  }
}

export function ensureCatalogProfileSchema(): Promise<boolean> {

  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query(SCHEMA)
        await migrateCatalogProfileSchema()
        return true
      } catch (e) {
        console.error('[catalog-profile] ensure schema failed:', (e as Error).message)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

/** Dossier fields served to the object-detail UI (photo is never filled from this catalog). */
export interface CatalogProfileDto {
  name: string | null
  owner: string | null
  ownerCode: string | null
  country: string | null
  countryCode: string | null
  purpose: string | null
  purposeCodes: string[]
  payload: string | null
  manufacturer: string | null
  catalogSize: string | null
  lengthM: number | null
  diameterM: number | null
  spanM: number | null
  launchSite: string | null
  launchSiteCode: string | null
  launchVehicle: string | null
  launchDate: string | null
  shape: string | null
  bus: string | null
  /** Catalog insertion mass; never written to the unit archive. */
  catalogMassKg: number | null
  photoUrl: string | null
}

export interface CatalogProfileRow {
  jcat: string
  norad_id: number
  piece: string | null
  launch_tag: string | null
  sat_type: string | null
  name: string | null
  owner: string | null
  owner_code: string | null
  country: string | null
  country_code: string | null
  purpose: string | null
  purpose_codes: string | null
  payload: string | null
  manufacturer: string | null
  manufacturer_code: string | null
  length_m: number | null
  diameter_m: number | null
  span_m: number | null
  catalog_size: string | null
  shape: string | null
  bus: string | null
  launch_site: string | null
  launch_site_code: string | null
  launch_vehicle: string | null
  launch_date: string | null
  catalog_mass_kg: number | null
  source_updated: string | null
}

const SELECT_COLS = `jcat, norad_id, piece, launch_tag, sat_type, name,
  owner, owner_code, country, country_code, purpose, purpose_codes, payload,
  manufacturer, manufacturer_code, length_m, diameter_m, span_m, catalog_size,
  shape, bus, launch_site, launch_site_code, launch_vehicle, launch_date,
  catalog_mass_kg, source_updated`

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

function rowToDto(row: CatalogProfileRow): CatalogProfileDto {
  const codes = blankToNull(row.purpose_codes)
  return {
    name: blankToNull(row.name),
    owner: blankToNull(row.owner),
    ownerCode: blankToNull(row.owner_code),
    country: blankToNull(row.country),
    countryCode: blankToNull(row.country_code),
    purpose: blankToNull(row.purpose),
    purposeCodes: codes ? codes.split('/').map((c) => c.trim()).filter(Boolean) : [],
    payload: blankToNull(row.payload),
    manufacturer: blankToNull(row.manufacturer),
    catalogSize: blankToNull(row.catalog_size),
    lengthM: numOrNull(row.length_m),
    diameterM: numOrNull(row.diameter_m),
    spanM: numOrNull(row.span_m),
    launchSite: blankToNull(row.launch_site),
    launchSiteCode: blankToNull(row.launch_site_code),
    launchVehicle: blankToNull(row.launch_vehicle),
    launchDate: blankToNull(row.launch_date),
    shape: blankToNull(row.shape),
    bus: blankToNull(row.bus),
    catalogMassKg: numOrNull(row.catalog_mass_kg),
    photoUrl: null
  }
}

/** Prefer a standard-catalog payload over attached stages / debris sharing a SATCAT number. */
function preferenceSql(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return ` (CASE WHEN ${p}jcat LIKE 'S%' THEN 1 ELSE 0 END) DESC,
           (CASE WHEN LEFT(IFNULL(${p}sat_type,''), 1) = 'P' THEN 1 ELSE 0 END) DESC,
           (CASE WHEN SUBSTRING(IFNULL(${p}sat_type,''), 2, 1) = 'A' THEN 0 ELSE 1 END) DESC,
           ${p}jcat ASC`
}

/** Normalize COSPAR / international designator for lookup (1990-037B, 90037B, spaces). */
export function normalizeIntlDesig(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '')
  if (!s || s === '-') return null
  const dotted = /^(\d{4})-(\d{3})([A-Z]{1,3})$/.exec(s)
  if (dotted) return `${dotted[1]}-${dotted[2]}${dotted[3]}`
  const compact = /^(\d{2})(\d{3})([A-Z]{1,3})$/.exec(s)
  if (compact) {
    const yy = Number(compact[1])
    const year = yy >= 57 ? 1900 + yy : 2000 + yy
    return `${year}-${compact[2]}${compact[3]}`
  }
  return s
}

export async function getCatalogProfile(opts: {
  noradId?: number | null
  intlDesig?: string | null
}): Promise<CatalogProfileDto | null> {
  if (!(await ensureCatalogProfileSchema())) return null
  const norad = Number(opts.noradId || 0)
  if (Number.isInteger(norad) && norad > 0) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${SELECT_COLS} FROM sat_catalog_profile
        WHERE norad_id = ?
        ORDER BY ${preferenceSql()}
        LIMIT 1`,
      [norad]
    )
    if (rows[0]) return rowToDto(rows[0] as unknown as CatalogProfileRow)
  }
  const piece = normalizeIntlDesig(opts.intlDesig)
  if (piece) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${SELECT_COLS} FROM sat_catalog_profile
        WHERE piece = ?
        ORDER BY ${preferenceSql()}
        LIMIT 1`,
      [piece]
    )
    if (rows[0]) return rowToDto(rows[0] as unknown as CatalogProfileRow)
  }
  return null
}

export interface CatalogProfileInsert extends CatalogProfileRow {}

const UPSERT_SQL = `INSERT INTO sat_catalog_profile (
  jcat, norad_id, piece, launch_tag, sat_type, name,
  owner, owner_code, country, country_code, purpose, purpose_codes, payload,
  manufacturer, manufacturer_code, length_m, diameter_m, span_m, catalog_size,
  shape, bus, launch_site, launch_site_code, launch_vehicle, launch_date,
  catalog_mass_kg, source_updated, ingested_at
) VALUES ?
ON DUPLICATE KEY UPDATE
  norad_id = VALUES(norad_id),
  piece = VALUES(piece),
  launch_tag = VALUES(launch_tag),
  sat_type = VALUES(sat_type),
  name = VALUES(name),
  owner = VALUES(owner),
  owner_code = VALUES(owner_code),
  country = VALUES(country),
  country_code = VALUES(country_code),
  purpose = VALUES(purpose),
  purpose_codes = VALUES(purpose_codes),
  payload = VALUES(payload),
  manufacturer = VALUES(manufacturer),
  manufacturer_code = VALUES(manufacturer_code),
  length_m = VALUES(length_m),
  diameter_m = VALUES(diameter_m),
  span_m = VALUES(span_m),
  catalog_size = VALUES(catalog_size),
  shape = VALUES(shape),
  bus = VALUES(bus),
  launch_site = VALUES(launch_site),
  launch_site_code = VALUES(launch_site_code),
  launch_vehicle = VALUES(launch_vehicle),
  launch_date = VALUES(launch_date),
  catalog_mass_kg = VALUES(catalog_mass_kg),
  source_updated = VALUES(source_updated),
  ingested_at = VALUES(ingested_at)`

function toValueTuple(r: CatalogProfileInsert, ingestedAt: Date): unknown[] {
  return [
    r.jcat,
    r.norad_id || 0,
    r.piece,
    r.launch_tag,
    r.sat_type,
    r.name,
    r.owner,
    r.owner_code,
    r.country,
    r.country_code,
    r.purpose,
    r.purpose_codes,
    r.payload,
    r.manufacturer,
    r.manufacturer_code,
    r.length_m,
    r.diameter_m,
    r.span_m,
    r.catalog_size,
    r.shape,
    r.bus,
    r.launch_site,
    r.launch_site_code,
    r.launch_vehicle,
    r.launch_date,
    r.catalog_mass_kg,
    r.source_updated,
    ingestedAt
  ]
}

/** Idempotent upsert in chunks. Returns the number of rows submitted. */
export async function upsertCatalogProfiles(rows: CatalogProfileInsert[], chunkSize = 200): Promise<number> {
  if (!(await ensureCatalogProfileSchema())) throw new Error('sat_catalog_profile 表不可用')
  if (!rows.length) return 0
  const now = new Date()
  let submitted = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const values = chunk.map((r) => toValueTuple(r, now))
    await pool.query<ResultSetHeader>(UPSERT_SQL, [values])
    submitted += chunk.length
  }
  return submitted
}

export async function countCatalogProfiles(): Promise<number> {
  if (!(await ensureCatalogProfileSchema())) return 0
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sat_catalog_profile')
  return Number(rows[0]?.n || 0)
}
