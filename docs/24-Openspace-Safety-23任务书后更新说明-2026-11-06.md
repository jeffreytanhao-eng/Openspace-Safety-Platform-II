# Openspace Safety · 《23》任务书后完成更新说明

| 项 | 内容 |
|---|---|
| **文档编号** | 24 |
| **对应任务书** | `docs/23-Openspace-Safety-修复计划书-给TRAE-2026-11-06.md`（v1.2，2026-11-06） |
| **覆盖范围** | 2026-11-06 收到《23》之后完成的全部代码、数据与部署变更（含任务书内 R2-12～R2-20，及任务书之外按现场反馈追加的改动） |
| **代码版本** | `ae3da7c`（功能实现）· `69de156`（文档补充）· 均已推送 `origin/main` |
| **线上状态** | 2026-11-06 已部署至 `123.57.41.32`（`/opt/openspace`，systemd `openspace-api`），健康检查与三账号登录通过 |
| **约束遵循** | 只改本仓库；密钥仅存 `.env`；未推倒星历/态势内核；`/ai` 入口与路由保留；本轮不接入 AOE；未对接第三方商业 SSA；UI 与文档未出现第三方商业产品名；署名仅「谭谈」 |

---

## 1. 交付总览

| 分类 | 条目 | 来源 | 状态 |
|---|---|---|---|
| 任务书内 | R2-12 极区影像补齐 | 《23》 | 已完成 |
| 任务书内 | R2-13 交会目标型号解析 | 《23》 | 已完成 |
| 任务书内 | R2-14 设定口径补强 | 《23》 | 已完成 |
| 任务书内 | R2-15 交会事件卡位置/高度/标签 | 《23》 | 已完成 |
| 任务书内 | R2-16 交会详情 · 相对运动 | 《23》 | 已完成 |
| 任务书内 | R2-17 `/ai` 操作事件流 | 《23》 | 已完成 |
| 任务书内 | R2-18 交会详情 · 风险演变 | 《23》 | 已完成 |
| 任务书内 | R2-19 机动再筛查前后对比 | 《23》 | 已完成 |
| 任务书内 | R2-20 目标档案信息架构 | 《23》 | 已完成 |
| 任务书外 | 参数档案：用户自有 2 组参数、目标级自定义参数 | 现场确认 | 已完成 |
| 任务书外 | 认领审核状态机 + 超管审核页 | 现场确认 | 已完成 |
| 任务书外 | 星历归属与可见性（public/private） | 现场确认 | 已完成 |
| 任务书外 | 超管「平台级只读」视图 | 现场确认 | 已完成 |
| 任务书外 | 登录页去「组织」化文案 | 现场确认 | 已完成 |
| 任务书外 | 操作事件流侧栏文案与交会放大视觉微调 | 现场确认 | 已完成 |
| 任务书外 | 站点图标（盾牌 + 地球）多尺寸 favicon | 现场确认 | 已完成 |

---

## 2. 任务书内条目（R2-12～R2-20）

### 2.1 R2-12 极区影像补齐

**问题**：底图为 Web Mercator 影像（覆盖止于约 ±85°），极区露出底层亮蓝球面，形成南北极对称淡蓝圆盘。

**实现**：
- `web/src/views/situation/cesiumEarth.ts`：新增极区补丁图层，`SingleTileImageryProvider` + `Rectangle` 覆盖 ±84° 以上，与在线影像保留约 1° 重叠；影像不可用时才加载离线底图，正常联网不再垫亮蓝底图。
- 补丁由本地静态图提供：`web/public/tiles/polar/north.png`（暗青蓝，按在线影像实采色调）、`south.png`（冰盖白），避免与底图产生突兀色差。
- 兼容性处理：Cesium 1.146 的 `SingleTileImageryProvider` 必须显式传 `tileWidth/tileHeight`，否则图层静默不挂载；可用性探测改为图片解码（并发初始化时 `HEAD` 会被浏览器中止）。

**验收**：补丁文件均返回 200；态势页南北极点淡蓝圆盘消失（补丁与在线影像存在轻微色调差，属数据源差异）。

### 2.2 R2-13 交会目标型号解析

