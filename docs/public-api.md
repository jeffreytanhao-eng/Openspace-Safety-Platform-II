# 对外公开 API 开发文档（发射简报 v1）

面向外部调用方的开放接口，包含两部分数据：

- **5 日发射简报**：中英双语任务信息、预估发射参数、场址几何拟合初始轨道，以及可直接嵌入的 2D 底图仿真图（SVG）；
- **每日热点资讯**：中英双语标题与摘要、发布日期、媒体名、原文直链。

- 版本：`v1`
- 路径前缀：`/api/v1/open`
- 数据形态：发射为滚动窗口 `now → now + N 天`（UTC）；资讯取最新一期计划的日切快照
- 传输：HTTP/HTTPS + JSON（UTF-8）；地图为 `image/svg+xml`

---

## 1. 接入准备

### 1.1 鉴权

所有请求必须携带 API Key，两种写法等价：

```http
X-API-Key: <your-key>
```

```http
Authorization: Bearer <your-key>
```

Key 由服务方线下分配。服务端以调用方名称做限流（同名 Key 共享配额）。

> `/api/v1/open/hotspots` 额外启用**来源 IP 白名单**：只有白名单内的服务器可调用（经 nginx 转发，按 `X-Forwarded-For` 最后一跳判定），其余返回 `403`。

### 1.2 限流

- 默认 **60 次/分钟/调用方**，Redis 固定窗口；
- 超限返回 `429`，响应头 `Retry-After: 60`；
- 成功响应会带 `X-RateLimit-Limit`（每分钟上限）与 `X-API-Client`（调用方名称）。

### 1.3 错误码

| 状态码 | 含义 | 处理建议 |
|---|---|---|
| `401` | 缺少或无效 API Key | 检查请求头，联系服务方确认 Key 状态 |
| `403` | 来源 IP 不在白名单（仅热点资讯接口） | 由服务方把调用方出口 IP 加入白名单 |
| `404` | `ll2_id` 不存在，或该条缺少生成仿真图所需的场址/倾角/方位参数 | 先查列表接口确认 id；地图 404 时降级为不展示图片 |
| `429` | 超过每分钟配额 | 按 `Retry-After` 退避；列表与地图建议本地缓存 |
| `503` | 对外接口未启用或未配置 Key | 联系服务方 |
| `422` | 参数不合法（如 `window_days` 超出 1–7） | 修正参数 |

### 1.4 缓存建议

| 资源 | 服务端缓存 | 建议客户端缓存 |
|---|---|---|
| 发射列表 | 60 秒 | 30–60 秒；按 `window_days` 分别缓存 |
| 单条详情 | 无（数据量小） | 60 秒 |
| SVG 地图 | 24 小时（参数变化自动失效） | 按 URL 长缓存，图片 URL 稳定可 CDN 化 |
| 热点资讯 | 60 秒 | 5–15 分钟（日切每日更新两次） |

`map.svg` 响应带 `ETag`，可用 `If-None-Match` 走 `304`。

### 1.5 现网入口

| 项目 | 值 |
|---|---|
| Base URL | `http://39.96.81.164:8080` |
| 路径前缀 | `/api/v1/open` |
| Key 分配 | 线下分配（当前调用方名称 `external`，每 Key 60 次/分钟） |
| 在线文档 | `http://39.96.81.164:8080/docs`（仅白名单 IP 可访问，其余 403） |

```bash
curl -s "http://39.96.81.164:8080/api/v1/open/launches?window_days=5" \
  -H "X-API-Key: <your-key>"
```

---

## 2. 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/open/launches` | 窗口内发射列表（默认 5 日） |
| GET | `/api/v1/open/launches/{ll2_id}` | 单条发射详情（不限窗口） |
| GET | `/api/v1/open/launches/{ll2_id}/map.svg` | 2D 底图仿真图（SVG） |
| GET | `/api/v1/open/hotspots` | 每日太空安全热点资讯（双语，IP 白名单） |
| GET | `/api/v1/open/meta` | 枚举字典、窗口语义、免责声明 |

---

## 3. 列表接口

```http
GET /api/v1/open/launches?window_days=5
X-API-Key: <your-key>
```

### 3.1 查询参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `window_days` | int | 否 | 窗口天数，`1–7`，默认取服务端配置（5） |

窗口定义：**滚动区间** `now → now + window_days`，按 `NET`（不早于发射时间）升序返回；同一发射即使出现在多天快照中也只返回一条（取最新快照）。

### 3.2 示例

```bash
curl -s "https://<host>/api/v1/open/launches?window_days=5" \
  -H "X-API-Key: $SSA_API_KEY"
```

