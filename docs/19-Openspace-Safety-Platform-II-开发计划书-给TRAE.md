# 19 · Openspace-Safety-Platform-II 开发计划书（给 TRAE）

> **给谁**：TRAE 直接按 Epic/Story 执行。  
> **仓库**：`jeffreytanhao-eng/Openspace-Safety-Platform-II`（正式生产站，非竞赛稿）  
> **现网**：http://123.57.41.32/  
> **设计依据**：功能设计建议页（数据双轨、多 Pc、参数重算、分级、超管）  
> **对标**：https://docs.space-safety.starlink.com/docs/  
> **版本**：v1.0 · 2026-11-03（Asia/Shanghai）  
> **约束（必读）**：
> 1. **只改本仓库**；后端是可读 TypeScript（`api/`），**没有** `server.jsc`，不要引入 bytenode。
> 2. **不要做侧栏 AI**；总览去掉 mock AI 区；假 KPI 必须换成真数或灰显「即将开放」。
> 3. **星历 / 态势已有能力只补强不推倒**（OCM/ITC、MAN 琥珀加粗+地影遮挡、跟踪相机在地心–目标延长线、关联至态势深链等）。
> 4. 密钥进环境变量 / 本地 `.env`，**禁止提交** Space-Track / AOE 口令；客户凭证服务端加密存储。
> 5. 开源 Pc（SatGuard/ASTRA 系）须在 UI 标注「作业辅助，非认证 CARA」；官方 CDM Pc 单独一列保留。
> 6. 改完每个 Epic 写简短验证说明进 `docs/` 或 PR 描述；`git status` 避开并行冲突文件。
> 7. 水印/署名仅「谭谈」；**不要**出现「佳男」。

---

## 0. 现状基线（TRAE 接手时认准）

| 模块 | 状态 | 主要路径 |
|------|------|----------|
| 星历 | 强：DB 入库 OCM/ITC、预览、关联态势 | `api/src/ephem/*`、`web/src/views/ephemerides` |
| 态势 | 强：编目云、轨道、跟踪/MAN UX | `web/src/views/situation/*` |
| 总览 | 弱：Stage-1 mock | `web/src/views/overview` |
| 交会 | 弱：壳/mock | `web/src/views/conjunctions` |
| 托管目标 | 入口在，缺归属与档案 | `web/src/views/objects` |
| 登录/组织 | 弱 | `web/src/views/login`、待建 org 表 |
| 超管 | 无 | 待建 `/admin` |
| 数据源日更 | 部分 TLE/CDM 表存在，缺双轨产品化 | `api/src/routes/satTle.ts`、`catalog.ts` |

技术栈锁定：Vue3 + Vite + TS + Pinia + Element Plus；Cesium + Three；Express + mysql2；部署 Docker/阿里云。

响应约定保持：`{ code:0, msg:'ok', data }`。

---

## 1. 产品北极星（实现时对齐）

数据模型：`Operator(组织) → Object(托管目标) → Trajectory(星历) → Event(交会) → CDM`。

作业链：认领目标 → 上传/拉取轨迹 → 筛查 → 多算法 Pc → 可配置重算 → 分级（non_critical / observe / critical）→ 报告。

侧栏建议：总览 | 托管目标 | 星历 | 交会事件 | 筛查 | 态势 | 报告 | 文档/API | 设置；**超管独立** `/admin`。可砍独立「轨道」「AI」页。

---

## 2. 里程碑总览

| 阶段 | 目标 | 建议顺序 |
|------|------|----------|
| **P0** | 组织/账号、系统日更骨架、客户凭证位、真总览、Object 认领、超管最小可用 | 先做完再 P1 |
| **P1** | 筛查闭环、交会列表/详情、CDM、多 Pc、参数重算、态势黄橙红事件云+弹窗、交会↔态势深链、星历版本归档 | |
| **P2** | 档位计量与 override、系统池按档分发、精度对比报告、通知、ASTRA 积分/MC（VIP） | |
| **P3** | 机动候选+再筛查、计费对接、多 SSA | 可后置 |

**本期 TRAE 优先交付：P0 全部 + P1 主干（筛查/事件/多 Pc/参数重算）。** P2/P3 在本文留接口与表结构，可分期 PR。