**实现**：
- `web/src/views/situation/catalogCloudThree.ts`：新增 `resolveCatalogModelKey(name, norad, objectType)`，交会对象按编目 `object_type` 选择型号模型，碎片/火箭残骸不再统一显示为卫星。
- `web/src/views/situation/eventCloudThree.ts`：建立编目元数据查询与类型标签映射。
- `web/src/views/situation/SceneCore.vue`：标签宽度与 A/B 两侧排布调整，避免长名称互相遮挡。

**验收**：交会放大态 A/B 双方按真实类型渲染模型，标签显示类型。

### 2.3 R2-14 设定口径补强

**实现**：
- `web/src/views/screens/index.vue`：进入筛查页时读取本组织交会默认值（`GET /cgi/ca/defaults`），预填时间窗与 HBR；未登录或无组织时回退系统建议值。
- 文案明确「组织级默认仅本组织生效，不影响其他组织」。
- 目标档案注明：质量、迎风面积等档案字段不参与 Pc、筛查 HBR 与 3D 尺寸计算。

**验收**：组织默认值预填正确；跨组织互不影响（沿用《23》§0.1 的隔离结论）。

### 2.4 R2-15 交会事件卡补充位置与高度

**实现**：
- `web/src/views/situation/eventCloudThree.ts`：新增 `eciToGeodetic()`（GMST → ECEF → WGS84 迭代反算），事件项附带 `latDeg / lonDeg / altKm`。
- `web/src/views/conjunctions/index.vue`：事件卡在相对速度之后增加「交会位置」「交会高度」。
- 交会放大态双方模型增设最小显示间距 0.008 场景单位（约 51 km，仅视觉分离，不参与任何计算，真实脱靶量仍以数值为准）；标签改为三行：名称 / NORAD ID / 类型。

**验收**：事件卡显示经纬度与高度；放大态标签三行、双方模型不重叠。

### 2.5 R2-16 交会详情 · 相对运动

**实现**：
- `api/src/routes/events.ts`：新增 `GET /cgi/events/:key/relative-motion?minutes=30&stepS=30`（需登录）。复用 `sat_tle` + SGP4，按主星 UVW 基投影，返回 `dR / dI / dC / dist` 时间序列；缺 TLE → 404，根数不可解析 → 422。
- `web/src/api/events.ts`：新增 `getRelativeMotion()`。
- `web/src/components/EChart.vue`：ECharts 按需引入（Line/Scatter、Grid/Tooltip/Legend/MarkLine、Canvas），随 `web/dist` 打包，运行时不请求外网。
- `web/src/views/conjunctions/Detail.vue`：新增「相对运动（TCA 附近）」面板——距离-时间四线（总距离 / R / I / C，含 TCA 标线）与 R–I、C–I 双平面图。

**验收**：三张图 canvas 均有绘制内容，无控制台报错；坐标基与筛查结果 `miss_r/t/n` 同源。

### 2.6 R2-17 `/ai` 操作事件流

**实现**：
- `web/src/views/ai/index.vue`：由占位页改为规则聚合的操作事件流。数据源为交会事件（按 TCA）+ 筛查任务（发起/完成/失败/取消），统一按时间倒序。
- 交互：24h / 3d / 7d / 全部时间窗；全部/红/橙/黄级别筛选（带计数）；点击跳转交会详情或筛查页。
- 定位明确为「规则聚合，非模型推断」，不输出无法由 TLE/CDM 证实的结论；路由 `/ai` 与侧栏入口保留。
- 侧栏与页面副标题同步更名：`AI` → `操作事件流`，副标题「规则聚合，非模型推断」。

**验收**：本地实测 34 条事件流，筛选与跳转正常。

### 2.7 R2-18 交会详情 · 风险演变

**实现**：
- `web/src/views/conjunctions/Detail.vue`：新增「风险演变」面板。CDM 报文按 `creation_date` 的 Pc 折线、本平台重算按 `created_at` 的 Pc 散点、CDM 脱靶距离虚线；左轴对数 Pc，右轴 km。
- 仅复用已有 `cdms` 与重算记录，不改接口。

**验收**：风险演变图正常绘制（实测 1 图）。

### 2.8 R2-19 机动再筛查前后对比

