# Openspace Safety — 超管数据运维改动与部署说明

| 项 | 内容 |
|---|---|
| **文档编号** | 28 |
| **日期** | 2026-11-10 |
| **对应说明** | 本轮改动已在本地仓库实现并完成测速；本文供 TRAE 理解差异后执行提交、推送与生产部署 |
| **方法文档** | `docs/星历公开源下载优化方法-2026-11-10.md`（gzip 压缩 + 分段并行的原理与验收数据） |
| **代码状态** | 已写在本地工作区，**尚未提交、尚未推送、尚未部署**。线上 `http://123.57.41.32/` 仍是旧下载器与旧数字输入框 |
| **仓库真相源** | 笔记本 `D:\项目\Openspace Safety`（`main`）。不要以 GitHub `origin/main` 或其它机器上的旧克隆为基准 |
| **约束** | 只改本仓库已列出的文件；不要重写下载器（代码已完成）；不要改文档 21～27 正文；不要覆盖生产 `/opt/openspace/api/.env`；不要提交 `data/ephemerides/`、`Temp/`、探测脚本或本机缓存 |

---

## 1. 交付总览

| 条目 | 内容 | 状态 |
|---|---|---|
| 下载加速 | 对 Starlink 公开星历的 gzip 传输体做分段并行拉取，本地再解压；清单与 OCM/ITC 共用同一下载器 | 本地已实现；生产机网络路径已测速通过；**未部署** |
| 默认拉取数量 | 超管 Data Ops 的 Starlink 拉取默认次数由 50 改为 **10** | 本地已改代码默认值 |
| 数字步进器 | 新增深色自定义上下箭头组件 `OspNumberInput`，全站同类数字框统一，隐藏系统原生箭头 | 本地已改 |
| 卡住状态自愈 | `GET /cgi/jobs/starlink-pull`：若库里 `running=true` 但进程内已不在跑，写回结束状态，避免页面一直转圈 | 本地工作区已有，随本轮一并提交 |

本轮**不要重新实现**上述能力，只需把已有改动提交、推送并部署。原理见方法文档，不要在产品文案里写第三方商业 SSA 品牌名。

---

## 2. 当前 Git 状态（提交前必读）

截至 2026-11-10 14:00（北京时间 / Asia/Shanghai）：

- 当前分支 `main`，**比 `origin/main` 超前 1 个未推送提交**：`2ab0081`（`feat: 账号档位与组织配额模型、基础用户权限限制、StarLink 星历拉取与来源标识`）。
- GitHub `origin/main` 仍停在 `7a2fb28`。生产上的 Starlink 拉取能力来自此前的本地部署，**并不在** `7a2fb28` 里。
- 本轮改动目前都在工作区（含未跟踪的新文件），还没有做成新提交。
- 提交时应把 `2ab0081` 作为父提交（在现有 `main` 上直接 commit），**不要**先 reset 到 `origin/main`，也**不要**从 GitHub 再拉一份覆盖本地。

---

## 3. 应提交的文件

### 3.1 下载加速（核心）

| 文件 | 说明 |
|---|---|
| `api/src/services/starlinkDownload.ts` | **新建**。原始 `https` 拉取、`Accept-Encoding: gzip`、8 段 Range 并行、keep-alive、重试、ETag 一致性、失败回退整包 gzip、本地 `gunzip` |
| `api/src/services/pullStarlink.ts` | 改为调用 `downloadPublicFile`；默认次数 10；同时下载 3 个文件（每文件再拆段）；清单也走同一下载器 |

### 3.2 默认次数

| 文件 | 说明 |
|---|---|
| `api/src/db/starlinkDb.ts` | `DEFAULT_STARLINK_CONFIG.count` 改为 `10` |
| `web/src/views/admin/DataOps.vue` | `slCount` 初始值与保存回退改为 `10`；使用 `OspNumberInput` |

### 3.3 数字步进器（全站）

