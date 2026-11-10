# Openspace Safety 任务书（给 TRAE）

| 项 | 内容 |
|---|---|
| **文档编号** | 25 |
| **依据** | 《23》已交付（R2-12～R2-20）+ 《24》更新说明（changelog，**本册不改 24**）+ 2026-11-06 Jeffrey 五条反馈 + 现网核查 `/workspace/acceptance-24/issues-2026-11-06-five.md` |
| **现网** | `http://123.57.41.32/` · 仓库 `jeffreytanhao-eng/Openspace-Safety-Platform-II` |
| **版本** | v1.0 · 2026-11-06（Asia/Shanghai） · **新要求册**（不回写 21 / 22 / 23 / 24） |
| **目标读者** | TRAE（按 Story 再开发；**只依据本文**） |
| **约束** | 只改本仓库；密钥进 `.env`；**不推倒**星历/态势内核；左侧栏 `/ai` **入口与路由保留**（不要删除）；开源 Pc 标注「作业辅助，非认证 CARA」；署名仅「谭谈」；**禁止**星网/HULIANWANG 硬编码；**不对接**任何第三方商业 SSA/雷达 API；产品 UI/更新说明**禁止**出现第三方商业 SSA 产品或套件名称；平台**不得**代付终端用户 Space-Track / SSA 拉数 |

---

> **与《21》《22》《23》《24》关系（必读）**  
> 《21》《22》已关闭，**禁止**回写、删改、合并。  
> 《23》为上一册任务（R2-12～R2-20）；《24》是《23》落地后的**更新说明 / changelog**，**本册不要改 24 文件**。  
> 本册是 **2026-11-06 下午新要求**（Story 从 **R2-21** 起编）。验收与分支以本册为准。  
> 《23》出门项与《24》已记能力视为**已上线基线**，本册只列新缺口；**不要回归**已交付的认领隔离、双色交会模型、相对运动/风险演变主体能力。

> **产品约束（沿用，不得削弱）**  
> 1. **业主认领**：仅认证 VIP（`plan=vip` 且 `status=active`）可 `claimType=owner`；须落在 `org_claim_scopes`；空范围 = **拒绝全部 owner**（安全默认，**不是 bug，不要改成未配置也可认领**）。  
> 2. **审核**：新 owner 写入 `claim_status=pending`，超管在 `/admin/claims` 通过后才 `claimed`；**关注（normal）可立即生效**。  
> 3. **唯一业主**：同一 NORAD 全局至多一个已生效 owner；普通档 **不可** owner。  
> 4. **客户数据隔离**：筛查 / 客户 CDM / 星历 / CA 默认按组织隔离。  
> 5. 交会态势放大态双方配色保持 **A 冰蓝 / B 琥珀**，**不要改回单色蓝**。  
> 6. 认领 / 搜索 / 筛查一律**通用能力**，禁止为某一星座或模拟账号做专项硬编码。  
> 7. 本轮**不做**硬件、军用传感、支付升级、第三方商业 SSA API。

---

## 0. 结论摘要（先读）

### 0.1 Jeffrey 2026-11-06 反馈 → 本册映射

| Jeffrey 原话要点 | 本册 Story | 核查结论（已核实，勿当空白重查） |
|---|---|---|
| 右上要账号管理：改密、看档位权限、预留升级续费 | **R2-21** | 顶栏仅有组织名 / VIP 徽章 / 显示名 / 退出 / 语言；无账号页；auth 仅 login/register/me，**无自助改密 API** |
| 交会进详情后左侧「交会」高亮丢失 | **R2-22** | **确认 bug**：列表 `name=conjunctions`，详情 `name=conjunction-detail`；`activeKey` 精确匹配 route.name |
| 筛查仍有「组织」字样 | **R2-23** | 硬编码「默认参数（组织）」+ i18n「TLE（系统池 / 组织快照）」等；语义勿改，只换用户话术 |
| 交会详情是否合理、相对运动图是否有用 | **R2-24** | **保留**相对运动；补一句白话 miss 轴摘要；重算默认折叠；修 `PAYLOAD` 折行；相对速度缺字段保持诚实空态 |
| （核查引申）VIP 看似不经审核认领 hulianwang | **R2-25**（标注，不改认领路径） | 截图账号为 **Local Test Org（org_id=5）**；231 条 owner+claimed 写于 2026-11-05 15:41–15:43（北京），`reviewed_by` 空——**历史直写**，非现行跳过审核。现行代码新 owner 仍写 pending |

