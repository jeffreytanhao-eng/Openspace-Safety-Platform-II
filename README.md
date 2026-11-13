# 开源太空安全平台（Openspace Safety Platform）

面向卫星业主与空间态势分析人员的太空安全平台：编目检索、目标认领与关注、交会事件聚合、碰撞筛查、精密星历管理与精度比对、三维态势推演。

线上地址：<https://www.openspace-safety.com/>

---

## 1. 功能模块

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 总览 | `/` | 组织级统计、高危/警告交会数、今日筛查与星历新鲜度、数据源健康面板、日报/关注事件包 CSV 导出 |
| 目标 | `/objects` | 全库编目检索；业主认领 / 关注目标；目标档案（四层叠加 + 照片 + 编辑）；绑定精密星历；目标侧栏 Pc–TCA 散点 |
| 轨迹 | `/trajectories` | 目标轨道与轨迹查询 |
| 交会 | `/conjunctions` | 即将交会总览（Pc–TCA 散点 + 事件列表），支持 CDM / TLE / Ephem / AOE 四种数据源、TCA 与 Pc 排序、范围筛选 |
| 筛查 | `/screens`、`/screens/:id` | 发起主星 × 副星碰撞筛查任务，查看进度、事件与取消 |
| 星历 | `/ephemerides` | ITC / OCM 星历上传、分页检索、版本归档、OCM × TLE/AOE 精度比对、机动（Δv / 方向 / 目的）明细 |
| 我的文档 | `/docs` | 文档库：上传 / 正文预览 / 删除（需登录） |
| 态势 | `/situation` | Cesium + Three 双引擎三维地球，卫星、轨道、碎片与交会云 |
| 账号 | `/account` | 组织信息、档位与配额、成员管理、升级申请 |
| 设置 | `/settings` | 认领/关注参数、Pc 算法、通知设置 |
| 超管后台 | `/admin/*` | 组织与配额覆盖、认领审核、升级审批、审计日志、数据运维（日更 / StarLink 拉取 / 公开目录导入） |
| 登录 | `/login` | 邮箱或用户名 + 密码登录；未登录访问根路径跳转 `/login?redirect=/` |

---

## 2. 技术架构

```
浏览器
  │  HTTPS（Nginx 443/80，站点 https://www.openspace-safety.com）
  ▼
Nginx ── 静态资源 ──▶ /opt/openspace/web/dist（Vue 打包产物）
  │
  └─ /cgi/* 反向代理 ──▶ 127.0.0.1:1234（systemd: openspace-api）
                              │
                              ├─ Express 路由层（api/src/routes）
                              ├─ 业务服务层（api/src/services）
                              ├─ 后台任务（api/src/jobs，30s 对表调度）
                              └─ mysql2 连接池 ──▶ MySQL 8（127.0.0.1:3306）
```

### 2.1 技术选型

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5、Vite 6、TypeScript、Vue Router 4、Pinia、Element Plus、ECharts 5 |
| 三维 | Cesium 1.146（地球、大气、晨昏线）、Three.js 0.185（星空/日月/卫星叠加层）、satellite.js 7（SGP4/GMST） |
| 后端 | Node.js 22、TypeScript、Express 4、mysql2、bcryptjs、jsonwebtoken、nodemailer、compression |
| 数据库 | MySQL 8（业务表 + `sat_*` 编目/CDM/AOE 基线表） |
| 部署 | Ubuntu 24.04 + Nginx + systemd；生产库与 API 同机 |

### 2.2 目录结构

```
.
├─ web/                          # 前端
│  ├─ src/views/                 # 页面（overview/objects/conjunctions/screens/ephemerides/situation/admin…）
│  ├─ src/components/            # 通用组件（PcTcaChart、EChart、DataSourceBar、OspNumberInput…）
│  ├─ src/views/situation/       # 三维态势（SceneCore、cesiumEarth、glTF 模型与 LOD）
│  ├─ src/api/                   # 前端接口封装
│  └─ public/                    # Cesium 运行时、离线底图、模型、登录背景
├─ api/                          # 后端
│  ├─ src/routes/                # /cgi 路由（auth、objects、events、screens、ephemerides、documents、admin…）
│  ├─ src/services/              # 业务实现（筛查、精度比对、CDM 解析、日更、StarLink 拉取…）
│  ├─ src/jobs/                  # 定时任务（dailyFetch、screening、dailyReport）
│  ├─ src/db/                    # 数据访问层（orgDb、planDb、screenDb、starlinkDb、userDocsDb…）
│  ├─ src/middleware/plan.ts     # 配额校验
│  └─ sql/                       # 建表脚本
├─ data/user-documents/          # 用户文档正文落盘（运行期数据，Git 仅保留目录）
├─ deploy/                       # Nginx 配置、加固脚本与 systemd drop-in、Dockerfile（可选容器部署）
└─ docs/                         # 阶段与变更文档（01～31）+ user-manual 使用手册
```

