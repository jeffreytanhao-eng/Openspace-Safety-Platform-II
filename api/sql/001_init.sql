-- =============================================================================
-- 001_init.sql —— 测试期数据库结构化重建（新平台自有表）
-- =============================================================================
-- 【文件性质】
--   草案（Draft），仅供人工评审。评审通过并在测试环境验证前，禁止在生产库执行。
--
-- 【用途】
--   1) 把原本散落在 api/src/db/*.ts 与 api/src/ephem/ephemDb.ts 中由
--      ensureXxxSchema() 惰性建表的新平台自有表，收敛为一份干净、可评审的
--      DDL（22 张自有表 + schema_migrations）；
--   2) 落实已识别的结构修正（见下方「本草案的修正项」）；
--   3) 作为测试期“结构化重建 / Fresh install”的唯一建表入口。
--
-- 【应用前提（缺一不可）】
--   A. 必须先备份：mysqldump 全库（含例程/触发器，若存在），并保留一份可回滚副本。
--   B. 仅用于：测试环境重建，或全新部署（Fresh install）。
--      已承载生产数据的库不要直接执行（datetime/JSON 类型变更会改变既有数据语义）。
--   C. 基线与历史表不动：本文件不包含任何 sat_* / hs_* 基线表；
--      历史表清理见文件末尾注释块（仅注释，绝不执行）。
--
-- 【配套代码改动（未完成则不要应用本文件）】
--   1. 时间口径：本草案的时间列统一为 datetime(3)，存储口径 = 数据库会话本地时间
--      （生产为 +08），与存量基线表（sat_tle.epoch、sat_cdm.tca）保持一致。
--      不做全局 UTC 切换：基线表历史数据是本地时间，若 pool 改 timezone:'Z' 或
--      连接执行 SET time_zone='+00:00'，会让存量数据读写整体偏移 8 小时。
--      UTC 化需连同基线数据一起迁移，另行安排。
--   2. 已完成：api/src/ephem/ingest.ts 的 updatedAtOf() / versions.createdAt
--      改为写 'YYYY-MM-DD HH:mm:ss' 本地时间（utils/time.ts: fmtLocalDateTime）。
--      不要再写 ISO（'2026-11-05T12:34:56.789Z'）——MySQL 严格模式会报 1292。
--   3. 已完成：api/src/ephem/ephemDb.ts 对 updated_at / created_at 做读取归一化，
--      同时兼容旧 varchar（UTC 字符串）与新 datetime（Date），接口契约不变。
--   4. 已完成：pool.ts 增加 jsonStrings: true——本文件把 params_json 等改为 JSON，
--      mysql2 默认会解析成对象，而现有代码普遍 JSON.parse(...)。
--   5. 已完成：api/src/jobs/screening.ts 两处事件写入改为 INSERT IGNORE，
--      n_events 按 affectedRows 统计（配合 conjunction_events.uk_job_pair_tca）。
--   6. objects 新增 deleted_at 仅作预留：本轮代码仍为物理删除，不启用软删；
--      若后续启用，所有 objects 查询需补 `deleted_at IS NULL`，释放认领时需处理唯一键。
--   7. 今日计数继续使用 CURDATE() / NOW()（与本地时间存储一致）；若将来切 UTC，
--      需同步改为 UTC_DATE() / UTC_TIMESTAMP()。
--
-- 【本草案的修正项（相对现有 ensureXxxSchema 代码）】
--   (1) objects：UNIQUE(norad_id) → UNIQUE KEY uk_org_norad (org_id, norad_id)，
--       并新增 deleted_at datetime(3) NULL；原 idx_org 由 uk_org_norad 最左前缀覆盖。
--       claim_type 区分 normal（普通认领，可多组织重复）/ owner（授权认领，卫星业主）；
--       生成列 owner_norad + UNIQUE uk_owner_norad 保证同一 NORAD 全局仅一个授权认领。
--       仅授权认领可维护档案参数与绑定星历（应用层校验）。
--   (2) varchar 存时间的列改 datetime(3)：
--       ephemeris.updated_at、ephemeris_versions.created_at。
--       （全库扫描结果：自有表中仅这两列为 varchar 时间；bigint 毫秒列保持原样，
--        原因见各列注释。）
--   (3) screening_jobs 直接包含 R0-3 / R2-8 新增列
--       （progress_pct、progress_note、heartbeat_at、cancel_requested、
--         primary_source、secondary_source），status 注释列全 5 种取值。
--   (4) conjunction_events 新增 uk_job_pair_tca (job_id, primary_norad,
--       secondary_norad, tca)，防止任务重试产生重复事件。
--   (5) 明确为 JSON 的列改 MySQL JSON：screening_jobs.params_json、
--       conjunction_pc_runs.params_json/rows_json/plane_json、
--       admin_audit_logs.before_json/after_json、ephemeris.maneuver_epochs。
--       被代码截断后写入、或不保证合法 JSON 的列保持 MEDIUMTEXT，并在列注释说明。
--   (6) 按代码实际查询补二级索引（org_id / status / tca / norad / 批次时间等）。
--   (7) 不加外键约束（沿用现状），仅用索引支撑按 org 过滤的查询。
--
-- 【未包含】
--   编目基线表（sat_tle、sat_tle_history、sat_cdm、sat_catalog、sat_constellation*、
--   sat_owner / sat_payload / sat_sensor、sat_space_weather、hs_cdm_history、
--   sat_aoe 及其同步日志等）由 heat-sidecar 基线保留，本文件不建、不改、不删。
--
-- 【执行方式】见同目录 README.md 的「001_init.sql 使用说明」小节。
-- =============================================================================

SET NAMES utf8mb4;
-- 不修改会话时区：时间列按数据库会话本地时间（生产 +08）存储，与基线表一致

-- -----------------------------------------------------------------------------
-- 0. 迁移账本（新平台自有；代码不感知，仅供人工/自动化判断本文件是否已应用）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version`    varchar(32)  NOT NULL COMMENT '迁移版本号，如 001',
  `applied_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '应用时间（DB 本地时间）',
  `note`       varchar(255) NOT NULL DEFAULT '' COMMENT '本版本说明',
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='数据库迁移版本账本';


-- =============================================================================
-- 1. 租户与账号
-- =============================================================================

CREATE TABLE IF NOT EXISTS `organizations` (
  `id`            bigint unsigned NOT NULL AUTO_INCREMENT,
  `name`          varchar(128) NOT NULL COMMENT '组织名称（全局唯一）',
  `plan`          enum('free','normal','vip') NOT NULL DEFAULT 'free' COMMENT '档位',
  `status`        enum('active','suspended','closed') NOT NULL DEFAULT 'active' COMMENT '生命周期状态',
  `trial_ends_at` datetime NULL DEFAULT NULL COMMENT '试用到期时间（DB 本地时间）',
  `notes`         text NULL COMMENT '运营备注',
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间（DB 本地时间）',
  `updated_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_name` (`name`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='租户组织（plan 档位 + status 生命周期）';

CREATE TABLE IF NOT EXISTS `users` (
  `id`            bigint unsigned NOT NULL AUTO_INCREMENT,
  `org_id`        bigint unsigned NULL DEFAULT NULL COMMENT '所属组织；platform_* 角色为空',
  `email`         varchar(190) NOT NULL COMMENT '登录邮箱（小写归一后唯一）',
  `display_name`  varchar(64) NOT NULL DEFAULT '' COMMENT '显示名',
  `role`          enum('platform_super_admin','platform_ops','org_admin','org_member') NOT NULL DEFAULT 'org_member' COMMENT '角色',
  `password_hash` varchar(100) NOT NULL COMMENT 'bcrypt 哈希（明文不落库）',
  `status`        enum('active','disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态',
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间（DB 本地时间）',
  `updated_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_email` (`email`),
  KEY `idx_user_org` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台与组织用户（platform_* 角色 org_id 为空）';


-- =============================================================================
-- 2. 目标
-- =============================================================================
-- 说明：
--   * 唯一键由原来的 UNIQUE(norad_id) 改为 UNIQUE(org_id, norad_id)：
--     允许多组织各自认领同一 NORAD（组织隔离），同时禁止同组织重复认领。
--   * claim_type：normal 普通认领（学习/教学/模拟科研，可多组织重复）/
--     owner 授权认领（卫星业主）。生成列 owner_norad 仅授权认领非空，
--     uk_owner_norad 保证同一 NORAD 全局仅一个授权认领。
--   * 仅授权认领可维护档案参数与绑定星历（应用层校验，库层只保证唯一性）。
--   * 原 idx_org(org_id) 不再单建 —— uk_org_norad 的最左前缀已覆盖按 org 过滤。
--   * idx_norad 保留：按 NORAD 全局查授权认领 / 编目发现需要。
--   * deleted_at 为软删预留。注意：软删后若保留原 norad_id，uk_org_norad 会
--     阻止同组织重新认领；启用软删时需在释放时清空/改写 norad_id，或改为物理删除。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `objects` (
  `id`               bigint NOT NULL AUTO_INCREMENT,
  `org_id`           bigint unsigned NOT NULL COMMENT '认领组织',
  `norad_id`         int NOT NULL COMMENT 'NORAD 编目号',
  `name`             varchar(100) NOT NULL DEFAULT '' COMMENT '目标名称',
  `mass_kg`          double NULL COMMENT '质量 (kg)',
  `cross_section_m2` double NULL COMMENT '迎风截面积 (m^2)',
  `propulsion`       varchar(60) NOT NULL DEFAULT '' COMMENT '推进类型/能力描述',
  `accepted_pc`      double NULL COMMENT '组织验收碰撞概率阈值',
  `accepted_miss_km` double NULL COMMENT '组织验收最小距离阈值 (km)',
  `claim_status`     varchar(20) NOT NULL DEFAULT 'claimed' COMMENT '认领状态（当前仅 claimed）',
  `claim_type`       enum('normal','owner') NOT NULL DEFAULT 'normal' COMMENT '认领类型：normal=普通（学习/教学/模拟科研，可多组织重复）/ owner=授权（卫星业主，全局唯一）',
  `owner_norad`      int GENERATED ALWAYS AS (CASE WHEN `claim_type` = 'owner' THEN `norad_id` ELSE NULL END) STORED COMMENT '授权认领 NORAD（普通认领为 NULL，唯一键保证全局仅一个授权认领）',
  `deleted_at`       datetime(3) NULL DEFAULT NULL COMMENT '软删时间（DB 本地时间）；NULL=未删。代码目前为硬删，启用软删后查询需加 deleted_at IS NULL',
  `created_at`       datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（DB 本地时间）',
  `updated_at`       datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_norad` (`org_id`, `norad_id`),
  UNIQUE KEY `uk_owner_norad` (`owner_norad`),
  KEY `idx_norad` (`norad_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='目标（组织认领的 NORAD 档案）';

-- C1（R2-11）：业主认领授权范围（超管配置；空 = 不允许 owner）
-- 通用机制、无品牌硬编码：
--   norad             按 NORAD 白名单（scope_value 为正整数）
--   constellation_key 按编目星座编码（sat_constellation.code，大小写不敏感）
--   tag               目标名包含 / 星座名称·编码·关键词包含
CREATE TABLE IF NOT EXISTS `org_claim_scopes` (
  `id`          bigint NOT NULL AUTO_INCREMENT,
  `org_id`      bigint unsigned NOT NULL COMMENT '组织',
  `scope_type`  enum('norad','tag','constellation_key') NOT NULL COMMENT '范围类型',
  `scope_value` varchar(64) NOT NULL COMMENT '范围值',
  `note`        varchar(128) NOT NULL DEFAULT '' COMMENT '备注',
  `created_at`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_scope` (`org_id`, `scope_type`, `scope_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='业主认领授权范围（超管配置；空 = 不允许 owner）';


-- =============================================================================
-- 3. 交会筛查（Epic E1 / R0-3 / R2-8）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `screening_jobs` (
  `id`               bigint NOT NULL AUTO_INCREMENT,
  `org_id`           bigint unsigned NOT NULL COMMENT '所属组织',
  `triggered_by`     varchar(128) NOT NULL DEFAULT '' COMMENT '触发人（邮箱/系统标识）',
  `status`           varchar(10) NOT NULL DEFAULT 'queued' COMMENT '任务状态：queued/running/done/failed/cancelled',
  `params_json`      JSON NULL COMMENT '筛查参数快照（windowH/missMaxKm/hbrM/primaryNorads/startMs/primarySource/secondarySource）',
  `window_h`         int NOT NULL DEFAULT 72 COMMENT '筛查时间窗 (h)',
  `miss_max_km`      double NOT NULL DEFAULT 10 COMMENT '粗筛最大脱靶距离 (km)',
  `hbr_m`            double NOT NULL DEFAULT 15 COMMENT '硬体半径 (m)',
  `n_primary`        int NOT NULL DEFAULT 0 COMMENT '主星数量',
  `n_secondary`      int NOT NULL DEFAULT 0 COMMENT '副星数量',
  `n_candidates`     int NOT NULL DEFAULT 0 COMMENT '候选交会数',
  `n_events`         int NOT NULL DEFAULT 0 COMMENT '入事件数',
  `progress_pct`     tinyint unsigned NOT NULL DEFAULT 0 COMMENT 'R0-3 进度百分比（0-100）',
  `progress_note`    varchar(200) NULL COMMENT 'R0-3 阶段说明（加载/粗筛/精化/写入/取消）',
  `heartbeat_at`     datetime(3) NULL COMMENT 'R0-3 心跳（DB 本地时间，僵死看门狗依据）',
  `cancel_requested` tinyint NOT NULL DEFAULT 0 COMMENT 'R0-3 取消请求标记（1=执行侧应终止）',
  `primary_source`   varchar(16) NOT NULL DEFAULT 'tle' COMMENT 'R2-8 主星源：tle|ephem',
  `secondary_source` varchar(16) NOT NULL DEFAULT 'catalog' COMMENT 'R2-8 副星/对照源：catalog|cdm',
  `error_message`    varchar(1000) NULL COMMENT '失败原因',
  `queued_at`        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入队时间（DB 本地时间）',
  `started_at`       datetime(3) NULL COMMENT '开始时间（DB 本地时间）',
  `finished_at`      datetime(3) NULL COMMENT '结束时间（DB 本地时间）',
  `duration_ms`      bigint NOT NULL DEFAULT 0 COMMENT '耗时 (ms)',
  PRIMARY KEY (`id`),
  KEY `idx_job_org` (`org_id`),
  KEY `idx_job_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='交会筛查任务（Epic E1）';

CREATE TABLE IF NOT EXISTS `conjunction_events` (
  `id`                bigint NOT NULL AUTO_INCREMENT,
  `job_id`            bigint NOT NULL COMMENT '所属筛查任务',
  `org_id`            bigint unsigned NOT NULL COMMENT '所属组织',
  `primary_object_id` bigint NULL COMMENT 'objects.id（TLE 主星时可空）',
  `primary_norad`     int NOT NULL COMMENT '主星 NORAD',
  `primary_name`      varchar(100) NOT NULL DEFAULT '' COMMENT '主星名称',
  `secondary_norad`   int NOT NULL COMMENT '副星 NORAD',
  `secondary_name`    varchar(100) NOT NULL DEFAULT '' COMMENT '副星名称',
  `tca`               datetime(3) NOT NULL COMMENT '最近交会时刻（DB 本地时间）',
  `miss_km`           double NOT NULL COMMENT '最近距离 (km)',
  `miss_r_km`         double NULL COMMENT 'RTN 径向分量 (km)',
  `miss_t_km`         double NULL COMMENT 'RTN 切向分量 (km)',
  `miss_n_km`         double NULL COMMENT 'RTN 法向分量 (km)',
  `rel_speed_kms`     double NULL COMMENT '相对速度 (km/s)',
  `pc`                double NULL COMMENT '碰撞概率',
  `pc_max`            double NULL COMMENT 'PcMax',
  `pc_method`         varchar(30) NOT NULL DEFAULT 'foster2d' COMMENT 'Pc 算法',
  `hbr_m`             double NULL COMMENT '硬体半径 (m)',
  `sigma_p_src`       varchar(8) NULL COMMENT '主星协方差来源',
  `sigma_p_t_km`      double NULL COMMENT '主星切向位置标准差 (km)',
  `sigma_s_src`       varchar(8) NULL COMMENT '副星协方差来源',
  `sigma_s_t_km`      double NULL COMMENT '副星切向位置标准差 (km)',
  `sec_epoch`         datetime(3) NULL COMMENT '副星根数历元（DB 本地时间）',
  `sec_age_h`         double NULL COMMENT '副星根数龄期 (h)',
  `level`             varchar(10) NOT NULL DEFAULT 'yellow' COMMENT '分级：red|orange|yellow',
  `diluted`           tinyint NOT NULL DEFAULT 0 COMMENT '是否稀释兜底',
  `a_x`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 x (km)',
  `a_y`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 y (km)',
  `a_z`               double NULL COMMENT '主星 TCA 时刻 TEME 位置 z (km)',
  `b_x`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 x (km)',
  `b_y`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 y (km)',
  `b_z`               double NULL COMMENT '副星 TCA 时刻 TEME 位置 z (km)',
  `cdm_id`            varchar(64) NULL COMMENT '匹配到的官方 CDM ID',
  `cdm_pc`            double NULL COMMENT '官方 CDM Pc',
  `pc_source`         varchar(10) NOT NULL DEFAULT 'core' COMMENT 'Pc 来源：core|cdm',
  `created_at`        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '写入时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_job_pair_tca` (`job_id`, `primary_norad`, `secondary_norad`, `tca`),
  KEY `idx_ev_job` (`job_id`),
  KEY `idx_ev_org_tca` (`org_id`, `tca`),
  KEY `idx_ev_tca` (`tca`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='交会事件（筛查产出，Epic E1）';


-- =============================================================================
-- 4. 碰撞参数与 Pc 重算（Epic F1）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `ca_org_defaults` (
  `org_id`             bigint unsigned NOT NULL COMMENT '组织 ID（一组织一行）',
  `hbr_mode`           varchar(10) NOT NULL DEFAULT 'single' COMMENT 'single=单侧合并 | both=双侧分设',
  `hbr_m`              double NOT NULL DEFAULT 15 COMMENT '单侧硬体/等效半径 (m)',
  `hbr_a_m`            double NULL COMMENT '双侧：A 侧半径 (m)',
  `hbr_b_m`            double NULL COMMENT '双侧：B 侧半径 (m)',
  `accepted_pc`        double NOT NULL DEFAULT 0.0001 COMMENT '接受 Pc 阈值',
  `accepted_miss_km`   double NOT NULL DEFAULT 1 COMMENT '接受最小脱靶 (km)',
  `screen_distance_km` double NOT NULL DEFAULT 10 COMMENT '筛查距离阈值 (km)',
  `covariance_mode`    varchar(12) NOT NULL DEFAULT 'tle-age' COMMENT 'tle-age | cdm',
  `propagator`         varchar(12) NOT NULL DEFAULT 'sgp4' COMMENT 'sgp4 | numeric',
  `window_h`           int NOT NULL DEFAULT 72 COMMENT '筛查时间窗 (h)',
  `step_s`             int NOT NULL DEFAULT 30 COMMENT '时间步长 (s)',
  `pc_methods`         varchar(64) NOT NULL DEFAULT 'foster,chan' COMMENT '勾选的 Pc 方法（逗号分隔）',
  `updated_by`         varchar(128) NOT NULL DEFAULT '' COMMENT '最后修改人',
  `updated_at`         datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织默认碰撞参数（Epic F1）';

CREATE TABLE IF NOT EXISTS `conjunction_pc_runs` (
  `id`           bigint NOT NULL AUTO_INCREMENT,
  `org_id`       bigint unsigned NOT NULL COMMENT '所属组织',
  `event_key`    varchar(64) NOT NULL COMMENT '事件 key（a:b:firstTcaMs）',
  `norad_a`      int NOT NULL COMMENT 'A 星 NORAD',
  `norad_b`      int NOT NULL COMMENT 'B 星 NORAD',
  `tca`          datetime(3) NOT NULL COMMENT '事件 TCA（DB 本地时间）',
  `params_json`  JSON NULL COMMENT '本次 run 解析后的参数（含来源标记）',
  `rows_json`    JSON NULL COMMENT 'Pc 比对行（方法/Pc/miss/TCA/HBR/协方差/耗时）',
  `agreement`    varchar(8) NULL COMMENT '方法一致性：green|yellow|red',
  `plane_json`   JSON NULL COMMENT '交会平面 + 协方差附加信息',
  `triggered_by` varchar(128) NOT NULL DEFAULT '' COMMENT '触发人/来源',
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  KEY `idx_run_org_event` (`org_id`, `event_key`, `created_at`),
  KEY `idx_run_org_created` (`org_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='参数重算 run（Epic F1，旧 run 可对比）';


-- =============================================================================
-- 5. 星历元数据（原始 .txt.gz 在文件系统，库中只存元数据）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `ephemeris` (
  `id`               varchar(64)  NOT NULL COMMENT '星历行 ID',
  `name`             varchar(128) NOT NULL DEFAULT '' COMMENT '目标名称',
  `norad`            varchar(16)  NOT NULL DEFAULT '0' COMMENT 'NORAD（字符串存储，兼容历史空值）',
  `object_id`        varchar(64)  NOT NULL DEFAULT '' COMMENT '外部对象标识',
  `bound_object_id`  bigint       NULL COMMENT '绑定到 objects.id（目标）',
  `format`           varchar(8)   NOT NULL DEFAULT 'ITC' COMMENT 'ITC|OCM',
  `file`             varchar(255) NOT NULL DEFAULT '' COMMENT '相对 EPH_ROOT 的文件路径',
  `file_mtime`       bigint       NOT NULL DEFAULT 0 COMMENT '文件 mtime（毫秒 epoch）',
  `file_size`        bigint       NOT NULL DEFAULT 0 COMMENT '压缩文件字节数',
  `raw_size`         bigint       NOT NULL DEFAULT 0 COMMENT '解压后原始字节数（0=未知）',
  `source_name`      varchar(255) NOT NULL DEFAULT '' COMMENT '来源标识（去重用）',
  `points`           int          NOT NULL DEFAULT 0 COMMENT '采样点数',
  `step_sec`         int          NOT NULL DEFAULT 60 COMMENT '采样步长 (s)',
  `start_ms`         bigint       NOT NULL DEFAULT 0 COMMENT '覆盖起点（毫秒 epoch）',
  `stop_ms`          bigint       NOT NULL DEFAULT 0 COMMENT '覆盖终点（毫秒 epoch）',
  `published_at`     bigint       NOT NULL DEFAULT 0 COMMENT '发布时间（毫秒 epoch）',
  `covariance`       tinyint      NOT NULL DEFAULT 0 COMMENT '是否含协方差',
  `cov_frame`        varchar(16)  NOT NULL DEFAULT '' COMMENT '协方差坐标系',
  `maneuvers`        int          NOT NULL DEFAULT 0 COMMENT '机动段数',
  `maneuver_summary` varchar(255) NOT NULL DEFAULT '' COMMENT '机动摘要',
  `maneuver_epochs`  JSON         NULL COMMENT '机动历元列表（JSON 数组）',
  `status`           varchar(16)  NOT NULL DEFAULT 'local' COMMENT '状态',
  `updated_at`       datetime(3)  NULL DEFAULT NULL COMMENT '文件更新时间（DB 本地时间）。原 varchar 存 ISO 字符串，见文件头代码改动；空串需回退 NULL',
  `originator`       varchar(128) NOT NULL DEFAULT '' COMMENT '数据生产方',
  PRIMARY KEY (`id`),
  KEY `idx_eph_norad` (`norad`),
  KEY `idx_eph_format` (`format`),
  KEY `idx_eph_name` (`name`),
  KEY `idx_eph_start` (`start_ms`),
  KEY `idx_eph_published` (`published_at`),
  KEY `idx_eph_bound` (`bound_object_id`),
  KEY `idx_eph_file` (`file`),
  KEY `idx_eph_source_name` (`source_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='星历元数据索引（原始 .txt.gz 在文件系统 data/ephemerides/）';

CREATE TABLE IF NOT EXISTS `ephemeris_versions` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `norad`        varchar(16)  NOT NULL DEFAULT '0' COMMENT 'NORAD',
  `format`       varchar(8)   NOT NULL DEFAULT 'ITC' COMMENT 'ITC|OCM',
  `source`       varchar(16)  NOT NULL DEFAULT 'upload' COMMENT 'upload=管理页上传 | scan=rebuild 扫描',
  `file`         varchar(255) NOT NULL DEFAULT '' COMMENT '版本文件相对路径',
  `sha256`       char(64)     NOT NULL DEFAULT '' COMMENT '内容 sha256',
  `bytes`        bigint       NOT NULL DEFAULT 0 COMMENT '压缩文件字节数',
  `raw_bytes`    bigint       NOT NULL DEFAULT 0 COMMENT '解压后字节数',
  `published_at` bigint       NOT NULL DEFAULT 0 COMMENT '发布时间（毫秒 epoch）',
  `uploaded_by`  varchar(190) NOT NULL DEFAULT '' COMMENT '上传人邮箱（与 users.email 关联查询）',
  `deleted_at`   bigint       NULL DEFAULT NULL COMMENT '软删时间戳（毫秒 epoch）。沿用代码 Date.now() 语义，本次不改为 datetime',
  `created_at`   datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入账时间（DB 本地时间）。原 varchar 存 ISO 字符串，见文件头代码改动',
  PRIMARY KEY (`id`),
  KEY `idx_ephver_norad` (`norad`, `format`, `id`),
  KEY `idx_ephver_sha` (`sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='星历版本归档账本（versions/<sha>.txt.gz 在文件系统，append-only + 软删）';


-- =============================================================================
-- 6. 机动候选（Epic J 占位：无机动引擎，只做候选管理 + 机动后再筛查）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `maneuver_plans` (
  `id`              bigint NOT NULL AUTO_INCREMENT,
  `org_id`          bigint unsigned NOT NULL COMMENT '所属组织',
  `object_id`       bigint unsigned NOT NULL COMMENT 'objects.id',
  `norad_id`        int NOT NULL COMMENT 'NORAD',
  `object_name`     varchar(100) NOT NULL DEFAULT '' COMMENT '目标名称（冗余展示）',
  `event_key`       varchar(64) NULL COMMENT '来源交会事件 key（可空=常规机动）',
  `event_tca`       datetime(3) NULL COMMENT '来源事件 TCA（DB 本地时间，冗余展示）',
  `event_level`     varchar(10) NULL COMMENT '来源事件分级（冗余展示）',
  `window_start`    datetime(3) NOT NULL COMMENT '机动窗口起点（DB 本地时间）',
  `window_end`      datetime(3) NOT NULL COMMENT '机动窗口终点（DB 本地时间）',
  `dv_m_s`          double NULL COMMENT '计划速度增量 (m/s，仅记录)',
  `direction`       varchar(24) NOT NULL DEFAULT '' COMMENT 'prograde|retrograde|radial|cross_track|other',
  `status`          varchar(12) NOT NULL DEFAULT 'proposed' COMMENT 'proposed|approved|executed|cancelled',
  `rescreen_job_id` bigint NULL COMMENT '最近一次再筛查任务 screening_jobs.id',
  `rescreen_at`     datetime(3) NULL COMMENT '最近一次再筛查时间（DB 本地时间）',
  `notes`           varchar(500) NULL COMMENT '备注',
  `created_by`      varchar(128) NOT NULL DEFAULT '' COMMENT '创建人',
  `created_at`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（DB 本地时间）',
  `updated_at`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  KEY `idx_mp_org` (`org_id`),
  KEY `idx_mp_obj` (`object_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='机动候选（Epic J 占位：候选管理 + 机动后再筛查，无机动引擎）';


-- =============================================================================
-- 7. 通知与日报（Epic H2）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `notify_channels` (
  `id`         bigint NOT NULL AUTO_INCREMENT,
  `org_id`     bigint unsigned NOT NULL COMMENT '所属组织',
  `kind`       varchar(10) NOT NULL COMMENT '渠道类型：webhook|email',
  `target`     varchar(500) NOT NULL COMMENT 'webhook URL 或收件邮箱',
  `min_level`  varchar(8) NOT NULL DEFAULT 'yellow' COMMENT '分级变化通知的最低等级（daily 不受此限）',
  `subscribe`  varchar(32) NOT NULL DEFAULT 'daily,changes' COMMENT '订阅项：daily 日报 | changes 分级变化',
  `secret_enc` varchar(512) NULL COMMENT 'webhook HMAC 密钥（AES-256-GCM 密文）',
  `enabled`    tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `last_ok_at` datetime(3) NULL COMMENT '最近一次投递成功时间（DB 本地时间）',
  `last_error` text NULL COMMENT '最近一次错误（截断后存放）',
  `created_by` varchar(128) NOT NULL DEFAULT '' COMMENT '创建人',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（DB 本地时间）',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  KEY `idx_org` (`org_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='通知渠道（Epic H2）';

-- 注意：payload_json 保持 MEDIUMTEXT 而非 JSON ——
-- api/src/jobs/dailyReport.ts:303 在写入前执行 payloadJson.slice(0, 1_000_000)，
-- 截断后可能不是合法 JSON；改为 JSON 会直接写入失败。若后续要去掉截断，
-- 再迁移为 JSON 并在 pool.ts 开启 jsonStrings。
CREATE TABLE IF NOT EXISTS `daily_reports` (
  `id`           bigint NOT NULL AUTO_INCREMENT,
  `org_id`       bigint unsigned NOT NULL COMMENT '所属组织',
  `report_date`  date NOT NULL COMMENT '报告日期',
  `scope`        varchar(10) NOT NULL DEFAULT 'managed' COMMENT 'managed=托管范围 | global=系统池',
  `payload_json` mediumtext NOT NULL COMMENT '日报汇总 + 事件等级快照（JSON 文本，写入前可能被截断）',
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建/覆盖时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_date` (`org_id`, `report_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='日报（每组织同日唯一，Epic H2）';

-- 注意：payload_json 保持 MEDIUMTEXT —— 见上，api/src/routes/notify.ts:244
-- 同样在写入前 slice(0, 10000)，不保证合法 JSON。
CREATE TABLE IF NOT EXISTS `notify_deliveries` (
  `id`           bigint NOT NULL AUTO_INCREMENT,
  `org_id`       bigint unsigned NOT NULL COMMENT '所属组织',
  `channel_id`   bigint NOT NULL COMMENT 'notify_channels.id',
  `kind`         varchar(20) NOT NULL COMMENT 'daily_report|level_change|test',
  `status`       varchar(10) NOT NULL COMMENT 'success|failed|skipped',
  `attempts`     int NOT NULL DEFAULT 0 COMMENT '尝试次数',
  `status_code`  int NULL COMMENT 'HTTP 状态码',
  `error`        text NULL COMMENT '错误信息',
  `payload_json` mediumtext NULL COMMENT '投递载荷（JSON 文本，可能被截断）',
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '投递时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  KEY `idx_org_time` (`org_id`, `created_at`),
  KEY `idx_channel` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='通知投递审计（Epic H2）';


-- =============================================================================
-- 8. 档位、配额与功能开关（Epic A2 / B1 / I）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `plan_defaults` (
  `plan`        enum('free','normal','vip') NOT NULL COMMENT '档位',
  `feature_key` varchar(64) NOT NULL COMMENT '功能键',
  `limit_value` bigint NOT NULL COMMENT '默认限额（count/days/bitmap/scope 编码见代码 FEATURE_KEYS）',
  PRIMARY KEY (`plan`, `feature_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='档位默认限额（plan × feature_key）';

CREATE TABLE IF NOT EXISTS `org_quota_overrides` (
  `org_id`      bigint unsigned NOT NULL COMMENT '组织 ID',
  `feature_key` varchar(64) NOT NULL COMMENT '功能键',
  `limit_value` bigint NOT NULL COMMENT '组织覆盖值（effective = override ?? plan default）',
  PRIMARY KEY (`org_id`, `feature_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织级限额覆盖（effective = override ?? plan default）';

CREATE TABLE IF NOT EXISTS `org_feature_flags` (
  `org_id`     bigint unsigned NOT NULL COMMENT '组织 ID',
  `flag_key`   varchar(64) NOT NULL COMMENT '开关键',
  `enabled`    tinyint NOT NULL DEFAULT 1 COMMENT '覆盖值（1=开，0=关）',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`org_id`, `flag_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织级功能开关覆盖（enabled = override ?? catalog default）';


-- =============================================================================
-- 9. 客户自配凭据与组织私有快照（Epic C2）
-- =============================================================================

-- 说明：org_credentials / org_fetch_batches / org_snapshots 的 org_id 沿用代码
-- 原类型 INT（其余表为 bigint unsigned）；改名会波及代码无需改，但不一致，
-- 建议后续统一为 bigint unsigned（需一次 ALTER，本草案保持代码原样）。
CREATE TABLE IF NOT EXISTS `org_credentials` (
  `id`         bigint NOT NULL AUTO_INCREMENT,
  `org_id`     int NOT NULL COMMENT '组织 ID（代码原为 INT，待统一 bigint unsigned）',
  `provider`   varchar(20) NOT NULL COMMENT 'spacetrack|aoe',
  `ciphertext` text NOT NULL COMMENT 'AES-256-GCM 密文 v1.<iv>.<tag>.<cipher>（明文永不落库）',
  `last_ok_at` datetime(3) NULL COMMENT '最近一次校验成功时间（DB 本地时间）',
  `last_error` text NULL COMMENT '最近一次错误（截断后存放）',
  `updated_by` varchar(128) NOT NULL DEFAULT '' COMMENT '最后修改人',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_provider` (`org_id`, `provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织自配数据源凭据（密文存储，Epic C2）';

CREATE TABLE IF NOT EXISTS `org_fetch_batches` (
  `id`            bigint NOT NULL AUTO_INCREMENT,
  `org_id`        int NOT NULL COMMENT '组织 ID（代码原为 INT，待统一 bigint unsigned）',
  `provider`      varchar(20) NOT NULL COMMENT 'spacetrack|aoe',
  `kind`          varchar(10) NOT NULL COMMENT 'gp|cdm|aoe',
  `status`        varchar(10) NOT NULL DEFAULT 'running' COMMENT 'running|success|failed',
  `triggered_by`  varchar(128) NOT NULL DEFAULT '' COMMENT '触发人/来源',
  `started_at`    datetime(3) NOT NULL COMMENT '开始时间（DB 本地时间）',
  `finished_at`   datetime(3) NULL COMMENT '结束时间（DB 本地时间）',
  `duration_ms`   int NULL COMMENT '耗时 (ms)',
  `total`         int NOT NULL DEFAULT 0 COMMENT '源记录总数',
  `inserted`      int NOT NULL DEFAULT 0 COMMENT '新增条数',
  `updated`       int NOT NULL DEFAULT 0 COMMENT '更新条数',
  `skipped`       int NOT NULL DEFAULT 0 COMMENT '跳过条数',
  `error_message` text NULL COMMENT '错误信息',
  PRIMARY KEY (`id`),
  KEY `idx_org_started` (`org_id`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织凭据拉取批次审计（Epic C2）';

-- raw_json 保持 MEDIUMTEXT：GP 路径写入空串 ''（见 orgFetch.ts:96），
-- 不能保证为合法 JSON，改 JSON 会写入失败。
CREATE TABLE IF NOT EXISTS `org_snapshots` (
  `id`           bigint NOT NULL AUTO_INCREMENT,
  `org_id`       int NOT NULL COMMENT '组织 ID（代码原为 INT，待统一 bigint unsigned）',
  `provider`     varchar(20) NOT NULL COMMENT 'spacetrack|aoe',
  `kind`         varchar(10) NOT NULL COMMENT 'gp|cdm|aoe',
  `norad_id`     int NOT NULL DEFAULT 0 COMMENT '单目标行=NORAD；CDM 行=0',
  `object_name`  varchar(100) NOT NULL DEFAULT '' COMMENT '目标名称',
  `epoch`        datetime(3) NULL COMMENT 'GP=根数历元；CDM=TCA（DB 本地时间）',
  `tle_line1`    varchar(100) NOT NULL DEFAULT '' COMMENT 'TLE 第一行',
  `tle_line2`    varchar(100) NOT NULL DEFAULT '' COMMENT 'TLE 第二行',
  `content_hash` char(40) NOT NULL COMMENT 'sha1(内容)',
  `raw_json`     mediumtext NULL COMMENT '原始片段/报文（不保证合法 JSON，故保持文本）',
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '写入时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_kind_norad_hash` (`org_id`, `provider`, `kind`, `norad_id`, `content_hash`),
  KEY `idx_org_norad` (`org_id`, `norad_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='组织私有轨道快照（append 版本化，Epic C2）';


-- =============================================================================
-- 10. 系统池日更批次与版本化快照（Epic C1）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `orbital_fetch_batches` (
  `id`            bigint NOT NULL AUTO_INCREMENT,
  `source`        varchar(30) NOT NULL COMMENT 'spacetrack_gp|spacetrack_cdm|aoe',
  `status`        varchar(10) NOT NULL DEFAULT 'running' COMMENT 'running|success|failed',
  `triggered_by`  varchar(60) NOT NULL DEFAULT 'cron' COMMENT 'cron|manual:<email>',
  `started_at`    datetime(3) NOT NULL COMMENT '开始时间（DB 本地时间）',
  `finished_at`   datetime(3) NULL COMMENT '结束时间（DB 本地时间）',
  `duration_ms`   int NULL COMMENT '耗时 (ms)',
  `total`         int NOT NULL DEFAULT 0 COMMENT '源记录总数',
  `inserted`      int NOT NULL DEFAULT 0 COMMENT '新增条数',
  `updated`       int NOT NULL DEFAULT 0 COMMENT '更新条数',
  `skipped`       int NOT NULL DEFAULT 0 COMMENT '跳过条数',
  `error_message` text NULL COMMENT '错误信息',
  PRIMARY KEY (`id`),
  KEY `idx_src_status` (`source`, `status`),
  KEY `idx_finished` (`finished_at`),
  KEY `idx_status_started` (`status`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='系统池日更拉取批次（Epic C1）';

-- raw_json 保持 MEDIUMTEXT：与 org_snapshots 对齐，存来源原始片段，
-- 不保证所有数据源都是合法 JSON。
CREATE TABLE IF NOT EXISTS `orbital_snapshots` (
  `id`           bigint NOT NULL AUTO_INCREMENT,
  `batch_id`     bigint NOT NULL COMMENT 'orbital_fetch_batches.id',
  `provider`     varchar(20) NOT NULL COMMENT 'spacetrack_gp|aoe',
  `source`       varchar(20) NOT NULL DEFAULT 'system_pool' COMMENT '系统池口径（C3 按档位裁剪）',
  `norad_id`     int NOT NULL COMMENT 'NORAD',
  `object_name`  varchar(100) NOT NULL DEFAULT '' COMMENT '目标名称',
  `object_type`  varchar(20) NOT NULL DEFAULT 'UNKNOWN' COMMENT '目标类型',
  `epoch`        datetime(3) NULL COMMENT '根数历元（DB 本地时间）',
  `tle_line1`    varchar(100) NOT NULL DEFAULT '' COMMENT 'TLE 第一行',
  `tle_line2`    varchar(100) NOT NULL DEFAULT '' COMMENT 'TLE 第二行',
  `content_hash` char(40) NOT NULL COMMENT 'sha1(line1+line2)',
  `raw_json`     mediumtext NULL COMMENT '来源原始片段（不保证合法 JSON，故保持文本）',
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '写入时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_prov_norad_hash` (`provider`, `norad_id`, `content_hash`),
  KEY `idx_norad_epoch` (`norad_id`, `epoch`),
  KEY `idx_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='系统池轨道根数版本化快照（append，Epic C1）';


-- =============================================================================
-- 11. 平台管理审计（Epic B1）
-- =============================================================================
-- before_json / after_json 为 JSON.stringify 后的结构化快照，改为 JSON。
-- 注意：mysql2 默认会把 JSON 列解析为对象；若 pool.ts 未设 jsonStrings: true，
-- 管理端返回给前端的字段类型会从字符串变为对象，需同步调整。
CREATE TABLE IF NOT EXISTS `admin_audit_logs` (
  `id`            bigint unsigned NOT NULL AUTO_INCREMENT,
  `actor_user_id` bigint unsigned NULL DEFAULT NULL COMMENT '操作人 users.id（系统操作可空）',
  `actor_email`   varchar(190) NOT NULL DEFAULT '' COMMENT '操作人邮箱（冗余）',
  `org_id`        bigint unsigned NULL DEFAULT NULL COMMENT '目标组织（平台级操作可空）',
  `action`        varchar(64) NOT NULL COMMENT '动作标识',
  `before_json`   JSON NULL COMMENT '变更前快照',
  `after_json`    JSON NULL COMMENT '变更后快照',
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间（DB 本地时间）',
  PRIMARY KEY (`id`),
  KEY `idx_audit_org` (`org_id`),
  KEY `idx_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台管理操作审计（只读展示）';


-- =============================================================================
-- 12. 迁移版本登记（文件末尾）
-- =============================================================================
INSERT IGNORE INTO `schema_migrations` (`version`, `note`)
VALUES ('001', '测试期结构化重建：新平台自有表 22 张 + 类型/唯一键/索引修正');


-- =============================================================================
-- 附录 A：建议备份后删除的历史表（全部为注释，绝不执行）
-- =============================================================================
-- 前置条件（缺一不可）：
--   1) 先做全库 dump 并校验可恢复；
--   2) 先确认 heat-sidecar 同步泵未部署、未连接本库（否则会连带影响其依赖表）；
--   3) 逐表确认无代码引用（本仓库 api/src 已全量检索，下列表均无引用）。
--
-- 旧平台交会/CRI/联测（sat_joint_* 体系）：
--   sat_conjunction, sat_conjunction_aoe, sat_conj_run, sat_conj_run_aoe,
--   sat_cri_conjunction, sat_cri_conjunction_aoe, sat_cri_run, sat_cri_run_aoe,
--   sat_joint_conj_pair, sat_joint_conj_report, sat_joint_conj_run,
--   sat_joint_cri_pair, sat_joint_cri_report, sat_joint_cri_run, sat_joint_health
--
-- 旧平台报表/协方差模型/手工 TLE/检索日志：
--   sat_report, sat_report_aoe, sat_cov_model, sat_cov_model_aoe,
--   sat_manual_tle, sat_manual_tle_aoe, sat_search_log
--
-- 旧平台过境（pass_*，12 张）：
--   pass_detail, pass_geo, pass_info, pass_multi_region,
--   pass_multi_region_access, pass_multi_region_report, pass_multi_region_scan,
--   pass_region, pass_region_access, pass_region_report, pass_region_scan,
--   pass_scan_run
--
-- 旧平台发射（launch_*，5 张）：
--   launch_payload, launch_record, launch_site, launch_upcoming, launch_vehicle
--
-- 旧平台 AI 日志（ai_*，4 张）：
--   ai_chat_log, ai_download_log, ai_gap_log, ai_question_log
--
-- 旧平台系统/RBAC（sys_*，5 张；本平台用户与鉴权走 users + JWT，不依赖）：
--   sys_log, sys_message, sys_message_user, sys_role, sys_user
--
-- 旧平台内容/联系表单（3 张）：
--   content_banner, contact_cooperation, contact_feedback
--
-- 旧 heat-sidecar 遗留（9 张；注意 hs_cdm_history 属基线，必须保留）：
--   hs_eph_file, hs_ephem, hs_event, hs_screen_job, hs_screen_run,
--   hs_supgp, hs_sync_log, hs_uploaded_ephem, hs_validate
--
-- 暂不列入删除、需人工确认（与在用的 AOE 链路同源，删前确认无同步依赖）：
--   sat_aoe_history, sat_aoe_sync_log
--
-- =============================================================================
-- 附录 B：基线表（由 heat-sidecar 基线保留；本文件不建、不改、不删）
-- =============================================================================
--   sat_tle, sat_tle_history, sat_cdm, sat_cdm_sync_log, sat_sync_log,
--   sat_catalog, sat_constellation, sat_constellation_log, sat_constellation_sat,
--   sat_owner, sat_payload, sat_sensor, sat_space_weather, sat_aoe,
--   hs_cdm_history
-- =============================================================================