**实现**：
- `web/src/views/objects/index.vue`：再筛查结果面板新增前后对比块。
  - 前：来源交会事件（可点击）+ 事件级别。
  - 后：本次 `summary` 的事件数、最高等级、最大 Pc。
- 新增 i18n：`mv.before / mv.after / mv.noSourceEvent`。

**验收**：本地无机动候选数据，未做端到端实测（逻辑复用已有 `rescreen` 接口）。

### 2.9 R2-20 目标档案信息架构

`web/src/views/objects/index.vue` 右侧详情抽屉按六个分区重排，只聚合已有字段，不新造物理量：

1. **身份**：名称 / NORAD / 类型 / 国际标识 / 轨道域 / 倾角 / 远地点 / 近地点 / 历元。
2. **本组织档案**：认领类型（关注 / 业主认领）、名称与档案参数（质量、迎风面积、推进、接受 Pc、接受交会距离）。
3. **近期交会（7 天）**：本目标作为主/次星的事件，按 TCA 倒序，带区间最坏等级。
4. **星历与机动**：已上传星历计数、已绑定星历与绑定/解绑、含 MAN 段的星历摘要。
5. **CDM 摘要**：近期报文数量、最新报文时间、最高 Pc（仅本组织可见范围）。
6. **机动候选**：候选列表、新建与再筛查入口。

配套：
- `api/src/routes/objects.ts`：对象详情 `sat` 增加只读字段 `intl_desig`（国际标识）。
- 顺带修正对象详情远/近地点反算：`rec.no` 为 rad/min，统一换算为 rad/s 后再求半长轴，与筛查模块同口径（此前 ISS 会显示约 24.8 万 km 的错误高度）。

**验收**：六分区齐全，空分区显示「暂无 / 无」；ISS 身份区显示 NORAD 25544、1998-067A、远/近地点约 424.5 / 414.7 km。

---

## 3. 任务书之外的追加更新

### 3.1 参数档案：用户自有 2 组参数与目标级自定义参数

- **新表 `ca_user_params`**：主键 `(user_id, slot)`，`slot ∈ {1,2}`，存完整参数集；用户之间、组织之间互不可见。
- **新表 `object_ca_params`**：主键 `object_id`，含 `org_id / params_json / updated_by / updated_at`；仅授权认领且审核通过的业主可写，只影响本组织对该目标的使用，不影响其他组织的关注或检索。
- `api/src/db/caDb.ts`：新增 `getObjectCaParams / saveObjectCaParams / deleteObjectCaParams`。
- `api/src/routes/ca.ts`：
  - `GET /cgi/ca/profiles`：组织默认 + 系统建议 + 本人两组；
  - `PUT /cgi/ca/profiles/:slot`、`DELETE /cgi/ca/profiles/:slot`。
- `api/src/routes/objects.ts`：`GET /cgi/objects/:id` 返回本组织可见的 `ca_params`；`PATCH /cgi/objects/:id` 支持 `params` 补丁；`DELETE` 时连带清理目标级参数。
- `web/src/views/settings/index.vue`：新增「我的自定义参数」两张参数卡（编辑/保存/恢复默认）。
- `web/src/views/objects/index.vue`：业主认领通过后展示「自定义参数（业主）」分区与「保存自定义参数」按钮。

### 3.2 认领审核状态机与超管审核页

- `objects` 表新增 `requested_by_user_id / reviewed_by / reviewed_at / review_note`；`claim_status = pending | claimed | rejected`。
- 生成列 `owner_norad` 仅在 `claim_type='owner' AND claim_status='claimed'` 时取值，`uk_owner_norad` 保证**全局唯一已生效业主**。
- 业主认领仅限 `plan=vip && status=active` 的组织；提交后进入 `pending`；同组织重复提交 409；被驳回可重新提交；审核通过前维护参数/星历返回 403。
- `api/src/routes/admin.ts`：
  - `GET /cgi/admin/object-claims`
  - `POST /cgi/admin/object-claims/:id/approve`
  - `POST /cgi/admin/object-claims/:id/reject`
  - 均需超管权限，写审计日志；通过时自动驳回同 NORAD 其他待审申请。
