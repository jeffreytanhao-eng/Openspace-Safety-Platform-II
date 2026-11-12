-- Local public-catalog dossier baseline (GCAT ingest).
-- Source (internal attribution only; do not show in product UI):
--   McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects,
--   https://planet4589.org/space/gcat
-- This table is a read-side cache filled by `npm run ingest:gcat`.
-- It must never be written into objects.mass_kg / objects.cross_section_m2.

CREATE TABLE IF NOT EXISTS `sat_catalog_profile` (
  `jcat`             varchar(16)  NOT NULL COMMENT 'GCAT JCAT identifier',
  `norad_id`         int          NOT NULL DEFAULT 0 COMMENT 'US SATCAT / NORAD; 0 if none',
  `piece`            varchar(32)  NULL COMMENT 'COSPAR / international designator',
  `launch_tag`       varchar(32)  NULL,
  `sat_type`         varchar(16)  NULL COMMENT 'GCAT SatType string',
  `name`             varchar(160) NULL,
  `owner`            varchar(200) NULL COMMENT 'Resolved operator name',
  `owner_code`       varchar(32)  NULL,
  `country`          varchar(120) NULL COMMENT 'Resolved country / state name',
  `country_code`     varchar(16)  NULL,
  `purpose`          varchar(160) NULL COMMENT 'Resolved purpose labels, slash-joined',
  `purpose_codes`    varchar(64)  NULL COMMENT 'GCAT payload Category codes, slash-joined',
  `payload`          varchar(200) NULL COMMENT 'Payload / PLName',
  `manufacturer`     varchar(240) NULL COMMENT 'Resolved manufacturer name(s)',
  `manufacturer_code` varchar(64) NULL,
  `length_m`         double       NULL,
  `diameter_m`       double       NULL,
  `span_m`           double       NULL,
  `catalog_size`     varchar(80)  NULL COMMENT 'Preformatted size, language-neutral',
  `shape`            varchar(80)  NULL,
  `bus`              varchar(80)  NULL,
  `launch_site`      varchar(200) NULL COMMENT 'Resolved launch site name',
  `launch_site_code` varchar(32)  NULL,
  `launch_vehicle`   varchar(120) NULL,
  `launch_date`      varchar(16)  NULL COMMENT 'YYYY-MM-DD or YYYY-MM when day unknown',
  `catalog_mass_kg`  double       NULL COMMENT 'Catalog mass at insertion; never copied to org archive',
  `source_updated`   varchar(128) NULL COMMENT 'Timestamp line from the source TSV',
  `ingested_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`jcat`),
  KEY `idx_norad` (`norad_id`),
  KEY `idx_piece` (`piece`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Public-catalog dossier baseline (local GCAT cache)';
