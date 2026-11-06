# Openspace Safety · 《25》任务书后完成更新说明

| 项 | 内容 |
|---|---|
| **文档编号** | 26 |
| **对应任务书** | `docs/25-Openspace-Safety-任务书-给TRAE-2026-11-06.md`（v1.0） |
| **覆盖范围** | 2026-11-06 下午《25》任务书内 R2-21～R2-25 的全部实现 |
| **代码状态** | 已推送 `origin/main`（commit `17d3cf7`） |
| **线上状态** | 已部署生产 `123.57.41.32`（备份 `/opt/backup/deploy-20261106-172546`）；三个既有账号 `admin` / `xingwang` / `gaoxiao` 口令均未改动 |
| **约束遵循** | 只改本仓库；密钥仅存 `.env`；未推倒星历/态势内核；`/ai` 入口与路由保留；未改认证隔离与认领写入路径；交会 A 冰蓝 / B 琥珀未改色；未做支付、未接第三方商业 SSA；未修改文档 21/22/24，未回写 23 |

---

## 1. 交付总览

| Story | 条目 | 状态 |
|---|---|---|
| R2-21 | 右上账号页：改密 / 档位只读 / 升级续费占位 | 已完成 |
| R2-22 | 交会详情侧栏「交会」高亮 | 已完成 |
| R2-23 | 筛查及周边去「组织」话术（中英） | 已完成 |
| R2-24 | 交会详情打磨（白话轴摘要 / 重算默认折叠 / 类型折行） | 已完成 |
| R2-25 | 超管认领审核页「历史直写 / 未审」标注 | 已完成 |

---

## 2. 逐项说明

### 2.1 R2-21 账号页与自助改密

**后端**
- `api/src/routes/auth.ts`：新增受保护的 `POST /cgi/auth/password`。
  - 仅改当前登录用户本人（`req.auth.user.id`）；
  - 校验原密码；新密码 ≥ 8 位、≤ 100 位，且不能与原密码相同；
  - 返回 `{ changed: true }`，不涉及任何 `plan` 修改。
- `api/src/db/orgDb.ts`：新增 `updateUserPassword(id, hash)`，只更新 `users.password_hash`。

**前端**
- 新页 `web/src/views/account/index.vue`，路由 `/account`（`requiresAuth: true`，匿名访问跳登录）。
  - 身份：显示名、邮箱、角色；
  - 档位与权限（只读）：单位、`plan`、单位状态、配额明细（`GET /cgi/org/quota`），并展示业主认领 / 关注的能力摘要；
  - 修改密码：原密码 / 新密码 / 确认新密码，成功后提示「下次登录请使用新密码」，**不强制退出登录**；
  - 升级 / 续费：按钮可见但 `disabled`，文案「联系平台管理员开通（暂不可自助）」。
- `web/src/layouts/AppShell.vue`：顶栏新增「账号」按钮 → `/account`。
- `web/src/router/index.ts`、`web/src/api/auth.ts`、`web/src/i18n/messages.ts` 同步。

**验收（已实测）**
- `gaoxiao` 登录后打开 `/account`：显示 `normal`、单位「高校测试组织」、9 项配额只读表格；升级按钮 `disabled`；改密表单 3 个输入。
- 改密 API：错误原密码 → 400「原密码不正确」；新密码过短 → 400「新密码至少 8 位」；匿名 → 401；合法改密 → 成功，新密码可登录、旧密码失败（测试后已将测试账号口令恢复原状）。

### 2.2 R2-22 交会详情侧栏高亮

**实现**
- `web/src/layouts/AppShell.vue`：`activeKey` 在 `situation → simulation` 别名基础上新增：
  - `route.name === 'conjunction-detail'` → `conjunctions`；
  - 或 `route.path.startsWith('/conjunctions')` → `conjunctions`。
- 未改路由 `name` / `path`，深链保持兼容。

**验收（已实测）**：`/conjunctions` 列表 → 点进任意详情，侧栏「交会」保持 `nav-item on` 高亮；其它栏目切换不受影响。