```json
{
  "generated_at": "2026-11-19T07:10:00Z",
  "window": {
    "days": 5,
    "basis": "rolling",
    "from": "2026-11-19T07:10:00Z",
    "to": "2026-11-24T07:10:00Z"
  },
  "count": 1,
  "disclaimer": "发射时间、方位角、倾角与初始轨道均为基于公开信息的推算值……",
  "items": [
    {
      "id": "ll2-abc123",
      "name": {
        "en": "Falcon 9 Block 5 | USSF-317",
        "zh": "猎鹰9号 Block 5 | USSF-317"
      },
      "rocket": "Falcon 9 Block 5",
      "launch_service_provider": "SpaceX",
      "summary": {
        "en": "SpaceX launches a classified payload for the US Space Force.",
        "zh": "SpaceX 为美国太空军发射一颗保密载荷。"
      },
      "mission_type": { "en": "Government/Top Secret", "zh": "政府/机密" },
      "net": "2026-11-20T03:15:00Z",
      "window": { "start": "2026-11-20T03:15:00Z", "end": "2026-11-20T05:15:00Z" },
      "status": {
        "value": "Go",
        "code": "go",
        "label": { "en": "Go", "zh": "Go · 待发" },
        "probability": 0.9
      },
      "orbit_type": {
        "value": "SSO",
        "confirmed": true,
        "label": { "en": "Sun-Synchronous Orbit", "zh": "SSO · 太阳同步轨道" }
      },
      "payload": {
        "status": "classified",
        "status_zh": "保密任务",
        "summary": { "en": "Classified payload", "zh": "保密任务，载荷信息未公开" },
        "catalog_state": "CLASSIFIED_OR_WITHHELD",
        "objects": [],
        "truncated": false
      },
      "site": {
        "launch_site": { "en": "Vandenberg Space Force Base", "zh": "范登堡太空军基地" },
        "pad": { "en": "Space Launch Complex 4E", "zh": "4E号发射工位" },
        "country": {
          "code": "USA",
          "name": { "en": "USA", "zh": "美国" }
        },
        "latitude": 34.632,
        "longitude": -120.61
      },
      "estimate": {
        "azimuth_deg": 189.0,
        "azimuth_source": "notam",
        "azimuth_confidence": 0.8,
        "inclination_deg": 97.4,
        "inclination_basis": "sso_target",
        "orbit_family_inferred": "SSO",
        "altitude_km": 500.0,
        "apogee_km": 500.0,
        "confidence": 0.7,
        "notes": ["太阳同步轨道：倾角由轨道高度唯一确定（500 km → 97.40°）"]
      },
      "initial_orbit": {
        "model": "pad-geometry-v1",
        "epoch": "2026-11-20T04:17:00Z",
        "elements": {
          "a_km": 6878.137,
          "ecc": 0.001,
          "inc_deg": 97.4,
          "raan_deg": 214.5321,
          "argp_deg": 0.0,
          "mean_anomaly_deg": 318.2213,
          "n_rev_day": 15.1988,
          "period_min": 94.744,
          "alt_km": 500.0,
          "apogee_km": 506.9,
          "perigee_km": 493.1
        },
        "tle": ["1 99999U 26200A   26324.17847222  .00000000  00000-0  00000-0 0  0000", "2 99999  97.4000 214.5321 0010000   0.0000 318.2213 15.19880000    00"],
        "liftoff_error_km": 0.0,
        "assumptions": {
          "sep_minutes": 62.0,
          "duration_hours": 6.0,
          "ecc": "近圆默认",
          "argp_deg": 0.0,
          "altitude_basis": "orbit_hint"
        },
        "notes": ["场址几何拟合：由发射场纬度 + 方位角 + 倾角反解升交点与近地点幅角"]
      },
      "simulation": {
        "image": {
          "url": "https://<host>/api/v1/open/launches/ll2-abc123/map.svg",
          "width": 2048,
          "height": 1024,
          "format": "svg"
        },
        "layers": ["coastline", "graticule", "track", "pad"]
      },
      "source_url": "https://ll.thespacedevs.com/...",
      "data_source": "ll2"
    }
  ]
}
```

### 3.3 字段口径