### 2.3 运行形态

- 前端为单页应用，路由懒加载；生产由 Nginx 直接托管 `web/dist`。
- 后端单进程 Express，`/cgi` 前缀，统一响应 `{ code, msg, data }`。
- 后台任务与 API 同进程：每日 06:00 UTC 数据日更、UTC 00:00 StarLink 自动拉取、筛查任务队列。
- 数据库不可用时 API 仍可启动，`GET /cgi/health` 返回 `db: "down"`，前端不白屏。
- 三维场景使用项目内离线 NaturalEarth 底图，启动不访问境外影像服务。

---

## 3. 账号体系

### 3.1 档位模型

账号分为 `free` / `normal` / `vip` 三档。注册即为**基础用户（normal）**，`free` 仅保留在数据结构中、当前不投放。

| 维度 | 基础（normal） | VIP（vip） |
| --- | --- | --- |
| 组织形态 | 单人组织（注册时自动创建，组织名=用户名） | 组织最多 3 人（管理员 + 2 名成员） |
| 业主认领目标 | 0（不可认领） | 100（组织共享） |
| 关注目标 | 50 | 500（组织共享） |
| 每日星历上传 | 100 | 1000 |
| 每日筛查任务 | 0（不可发起） | 1000 |
| 每日重算次数 | 0 | 5000 |
| 系统 CDM 可查天数 | 30 | 365 |
| Pc 算法集 | Foster / Chan / Alfano / 官方 CDM | 同左 |
| API Key 数 | 3 | 20 |
| 系统 TLE 可见范围 | 全量公开池 | 全量公开池 |

### 3.2 组织与角色

- **组织（organizations）**：租户单元，持有 `plan` 档位与 `status` 生命周期；所有目标、筛查任务、交会事件、星历均按 `org_id` 隔离。
- **个人组织**：注册时自动创建，`plan=normal`、`notes='auto:personal'`，前端不展示组织管理入口；升级 VIP 时该组织原地升档，保留已有数据。
- **角色**：
  - 平台超管：可进入 `/admin/*`，管理组织配额覆盖、认领审核、升级审批、审计与数据运维；
  - 组织管理员（VIP 组织创建者）：可改名、邀请/移除成员、分配组织共享配额；
  - 组织成员：与管理员共享组织目标与档位额度，不能管理成员或修改组织参数；
  - 基础用户：只有自己的单人组织，无成员与认领能力。
- **升级流程**：用户在 `/account` 提交升级申请 → 平台超管在 `/admin/upgrades` 审批 → 服务端 `promotePersonalOrgToVip` 将个人组织升为 VIP，无需迁移数据。
- **认证**：`POST /cgi/auth/register`、`POST /cgi/auth/login`（邮箱或用户名 + 密码，密码至少 8 位），成功后签发 JWT，前端以 `Authorization: Bearer` 调用；密码用 bcrypt（cost 10）存储。
- 修改密码走 `POST /cgi/auth/password`；档位不可自助修改。

### 3.3 配额实现方式

- `plan_defaults`：档位 × 功能键的默认限额（服务端 seed，可运营调整）；
- `org_quota_overrides`：超管对单个组织的覆盖；
- 实际额度 `effective = override ?? plan default`；
- 功能键：`claims_max`、`watches_max`、`ephem_upload_day`、`screen_day`、`recompute_day`、`system_tle_scope`、`system_cdm_days`、`pc_methods`、`api_keys_max`、`members_max`；
- 超限统一返回 HTTP 403、业务码 `4030（QUOTA_EXCEEDED）`，前端展示具体额度与用量；
- 认领/关注配额为**组织共享**，成员与管理员共用同一池。

