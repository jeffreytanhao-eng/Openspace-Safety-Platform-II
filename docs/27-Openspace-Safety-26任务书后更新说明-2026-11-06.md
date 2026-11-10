# Openspace Safety · 《26》任务书后完成更新说明

| 项 | 内容 |
|---|---|
| **文档编号** | 27 |
| **对应任务书** | `docs/26-Openspace-Safety-任务书-给TRAE-2026-11-06.md`（v1.0） |
| **覆盖范围** | 2026-11-06 晚间《26》任务书 R2-26～R2-30 的全部实现 |
| **代码状态** | 已提交 `923a4f5` 并推送 `origin/main`；2026-11-07 已部署生产（含后续账号页/目标页 UI 调整） |
| **约束遵循** | 只改本仓库；未推倒星历/态势内核；`/ai` 入口与路由保留；文案统一「关注」；未接支付；未改文档 21～26；未为任何星座/账号写硬编码分支 |

---

## 1. 交付总览

| Story | 条目 | 状态 |
|---|---|---|
| R2-26 | 账号页可滚动 + 左侧分段锚点 + 区块顺序调整（身份 → 修改密码 → 档位与权限 → 升级申请 → 组织成员）+ 配额紧凑网格 | 已完成 |
| R2-27 | 「认领目标」「关注目标」分按钮；普通用户 owner 前后端双重拒绝；唯一业主；关注与业主不互斥；已关注升级业主同行 pending | 已完成 |
| R2-28 | 公开注册不再建组织（普通账号）；新增 VIP 升级申请与超管审核 | 已完成 |
| R2-29 | 组织仅超管创建，必须指定已有 VIP 为管理员；拒绝普通账号/已有组织账号 | 已完成 |
| R2-30 | 组织管理员在账号页管理最多 3 名成员；成员为 VIP 能力但不能管理他人；超管同口径上限 | 已完成 |

---

## 2. 逐项说明

### 2.1 R2-26 账号页布局与滚动

**前端** `web/src/views/account/index.vue`
- 主内容改为 `grid(160px + 1fr)` 两列：左列为分段锚点导航（身份 / 修改密码 / 档位与权限 / 申请升级为 VIP / 组织成员），右侧 `.acct-scroll` 独立纵向滚动（`overflow-y:auto`）。
- 区块顺序调整为：**① 身份 → ② 修改密码 → ③ 档位与权限 → ④ 升级申请 → ⑤ 组织成员**。
- 档位与权限的配额从单列长列表改为 **3 列紧凑网格** `.quota-grid`，能力摘要保持只读。
- 滚动时按 `scrollTop` 自动高亮当前分区；点击锚点平滑跳转到对应区块。

**验收（浏览器实测，xingwang）**
- 滚动容器 `scrollHeight=1049 / clientHeight=810`，可滚动到底（239px）。
- 区块顺序实测：身份 top=106 → 修改密码 top=204 → 档位与权限 top=468 → 组织成员 top=768。
- 配额网格实测 `grid-template-columns: 234px 234px 234px`，9 项仅占约 80px 高。
- 四个锚点均可实际跳转。

### 2.2 R2-27 认领 / 关注分按钮

**后端** `api/src/routes/objects.ts`、`api/src/db/objectsDb.ts`
- `POST /cgi/objects`：
  - 普通账号（非 VIP）请求 `claimType=owner` → **403**（不依赖前端禁用）；关注 `normal` 正常。
  - owner 仍要求：组织存在、`org.plan=vip` 或 `user.is_vip=1`、组织 `active`、且落在 `org_claim_scopes` 内；空范围继续 403。
  - 同一组织同一 NORAD 已有 `normal + claimed`，再次提交 `owner` 时**不插入第二行**，而是调用 `upgradeNormalToOwner` 将原行改为 `claim_type=owner, claim_status=pending`，返回 `pending_review: true` 与「关注已升级为业主认领申请，等待平台超管审核」。
  - `pending` 再提交 → 409；已 `owner + claimed` → 409；`claimed + normal` 重复关注 → 409。
  - 全局唯一业主仍由 `uk_owner_norad` 兜底：其它 VIP 组织对已有业主的目标提交 owner → 409。