### 0.2 本册要做 / 不要做

**要做：** R2-21～R2-25（见 §3）。

**不要做 / 不要重做：**
- 不要改 `POST /cgi/objects` 的 owner→pending 逻辑，也不要为「空 scopes」开后门。  
- 不要撤销或批量改写 Local Test Org 历史 231 条 owner（R2-25 只做超管列表**标注**）。  
- 不要为 HULIANWANG / 星网写特殊分支。  
- 不要删除 `/ai`、不要改回交会单色蓝、不要接支付、不要代付 Space-Track。  
- 不要修改文档 **21 / 22 / 24**（23 亦勿回写；本册独立成 25）。

### 0.3 测试账号（仅用户名；口令不入本文）

| 角色 | 用户名 | 说明 |
|---|---|---|
| VIP | `xingwang` | org 7「星网测试组织」；登录框可填用户名，服务端补 `@openspace.local` |
| 普通 | `gaoxiao` | org 8「高校测试组织」 |
| 超管 | `admin` | 平台超管 |
| 数据上下文（非本册必测登录） | Local Test Org / org 5 | 历史 VIP 场景账号；R2-25 标注对象；**不要**在产品里为其做特例 |

---

## 1. 现网基线（与本册相关的已核实事实）

- 顶栏：`web/src/layouts/AppShell.vue` — 组织名、`plan-chip`、显示名、退出、语言；平台角色另有「管理控制台」。  
- 路由：`web/src/router/index.ts` — `conjunctions` 与 `conjunctions/:id`（`name: conjunction-detail`）为**同级**子路由。  
- `activeKey`：详情落到 `conjunction-detail`，与 nav key `conjunctions` 不等 → 高亮丢失；`situation` 已有别名映射，交会详情没有。  
- 筛查文案：`web/src/views/screens/index.vue` 硬编码 `默认参数（组织）`；`web/src/i18n/messages.ts` 的 `scr.srcTle` 等含「组织 / 系统池」。  
- 交会详情：`web/src/views/conjunctions/Detail.vue` 已有 KPI、双目标卡、CDM 时间线、Pc 多算法、风险演变、相对运动（RIC）、重算面板。  
- 认领：`api/src/routes/objects.ts` 对 owner 写 `pending`；`batch-claim` 仅普通认领。超管 `GET /cgi/admin/object-claims`。  
- org5 历史 owner 231 条、`reviewed_*` 空；org5/org7 `claim_scopes=[]`（空=拒 owner，保持）。

---

## 2. Story 清单（本册实施）

### R2-21 右上账号管理（改密 / 档位只读 / 升级续费占位）