---

## 4. 实现方式

### 4.1 目标、认领与关注

- 编目数据来自系统池 `sat_tle`（Space-Track GP），支持按 NORAD、名称、类型检索。
- 认领分两类：`claim_type='owner'`（业主认领，同一 NORAD 全平台仅允许一家组织）与 `claim_type='normal'`（关注，可多组织并存）。
- 两类记录均写入 `objects` 表并以 `org_id` 隔离；同一目标可在同一组织内同时存在「业主认领 + 关注」，但第二个组织的业主认领会返回 409。
- 业主认领后可维护碰撞规避参数（CA 参数），用于筛查与风险评估；关注仅做跟踪与展示。
- 星历绑定：业主认领的目标可绑定 OCM / ITC 星历，供筛查（主星源 ephem）与精度比对使用。
- 批量取消关注：`POST /cgi/objects/batch-unwatch`，仅释放本组织 `normal` 关注目标（单次上限 500，解绑星历与 CA 参数）；业主认领目标跳过，须在详情页单独释放。
- 组织内别名：`PATCH /cgi/objects/:id/alias` 设置/清除，仅本组织可见（跨组织查询不返回该列值）；别名组织内唯一（冲突 409），为空时展示回退官方名称，`GET /cgi/objects/aliases` 返回本组织别名表。`003_object_aliases.sql` 供对照，启动时惰性补列。
- 目标档案（目录档案）：按「目录基线 → 型号家族 → 单目标覆盖 → 本组织覆盖」四层叠加展示，对应 `sat_catalog_profile` / `catalog_family(_profile)` / `catalog_object_override` / `org_object_dossier`；只读展示，绝不写回 `objects.mass_kg` / `cross_section_m2`。
  - 接口：`PATCH/DELETE /cgi/objects/:id/dossier`（本组织覆盖）、`GET/POST /cgi/objects/:id/dossier-photo`（照片 ≤8 MB，JPEG/PNG/WebP/GIF）。
  - 写权限：平台超管，或 VIP + 本组织 owner 且已认领；`004_catalog_profile.sql` / `005_dossier_layers.sql` 为对照脚本，运行期惰性建表。

### 4.2 交会事件

`GET /cgi/events?window=&scope=&eventSource=`

- `eventSource=cdm`（缺省）：聚合 `sat_cdm` 官方/客户 CDM，同一事件多份报文取较大 Pc；客户上传 CDM 按组织隔离。
- `eventSource=tle|ephem|aoe`：读取本组织 `conjunction_events ⋈ screening_jobs`，要求 `primary_source` 匹配、`status='done'`，各源之间**不互相回退**，无对应任务时返回空列表。
- `scope=mine`：按本组织已认领/关注的 NORAD 过滤。
- 去重：无序目标对 + TCA 落在约 5 分钟岛内，保留 Pc 更高者、其次更新的 `job_id`。
- 展示过滤：Pc 有值且 `< 1e-7` 的事件不进列表、不绘点（服务端与前端同口径），不从数据库删除原始 CDM。
- 分级阈值：`≥1e-4` 高危、`≥1e-5` 警告、`≥1e-7` 关注。
- 筛查事件 key 形如 `scr-{jobId}-{eventId}`，点击进入 `/screens/{jobId}`；CDM 事件进入 `/conjunctions/{key}`。

### 4.3 筛查引擎

`POST /cgi/screens` 创建任务，参数含主星、副星、时间窗与步长。

- 主星源：`tle`（系统池 GP）、`ephem`（本组织精密星历）、`aoe`（系统池 AOE 两行根数）；
- 副星源：`catalog`（全目录）、`cdm`（官方 CDM 关联目标）、`aoe`；
- 传播：satellite.js 的 SGP4/SDP4，按时间步长粗筛最近距离，再对候选对做精算；
- 碰撞概率：Foster、Chan、Alfano 及官方 CDM Pc，按档位 `pc_methods` 位图开放；
- 任务异步执行（`kickScreeningRunner`），带进度与阶段；支持取消（终态 `cancelled`）与重算配额 `recompute_day`；
- 结果写入 `conjunction_events`，供交会页与三维态势使用。

### 4.4 星历管理

