# Openspace Safety — TRAE 协作项目介绍

> 给 TRAE / 其他 AI 编程助手的项目简报。改代码前先读相关文件；不确定就问用户。  
> 仓库根目录：`D:\项目\Openspace Safety`（Windows）；亦可在 Linux 上用 Docker 部署。

## 1. 产品定位

- **专业运营商仪表盘**（Starlink Space Safety 风格）：深色 ops UI、橙黄 staging 点缀；**不是**课堂 3D 科普大屏。
- 产品中文名：**开源太空安全平台**（`i18n`：`appName` / `sit.title`）；英文名 Openspace Safety。
- 水印文案仅允许 **「谭谈」**（`web/src/components/Watermark.vue`，极淡、不挡操作）；**禁止**出现「佳男」。
- 默认中文，可切换 EN（`web/src/i18n` + `useI18n`）。
- 主壳：`web/src/layouts/AppShell.vue`（顶栏 logo/标题、左栏导航、右下 UTC|北京时间）。内嵌「态势」**不要**再画一套 logo/标题/平台时钟。

## 2. 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + Vite + TypeScript + Pinia + Vue Router + Element Plus |
| 3D 态势 | **Cesium**（地球/相机/光照）+ **Three.js**（透明叠加：点云、轨道、用户星历） |
| 轨道/TLE | `satellite.js` |
| 后端 | Express（`api/`，TypeScript → `dist/`），前缀 `/cgi` |
| 数据库 | MySQL 8（**可选**；连不上库 API 仍启动，`/cgi/health` → `db:'down'`） |
| 星历数据 | 真 Starlink **ITC/OCM** 文本（仓库内 `data/ephemerides/{itc,ocm}/`，多为 gzip） |

## 3. 目录要点

```
Openspace Safety/
  web/                  # 前端
    src/layouts/        # AppShell
    src/views/          # overview, objects, trajectories, conjunctions,
                        # ephemerides, situation, simulation, ai, docs, login
    src/views/situation/# 态势 3D 核心（见 §4）
    src/i18n/           # 中英文案
  api/                  # Express
    src/routes/         # cgi, catalog, ephemerides, satTle, satConstellation
    src/db/pool.ts      # mysql2 惰性连接池
    sql/README.md       # 本地库说明与 schema 引用
    .env.example
  data/ephemerides/     # itc/, ocm/, index.json, MANIFEST…
  deploy/               # Docker Compose + Dockerfiles + nginx
  docs/                 # cesium-three.md、本文件等
  .reference/           # 旧 Openspace-Safety-Platform 参考实现（只读对照，勿当运行入口）
```

态势关键文件（改 3D 必读）：

- `web/src/views/situation/SceneCore.vue` — 主循环、跟踪相机、准星
- `web/src/views/situation/cesiumEarth.ts` — Cesium 初始化、相机同步、绕焦点拖拽
- `web/src/views/situation/catalogCloudThree.ts` — 编目点云 / 星座轨道
- `web/src/views/situation/ephemOrbitThree.ts` — 用户星历轨 + MAN 管
- `web/src/views/situation/EphemPanel.vue` / `index.vue` — 星历面板与关联/跳转

更细的 Cesium/Three 约定见：`docs/cesium-three.md`。

## 4. 态势渲染（必读）

**分层**

- Cesium canvas：地球、大气、相机交互（底层，收指针事件）。
- Three canvas：`pointer-events: none` 叠加——星空、日/月标记、编目点云、浅蓝用户轨道、琥珀 MAN、青标。

**编目**

- Instanced / 点云 + 距离 LOD（远距 stride 抽稀）；类型过滤全关时用**无状态占位文字**（勿闪错误状态）。
- 星座轨道：`LineSegments` 批量；采样约 180 点/圈（勿再降到明显折线）。

**用户星历（OCM/ITC）**

- 主轨：浅蓝 `#81d4fa`（`EPH_ORBIT_COLOR`），多圈折线；预算约 16k 点 + 弦长加密，避免近景「折线感」。
- MAN：琥珀 `#ffb454`，**短粗** `TubeGeometry`，`depthTest: true`（靠地球 occluder 遮挡背面）；不要改回「透地球的球点」。
- 选中 /「关联至态势」：先沿 **地心→目标径向** 飞入（`TRACK_CAM_DIST≈0.15`），再 **delta 跟随**（相机与 lookAt 同位移）；落位后可 **拖拽绕目标转 + 滚轮缩放**（`setCameraOrbitFocusScene`）。不要每帧强制锁死径向，否则控件会假死。
- 「跳转至机动段」：停止跟踪、隐藏呼吸环与标签；相机以 TRACK 高度框住 MAN 中点；多 MAN **循环**，单 MAN 再点则重新框中点。
- 准星：白环呼吸约 3.2s + 名称标签；有名字用名字，**勿**在 name 数字后缀 ≠ NORAD 时强行改成 `NORAD xxx`。

**内嵌 chrome**

- 态势页**禁止**自带 logo、标题栏「开源太空安全平台」、右下 UTC|北京（平台壳已有）。只保留仿真条 / dock / 面板。

## 5. 星历

