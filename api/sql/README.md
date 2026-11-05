# Database

Local MySQL is provided by Docker container `openspace-mysql` (image mysql:8):

- Host port: **13306** → container 3306
- Database: `openspace`
- User/pass: see `api/.env` / container env
- Already contains Space-Track synced tables (`sat_tle`, `sat_cdm`, …)

If the container is missing, from repo root:

```bash
cd deploy
cp .env.example .env
# set DB_* and MYSQL_ROOT_PASSWORD, map host port 13306 if preferred
docker compose --profile mysql up -d mysql
```

Then apply reference schema:

```bash
docker exec -i openspace-mysql mysql -uopenspace -p openspace < ../.reference/server/db/schema.sql
```

Space-Track GP/CDM import is done by the heat-sidecar sync (`spacetrackGp` / `spacetrackCdm`) using `SAT_USERNAME` / `SAT_PASSWORD` in that project's `.env` (do not commit secrets).

## `001_init.sql` 使用说明（测试期结构化重建草案）

`001_init.sql` 是新平台 22 张自有表（organizations/users/objects/screening_jobs/…）的建表草案，**仅供人工评审**，不包含 `sat_*` / `hs_*` 基线表。字段与索引均以 `api/src/db/*.ts`、`api/src/ephem/ephemDb.ts` 的 `CREATE TABLE` 及实际查询为准，并包含以下修正：`objects` 唯一键改为 `(org_id, norad_id)` + `deleted_at`，新增 `claim_type` 与唯一授权认领生成列 `owner_norad`（`uk_owner_norad`）；`ephemeris.updated_at`、`ephemeris_versions.created_at` 由 varchar 改为 `datetime(3)`；`screening_jobs` 直接含 R0-3/R2-8 列；`conjunction_events` 新增 `uk_job_pair_tca`；明确的 JSON 列改为 `JSON`。

应用顺序与前置条件（完整清单见文件头注释）：

1. **先全库备份**（`mysqldump`），并确认可恢复。
2. 完成文件头列出的配套代码改动（**已完成**，见文件头逐条标注）：
   - `pool.ts` 增加 `jsonStrings: true`（JSON 列与现有 `JSON.parse` 调用兼容）；
   - `ingest.ts` 的 `updated_at` / `versions.created_at` 改为本地时间 `YYYY-MM-DD HH:mm:ss`（`utils/time.ts: fmtLocalDateTime`）；
   - `ephemDb.ts` 读取归一化，兼容旧 varchar（UTC 字符串）与新 `datetime`；
   - `jobs/screening.ts` 两处事件写入改 `INSERT IGNORE`，`n_events` 按 `affectedRows` 统计；
   - `objects` 的 `deleted_at` 仅预留，本轮仍物理删除；
   - `objects` 新增 `claim_type`（normal 普通 / owner 授权），仅 owner 可维护参数与绑定星历，旧库由 `ensureObjectsSchema` 幂等迁移自动补列与唯一键。
   - **时间口径说明**：时间列统一存数据库会话本地时间（生产 +08），与 `sat_tle.epoch`、`sat_cdm.tca` 等存量基线表一致；**暂不切 UTC**（切换会让存量基线数据整体偏移 8 小时，需连同数据迁移另行安排）。
3. 本文件使用 `CREATE TABLE IF NOT EXISTS`：对已存在的表**不会**改动结构。仅适用于空库（Fresh install）或人工 drop 后的测试重建；已有数据结构请改用评审后的 `ALTER` 迁移。
4. 执行（示例，需人工确认目标库）：
   ```bash
   docker exec -i openspace-mysql mysql -uopenspace -p openspace < api/sql/001_init.sql
   ```
5. 执行后核对：`SELECT * FROM schema_migrations;` 应存在 `001` 一行；再比对 `SHOW CREATE TABLE objects\G`（`claim_type`、`owner_norad`、`uk_org_norad`、`uk_owner_norad`、`deleted_at`）与 `SHOW CREATE TABLE conjunction_events\G`（`uk_job_pair_tca`）。

只读核对本地库结构（不写库）：

```bash
docker exec openspace-mysql mysql -uopenspace -popenspace_db_2026 -N openspace -e "SHOW CREATE TABLE objects\G"
```

文件末尾的「历史表删除清单」全部是注释，删除前须确认 heat-sidecar 同步泵未部署/未连库，并先做全库 dump。