- `GET /cgi/objects` 现在返回本组织的 `claimed` + `pending` 行，便于用户在列表中看到「待审核」状态；日更、凭证等其它取数路径仍只取 `claimed`，不受影响。
- 批量入口 `POST /cgi/objects/batch-claim` 仅创建 `normal`（前端已改为「批量关注」）。

**前端**
- `web/src/views/objects/index.vue`：右上并列两个按钮——**认领目标**（普通用户可见但 `disabled`，tooltip「仅 VIP 可发起业主认领」）与 **关注目标**（立即生效）。
- 认领弹窗只走 owner：预览 NORAD + 档案参数表单，提交后 pending；关注弹窗只走 normal：预览 + 确认，无参数表单；弹窗内不再出现「关注 / 业主」二选一。
- 列表「认领类型」列：`pending` 显示「待审核」，已生效显示「业主 / 关注」。
- 编目发现区按钮改为「批量关注」，只产生关注。
- i18n 中英同步，全量使用「关注」，未出现「跟踪」。

**验收（本地 API 冒烟）**
- `gaoxiao`（普通）：owner → 403；follow → 200（其组织 61 已有该星关注时为 409，符合同组织单行语义）。
- 普通用户 owner 在 API 层被拒，不依赖按钮禁用。
- 测试 VIP：先 follow（`normal/claimed`），再 owner → 同一 `id=75` 变为 `owner/pending`，列表仅 1 行。
- 超管审核通过 → 该行 `owner/claimed`；另一 VIP 组织（已配置同 NORAD 范围）再 owner → **409**；`gaoxiao` 对该星关注仍为 200/既有行。
- 空 `claim_scopes` 的 VIP 组织 owner → 403（回归通过）。

### 2.3 R2-28 注册普通账号 + VIP 升级申请

**后端**
- `api/src/db/orgDb.ts`
  - `users` 新增 `is_vip tinyint(1) NOT NULL DEFAULT 0`（惰性建表 + ALTER 迁移，重复列错误忽略）。
  - 新增 `org_upgrade_requests` 表（`pending/approved/rejected`、`reason`、`review_note`、`reviewed_by/at`）。
  - 新注册 `createUser`：`org_id=NULL`、`role=org_member`、`is_vip=0`。
  - 升级申请：`findPendingUpgrade / findLatestUpgrade / createUpgradeRequest / listUpgradeRequests / approveUpgradeRequest / rejectUpgradeRequest`；通过时事务写 `users.is_vip=1`。
- `api/src/routes/auth.ts`
  - 注册去掉 `orgName` 与 `createOrgWithAdmin`，返回 `{ token, user, org: null }`。
  - `SafeUser` 增加 `isVip`。
  - 新增 `POST /cgi/auth/upgrade-request`（已是 VIP → 400；已有 pending → 409）与 `GET /cgi/auth/upgrade-request`。
- 超管 `api/src/routes/admin.ts`：`GET /admin/upgrade-requests?status=pending|all`、`POST /admin/upgrade-requests/:id/approve|reject`，均写审计。

**前端**
- 登录页注册模式删除「组织名称」输入，增加提示：注册后为普通账号，可在账号页申请升级 VIP。
- `/account` 新增「申请升级为 VIP」区块：普通用户可填理由并提交；待审显示「已提交，等待平台审核」并禁用按钮；驳回显示原因并可重新提交；VIP 不显示该区块。
- 新增超管页 `web/src/views/admin/Upgrades.vue` + 路由 `/admin/upgrades` + 侧栏「升级申请」：待审核 / 全部两个 Tab，行内「通过 / 驳回」，通过二次确认、驳回填写原因。