| 字段 | 说明 |
|---|---|
| `name` | `en` 为来源原文（"火箭 \| 载荷"），`zh` 为机翻；`zh` 缺失时回退 `en` |
| `summary` | 任务简介；`zh` 为日切预翻译，失败时回退英文（`zh == en`） |
| `orbit_type.confirmed` | **仅当来源站明确给出轨道标签时为 `true`**；缺失/`Unknown` 时 `value="unknown"`、`confirmed=false`。推断出的轨道族只放在 `estimate.orbit_family_inferred`，不冒充确认信息 |
| `payload.status` | 三态：`named`（已编目到具体载荷）、`unknown`（来源未披露）、`classified`（来源标注保密/不公开） |
| `payload.objects` | 仅 `object_type=PAY` 的载荷对象；火箭残骸（R/B）不计入；最多返回 50 个，超限 `truncated=true` |
| `site` | 场站 + 发射台 + 国家，中英双语；经纬度为发射台坐标 |
| `estimate.azimuth_deg` | 发射方位角（度，正北顺时针）；`azimuth_source` 说明来源：`notam`/`navarea`/`prior`/`llm`/`derived_from_inclination`/`unknown` |
| `estimate.inclination_deg` | 轨道倾角；`inclination_basis` 说明依据：`azimuth`/`impact_geometry`/`sso_target`/`prior` |
| `initial_orbit` | **场址几何拟合**参数组（`model=pad-geometry-v1`）：由场址纬度、方位角、倾角、高度档反解 RAAN 与近地点幅角，输出六根数 + TLE；缺失场址/倾角/方位时整块为 `null` |
| `simulation` | 仅当 `initial_orbit` 可生成时返回；`url` 可直接用于 `<img src>` |

> 时间字段统一为 `YYYY-MM-DDTHH:MM:SSZ`（UTC）。

---

## 4. 详情接口

```http
GET /api/v1/open/launches/{ll2_id}
X-API-Key: <your-key>
```

返回单个发射对象，结构与列表 `items[]` 中的元素完全一致；不限窗口（5 日之外的历史/远期条目也可查询，便于分享链接）。

`ll2_id` 不存在 → `404`。

---

## 5. 2D 仿真图接口

```http
GET /api/v1/open/launches/{ll2_id}/map.svg
X-API-Key: <your-key>
```

- `Content-Type: image/svg+xml`
- 尺寸：2048×1024，等距圆柱投影（equirectangular）
- 图层：海岸线底图、30° 经纬网、推算地面轨迹（跨 ±180° 自动断开）、**单个**发射场点
- 不含落区/警告区（NOTAM/NAVAREA）几何与相关数据
- **不包含**观测站/地面站位置点，也**不包含**其他发射场点
- 轨迹自起飞时刻（NET）起笔于发射场，覆盖 6 小时；与 `initial_orbit` 同源（同一组 SGP4/TLE 根数），参数与图天然一致
- 响应头：`ETag`、`Cache-Control: public, max-age=86400`

### 使用示例

```html
<img
  src="https://<host>/api/v1/open/launches/ll2-abc123/map.svg"
  alt="发射轨迹仿真图"
  width="1024"
/>
```

> 浏览器 `<img>` 无法附加自定义请求头，因此图片 URL 建议由服务端在列表响应中给出 `simulation.image.url`；若需自行拼接并携带 Key，请以 `fetch` 获取 SVG 文本后内联渲染。

### 何时返回 404

- `ll2_id` 不存在；
- 该条缺少发射场经纬度，或缺少倾角/方位角，无法做几何拟合。

降级策略：列表里若 `simulation` 为 `null`，直接不展示图片即可。

---

## 6. 每日热点资讯接口

```http
GET /api/v1/open/hotspots?limit=20
X-API-Key: <your-key>
```

- 数据源：本系统**当日最新计划内已展示的热点资讯**（与站内“今日资讯”同源），不另做跨日检索；当日快照尚未生成时返回空列表；
- 口径：仅返回航天相关资讯，范围限定为军事航天（军用/侦察卫星、导弹预警与防御、太空军）、太空政策（预算/法规/军控）、太空态势感知、太空交通管理、在轨安全（碎片、解体、碰撞/交会、再入、在轨异常）、空间对抗（反卫、干扰/欺骗、网络、电子战）、空间天气、火箭发射（发射任务、结果、事故与残骸）；与航天无关的同名内容（产品发布、体育球队等）一律不下发；
- 排序：按 `published_at` 倒序；同事件多源报道合并为一条（保留最新）；
- **旧文剔除**：`published_at` 早于回看窗口的条目直接丢弃；若发布时间被刷新但 URL 内嵌日期（如 `/2025-03-02/`）早于窗口，或比发布时间早 3 天以上（媒体重推旧文），同样丢弃；
- **原文链接（best-effort）**：只返回文章页直链；对只有搜索页/聚合转跳页的条目会尽力提取原文，取不到则整条不下发（不返回二次链接）；
- **条数**：等于当日资讯经三重筛选（相关、去重、过期）后的实际条数，可为 0；不补位、不混入无关内容；
- 每 60 秒服务端缓存，`Cache-Control: max-age=60`。

### 6.1 查询参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `limit` | int | 10 | 返回条数上限，1–20 |

### 6.2 示例

