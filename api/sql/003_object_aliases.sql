-- =============================================================================
-- 003_object_aliases.sql —— 组织内目标别名（仅本组织可见）
-- =============================================================================
-- API 启动时 ensureObjectsSchema() / migrateObjectsSchema() 会幂等补列，
-- 本地与后续生产无需手工跑本文件。本文件供评审 / 对照。
-- 别名挂在既有 objects 行（本组织认领或关注的目标）上，不新建平行表。
-- 空别名存 NULL，展示时回退官方名称；跨组织查询不得返回此列有效值。
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE `objects`
  ADD COLUMN `alias` varchar(64) NULL
    COMMENT '组织内别名，仅本组织可见；空则回退官方名称' AFTER `name`;

ALTER TABLE `objects`
  ADD KEY `idx_org_alias` (`org_id`, `alias`);