- 支持 ITC / OCM 上传与解析，按 `norad + format` 维护元数据；同目标同格式仅保留发布时间最新的一份。
- 版本归档：文件内容 sha256 寻址落盘 `versions/<fmt>/<分片>/<sha前16>.txt.gz`，同内容全局只存一份；`ephemeris_versions` 账本按 (sha, source, 操作者) 去重；软删仅标记 `deleted_at`，`rebuild` 不触碰归档。
- VIP 上传的星历带「用户上传」标识，全平台可见，hover 显示上传者。
- 精度比对：`OCM × TLE`、`OCM × AOE`（不让 OCM × OCM 编造马氏距离）
  - RTN 三向残差时间序列与 CDF；
  - 预报时效窗：完整重叠或 3/6/12/24 h（窗沿 ±45 min）；
  - RMS 跟随当前绘制的点；
  - 马氏距离仅在 TLE/AOE 一侧使用筛查龄期模型 σ 时给出。
- 机动信息：解析 OCM 的 `MAN_*`（参考系、基质、加速度/时长、目的、器件等）写入元数据；星历表格展示 Δv 模长（加速/减速）、UVW 方向矢量与目的，并可展开明细；态势卡片与地球标注使用同一句 `Δv = (0.000 U, 0.093 V, 0.000 W) m/s`。选中机动段在轨道上以琥珀色管和蓝色「>」标出（按文件坐标系分量朝向；有偏离时交错排列），点击会把仿真时刻跳到该段 `t0`。
- Δv 方向统一按 UVW 显示（矢量行只写 U / V / W；「方向」标题后附灰色小字说明轴含义，不把长全称写进矢量）。U = 径向（Radial，沿 r̂ 向外），V = 沿迹（Along-track），W = 轨道面外（Cross-track，r̂×v̂）。这与 RTN / RSW 为同一族：R↔U、T↔V、N↔W。NTW 不同：T 沿速度、W = r×v、N = T×W（面内法向，近圆轨道上约等于 U）；界面会在机动历元把 NTW（及惯性系）Δv 投影到 UVW，而不会把 N、T、W 的数值直接标成 U、V、W。详见 `docs/user-manual/uvw-reference-frame.md`。

### 4.5 数据同步

| 数据源 | 频率 | 实现 |
| --- | --- | --- |
| Space-Track GP | 每日 06:00 UTC（`DAILY_FETCH_CRON`） | 两行根数入库 `sat_tle`，保留历史 |
| Space-Track CDM | 每日 06:00 UTC | 公报 CDM 入库 `sat_cdm` |
| AOE（spacemapper） | 每日同批 | `AOE_TOKEN` 缺失则跳过该源，不报错 |
| StarLink 公开星历 | UTC 00:00（配置开启时） | 读取 MANIFEST，按配置数量拉取 OCM/ITC；gzip Range 8 段并行下载后本地解压 |
| 公开目录（GCAT） | 每周一 00:00（北京时） | 下载 6 个 TSV（约 30 MB）入库 `sat_catalog_profile`；启动 8 s 后补跑一次，不受配置开关控制 |

- 调度器每 30 s 对表 UTC 时刻，同一天只触发一次；均支持超管在 `/admin/data-ops` 手动触发并查看进度。
- StarLink 下载器直接使用 `node:https` 取原始 gzip 字节（fetch 会自动解压导致无法拼接），先 `Range: bytes=0-0` 探测总大小，再分段下载、校验 ETag / `x-goog-generation` 一致性，失败回退整包下载。
- GCAT 也可手动导入：`npm run ingest:gcat -- --download`（或 `--dir <目录>` / `GCAT_DATA_DIR` 指向已下载的 TSV）；超管可在 `/admin/data-ops` 查看状态并手动触发（`GET /cgi/jobs/gcat/status`、`POST /cgi/jobs/gcat/ingest`，异步、409 互斥、写审计 `catalog.gcat.ingest`）。`data/gcat/*.tsv` 不入库。目录来源仅作内部数据基线，产品界面不展示其名称。
- 下载策略：先 `HEAD` 取远端长度、再用 `Range` 读首行 `# Updated …` 与本地比对，未变化直接跳过（每次约 600 字节）；有变化才按 `Range` 断点续传（写到 `*.part`，单连接 90 s 无数据自动重试，最多 4 次），完成后校验 `Content-Length` 再原子改名。