---

## 3. Epic 与 Story（可直接拆任务）

### Epic A · 组织、认证与档位底座（P0）

#### A1 组织与用户表

| 项 | 内容 |
|---|---|
| **做什么** | MySQL：`organizations`（id, name, plan enum free/normal/vip, status active/suspended/closed, trial_ends_at, notes）、`users`（org_id, email, role org_admin/org_member, password_hash）、`sessions` 或 JWT。 |
| **改哪些** | `api/sql/` 新 migration；`api/src/db/`；`api/src/routes/auth.ts`（新建）；`.env.example` 增 `JWT_SECRET` 等。 |
| **验收** | 可注册/登录（或超管开通后邀请登录）；未登录访问受保护 API 返回 401；`/cgi/health` 仍可用。 |

#### A2 档位默认与 effective_limit

| 项 | 内容 |
|---|---|
| **做什么** | `plan_defaults`（feature_key → limit）；中间件 `requirePlan` / `checkQuota(feature)`；超限返回明确 `code` + 升级文案。 |
| **功能键建议** | `objects_max`, `ephem_upload_day`, `screen_day`, `recompute_day`, `system_tle_scope`, `system_cdm_days`, `pc_methods`, `api_keys_max`, `members_max`。 |
| **验收** | 免费档创建第 4 个托管目标被拒；日志可查。 |

#### A3 前端登录与壳

| 项 | 内容 |
|---|---|
| **做什么** | 完善 `web/src/views/login`；AppShell 显示组织名/档位；去掉侧栏孤立「登录」若已有顶部账号。 |
| **验收** | 登录后进总览；登出清 token。 |

---

### Epic B · 超级管理员最小可用（P0）

#### B1 `/admin` 路由与鉴权

| 项 | 内容 |
|---|---|
| **做什么** | 平台角色 `platform_super_admin` / `platform_ops`（可先只实现 super_admin）；前端独立布局，**不进客户侧栏**。 |
| **页面** | 客户列表、组织详情（升降级/关停/恢复）、开通向导、审计只读列表。 |
| **改哪些** | `web/src/views/admin/*`（新建）、`api/src/routes/admin.ts`、`admin_audit_logs` 表。 |
| **验收** | 超管可开通 org+首个管理员+初始 plan；关停后客户登录见提示；每次写操作有 audit（actor, org, action, before, after）。 |
| **刻意不做（P0）** | 完整 override UI（放 P2）；计费系统。 |

---

### Epic C · 数据源双轨与日更（P0 骨架 → P1 完善）

#### C1 系统账号日更任务

| 项 | 内容 |
|---|---|
| **做什么** | 服务端 cron/定时：每日 1 次拉取 **TLE(GP)**、**CDM**、**AOE**（AOE 按现有太空地图类 API：channel KY/INTERNATIONAL，格式 TLE/JSON/OMMXML）。写入版本化表：epoch、source=`system_pool`、batch_id、content_hash；**不覆盖历史**。 |
| **改哪些** | `api/src/services/ingestSpaceTrack.ts`、`ingestAoe.ts`、`jobs/dailyFetch.ts`；复用/扩展 `sat_tle` / `sat_cdm`；新建 `sat_aoe` 或统一 `orbital_snapshots`。 |
| **配置** | `.env`：`SPACETRACK_USER/PASS`、`AOE_TOKEN`、`DAILY_FETCH_CRON`。 |
| **验收** | 手动触发 job 成功；`/cgi/catalog/stats` 或新 health 字段显示上次成功时间；失败有日志与退避。 |

#### C2 客户自配凭证

| 项 | 内容 |
|---|---|
| **做什么** | 设置页「数据凭证」：Space-Track、AOE；连通性探测；拉取走组织队列，**不得**写入 system_pool。 |
| **表** | `org_credentials`（org_id, provider, ciphertext, last_ok_at, last_error）。 |
| **验收** | 客户 A 的密钥拉数只进 A 的可见范围；审计记条数。 |

#### C3 按档位裁剪系统池