| 项 | 内容 |
|---|---|
| **目标** | 登录用户可从顶栏进入「账号」页：自助改密；只读查看本人档位 / 角色 / 配额与权限摘要；预留升级续费入口（本轮不接支付）。 |
| **现状** | 顶栏无账号入口；`api/src/routes/auth.ts` 仅有 `register` / `login` / `me`；档位变更仅超管改组织 `plan`。 |
| **期望** | 1）`AppShell` 顶栏（组织名/徽章旁或右侧）增加 **账号** 按钮 → 新路由（建议 `/account`，需登录）。<br>2）页面分区：① **身份**：显示名、邮箱、角色；② **档位与权限**（只读）：`plan`、组织状态、配额用量（可复用 `GET /cgi/org/quota` 或 `/auth/me` 扩展只读字段），说明业主认领/关注等能力差异（文案通用，勿写死星座）；③ **修改密码**：旧密码 + 新密码 + 确认；④ **升级 / 续费**：按钮可见，**disabled** 或文案「联系平台管理员开通」（本轮无支付、无自助升档 API）。<br>3）新增自助改密 API（示例：`POST /cgi/auth/password` 或 `PATCH /cgi/auth/password`）：校验旧密码、新密码长度策略与注册一致（≥8）；**仅改当前用户**；成功可要求重新登录（二选一，验收写清）。<br>4）**禁止**：用户通过本页把自己的 `plan` 改成 vip；禁止普通用户调用超管组织 PATCH。 |
| **改动面** | `web/src/layouts/AppShell.vue`；新页 `web/src/views/account/`（或同等）；`web/src/router/index.ts`；`web/src/api/auth.ts`；`api/src/routes/auth.ts`；`web/src/i18n/messages.ts`；`docs/更新说明-*.md` 一小节 |
| **验收** | **xingwang**：能打开账号页，看到 VIP / 配额只读；改密成功后可用新密码登录，旧密码失败；升级按钮不可真正升档。<br>**gaoxiao**：同上，plan 显示 normal；页面不出现可点的「一键变 VIP」。<br>**admin**：可进入或按设计跳转；不得借此绕过超管改 org plan 的既有入口。<br>匿名访问 `/account` → 登录页。 |

---

### R2-22 交会详情侧栏「交会」高亮

| 项 | 内容 |
|---|---|
| **目标** | 从交会列表点进任意详情时，左侧「交会」保持选中高亮。 |
| **现状** | `name=conjunctions`（列表）vs `name=conjunction-detail`（详情，`path: conjunctions/:id`）；`AppShell` 的 `activeKey` 用 `route.name` 精确相等；`situation` 有别名，交会详情没有。 |
| **期望** | `activeKey` 将 `conjunction-detail` **或** `path.startsWith('/conjunctions')` 映射为 nav key `conjunctions`（与 situation→simulation 同类）。不要改路由 name 除非同步改所有深链。 |
| **改动面** | **必改** `web/src/layouts/AppShell.vue`（`activeKey`）；核对 `web/src/router/index.ts`（引用即可，非必须改 path） |
| **验收** | 打开 `/conjunctions` → 「交会」高亮；再点右侧/列表任一事件进详情 → **仍高亮**；返回列表仍高亮；其它栏目（筛查/态势）切换正常，不被误亮。 |

---

### R2-23 筛查及周边去「组织」话术

| 项 | 内容 |
|---|---|
| **目标** | 用户可见文案去掉多租户黑话「组织」，改为「单位 / 团队 / 已托管 / 系统目录」等；**不改** API 字段名与 `paramsSource=default` 等语义。 |
| **现状（P0 筛查表单，截图已确认）** | 硬编码 `默认参数（组织）`（`web/src/views/screens/index.vue`）；i18n `scr.srcTle`=`TLE（系统池 / 组织快照）`；另有 `scr.newSub`、`scr.noManaged`、`scr.platformReadonly`、`scr.srcCatalog` 等含「组织 / 系统池」。 |
| **期望替换（中文；英文 i18n 同步）** | |
| | `默认参数（组织）` → **单位默认** 或 **团队默认参数**（仍是 org 级 CA 默认，不是 mine1/mine2） |
| | `TLE（系统池 / 组织快照）` → **TLE（系统目录）**；若产品必须区分租户已同步根数，可另文案「已同步根数」，**不要**再写「组织快照」 |
| | `编目 GP（系统池）` → **编目 GP（系统目录）** |
| | `主星 = 本组织目标 vs …` → **主星 = 已托管目标 vs 全编目（TLE）** |
| | `本组织暂无目标…` → **暂无已托管目标，请先在「目标」页认领** |
| | 平台只读「各组织筛查任务」 → **全平台任务**（仅平台账号可见文案） |
| **顺带（便宜就做）** | 设置页 `ca.f.orgDefaults`「组织默认」→「单位默认」；目标页用户可见「本组织」→「本单位 / 已托管」同类替换。筛查表单为 **P0**。 |
| **不要做** | 不重命名 DB/API 的 `org_id`、`paramsSource=default`、后端错误码内部用词；不改隔离逻辑。 |
| **改动面** | `web/src/views/screens/index.vue`；`web/src/i18n/messages.ts`（中英）；可选 `settings` / `objects` 文案；`docs/更新说明-*.md` |
| **验收** | 筛查发起区用户可见字符串 **不再出现「组织」**（平台超管只读提示可用「全平台」）；参数来源选「单位默认」行为仍读 org CA 默认；选「我的参数组」仍是个人；英文界面无残留 `org snapshot` 类对用户话术（内部注释除外）。xingwang / gaoxiao 各看一眼表单即可。 |