### 4.6 三维态势

- Cesium 负责地球、影像、大气与晨昏线；Three.js 透明叠加层负责星空、日月、卫星与轨道。
- 卫星模型按型号分组使用 InstancedMesh，按可见数量自动切换 low/med/high LOD；低配设备自动降到 low 档；未知类型使用十二面体占位模型。
- 底图使用项目内离线 NaturalEarth 影像，启动不请求境外 ArcGIS，避免网络受限环境启动卡顿。
- 从交会进入态势时只加载本次事件的星历轨道与交会云；离开态势时统一复位（停用临时星历轨道、关闭交会云、仿真钟回到当前时刻、速率复位），不会叠加历史会话内容。
- 深链 `/situation?norad=<NORAD>`：直接注入并选中该编目目标（即使类型筛选已关闭也会绘制），目标档案页的「态势」按钮即走此入口。
- 选中星历后可勾选侧栏「显示不确定度管道」，沿整段轨道叠加暗靛紫 `#3b1a78` 半透明填充管道（无边缘线框/虚线；默认不勾选；勾选后默认为 1σ、可切 3σ）。镜头贴近轨道（视距小于约 3–10 倍管半径）时自动淡出，避免近景被管壁铺满。横向截面按真实 1σ 截面放大显示，倍率可在「1σ 截面放大」中选 **1×**、**5×** 或 **20×**（默认 5×）；3σ 为所选倍率的 3 倍。放大只作用于横向截面，沿轨方向按真实位置铺展，倍率不随镜头远近变化，也没有视距下限；画在 3D 模型之下，被模型挡住是预期现象。有文件 `COV_` 时按协方差在垂直于轨道的平面上取椭圆截面（逐站直接使用该状态自带的协方差，每个状态一个截面，截面长短轴端点落在顶点上），并在 ITRF CARTPV 下随状态旋转到 ECI；没有完整协方差时回退到龄期经验 σ。轴线与轨道线共用同一组状态顶点，实测偏差在浮点量化量级（< 1 m）。详见 `docs/user-manual/uncertainty-ellipsoids.md`。

### 4.7 通知与报告

- 邮件通知（nodemailer）：按组织配置推送高风险交会与筛查完成提醒。
- 总览页「报告下载」：组织日报摘要（CSV）、关注事件包（CSV）。

### 4.8 我的文档

- 每个组织的文档库：`/cgi/documents` 列表 / 上传 / 正文 / 删除，按 `org_id` 隔离。
- 正文按 UUID 落盘 `data/user-documents/`（运行期存储，不入 Git，仓库仅保留目录）；元数据在 `user_documents` 表（`002_user_documents.sql` 惰性建表）。
- 事件包入库：交会事件详情一键保存（Markdown / HTML / CSV，`POST /cgi/documents/from-event-package`，`source_type='event-package'`，仅组织账号）。

### 4.9 安全加固基线

- 星历全系接口（`/cgi/ephemerides` 列表 / 文件 / 元数据 / 版本）需登录，版本做可见性校验，列表不再下发服务器路径；元数据缺失时文件接口返回 503。
- `/cgi/sat_tle/constellation/cache-clear` 仅平台超管。
- API 默认监听 `127.0.0.1`（可用 `API_LISTEN` 覆盖，生产禁止 `0.0.0.0`）。
- 主机侧：systemd 以 `openspace` 用户运行（drop-in `deploy/openspace-api.service.d/hardening.conf`），`/opt/openspace` 权限收紧由加固脚本统一设置；nginx 可选片段 `deploy/nginx/hardening-snippets.conf` 拒绝 `.bak` / `.sql` / `.env` 下载。
- 审计范围：`admin_audit_logs` 除平台管理操作外，覆盖各账号的关键写操作——目标认领/关注（含批量）/别名/释放/星历绑定、筛查创建与取消、文档上传/删除/钉选/下载、星历上传/删除/可见性/重建/版本删除、CDM 导入与事件重算、CA 参数维护；写审计失败仅记服务端日志不阻断业务，表启动惰性建。超管在「审计日志」页只读查看（摘要优先展示）。

### 4.10 界面语言