**验收（API + 浏览器）**
- 新注册账号：`org=null`、`role=org_member`、`isVip=false`；owner → 403；follow → 自动创建个人工作区并成功。
- 升级申请首次 200 pending、重复 409；超管「全部」列表可见历史记录，待审核行渲染「通过 / 驳回」按钮，驳回后用户侧显示原因。
- `xingwang`（VIP）账号页不显示升级申请；`gaoxiao` 可提交并看到驳回原因。

### 2.4 R2-29 仅超管建组织，指定已有 VIP 管理员

**后端** `api/src/db/orgDb.ts`、`api/src/routes/admin.ts`
- `POST /cgi/admin/orgs` 请求体改为 `{ name, adminEmail }`：不再新建邮箱+密码。
- 校验顺序：邮箱格式 → 用户存在（404）→ 非平台账号（400）→ `is_vip=1`（409，「请先通过该用户的 VIP 升级申请」）→ 不属于其它正式组织（409）。
- 系统自动个人工作区（`notes='auto:personal'`）可被新组织收编：事务内迁移 `objects.org_id` 到新组织，并将个人工作区置 `closed / auto:personal:retired`；正式组织一律拒绝。
- 新组织档位固定 `vip`，被指定用户 `org_id=新组织`、`role=org_admin`；写审计 `org.create`。
- 新增 `GET /cgi/admin/vip-users?q=`：仅返回已通过 VIP、未加入正式组织的候选账号（供表单 datalist）。

**前端** `web/src/views/admin/Orgs.vue`
- 开通向导仅两项必填：组织名称、指定已有 VIP 管理员邮箱（带候选 datalist）；档位显示「VIP（固定）」只读；删除新建密码/姓名字段。

**验收**
- 指定普通账号 → 409；指定已有组织账号 → 409；指定独立 VIP（先关注形成个人工作区）→ 200，组织 `plan=vip`，用户 `org_admin`，原个人工作区对象迁移完成。
- 浏览器实测开通向导：password 输入框 0 个、档位不可选，仅组织名 + VIP 邮箱。

### 2.5 R2-30 组织管理员最多 3 名成员

**后端**
- `api/src/db/orgDb.ts`：`countOrgMembers`（只统计 `role='org_member'`）、`listOrgMembers`、`removeOrgMember`（仅移出本组织成员）。
- 新增 `api/src/routes/org.ts`：
  - 守卫 `memberManager`：必须有组织、`role=org_admin`、`org.plan=vip` 且 `active`；
  - `GET /cgi/org/members`（列表 / 用量 / 上限 / 是否可管理）；
  - `POST /cgi/org/members`：邮箱、显示名、初始密码（≥8），只创建 `org_member`，硬上限 3；
  - `DELETE /cgi/org/members/:id`：不能移除自己、只能移除本组织 `org_member`；写审计。
- 超管 `POST /admin/orgs/:id/members`：角色固定 `org_member`，上限同样为 3（`Math.min(members_max, 3)`），不可绕过。
- `planDb.ts`：VIP 默认 `members_max` 从 50 改为 3，并做一次性迁移；用量只统计成员，不含管理员本人。

**前端**
- `/account` 新增「组织成员」区块（仅 VIP 组织管理员可见）：`n / 3` 计数、成员列表、添加表单、移除确认；满 3 人禁用添加并说明原因。
- 超管 `OrgDetail.vue`：移除角色下拉，标题显示 `成员（n / 3）`，满员禁用添加。

**验收（API 实测）**
- 新组织管理员添加第 1/2/3 名成员 → 200；第 4 名 → 403。
- `org_member` 访问成员列表 / 添加 → 403；成员无法移除他人。
- 移除 1 名后可再添加 → 200；管理员移除自己 → 拒绝。
- `gaoxiao`（普通、非该组织管理员）看不到成员管理区块。

---

## 3. 数据与接口变更清单