- `web/src/views/admin/Claims.vue` + 路由 `/admin/claims` + 侧栏「认领审核」：按状态筛选、通过/驳回（驳回需填原因）。
- 目标页档案标题显示「认领待审核」徽标，提交后回执提示。

### 3.3 星历归属与可见性

- `ephemeris` 表新增 `uploaded_by / owner_user_id / owner_org_id / visibility`（含 `idx_eph_owner`、`idx_eph_visibility`）。
- 上传 `POST /cgi/ephemerides/upload` 改为需登录：
  - 超管：任意目标，默认 `public`；
  - VIP 组织成员：仅本组织已认领（claimed）目标，默认 `private`；
  - 其余：401 / 403。
- 可见性过滤统一在列表、`/ephemerides/file`、`/ephemerides/meta/:id` 三处实现：`public` 全平台只读，`private` 仅上传者本人与超管；匿名仅见 `public`。
- 新增 `PATCH /cgi/ephemerides/:id`（改可见性）、`DELETE /cgi/ephemerides/:id`（删元数据 + 磁盘文件），权限为上传者本人或超管。
- 星历页：上传可选「全平台可见 / 仅自己可见」；预览区显示可见性徽标、切换与删除；列表标注「仅自己可见」。

### 3.4 超管「平台级只读」视图

超管 `platform_super_admin` 无组织结构，此前访问业务页被「需要组织账号」拦截。现改为全平台只读：

- `api/src/routes/overview.ts`：移除 403；目标数为全平台 `objects` 总数，今日筛查次数为全平台口径（`countScreensToday(null)`）。
- `api/src/routes/objects.ts`：`GET /objects` 返回全平台已生效目标（附 `org_name`）；`GET /objects/:id` 可读任意组织目标；写操作仍要求组织账号。
- `api/src/routes/screens.ts`：`GET /screens`、`GET /screens/:id` 跨组织只读；发起/取消仍要求组织账号。
- `api/src/routes/maneuvers.ts`：平台账号可只读查看任意组织目标的机动候选。
- `api/src/routes/ca.ts`：`GET /ca/defaults` 返回系统建议（`platform: true`）；`/ca/profiles` 以系统默认值为基线，个人两组参数照常可用。
- `api/src/routes/events.ts`：`GET /events/:key/recompute` 平台账号返回空 runs（重算记录按组织隔离）。
- 前端：
  - 目标页新增「所属组织」列与「平台账号 · 全平台只读视图」标记，隐藏认领/释放/新建机动；
  - 筛查页禁用发起按钮并隐藏取消；
  - 设置页隐藏「数据凭证」「日报与通知」，默认参数只读展示。

### 3.5 登录页去「组织」化

- `web/src/i18n/messages.ts`：
  - 中文：`ACCOUNT CONSOLE`；`注册` 替代「注册组织」；`用户名`（占位「如：zhangsan」）；「没有账号？注册」。
  - 英文：`Sign up` / `Username` / `No account? Sign up`。
- `web/src/views/login/index.vue`：注册用户名输入框改为 `name="username" autocomplete="username"`。注册流程仍按「用户 + 组织」一体创建，仅前端文案不再出现「组织」。

### 3.6 站点图标

- 基于原 64×64 图标，在左下角合成蓝色渐变盾牌（白色光晕 + 深蓝描边），盾牌中央内嵌地球图案（白色实心球 + 蓝色赤道线与经线）。
- 1024 超采样绘制后按尺寸降采样，兼顾 16/32px 可辨识度。
- 输出：`web/public/favicon.ico`（16/32/48/64/128/256）、`favicon-32.png`、`apple-touch-icon.png`（180）。
- `web/index.html` 增加三条 `link rel="icon"` / `apple-touch-icon` 声明。

---

## 4. 数据与接口变更清单

### 4.1 数据表 / 字段

| 对象 | 变更 |
|---|---|
| `ca_user_params` | 新建：`user_id + slot` 主键，`params_json` |
| `object_ca_params` | 新建：`object_id` 主键，`org_id / params_json / updated_by` |
| `objects` | 新增 `requested_by_user_id / reviewed_by / reviewed_at / review_note`；新增生成列 `owner_norad` + 唯一键 `uk_owner_norad`；唯一键调整为 `uk_org_norad (org_id, norad_id)` |
| `ephemeris` | 新增 `uploaded_by / owner_user_id / owner_org_id / visibility` 及两个索引 |
| `conjunction_pc_runs` | 沿用（既有表，无结构变更） |