---

### R2-24 交会详情页产品打磨（保留相对运动）

| 项 | 内容 |
|---|---|
| **目标** | 详情页对值班更易扫读，同时保留分析员需要的 RIC 图。 |
| **现状** | 长页：KPI → 双目标卡 → CDM 时间线 → Pc 多算法 → 风险演变 → 相对运动 → 重算。相对运动仅有坐标系教科书说明（`rm.desc`），无「本次最小间距主要在哪一轴」白话；重算面板默认展开；`object_type`（如 PAYLOAD）在两列 `.kv` 可能awkward 折行；相对速度缺 CDM 字段时已有「未提供」。 |
| **期望** | 1）**保留**相对运动整块（距离–时间 dR/dI/dC/总距离 + R–I、C–I 平面），不要删。<br>2）在图**上方**增加**一行**白话摘要：根据 TCA（或序列最小距离点）的 R/I/C 分量，指出主要分量，例如「本次最小间距主要在径向 / 沿轨（迹向）/ 法向」；三者接近时可写「三分量接近」；缺数据则不编造。<br>3）**重算面板默认折叠**（标题可见，一键展开）；折叠不影响已有重算历史只读列表的可达性（可放在折叠区内或区外，验收时说明）。<br>4）双目标卡 `object_type`：CSS `overflow-wrap` / `word-break` / 适当 `nowrap`，避免 `PAYLOAD` 等被拆成难看两截。<br>5）相对速度：**保持**诚实空态「未提供（CDM 无此字段）」；**禁止**用假速度填满。<br>6）**不要删** Pc 多算法、风险演变、CDM 时间线、双目标卡；**不要**改态势双色冰蓝/琥珀。 |
| **改动面** | `web/src/views/conjunctions/Detail.vue`；`web/src/i18n/messages.ts`；相对运动数据已有则前端算摘要即可，必要时轻微只读 API 扩展 |
| **验收** | 打开任意有 TLE 的交会详情：相对运动仍在；摘要行与分量一致；首屏不必先看到大块重算表单（默认折叠）；类型字段不奇怪断字；无相对速度时仍显示未提供。回归：冰蓝/琥珀态势模型未被本提交改色。 |

---

### R2-25 超管认领审核页标注「历史直写 / 未审」