| 类型 | 变更 |
|---|---|
| 表 | `users` 新增 `is_vip`（默认 0，惰性 ALTER 迁移） |
| 表 | 新增 `org_upgrade_requests`（VIP 升级申请与审核记录） |
| 接口 | 新增 `POST/GET /cgi/auth/upgrade-request` |
| 接口 | `POST /cgi/auth/register` 去掉 `orgName`，不再建组织 |
| 接口 | 新增 `GET /cgi/org/members`、`POST /cgi/org/members`、`DELETE /cgi/org/members/:id` |
| 接口 | 新增 `GET /cgi/admin/vip-users`、`GET /cgi/admin/upgrade-requests`、`POST /cgi/admin/upgrade-requests/:id/approve|reject` |
| 接口 | `POST /cgi/admin/orgs` 请求体改为 `{ name, adminEmail }`（指定已有 VIP） |
| 接口 | `POST /cgi/admin/orgs/:id/members` 只建 `org_member`，上限 3 |
| 接口 | `GET /cgi/objects` 返回本组织 `claimed + pending` 行（新增「待审核」可见性） |
| 权限 | 普通账号 `claimType=owner` → 403；组织成员管理仅本组织 `org_admin`（VIP/active）；超管建组织限已通过 VIP 的独立账号 |

---

## 4. 验证记录

| 项 | 方式 | 结果 |
|---|---|---|
| web 类型检查 | `npx vue-tsc -b --pretty false` | 通过（EXIT=0） |
| web 生产构建 | `npm run build` | 通过（EXIT=0） |
| api 构建 | `npm run build` | dist 产出完整；仅 `constellationSnapshot.ts` 既有 tsc 错误（非本轮引入） |
| API 权限冒烟 | 本地 1235（`node dist/server.js`） | R2-27/28/29/30 全链路通过（详见 §2 各验收） |
| 账号页布局 | 浏览器（1233） | 可滚动、锚点跳转、区块顺序与 3 列配额网格均通过 |
| 目标页按钮 | 浏览器（1233，gaoxiao） | 「认领目标」disabled、「关注目标」可用、弹窗无二选一 |
| 超管后台 | 浏览器（1233，admin） | 升级申请列表 / 全部历史 / 待审行操作按钮、开通组织向导均通过 |

**测试数据清理**：已删除本轮冒烟创建的 `@test.local` 测试账号、`OwnerOrg*` 及个人工作区、对应 objects 行与升级申请记录；`xingwang` 组织 60 的 `claim_scopes` 已从验证用 `25544` 恢复为原值 `20580`。`gaoxiao` 组织 61 的行 72、`xingwang` 组织 60 的行 70 为历史测试关注数据，本轮保留。

---

## 5. 部署状态

- 2026-11-07 已推送 `origin/main`（提交 `923a4f5`）并部署生产 `123.57.41.32`：`/opt/backup/deploy-20261107/` 备份了部署前 `api` 与 `web/dist`；api、web 产物覆盖后 `systemctl restart openspace-api` 正常，健康检查 `db:up`。
- 同期纳入部署的 UI 调整：账号页冻结标题/组织信息/简介折叠编辑/档位徽标配色、编目发现每页 20 条分页与跳页、`catalog` 排序补 `norad_id` 稳定分页、全局表单控件文字格式统一。
- 上线冒烟：首页 200 且加载新产物；匿名 `/cgi/objects`、`/cgi/admin/orgs` 均 401；`xingwang` 为组织管理员、`plan=vip`，`/cgi/org/members` 返回 `max=3`；检索 DIGUI 共 231 条、前两页 NORAD 重叠 0；`admin` 可访问升级申请列表；`gaoxiao` 发起业主认领 403、访问成员接口 403。三个既有账号密码保持不变。
- `users.bio`、`users.is_vip` 与 `org_upgrade_requests` 均为惰性建表/迁移，首次带 token 的业务请求已自动补齐。

---

**文档结束（27 · 2026-11-06）**

---

后续独立更新（Starlink 拉取加速、Data Ops 默认 10、深色数字步进器；当时尚未推送部署）见 `docs/28-Openspace-Safety-超管数据运维改动与部署说明-2026-11-10.md`，方法说明见 `docs/星历公开源下载优化方法-2026-11-10.md`。