### 4.2 新增/调整接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cgi/events/:key/relative-motion` | TCA 附近相对运动序列（UVW） |
| GET | `/cgi/ca/profiles` | 组织默认 + 系统建议 + 本人两组 |
| PUT / DELETE | `/cgi/ca/profiles/:slot` | 维护本人第 1/2 组参数 |
| PATCH | `/cgi/objects/:id` | 支持 `params` 补丁（业主） |
| GET | `/cgi/admin/object-claims` | 认领申请列表 |
| POST | `/cgi/admin/object-claims/:id/approve` | 审核通过 |
| POST | `/cgi/admin/object-claims/:id/reject` | 审核驳回 |
| PATCH / DELETE | `/cgi/ephemerides/:id` | 改可见性 / 删除星历 |
| GET | `/cgi/objects`、`/cgi/screens`、`/cgi/ca/defaults` 等 | 超管平台级只读口径调整 |

---

## 5. 验证记录

| 项 | 结果 |
|---|---|
| `web` 类型检查 | `npx vue-tsc -b` 通过 |
| `web` 构建 | `npm run build` 通过（exit 0），产物含新图标与极区补丁 |
| `api` 类型检查 | 仅剩既有 `src/services/constellationSnapshot.ts` 类型错误；`noEmitOnError=false` 下 `dist` 正常产出 |
| 浏览器实测 | `/ai` 事件流、交会详情（风险演变 + 相对运动 3 图）、目标档案六分区、设置页两组参数卡、筛查页参数来源、`/admin/claims` 审核列表均正常 |
| API 冒烟 | `/ca/profiles` 两槽读写删正常；匿名星历仅见 public、匿名上传 401；业主认领 pending → 超管 approve → claimed |
| 未覆盖 | 极区补丁人工视觉复核（补丁已修复，需大屏确认）；机动前后对比（本地无候选数据）；业主上传星历端到端（需人工执行一次） |

---

## 6. 部署记录（2026-11-06）

- **推送**：`ae3da7c`（功能）与 `69de156`（文档）已推送至 `origin/main`。
- **部署方式**：本地 `api` 构建 + `web` 构建 → 打包 `api`（排除 `node_modules`、`.env`、`data`）与 `web/dist` → 上传 `/opt/backup/` → 解压覆盖 → `npm ci` → `systemctl restart openspace-api`。
- **部署前备份**：
  - `/opt/backup/api-dist-before-20261106-140326`
  - `/opt/backup/web-dist-before-20261106-140326`
  - 全量回退锚点仍为 `/opt/backup/snapshot-20261105-pre/`
- **线上校验**：
  - `openspace-api` active；`/cgi/health`：`status=up, db=up`；首页 200；`/favicon.ico` 200（126,551 字节）。
  - 惰性表 `ca_user_params`、`object_ca_params` 已由首访问自动创建；`ephemeris` 归属字段已自动补齐。
  - 超管接口 200：总览（全平台目标 242）、`/cgi/objects` 跨组织列表、`/cgi/screens`、`/cgi/ca/profiles`、`/cgi/ca/defaults`。
  - 组织账号（星网）接口 200：总览、目标、星历、参数档案。
- **账号保持**：`users=5`、`organizations=4`，id/email/组织映射与部署前完全一致；启动日志无密码重置记录；`xingwang` / `gaoxiao` / `admin` 以原口令 `a1234` 登录均返回 200。

---

## 7. 边界与说明

- 本轮未接入 AOE（`AOE_TOKEN` 未配置，日更任务按预期 skipped）。
- 未修改星历/态势内核，未引入外部商业数据源或第三方商业 SSA 名称。
- 认领审核当前仅支持业主（owner）认领需审核；普通「关注」仍即时生效。
- 目标档案中的质量/迎风面积不参与 Pc、HBR 与 3D 尺寸计算，属档案信息字段。
- 机动再筛查前后对比、业主上传星历端到端链路尚未自动化实测，建议后续人工复验。