| 项 | 内容 |
|---|---|
| **免费** | 公共小子集 / 样例窗 |
| **普通** | 托管 NORAD 相关 TLE + 有限天 CDM |
| **VIP** | 更大编目、更深历史、优先队列 |
| **验收** | 同 API 不同 plan 返回条数不同；响应带 `data_source: system_pool|org_credential`。 |

---

### Epic D · 托管目标与真总览（P0）

#### D1 Object 认领与档案

| 项 | 内容 |
|---|---|
| **做什么** | `objects`：norad_id、name、org_id、mass_kg、cross_section_m2、propulsion、accepted_pc、accepted_miss_km、claim_status。星历上传/关联必须挂 object_id。 |
| **改哪些** | `web/src/views/objects`、`api/src/routes/objects.ts`；星历绑定校验。 |
| **验收** | 认领后总览资产计数真；NORAD 冲突提示；无绑定拒绝 definitive 共享筛查（可先 warn）。 |

#### D2 总览驾驶舱去 mock

| 项 | 内容 |
|---|---|
| **做什么** | `overview`：组织 profile、资产清单、关注事件（可先空表）、数据源健康（系统日更 + 客户凭证状态）。**删除 AI 区块**。 |
| **验收** | 无假随机 KPI；无数据时灰显「即将开放」而非假曲线。 |

---

### Epic E · 筛查、交会事件与多 Pc（P1）

#### E1 筛查任务

| 项 | 内容 |
|---|---|
| **做什么** | 异步 job：主星（托管+星历或 TLE）vs 编目/副星；阈值距离预筛 → TCA 精炼；结果写入 `conjunction_events`。 |
| **参考** | SatGuard 流程（SGP4/星历传播 → screen → Pc）；可先 Node 移植 Foster/Chan/Alfano，或 sidecar Python 调 `satguard`/`astra-core-engine`（选一种写清依赖，优先可维护）。 |
| **验收** | 对已知近旁对能出 miss/TCA；任务状态 queued/running/done/failed。 |

#### E2 CDM 入站与交会事件列表/详情

| 项 | 内容 |
|---|---|
| **做什么** | 系统/客户 CDM 解析（XML/KVN）；同一主副星+近 TCA 聚合成 Event 时间线；官方 Pc 字段原样保留。 |
| **UI · 列表** | `web/src/views/conjunctions`：时间、主/副目标、危险等级（黄/橙/红）、Pc、脱靶、状态；可按等级与时间窗筛选。 |
| **UI · 详情** | 双方档案摘要、CDM 时间线、多 Pc 比对、参数重算；**详情下方固定「打开态势可视化」**（交互对齐星历页「关联至态势」：进态势、定位 TCA、高亮对应事件云并可自动打开弹窗）。 |
| **验收** | 导入或日更 CDM 后列表可见；详情有官方 Pc 列；点「打开态势可视化」行为与星历→态势深链同级稳定。 |

#### E3 多算法 Pc 比对

| 项 | 内容 |
|---|---|
| **方法** | 默认：Foster、Chan、Alfano 界、官方 CDM Pc。VIP/重算：2D 积分、蒙特卡洛（ASTRA 系，标耗时与配额）。 |
| **UI** | 表：方法 \| Pc \| miss \| TCA \| HBR \| 协方差来源 \| 耗时；一致性灯（同量级绿 / 差一个数量级黄 / 缺协方差或冲突红）。 |
| **验收** | 同源输入至少 3 个方法+官方列；无协方差时禁用需协方差的方法并提示。 |

#### E4 态势交会危险云（黄 / 橙 / 红）

| 项 | 内容 |
|---|---|
| **做什么** | 在现有编目+星历之上叠加**事件云**图层：按交会/碰撞危险性着色——**黄**（关注/较低危）、**橙**（警告）、**红**（高危）。云锚在 TCA 附近相对几何中心（或主星位置）；尺度可随脱靶/不确定度微调。 |
| **点击** | 点云 → 事件弹窗：双方目标（名称/NORAD）、TCA、脱靶、代表 Pc、危险等级、数据来源（筛查/CDM）；按钮「查看详情」进交会详情页。 |
| **图层** | 可开关「事件云」；「复核交会」作业模式默认打开并提高点选优先级；数量软上限，远距降采样/合并。 |
| **深链** | 交会详情 → 态势（见 E2）；与星历→态势对称验收。 |
| **改哪些** | `web/src/views/situation/*`（事件云渲染与拾取，优先 Three 叠加层，避免重写 SceneCore 主路径）；`conjunctions` 详情底栏链接与 query（如 `eventId`）。 |
| **验收** | 有事件时态势可见黄/橙/红云；点击弹窗字段正确；详情深链定位并高亮该云；关闭图层不影响编目；**不破坏**现有跟踪相机、MAN 琥珀段、星历关联可视化。 |
| **不做** | 推倒重写态势内核；用假随机云；无事件时画装饰性彩云。 |