| 文件 | 说明 |
|---|---|
| `web/src/components/OspNumberInput.vue` | **新建**。深色自定义步进，长按连加/连减，隐藏原生箭头；`defineModel`；向外发 `input` 事件，保证设置页 `@input="onEdit"` 仍能触发 |
| `web/src/main.ts` | 全局注册 `OspNumberInput` |
| `web/src/styles/global.scss` | 全局隐藏 `input[type=number]` 原生上下箭头 |
| `web/src/views/admin/admin.scss` | 配额编辑等处的数字框样式改为作用在内部 `input`，避免套在包装器上重复内边距 |
| `web/src/views/admin/OrgDetail.vue` | 数字框改为 `OspNumberInput` |
| `web/src/views/conjunctions/Detail.vue` | 同上 |
| `web/src/views/ephemerides/index.vue` | 同上 |
| `web/src/views/objects/index.vue` | 同上 |
| `web/src/views/screens/index.vue` | 同上 |
| `web/src/views/settings/index.vue` | 同上 |

样式要点：不要把原来写给 `input[type=number]` 的 `padding` / `border` 直接套到 `.osp-num` 包装器上（会双层内边距）。Data Ops 数量框宽度约 76px，背景用 `--bg-panel`。令牌沿用 `--bg-deep #07090c`、`--bg-panel #0f1318`、`--border #1e2630`、`--accent #4a7d9a`、`--text-muted #7a8696`。

### 3.4 拉取状态（建议一并提交）

| 文件 | 说明 |
|---|---|
| `api/src/routes/jobs.ts` | 查询时若持久化状态为 running、进程内已结束，则写回 `running=false` 并补 `finishedAt` |
| `web/src/api/admin.ts` | `StarlinkPullStatus` 补 `processed`、`current` 字段 |

### 3.5 不要提交

- `data/ephemerides/` 及其中的清单、下载缓存、OCM/ITC 样例（本机拉取产物，不是产品代码）
- `Temp/`、`osp-starlink-src/`、`api/_probe.mjs`、`api/_probe2.mjs`
- `api/src/routes/satTle.ts`：工作区仅有文件头编码/注释杂质，**与本轮无关，不要带上**
- 不要改 `/opt/openspace/api/.env`，也不要把本地 `.env` 打进部署包

文档本身（本文件与方法文档）可以一并提交，便于以后对照。

---

## 4. 测速结论（部署前已在生产机网络路径上验证）

对比脚本只下载、不入库、不改线上 API。同一批 3 个 OCM：`STARLINK-38128`、`STARLINK-37711`、`STARLINK-38123`。新旧方法解压后 SHA-256 一致。

| 环境 | 旧方法（每文件单条 gzip 流，3 个文件并行） | 新方法（每文件 8 段 gzip Range，3 个文件并行） | 倍率 |
|---|---|---|---|
| 生产服务器 `123.57.41.32` 本机 | 墙钟 **140.9 秒**（单文件 94.1～140.9 秒） | 墙钟 **25.1 秒**（单文件 13.9～25.0 秒） | **约 5.6 倍** |
| 开发笔记本 | 墙钟 **137.3 秒**（单文件 79.1～137.3 秒） | 墙钟 **17.9 秒**（单文件 9.3～17.9 秒） | **约 7.7 倍** |

同日上午线上真实拉取（旧代码、3 个 OCM）曾用时 76 秒（11:46:25–11:47:41 北京时间），说明北京到 GCS 的路径质量会波动。即便对照那个更好的 76 秒，本次 25.1 秒仍然明显更快。详细机制见方法文档。

---

## 5. 提交、推送与部署（请 TRAE 执行）

### 5.1 提交与推送

1. 在笔记本仓库 `D:\项目\Openspace Safety` 操作，确认当前 `HEAD` 为 `2ab0081`。
2. 只暂存 §3.1～§3.4 列出的文件，以及这两份文档（若需入库）。
3. 提交说明建议：`feat: 加速 Starlink 公开星历拉取（gzip 分段并行），Data Ops 默认 10 条并统一深色数字步进器`。
4. 再推送 `main` 到 `origin`。此次会**同时推送**尚未在 GitHub 上的 `2ab0081` 以及本轮新提交，这是预期行为。
5. 推送前不要 rebase / reset 到 `origin/main`。

### 5.2 部署生产 `123.57.41.32`

既有流程，不要自行发明步骤：

- 应用目录 `/opt/openspace`；API 由 systemd `openspace-api` 管理；Nginx `/cgi` 反代 `127.0.0.1:1234`。
- 先备份到 `/opt/backup/deploy-20261110/`（至少备份部署前的 `api` 与 `web/dist`）。
- 本地构建 web / api 产物，打包上传，解压覆盖，必要时在服务器 `api` 目录 `npm ci`（或按既有 deploy 脚本），然后 `systemctl restart openspace-api`。
- **禁止覆盖** `/opt/openspace/api/.env`。
- 确认 `systemctl is-active openspace-api` 为 active；健康检查数据库为 up；首页能加载到新的前端产物。