```json
{
  "window_days": 7,
  "plan_date": "2026-11-19",
  "generated_at": "2026-11-19T07:58:09Z",
  "count": 1,
  "items": [
    {
      "id": "0f0c1f0a-6b8e-4a63-9a4a-0d4b1f5b0c11",
      "title": {
        "en": "ESA Awards OHB €102M Contract for ClearSpace-1 Debris Removal Mission",
        "zh": "欧空局授予 OHB 1.02 亿欧元合同开展 ClearSpace-1 碎片清除任务"
      },
      "published_at": "2026-11-19T06:41:35Z",
      "published_date": "2026-11-19",
      "media": {"en": "European Spaceflight", "zh": "European Spaceflight"},
      "summary": {
        "en": "The European Space Agency awarded OHB a contract to build and operate the ClearSpace-1 active debris removal mission.",
        "zh": "欧空局授予 OHB 合同，建造并运营 ClearSpace-1 主动碎片清除任务。"
      },
      "url": "https://europeanspaceflight.com/esa-awards-ohb-contract/"
    }
  ]
}
```

### 6.3 字段口径

| 字段 | 说明 |
|---|---|
| `plan_date` | 所取当日计划的日期（按 Asia/Shanghai 切日） |
| `generated_at` | 该期计划的生成时间（UTC） |
| `window_days` | 过期判定使用的回看窗口（天） |
| `title.en/zh` | 标题原文与中文机翻；中文缺失时回退原文 |
| `published_at` | 原文发布时间（UTC，ISO 8601） |
| `published_date` | 按 Asia/Shanghai 切日的发布日期，便于直接展示 |
| `media.en/zh` | 媒体名：英文源保留品牌原名，中文源补英文品牌（如 新浪科技 → Sina Tech） |
| `summary.en/zh` | 摘要原文与中文机翻；中文缺失时回退原文 |
| `url` | 原文直链，不含搜索/聚合跳转 |

---

## 7. 元数据接口

```http
GET /api/v1/open/meta
X-API-Key: <your-key>
```

返回：窗口语义、`payload.status` 中文映射、`orbit_type.value` 枚举、`azimuth_source` / `inclination_basis` 枚举、`initial_orbit_model`、免责声明。建议客户端启动时拉取一次并缓存。

---

## 8. 参数与推算说明（重要）

### 8.1 太阳同步轨道（SSO）倾角

SSO 的倾角由轨道高度唯一确定，接口**不采用方位角反推值**，而是按高度档反解：

| 高度 | 倾角（约） |
|---|---|
| 400 km | 97.0° |
| 500 km | 97.4° |
| 600 km | 97.8° |
| 800 km | 98.6° |

此时 `estimate.inclination_basis = "sso_target"`，并在 `notes` 中写明所用高度。

### 8.2 方位角

优先级：NOTAM/NAVAREA 警告几何 > 历史先验 > 由倾角与场址纬度反解（`derived_from_inclination`）。

### 8.3 初始轨道

`initial_orbit.elements` 为历元时刻（默认 NET + 分离时间）的瞬时根数，`assumptions` 明确写出：

- `sep_minutes`：分离时间（LEO/SSO 默认 62 分钟，GTO 26，GEO 25）；
- `duration_hours`：仿真时长（6 小时）；
- `ecc` / `argp_deg`：近圆默认假设；
- `altitude_basis`：`orbit_hint`（来源/警告几何给出高度候选）或 `family_default`（按轨道族默认高度档，未知族按 LEO 500 km），后者会在 `notes` 中注明。

`a_km` 为半长轴（含地球半径），`alt_km/apogee_km/perigee_km` 为相对地表高度。

### 8.4 免责声明

所有时间、方位角、倾角、初始轨道均为**基于公开信息的推算值**，不代表官方数据。响应中的 `disclaimer` 与每条记录的 `confidence` 字段请原样展示或保留。

---

## 9. 服务端启用步骤（运维）

1. 在 `.env` 配置：

```dotenv
PUBLIC_API_KEYS=acme:xxxxxxxx,partner:yyyyyyyy
PUBLIC_API_BASE_URL=https://ssa.example.com
PUBLIC_API_RATE_LIMIT_PER_MIN=60
PUBLIC_API_WINDOW_DAYS=5
# 热点资讯：回看窗口天数（1-14）与来源 IP 白名单（逗号分隔，留空=不限制）
PUBLIC_NEWS_WINDOW_DAYS=7
PUBLIC_NEWS_IP_ALLOWLIST=123.57.41.32,127.0.0.1
```

2. 重启 API 容器：

```bash
docker compose up -d api
```

3. 自检：

```bash
curl -s http://127.0.0.1:8001/api/v1/open/meta -H "X-API-Key: xxxxxxxx"
```

> `PUBLIC_API_KEYS` 留空时，所有 `/api/v1/open/*` 返回 `503`，不会暴露数据。

---

## 10. 变更与兼容

- 新增字段视为向后兼容；
- 字段删除/重命名、枚举值语义变化会升级路径版本（`/api/v2/open/...`）；
- `orbit_type.value` 在来源标签未收录时会直接返回原始标签字符串，请按字符串处理，不要硬编码穷举。