### 2.3 R2-23 去「组织」话术

**筛查表单（P0）**
- `web/src/views/screens/index.vue`：`默认参数（组织）` → **单位默认**。
- `web/src/i18n/messages.ts`：
  - `TLE（系统池 / 组织快照）` → **TLE（系统目录）**；
  - `编目 GP（系统池）` → **编目 GP（系统目录）**；
  - 主星说明 → **主星 = 已托管目标 vs 全编目（TLE 通道）**；
  - 空态 → **暂无已托管目标，请先在「目标」页认领**；
  - 平台只读提示 → **全平台只读视图（仅展示全平台任务…）**；
  - 同步英文（system catalog / managed objects / platform-wide）。

**周边顺带**
- 设置页：`nav.settingsHint`、`ca.sub`、`ca.defaultsSub`、`ca.saved`、`ca.readOnly`、`ca.mineSub`、`ca.mineDefaultHint` 的「组织」统一为「单位」。
- 目标页：`obj.sub`、`obj.claimedByOther`、`obj.ownerMine`、`obj.claimMine`、`obj.ownerVipOnly`、`obj.ownerScopeNone/Out`、`obj.normalHint`、`obj.ownerFrozen`、`obj.col.org`、`obj.sec.orgArchive`、`obj.releaseConfirm`、`obj.platformHint` 等同步。
- 配额标签（`api/src/db/planDb.ts`）：`系统池可见范围` → **系统目录可见范围**；`组织成员数` → **单位成员数**（账号页与超管档位页共用）。
- 交会重算面板参数来源同改为「单位默认」。

**未改**：`org_id`、`paramsSource=default` 等 DB/API 字段与隔离逻辑；后端错误码内部用词。

**验收（已实测）**：`gaoxiao` 打开筛查发起区，参数来源显示「单位默认」、主星源「TLE（系统目录）」、对照源「编目 GP（系统目录）」；发起面板 `innerText` / `outerHTML` 中「组织」出现 0 次。

### 2.4 R2-24 交会详情打磨

**实现**
- `web/src/views/conjunctions/Detail.vue`：
  - 相对运动整块保留（距离—时间、R–I、C–I 平面）；
  - 新增 `rmAxisSummary` / `rmAxisValues`：取 TCA（或最近采样点）的 |R| / |I| / |C|，最大者为唯一主轴且至少比最小者大 30% 时给出白话结论（径向 / 沿轨迹向 / 法向），三者接近时输出「三分量接近，交会几何无明显主轴」；缺数据不输出、不编造；
  - 摘要行显示在图表上方，并附 `R x · I y · C z km` 数值；
  - 重算面板默认折叠：标题行常驻，`▸ 展开 / ▾ 收起` 切换，参数表单、结果与重算历史在折叠区内；
  - `.kv dd` 增加 `word-break: normal; overflow-wrap: break-word; hyphens: none;`，避免 `PAYLOAD` 等被硬拆；
  - 相对速度缺 CDM 字段时仍显示「未提供（CDM 无此字段）」。
- `web/src/i18n/messages.ts`：新增 `rm.sum.radial/intrack/crosstrack/mixed`、`ca.expand/collapse`，中英同步。
- 未改 A 冰蓝 / B 琥珀配色，未删 Pc 多算法、风险演变、CDM 时间线、双目标卡。

**验收（已实测）**：详情页摘要显示「本次最小间距主要在沿轨（迹向 I）… R 0.1 · I 17.5 · C 2.3 km」单行；重算面板初始仅标题 + 展开，展开后表单出现、收起后 `display:none`；`PAYLOAD` / `DEBRIS` 均单行显示。

### 2.5 R2-25 认领审核「历史直写 / 未审」标注

