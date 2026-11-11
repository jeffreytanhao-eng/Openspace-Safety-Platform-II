-- =============================================================================
-- 002_user_documents.sql —— 我的文档元数据表
-- =============================================================================
-- API 启动时 ensureUserDocsSchema() 会幂等执行同等 DDL，本地与后续生产无需手工跑本文件。
-- 本文件供评审 / 全新安装对照；不要 chmod 777 文档目录。
-- 磁盘文件落在应用 data 根下的 user-documents/，文件名=服务端 UUID。
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `user_documents` (
  `id`            char(36) NOT NULL COMMENT '服务端生成 UUID',
  `owner_user_id` bigint NOT NULL COMMENT '创建者用户 id',
  `org_id`        bigint NULL COMMENT '所属组织；置顶可为 NULL',
  `title`         varchar(255) NOT NULL COMMENT '展示文件名（含生成时间，无路径）',
  `original_name` varchar(255) NOT NULL COMMENT '原始/建议文件名',
  `storage_key`   varchar(80) NOT NULL COMMENT '磁盘文件名（UUID，不含用户文件名）',
  `size_bytes`    bigint NOT NULL,
  `mime`          varchar(127) NOT NULL,
  `source_type`   varchar(32) NOT NULL COMMENT 'report | ephemeris | upload | pinned',
  `pinned`        tinyint(1) NOT NULL DEFAULT 0,
  `scope`         varchar(16) NOT NULL COMMENT 'personal | org | pinned',
  `created_by`    bigint NOT NULL,
  `created_at`    datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_storage_key` (`storage_key`),
  KEY `idx_owner` (`owner_user_id`, `pinned`, `created_at`),
  KEY `idx_org_scope` (`org_id`, `scope`, `pinned`, `created_at`),
  KEY `idx_pinned` (`pinned`, `created_at`),
  KEY `idx_title` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='我的文档元数据';