- 真文件落在 `data/ephemerides/`（ITC/OCM，常 `.txt.gz`）；API 侧按需 **gunzip** 读出，**不要**从 TLE「派生假 OCM」。
- 上游公开文件形态：`https://www.starlink.com/public-files/ephemerides/STARLINK-*.txt`（以仓库 manifest/脚本为准）。
- 前端：`/ephemerides` 列表与预览；「关联至态势」→ 入库/激活 → `/situation`（或 `ephId` 深链）绘制目标+轨+MAN。
- 解析与 IDB：`web/src/views/situation/ephem/`；旧 IDB 可能丢 `maneuvers`，跳转前会尝试从本地 index 补回。

## 6. Docker 与数据库

路径：`deploy/docker-compose.yml`、`deploy/api.Dockerfile`、`deploy/web.Dockerfile`、`deploy/.env.example`、`deploy/nginx/openspace.conf`。

### 服务

| Service | Image / Build | 说明 |
|---------|---------------|------|
| `web` | `openspace-safety-web:1.0.0`（`web.Dockerfile`：Node 22 build → **nginx:1.27-alpine**） | 宿主机 `${WEB_PORT:-1233}:1233`；反代 `/cgi` → api |
| `api` | `openspace-safety-api:1.0.0`（`api.Dockerfile`：Node 22-alpine，`node dist/server.js`） | 容器内 1234；可选映射 `${API_PORT:-1234}:1234`；卷 `uploads`；构建时 **COPY `data/ephemerides`** 进镜像 |
| `mysql` | **`mysql:8.0`** | **profile：`mysql`（默认不启动）**；utf8mb4；卷 `mysql-data` → `/var/lib/mysql` |

### 启动

```bash
cd deploy
cp .env.example .env    # 按需改端口与口令
docker compose up -d --build
# 需要本地 MySQL 时：
docker compose --profile mysql up -d --build
```

- 对外：`http://<host>:1233`（前端 + `/cgi`）；调试可直连 `:1234/cgi`。
- API **无库也能起**；健康检查打 `/cgi/health`。

### 环境变量（库）

`deploy/.env.example`（Compose 注入 api / mysql）：

- `DB_HOST` 默认 `mysql`（容器服务名；本机跑 api 时用 `127.0.0.1`）
- `DB_PORT=3306`、`DB_USER=openspace`、`DB_PASSWORD=openspace`
- `DB_NAME` 默认 **`openspace`**（注意：`api/.env.example` / `config.ts` 本地默认名是 **`openspace_safety`**——本地与 Compose 对齐时改同一名字）
- `MYSQL_ROOT_PASSWORD`（仅 mysql 服务）

`api` 通过 `api/src/config.ts` → `api/src/db/pool.ts`（mysql2 pool，`connectTimeout: 3000`）连接；前端只走 HTTP `/cgi`，**不直连** MySQL。

### Migrate / seed

- 仓库 **没有** 完整的自动 migration 流水线；`api/sql/README.md` 说明：需要时手动起 mysql，并可用参考 schema：
  - `docker exec -i openspace-mysql mysql -uopenspace -p openspace < ../.reference/server/db/schema.sql`
- Space-Track 类表（如 `sat_tle` / `sat_cdm`）的灌数依赖外部 sync / sidecar 与账号环境变量——**勿把密钥写进 git**。视为可选能力，未接好前不要假设交会/热力已通。

## 7. 硬性约束 / 勿改坏

1. 内嵌态势：**无**自有 logo / 标题 / 语言条 / 平台时间栏。
2. 类型过滤全关：无状态占位，勿错误闪烁。
3. 「初始化窗口」只重建 3D 视口，勿整页重载 AppShell。
4. 水印「谭谈」极淡；禁止「佳男」。
5. MAN 保持粗管 + 深度遮挡；跟踪保持径向飞入 + delta 跟随 + 可拖拽缩放。
6. Linux / Docker 友好（路径、LF、compose）；星历用真文件 gzip，勿造假 OCM。
7. 改态势后请用户 **硬刷新** 再验（Cesium/Three 缓存很顽固）。

## 8. 建议协作方式

- 与用户或其他助手**并行**时：改前打开将动的 `.vue` / `.ts`；**小步**改、说清文件列表。
- 3D / 相机 / 星历：先读 `docs/cesium-three.md` 与 §4；对照 `.reference` 旧实现，但新代码在 `web/src/views/situation/`。
- 不确定产品口径（文案、是否做某功能）→ **先问用户**，不要自行发明交互。
- 提交说明写清：现象、根因、文件、如何手测。

## 9. 可继续完善方向（多数仍为 aspirational）

下列导航已有壳页，但深度能力参差；未证实前当作待做：

- 交会筛选 / CDM 工作流（`/conjunctions`，Space-Track 数据需库+同步）
- 热力、过境等旧平台能力迁移
- 更多星座资产与登录后的「我的卫星/星历」权限
- AI 栏（`/ai`）实装
- 性能：屏幕空间 LOD、更稳的 30k+ 点云
- 文档页与运营商报表

---

**快速自检（态势）**：关联一条带 MAN 的 OCM → 径向飞入且可拖拽缩放 → 轨道近看不呈明显折线 →「跳转至机动段」停跟并框住琥珀段 → 页面无第二套 logo/标题/时钟。
