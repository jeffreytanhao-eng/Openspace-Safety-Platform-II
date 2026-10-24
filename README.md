# 开源太空安全平台（Openspace Space Safety Platform）

第一部分：系统设计 + 3D 地球场景外壳。

双引擎混合渲染：**Cesium** 负责地球影像、大气辉光与真实晨昏线，**Three.js** 以透明叠加层负责星空、太阳、月亮（后续卫星与轨道也走这一层）。

后端为**全新编写的可读 TypeScript 源码**，不使用原仓库的 `server.jsc` 字节码与 bytenode 加载器。

---

## 目录结构

```
.
├─ web/                     # 前端 Vue 3 + Vite 6 + TS
│  └─ src/views/situation/  # 主场景（3D 地球 + 页面外壳）
├─ api/                     # 后端 Node.js 22 + Express + TS
│  ├─ src/app.ts            # express 实例与中间件
│  ├─ src/config.ts         # 环境变量读取
│  ├─ src/db/pool.ts        # mysql2 连接池（惰性，库不可用不阻塞启动）
│  ├─ src/utils/response.ts # ok(data) / fail(code, msg)
│  ├─ src/routes/cgi.ts     # /cgi 路由
│  └─ src/server.ts         # 入口
├─ deploy/                  # nginx 配置、Dockerfile、docker-compose.yml
└─ README.md
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5、Vite 6、TypeScript、Pinia、Element Plus |
| 3D | Cesium 1.146（地球/大气/光照）、Three.js 0.185（星空/日月/叠加层）、satellite.js 7（GMST） |
| 后端 | Node.js 22 LTS、TypeScript、Express 4、mysql2 |
| 数据库 | MySQL 8（可选） |
| 部署 | Docker Compose：`web`(nginx, 1233) + `api`(1234) + `mysql`(可选) |

---

## 本地开发

要求：Node.js 22+、npm 10+。

### 后端（端口 1234）

```bash
cd api
cp .env.example .env        # 可选；不建库也能启动
npm install
npm run dev                 # tsx watch src/server.ts
```

验证：

```bash
curl http://127.0.0.1:1234/cgi/health
# {"code":0,"msg":"ok","data":{"status":"up","db":"down","time":"..."}}
curl http://127.0.0.1:1234/cgi/config
# {"code":0,"msg":"ok","data":{"staticBase":""}}
```

### 前端（端口 1233）

```bash
cd web
npm install
npm run dev                 # http://127.0.0.1:1233
```

开发服务器已把 `/cgi`、`/uploads` 代理到 `http://127.0.0.1:1234`；后端未启动时接口返回 502 JSON，页面不白屏。

构建：

```bash
cd web
npm run build               # 先 vue-tsc 类型检查，再 vite build
```

---

## Docker 部署（阿里云 Linux 轻量服务器）

### 1. 准备服务器

```bash
# Ubuntu 22.04+ / Debian 12（阿里云轻量应用服务器镜像均可）
sudo apt update && sudo apt install -y git
# 安装 Docker + Compose 插件（官方脚本）
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

> 国内服务器拉取 Docker Hub 镜像可能较慢，可配置阿里云容器镜像加速器（控制台 → 容器镜像服务 → 镜像工具 → 镜像加速器），写入 `/etc/docker/daemon.json` 后 `sudo systemctl restart docker`。
>
> 内存 2GB 的轻量服务器建议先加 2GB swap，Cesium 打包阶段内存占用较高：
>
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

### 2. 拉代码并启动

```bash
git clone <你的仓库地址> openspace-safety
cd openspace-safety/deploy
cp .env.example .env        # 修改端口 / 数据库口令
docker compose up -d --build
```

启动后：

- 页面：`http://<服务器IP>:1233`
- 接口：`http://<服务器IP>:1233/cgi/health`、`http://<服务器IP>:1233/cgi/config`

### 3. 阿里云安全组 / 防火墙

在**轻量应用服务器控制台 → 防火墙**放行：

| 端口 | 用途 |
| --- | --- |
| 1233/tcp | 前端与 `/cgi` 反代（必须） |
| 1234/tcp | 后端直连调试（可选，生产建议关闭） |
| 22/tcp | SSH |

若启用了系统防火墙（ufw/firewalld），同步放行：

```bash
sudo ufw allow 1233/tcp
```

### 4. 可选：启用本地 MySQL