- 中英文双语界面：登录页右上角未登录即可切换 CN/EN，登录后由顶栏切换；偏好存 `localStorage['osp-locale']`，并同步 `<html lang>`。
- 文案集中在 `web/src/i18n/messages.ts`（zh / en 键严格 1:1，缺键会被 `vue-tsc` 报错）；超管后台与平台内部调试文案固定中文。

---

## 5. 本地开发

要求：Node.js 22+、npm 10+、MySQL 8（可选）。

### 5.1 后端

```bash
cd api
cp .env.example .env        # 至少填写 JWT_SECRET；不建库也能启动
npm install
npm run dev                # tsx watch src/server.ts
```

当前本地开发以 1235 端口运行构建产物（`node dist/server.js`），修改后端代码后需 `npm run build` 并重启该进程，改动才生效。

### 5.2 前端

```bash
cd web
npm install
npm run dev                # http://127.0.0.1:1233
```

Vite 开发服务器把 `/cgi`、`/uploads` 代理到 `VITE_PROXY_TARGET`（缺省 `http://127.0.0.1:1235/`）；后端未启动时接口返回 502 JSON，页面不白屏。

构建：`npm run build`（先 `vue-tsc -b` 类型检查，再 vite build）。

冒烟：

```bash
curl http://127.0.0.1:1235/cgi/health
# {"code":0,"msg":"ok","data":{"status":"up","db":"up","time":"..."}}
```

---

## 6. 部署（生产现状）

生产服务器：阿里云 Ubuntu 24.04，项目根 `/opt/openspace`。

| 组件 | 配置 |
| --- | --- |
| API | systemd `openspace-api`，`PORT=1234`，监听 `127.0.0.1`，以 `openspace` 用户运行（drop-in），工作目录 `/opt/openspace/api` |
| 数据库 | MySQL 8 本机，库 `openspace` |
| Web | Nginx 托管 `/opt/openspace/web/dist`，`/cgi` 反代 `127.0.0.1:1234` |
| 域名 | `https://www.openspace-safety.com/` |

发布步骤：

```bash
# 本地构建
cd web && npm run build
cd ../api && npm run build          # constellationSnapshot.ts 既有 tsc 错误不阻塞 emit

# 打包（务必排除线上配置与数据）
tar -czf Temp/deploy.tar.gz \
  --exclude api/node_modules --exclude api/.env --exclude api/data api web/dist
scp Temp/deploy.tar.gz root@<server>:/tmp/

# 服务器
tar -xzf /tmp/deploy.tar.gz -C /opt/openspace
cd /opt/openspace/api && npm ci

# ★ 固定流程：先跑加固脚本，再重启服务（脚本可重复执行，不改 .env 内容）
bash /opt/openspace/deploy/scripts/apply-openspace-host-hardening.sh
systemctl restart openspace-api
systemctl status openspace-api --no-pager
```

验收：未带 token 访问 `/cgi/ephemerides` 应返回 401；`ss -lntp | grep 1234` 应显示 `127.0.0.1:1234` 且进程用户为 `openspace`。

注意事项：

- **禁止覆盖** `/opt/openspace/api/.env`（线上端口、数据库、外部数据源凭据都在里面）。
- 解压为叠加语义：仓库中删除或改名的文件不会自动从服务器消失，需手动清理旧路径。
- 发布前先备份 `/opt/openspace` 的 `api` 与 `web/dist`，便于回退。
- 数据库表多为惰性建表，新库首次访问对应接口时自动创建。
- 公开目录照片目录（默认 `data/catalog-photos`）运行期自动创建，属主须与 `openspace` 运行用户一致；公开目录周更需服务器能访问 `planet4589.org`（每次约 30 MB）。
- 不要 `chmod -R 777 /opt/openspace`、不要把监听改回 `0.0.0.0`、不要删除 systemd drop-in、不要开启 ufw（安全组挡 1234/3306 即可）。

`deploy/` 下的 Docker Compose 为早期可选方案，生产未使用。

---

## 7. 接口概览