### 5.3 部署后必须知道的一点

生产里已经保存过的 Starlink 拉取数量是 **49**。代码里的默认值 10 **不会自动改掉**这条已存配置。部署后 Data Ops 输入框仍可能显示 49，直到超管改成 10 并保存，或按产品意愿写回配置。不要在未确认的情况下直接改库。

### 5.4 部署后冒烟

1. 超管打开 `/admin/data-ops`：数字框是深色自定义箭头（不再是系统原生箭头）；其它带数字步进的页面（设置、目标、筛查、交会详情、星历翻页、组织配额等）同样式。
2. 将数量临时改为 **3**（或 10），执行一次 Starlink OCM 拉取：状态能从 running 走到结束；墙钟应明显低于旧版同批（同日旧代码 3 份约 76～141 秒，新方法同批约为二十多秒，受链路波动影响）。
3. 抽查入库的 OCM 能正常打开，不是 HTML。
4. 既有账号口令与 `.env` 中的外部凭据均保持不变。

---

## 6. 与文档 27 的关系

文档 27 记录的是《26》任务书 R2-26～R2-30 的实现，以及 2026-11-07 那次已完成的推送与部署。本文是其后的独立更新，不修改 21～27 的既有正文。

---

## 7. 筛查任务可选 AOE 数据源（2026-11-10 补充）

筛查任务现在可以把系统池 AOE 编目选为主星源或副星源。AOE 是 `sat_aoe` 里的两行根数（SGP4 外推），不是 Starlink ITC/OCM 精密星历。产品界面称为「AOE」/「AOE 编目」，不要写第三方商业 SSA 品牌名。

**行为**
- 主星 `primarySource=aoe`：从系统池 `sat_aoe`（`is_active=1`、两行根数非空）加载所选主星并做 SGP4 外推；没有可用根数时明确失败，不回退到 `sat_tle`。
- 副星 `secondarySource=aoe`：`loadCatalog()` 读 `sat_aoe`，对象 `src='aoe'`；目录为空时明确失败。
- 与原有组合兼容：`tle|ephem` × `catalog|cdm` 仍是默认且有效；同时支持 `ephem×aoe`、`aoe×catalog`、`aoe×aoe`、`tle×aoe`。副星 `cdm` 仍走 CDM 复核、不跑全编目粗筛。
- 创建任务时校验：主星选 AOE 则所选目标须有可用 `sat_aoe` 行；副星选 AOE 则系统池至少有一条可用两行根数，否则 400。
- `screening_jobs.primary_source` / `secondary_source` 与 `params_json` 会如实保存 `aoe`（不再把未知值折成 `tle`/`catalog`）。
- 前端筛查页两个下拉框增加 AOE，任务列表标签显示 AOE；选中时有简短说明。Stargaze 仍不提供。

**本轮改动文件（请 TRAE 纳入即将进行的同一次提交 / 推送 / 部署，无需再实现一遍）**
- `api/src/routes/screens.ts`
- `api/src/db/screenDb.ts`
- `api/src/jobs/screening.ts`
- `api/src/routes/catalog.ts`（仅去掉「AOE 暂不接入」注释）
- `api/sql/001_init.sql`（列注释补 `aoe`）
- `web/src/api/screens.ts`
- `web/src/views/screens/index.vue`
- `web/src/i18n/messages.ts`
- `web/src/views/admin/DataOps.vue`（去掉「AOE 本轮不接入 / 预留」文案）
- 文档：本文本节；以及从文档 21～26、`星历公开源下载优化方法-2026-11-10.md`、`更新说明-2026-11-06.md`、`更新说明-2026-11-fix.md` 中删除或改写「本轮不做 AOE / AOE 暂缓 / 验收不要求 AOE」一类约束句。文档 27 无此类约束，未改正文。

**不要做**
- 不要覆盖生产 `.env`。
- 不要改生产里已保存的 Starlink 拉取数量。
- 不要为此单独再写一套下载器或筛查引擎。

---

**文档结束（28 · 2026-11-10）**