| 项 | 内容 |
|---|---|
| **目标** | 超管在认领审核列表能区分「现行 pending 流」与「历史上直接写成 claimed、无审核人」的记录；**不**自动撤销历史数据。 |
| **背景（数据上下文，非产品特例）** | Local Test Org（`org_id=5`，VIP）在 2026-11-05 曾写入大量 `claim_type=owner` 且 `claim_status=claimed`、`reviewed_by`/`reviewed_at` 为空的行（含通用编目标签下的多星）。现行代码已对**新** owner 写 pending；**本 Story 不改认领写入路径**。 |
| **期望** | 在 `/admin/claims`（`web/src/views/admin/Claims.vue` 或等价）：当 `claim_type=owner` **且** `claim_status=claimed` **且** 无审核人（`reviewed_by` 空 / 无审核时间）时，显示徽章或列值 **「历史直写」** / **「未审」**（中英 i18n）。列表筛 `claimed`/`all` 时可见。点击详情勿暗示「本轮刚越权通过」。 |
| **不要做** | 不要按星座名/HULIANWANG/星网分支；标签规则对**任意** NORAD 一视同仁。不要因空 `claim_scopes` 而允许无范围 owner。不要批量 reject/delete 历史行（除非另开运维任务且用户明示）。 |
| **改动面** | `web/src/views/admin/Claims.vue`；必要时 `api` 列表已有字段足够则纯前端判断；`i18n`；`docs/更新说明-*.md` |
| **验收** | **admin** 打开认领审核，在 claimed/all 下能看到带「历史直写/未审」的行（现网 org5 数据可作回归夹具）；pending 行不打此标；新走 pending→approve 的行有审核人后**不**再显示「未审」。xingwang/gaoxiao 仍 403 超管接口。 |

---

### 本轮明确不做（防止自行发挥）

- 支付 / 自助升 VIP / 续费扣款。  
- 放开空 `claim_scopes` 的 owner；撤销 org5 历史 owner。  
- 星网 / HULIANWANG 硬编码；硬件 / 军用传感。  
- 删除 `/ai`；交会模型改回单色；删除相对运动 / Pc 多算法 / 风险演变。  
- 修改文档 **21、22、24**；回写 **23**。  
- 对接第三方商业 SSA；平台代付 Space-Track 拉数。

---

## 3. 建议实现顺序

1. **R2-22**（侧栏高亮，改动面最小，可先合）  
2. **R2-23**（筛查文案 P0；顺带设置/目标文案）  
3. **R2-24**（详情打磨，依赖已有相对运动，无新大数据源）  
4. **R2-25**（超管标注，独立）  
5. **R2-21**（账号页 + 改密 API，前后端，放后以免挡文案/高亮）

每步：`vue-tsc` / `npm run build` + 浏览器冒烟；在 **新的** `docs/更新说明-*.md` 小节记录（或续写 11-06 更新说明时**不要覆盖**《24》正文结构——《24》文件本身勿改；可另起「25 任务书后更新说明」由用户后续编号）。

---

## 4. 验收检查表（本册）

- [ ] 顶栏有账号入口；改密 API 可用；档位只读；升级/续费不可自助升档（R2-21）  
- [ ] 交会列表 → 详情，左侧「交会」保持高亮（R2-22）  
- [ ] 筛查表单用户可见文案无「组织」；单位默认仍读 org CA；中英一致（R2-23）  
- [ ] 交会详情：相对运动保留 + 白话轴摘要；重算默认折叠；类型不恶俗折行；无速度不编造（R2-24）  
- [ ] 超管 Claims：owner+claimed+无审核人 →「历史直写/未审」；无星座硬编码；不自动撤销（R2-25）  
- [ ] 回归：VIP-only owner + pending；空 scopes 仍拒 owner；普通不可 owner；A 冰蓝 / B 琥珀；`/ai` 仍在  
- [ ] **未**修改仓库内 `21-*` / `22-*` / `24-*` 文档文件  

---

## 5. 参考路径速查

| 主题 | 路径 |
|---|---|
| 顶栏 / activeKey | `web/src/layouts/AppShell.vue` |
| 路由 | `web/src/router/index.ts` |
| 筛查文案 | `web/src/views/screens/index.vue`；`web/src/i18n/messages.ts` |
| 交会详情 | `web/src/views/conjunctions/Detail.vue` |
| 认领写入 / pending | `api/src/routes/objects.ts`；`api/src/db/objectsDb.ts` |
| 超管认领列表 | `web/src/views/admin/Claims.vue`；`api/src/routes/admin.ts` |
| 认证 | `api/src/routes/auth.ts`；`web/src/api/auth.ts` |
| 现网问题核查 | 内部验收笔记（五条问题，2026-11-06）；以本册 Story 为准实施 |

---

**文档结束（25 · v1.0）**
