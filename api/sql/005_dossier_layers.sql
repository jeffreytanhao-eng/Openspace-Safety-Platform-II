-- Object-dossier layers (super-admin family / object override, VIP org overlay).
-- Resolved at read time; family data is not copied onto every NORAD row.
-- Catalog mass / size must never be written to objects.mass_kg or cross_section_m2.

CREATE TABLE IF NOT EXISTS `catalog_family` (
  `id`              bigint unsigned NOT NULL AUTO_INCREMENT,
  `name`            varchar(80)  NOT NULL,
  `match_prefixes`  varchar(255) NOT NULL COMMENT 'Comma-separated name prefixes, case-insensitive',
  `match_bus`       varchar(80)  NULL,
  `note`            varchar(160) NULL,
  `created_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_family_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `catalog_family_profile` (
  `family_id`       bigint unsigned NOT NULL,
  `photo_path`      varchar(255) NULL,
  `owner`           varchar(200) NULL,
  `country`         varchar(120) NULL,
  `country_code`    varchar(16)  NULL,
  `purpose`         varchar(160) NULL,
  `purpose_codes`   varchar(64)  NULL,
  `manufacturer`    varchar(240) NULL,
  `catalog_size`    varchar(80)  NULL,
  `length_m`        double       NULL,
  `diameter_m`      double       NULL,
  `span_m`          double       NULL,
  `updated_by`      varchar(190) NULL,
  `updated_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`family_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `catalog_object_override` (
  `norad_id`        int          NOT NULL,
  `photo_path`      varchar(255) NULL,
  `owner`           varchar(200) NULL,
  `country`         varchar(120) NULL,
  `country_code`    varchar(16)  NULL,
  `purpose`         varchar(160) NULL,
  `purpose_codes`   varchar(64)  NULL,
  `payload`         varchar(200) NULL,
  `manufacturer`    varchar(240) NULL,
  `catalog_size`    varchar(80)  NULL,
  `length_m`        double       NULL,
  `diameter_m`      double       NULL,
  `span_m`          double       NULL,
  `launch_site`     varchar(200) NULL,
  `launch_vehicle`  varchar(120) NULL,
  `updated_by`      varchar(190) NULL,
  `updated_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`norad_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `org_object_dossier` (
  `id`              bigint unsigned NOT NULL AUTO_INCREMENT,
  `org_id`          bigint unsigned NOT NULL,
  `norad_id`        int          NOT NULL,
  `photo_path`      varchar(255) NULL,
  `owner`           varchar(200) NULL,
  `country`         varchar(120) NULL,
  `country_code`    varchar(16)  NULL,
  `purpose`         varchar(160) NULL,
  `purpose_codes`   varchar(64)  NULL,
  `payload`         varchar(200) NULL,
  `manufacturer`    varchar(240) NULL,
  `catalog_size`    varchar(80)  NULL,
  `length_m`        double       NULL,
  `diameter_m`      double       NULL,
  `span_m`          double       NULL,
  `launch_site`     varchar(200) NULL,
  `launch_vehicle`  varchar(120) NULL,
  `updated_by`      varchar(190) NULL,
  `updated_at`      datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_norad_dossier` (`org_id`, `norad_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