**实现**
- `api/src/db/objectsDb.ts`：超管认领列表 SELECT 增加 `reviewed_by`、`reviewed_at` 字段（原已有列，仅补输出）。
- `web/src/api/admin.ts`：`AdminObjectClaim` 增加同名字段。
- `web/src/views/admin/Claims.vue`：新增 `isLegacyDirect(row)` —— 仅当 `claim_status='claimed'` 且 `reviewed_by` 与 `reviewed_at` 均为空时，在状态旁显示琥珀色徽章「历史直写 / 未审」，`title` 说明「现行审核流上线前直接写为已通过，无审核人，不代表本轮越权通过」。
- `web/src/i18n/messages.ts`：新增 `adm.claims.legacy` / `adm.claims.legacyTip`（中英）。
- 规则对任意 NORAD 一视同仁，无星座 / 组织分支；不自动撤销、不批量改写历史行；未改 owner→pending 写入路径与空 scopes 拒绝逻辑。

**验收（已实测）**：用本地既有 claimed 记录临时清空审核人字段后，`admin` 在 `/admin/claims` 的「已通过」筛选下看到「已通过 + 历史直写 / 未审」双徽章；验证后已恢复原审核人与时间（`admin@openspace.local` / 2026-11-06 13:11:32.790）。pending 行不打标；线上 org5 历史数据将按同一规则显示。

---

## 3. 验证记录

| 项 | 结果 |
|---|---|
| `npx vue-tsc -b`（web） | 通过，无错误 |
| `npm run build`（web） | 通过，产物生成 |
| `npm run build`（api） | 仅 `src/services/constellationSnapshot.ts` 既有 10 条 tsc 错误（非本次改动），`noEmitOnError=false` 下 dist 正常产出；服务启动与健康检查通过 |
| 浏览器冒烟 | R2-22 详情侧栏高亮 PASS；R2-24 摘要/折叠/类型折行 PASS；R2-23 筛查文案 PASS；R2-21 账号页 PASS；R2-25 徽章 PASS |
| 回归 | 交会 A/B 双色未改；`/ai` 路由保留；匿名 `/account` → 登录页；`xingwang` / `gaoxiao` 仍无法访问超管接口 |

### 3.1 线上部署校验（2026-11-06 17:25 CST）

- 部署方式：本地构建 → 打包 `api`（排除 `node_modules` / `.env` / `data`）与 `web/dist` → 上传解包 → 服务器 `npm ci` → `systemctl restart openspace-api`。
- 部署前备份：`/opt/backup/deploy-20261106-172546`（api-dist、web-dist、package.json、package-lock.json）。
- 服务状态：`openspace-api` active；`/cgi/health` 返回 `db: up`。
- 账号回归：`admin`（platform_super_admin）、`xingwang`（vip）、`gaoxiao`（normal）以原口令 `a1234` 登录均返回 200，口令未变。
- 接口回归：匿名 `POST /cgi/auth/password` → 401；超管 `GET /cgi/admin/object-claims?status=claimed` 返回 231 条 org5 历史记录，均带 `reviewed_by=null / reviewed_at=null`，将显示「历史直写 / 未审」徽章。
- 前端产物：线上主包与账号页 chunk 哈希与本地构建一致，包含「历史直写」「单位默认」等新文案。

---

## 4. 变更文件清单

**后端**
- `api/src/routes/auth.ts`（改密接口）
- `api/src/db/orgDb.ts`（`updateUserPassword`）
- `api/src/db/objectsDb.ts`（认领列表审核人字段）
- `api/src/db/planDb.ts`（配额标签去「组织 / 系统池」）
- `api/src/routes/admin.ts`（成员上限提示文案）

**前端**
- `web/src/views/account/index.vue`（新增）
- `web/src/layouts/AppShell.vue`（账号入口 + 交会 activeKey 别名）
- `web/src/router/index.ts`（`/account`）
- `web/src/api/auth.ts`（`authChangePassword`）
- `web/src/api/admin.ts`（审核人字段）
- `web/src/views/admin/Claims.vue`（历史直写徽章）
- `web/src/views/conjunctions/Detail.vue`（轴摘要、重算折叠、类型折行）
- `web/src/views/screens/index.vue`（单位默认）
- `web/src/i18n/messages.ts`（中英文案）

---

*谭谈 · 2026-11-06*