统一响应：`{ "code": 0, "msg": "ok", "data": ... }`；除公开查询外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cgi/health` | 健康检查（含 db 状态） |
| GET | `/cgi/config` | 前端运行配置 |
| POST | `/cgi/auth/register`、`/cgi/auth/login` | 注册 / 登录 |
| GET | `/cgi/auth/me` | 当前用户与组织、档位、配额用量 |
| POST | `/cgi/auth/upgrade-request` | 提交 VIP 升级申请 |
| GET | `/cgi/events` | 交会事件（`window`、`scope`、`eventSource`） |
| GET/POST | `/cgi/objects` | 编目检索、认领 / 关注、批量取消关注、组织内别名 |
| PATCH/DELETE | `/cgi/objects/:id/dossier` | 本组织目标档案覆盖（超管 / VIP 业主） |
| GET/POST | `/cgi/objects/:id/dossier-photo` | 目标照片读取 / 上传（≤8 MB） |
| GET/POST | `/cgi/jobs/gcat/status`、`/cgi/jobs/gcat/ingest` | 公开目录导入状态 / 手动触发（超管） |
| GET/POST | `/cgi/screens` | 筛查任务列表 / 创建 |
| GET | `/cgi/ephemerides` | 星历分页、文件与版本（需登录） |
| POST | `/cgi/ephemerides/accuracy/compare` | 精度比对 |
| GET/POST | `/cgi/documents` | 我的文档：列表 / 上传 / 正文 / 删除 / 事件包保存 |
| GET | `/cgi/overview/summary` | 总览统计 |
| GET/POST | `/cgi/admin/*` | 超管组织、配额、审批、审计、数据运维 |

---

## 8. 环境变量（api）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `1234` | 监听端口 |
| `API_LISTEN` | `127.0.0.1` | 监听地址（生产禁止设为 `0.0.0.0`） |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `root` / 空 / `openspace_safety` | 数据库账号与库名（生产为 `openspace`） |
| `JWT_SECRET` | 空 | JWT 签名密钥，必填 |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | `admin@openspace.local` / 空 | 平台超管 bootstrap，密码为空则跳过 |
| `SPACETRACK_USER` / `SPACETRACK_PASS` | 空 | Space-Track 日更凭据，缺失时 GP/CDM 失败、AOE 不受影响 |
| `AOE_TOKEN` / `AOE_BASE_URL` | 空 / `https://spacemapper.cn` | AOE 日更 |
| `DAILY_FETCH_CRON` | `0 6 * * *` | 日更时刻（UTC） |
| `DAILY_REPORT_CRON` | `30 6 * * *` | 组织日报生成时刻（UTC） |
| `STATIC_BASE` | 空 | 静态资源前缀 |
| `GCAT_DATA_DIR` | 空（`data/gcat`） | 公开目录 TSV 目录（`ingest:gcat` 读取/下载） |
| `CATALOG_PHOTOS_DIR` | 空（`data/catalog-photos`） | 目标/家族照片落盘目录，运行期自动创建 |

前端：`VITE_BASE`（部署子路径，默认 `/`）、`VITE_PROXY_TARGET`（开发代理目标）。

---

## 9. 常见问题

**地球出图但没有影像 / 一直是深色**

默认使用 `web/public/cesium/Assets/Textures/NaturalEarthII` 离线底图，不依赖外网。如需更清晰影像，可预下载瓦片到服务器后通过 `configureEarthBase({ imageryUrl, imageryKind, maximumLevel })` 指向自备瓦片包；本地底图分辨率较卫星影像粗，近距离观察会偏软。

**打开页面提示「三维地球底座初始化失败」**

多为 WebGL 不可用（远程桌面、无 GPU 旧浏览器）或 Cesium 静态资源未就绪。确认 `web/public/cesium/` 已生成（dev/build 会自动从 `node_modules/cesium` 复制）。

**访问域名跳到 `/login?redirect=/`**

根路径要求登录，属预期行为。

**构建时被 OOM Kill**

轻量服务器内存不足，先加 swap，或提高 `NODE_OPTIONS=--max-old-space-size=4096`。

---

## 10. 相关文档

- `docs/`：01 系统设计与三维外壳、各阶段 Epic 文档、21～31 变更说明与部署记录（30 安全加固与部署注意、31 我的文档）
- `docs/user-manual/开源太空安全平台使用手册.html`：面向最终用户的使用手册（含截图）
- `本地测试账号.md`：测试账号与档位（不入 Git）