---

### Epic F · 碰撞参数面板与重算（P1）

#### F1 参数三列展示

| 项 | 内容 |
|---|---|
| **字段** | 硬体/等效半径（可双侧）、接受 Pc（默认 1e-4）、接受最小脱靶、筛查距离阈值、协方差模式、传播器、时间窗/步长、勾选 Pc 方法。 |
| **UI** | 已设置值 \| 系统建议值（短理由）\| 可编辑。组织默认在「设置」；单次可「仅本次」。 |
| **验收** | 改 HBR 或阈值后点「按此配置重算」生成新 `run_id`；旧 run 可对比；计入 `recompute_day` 配额。 |

---

### Epic G · 星历版本归档与精度对比（P1 归档 / P2 对比报告）

#### G1 版本化

| 项 | 内容 |
|---|---|
| **做什么** | 每次上传/拉取 append 版本（source + sha256）；可按 version_id 回放筛查。参考 ephem 归档思路，不必引入其 WASM。 |
| **验收** | 同一 NORAD 可见历史版本列表；删除仅软删。 |

#### G2 精度对比（P2）

| 项 | 内容 |
|---|---|
| **做什么** | 重叠时段 OCM vs TLE/AOE 的 RTN 残差摘要；进报告 CSV。 |
| **验收** | 选两源能出沿迹/径向/法向 RMS 表。 |

---

### Epic H · 报告与通知（P1 最小 / P2 完整）

#### H1 事件包导出（P1）

| 项 | 内容 |
|---|---|
| **做什么** | 单事件：CDM 时间线 + 多 Pc 表 + 参数 run → PDF 或先 Markdown/HTML 打印 + CSV。 |
| **验收** | 详情页一键导出，含免责声明。 |

#### H2 日报与 Webhook（P2）

| 项 | 内容 |
|---|---|
| **做什么** | 定时汇总 observe/critical、数据源健康；邮件/Webhook 可选。对齐 OKAPI：分级变化触发通知。 |

---

### Epic I · 分级计量全量与 override UI（P2）

| 项 | 内容 |
|---|---|
| **做什么** | 超管「配额与功能开关」：数字 override + flag（如 `pc_mc_enabled`）；`effective_limit = override ?? plan_default`。降级超额冻结新作业不删历史。 |
| **验收** | 改 VIP 目标上限为 200 立即生效；「恢复档位默认」清除 override。 |

---

### Epic J · 机动与再筛查（P3，仅占位）

- OKAPI 式：observe/critical → 机动候选 → 后续 7–10 天防新交会。
- P1/P2 **不要**实现完整机动引擎；目标档案预留推进字段即可。

---

## 4. 建议库表（设计级，可调命名）

```
organizations, users, admin_audit_logs
plan_defaults, org_quota_overrides, org_feature_flags
org_credentials
objects
ephemeris_versions          -- 已有 ephem 表则加 version/sha 字段
orbital_fetch_batches       -- 日更批次
conjunction_events, conjunction_cdms, conjunction_pc_runs
ca_org_defaults             -- 组织默认碰撞参数
```

---

## 5. API 草图（路径可微调，保持 `/cgi` 前缀风格）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/cgi/auth/login` | 登录 |
| GET/PATCH | `/cgi/org` | 本组织资料 |
| CRUD | `/cgi/objects` | 托管目标 |
| GET/PUT | `/cgi/org/credentials` | 数据凭证（不回明文密钥） |
| POST | `/cgi/jobs/daily-fetch` | 超管/运维手动触发日更（GET `/cgi/jobs/daily-fetch/status` 查询状态） |
| POST | `/cgi/screens` | 创建筛查任务（列表/详情/取消均为 `/cgi/screens/...`） |
| GET | `/cgi/events` | 交会列表 |
| GET | `/cgi/events/:id` | 详情含 pcs[] |
| POST | `/cgi/events/:id/recompute` | 参数重算 |
| CRUD | `/cgi/admin/orgs` | 超管 |