```bash
cd deploy
docker compose --profile mysql up -d --build
```

`api` 会通过 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` 连接；库不可用时服务照常启动，`/cgi/health` 的 `db` 字段为 `down`。

### 5. 常用运维命令

```bash
cd deploy
docker compose ps                 # 状态
docker compose logs -f api        # 后端日志
docker compose logs -f web        # nginx 日志
docker compose up -d --build      # 更新代码后重建
docker compose down               # 停止（保留数据卷）
```

### 6. 子路径部署（可选）

若要把站点挂到 `https://example.com/openspace/`：

```bash
# deploy/.env
VITE_BASE=/openspace/
```

然后 `docker compose up -d --build`，并在外层反向代理中把 `/openspace/` 指向本服务的 1233 端口。

> 注意：Cesium 通过 `window.CESIUM_BASE_URL = BASE_URL + 'cesium/'` 定位 Workers/Assets，已随 `VITE_BASE` 自动适配。

---

## 接口（本部分）

统一响应：`{ "code": 0, "msg": "ok", "data": ... }`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cgi/health` | `data: { status:'up', db:'up'\|'down', time:ISO }` |
| GET | `/cgi/config` | `data: { staticBase }`，取自环境变量 `STATIC_BASE` |

卫星、星座、发射站等接口在后续部分实现；当前前端对缺失接口优雅降级（空状态，不报错、不白屏）。

---

## 已实现 / 未包含

**已实现**

- 星空背景（确定性星表，被地球遮挡）
- 带大气辉光的地球，晨昏线跟随仿真时刻（默认=真实 UTC）
- Three 层绘制的太阳 / 月亮标记，Cesium 自带日月与星空已隐藏
- 初始镜头对准武汉，左键绕地心拖拽、滚轮缩放
- 左上 logo、顶部标题栏、底部播放栏（0.1× / 1× / 10× / 60×）、dock、左下复位
- 右下角只保留 UTC + 北京时间双时区时钟
- 底部 dock 与原系统一致：安全热力图 / AI专家 / 初始化窗口（前两项本期为占位入口）
- 左侧「太空安全目标列表」由左缘浮标拉出，头部标题居中 + 三角收起按钮，空白区域点击穿透画布
- 右侧「星历分析」窗口（与原系统同源迁移）：ITC / OEM / OCM 解析、IndexedDB 持久化、内置 Starlink 样本、交会威胁筛选（Web Worker）与事件列表

**未包含**

- 安全热力图（CRI / CDM / 交会热力）：dock 入口已就位，功能后续接入
- AI 专家对话：dock 入口已就位，功能后续接入
- 星历的三维轨道绘制与威胁事件定位：面板已可解析 / 筛选，`index.vue` 中留有待接入回调
- 星历交会筛选依赖后端在轨目录接口（`/cgi/sat_tle/constellation` 等），本期后端未提供，筛选会给出错误提示但不影响面板其它功能
- 城市过境、区域 / 多区域过境

---

## 环境变量

### api

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `1234` | 监听端口 |
| `DB_HOST` | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `root` | 用户名 |
| `DB_PASSWORD` | 空 | 口令 |
| `DB_NAME` | `openspace` | 库名 |
| `STATIC_BASE` | 空 | 静态资源前缀，`/cgi/config` 返回 |

### web

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_BASE` | `/` | 部署子路径 |
| `VITE_PROXY_TARGET` | `http://127.0.0.1:1234/` | 仅开发代理目标 |

---

## 常见问题

**地球出图但没有影像 / 一直是深色**

Cesium 默认使用 ArcGIS Online 世界影像兜底，需要服务器/浏览器能访问 `services.arcgisonline.com`。若服务器完全离线，请在 `web/src/views/situation/SceneCore.vue` 里调用 `configureEarthBase({ imageryUrl, imageryKind, maximumLevel })` 指向自备离线瓦片包。

**打开页面提示「三维地球底座初始化失败」**

多为 WebGL 不可用（远程桌面、无 GPU 的旧浏览器）或 Cesium 静态资源未就绪。确认 `web/public/cesium/` 已生成（`npm run dev` / `npm run build` 会自动从 `node_modules/cesium` 复制）。

**构建时被 OOM Kill**

轻量服务器内存不足，先按上文增加 swap，或在 `deploy/web.Dockerfile` 调大 `NODE_OPTIONS=--max-old-space-size=4096`。