---

## 6. 前端信息架构改动清单

1. `AppShell` 侧栏：按设计重排；隐藏或降级 AI、空壳轨道页。  
2. `overview`：真数据 + 去 AI。  
3. `objects`：档案字段对齐 OKAPI 最小集。  
4. `conjunctions`：多 Pc + 重算侧栏。  
5. `settings`（可新建）：凭证、默认 CA 参数、通知开关。  
6. `admin`：独立路由。  
7. `situation`：加黄/橙/红交会危险云 + 点击弹窗 + 交会深链，**不重构** SceneCore 主路径。

---

## 7. 算法接入建议（给实现选型）

| 优先级 | 方案 | 说明 |
|--------|------|------|
| P1 默认 | 移植/依赖 SatGuard 的 Foster、Chan、Alfano + 相遇平面投影 | 文档全、与 CDM KVN 输出友好 |
| P1 | 官方 CDM Pc 优先展示 | 有 CDM 时 `pc_source=cdm` |
| P2 VIP | ASTRA 2D 积分 / 6D MC | 单独 worker，超时与配额 |
| 禁止 | 无免责冒充认证级 CARA；无协方差静默用假协方差不提示 | |

参考仓库（只读参考，注意许可证）：  
- https://github.com/cesabici-bit/satguard  
- https://github.com/ISHANTARE/ASTRA  

---

## 8. 验收总清单（P0+P1 出门标准）

- [ ] 超管可开通/关停/设档；客户不能自助改 plan  
- [ ] 系统日更 TLE+CDM+AOE 至少骨架跑通；客户可配自有凭证  
- [ ] 总览无 AI、无假 KPI；有资产与数据源健康  
- [ ] Object 认领；星历绑定 object  
- [ ] 筛查产出事件；交会列表+详情；详情多 Pc + 官方列
- [ ] 态势黄/橙/红事件云可点出弹窗；交会详情「打开态势」深链稳定（对齐星历→态势）  
- [ ] 参数已设置/建议/编辑 + 重算 run 可对比  
- [ ] 星历/态势既有 UX 回归通过（关联态势、MAN、跟踪相机）  
- [ ] 密钥未入库；UI 有 Pc 免责  

---

## 9. 刻意不做

- 侧栏堆 AI / 总览假数  
- 客户自助抬高配额  
- P0 上完整机动责任协议  
- 推倒重写 Cesium/Three 态势内核  
- 把竞赛旧站 `server.jsc` 或私有 heat-core 源码拷进本仓库  

---

## 10. TRAE 执行顺序（推荐一次只开一个 Epic 分支）

1. Epic A（组织登录档位）  
2. Epic B（超管最小）  
3. Epic C1+C2（日更 + 客户凭证）  
4. Epic D（Object + 真总览）  
5. Epic E1–E3（筛查 + CDM + 多 Pc）  
6. Epic F（参数重算）  
7. Epic E4 + G1（态势层 + 星历版本）  
8. Epic H1（事件包导出）  
9. 再开 P2（C3、G2、H2、I）  

每步：实现 → 本地 `npm run build`（web）→ 关键 API 冒烟 → 更新 `docs/更新说明-*.md` 一小节 → 提交。

---

## 11. 参考链接

- 设计建议（产品）：对话内 Canvas「开源太空安全 · 功能设计建议」  
- Space Safety Docs：https://docs.space-safety.starlink.com/docs/  
- 仓库已有：`docs/TRAE-项目介绍.md`、`docs/更新说明-2026-11.md`、`docs/cesium-three.md`  
- 现网：http://123.57.41.32/  

**完。** 本文件可整份丢给 TRAE 作为实施说明；若只做 P0，执行第 10 节 1–4 步即可收口一版可演示生产底座。
