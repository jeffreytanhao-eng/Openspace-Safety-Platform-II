# Openspace Safety — 《28》之后更新说明

| 项 | 内容 |
|---|---|
| **文档编号** | 29 |
| **日期** | 2026-11-10 |
| **对应说明** | 覆盖文档 28（提交 `9ec0963`）之后、仍留在本地工作区的交会总览、星历精度图、交会页数据源实装、图表微调，以及总览「报告下载」调整 |
| **代码状态** | 已写在本地工作区，**尚未提交、尚未部署**。文档 28 范围内的改动已于 2026-11-10 15:45（北京时间 / Asia/Shanghai）提交并推送到 `origin/main`（`9ec0963`） |
| **仓库真相源** | 笔记本 `D:\项目\Openspace Safety`（`main`）。当前 `HEAD` 与 `origin/main` 均为 `9ec0963` |
| **约束** | 不要重做《28》已交付的下载加速、Data Ops 默认次数、数字步进器、筛查 AOE 源；不要改文档 21～28 正文（仅在 28 文末加一行指向本文）；不要覆盖生产 `/opt/openspace/api/.env`；不要提交 `data/ephemerides/`、`Temp/`、探测脚本或本机缓存；产品界面不要写第三方商业 SSA 品牌名 |

---

## 1. 与《28》的关系

文档 28 记录的是 Starlink 公开星历 gzip 分段并行拉取、Data Ops 默认次数改为 10、全站深色数字步进器，以及筛查任务可选 AOE 主/副星源。这些已包含在提交 `9ec0963`（`feat: Starlink 星历拉取加速（gzip 分段并行）与 AOE 筛查源`）中，并已推送 `origin/main`。**不要再实现一遍，也不要在本轮提交里重复打包那一批文件。**

本文只描述其后新增、目前仍未提交的工作。生产是否已按《28》部署，不在本文验收范围内；《29》这些改动**尚未部署**，也尚未提交。未接到明确指示前，不要推送、不要部署。

---

## 2. 交付总览

| 条目 | 内容 | 状态 |
|---|---|---|
| 研究确认（先不做） | 对照 Space Safety 文档与样图：平均根数（1）、新鲜度/陈旧度（2）、发射 COLA 示意（5）可做类似效果，本轮未开发 | 已与产品确认，本轮不做 |
| 即将交会总览 | 交会页与目标侧栏增加 Pc–TCA 散点；后续按反馈收短高度、去掉副标题、保留当前时刻竖虚线但不写「现在」、日期格式 `Nov.11`；列表与图均去掉 Pc &lt; 1e-7 的事件 | 本地已实现 |
| 星历精度比对扩展 | 在既有比对上增加 RTN 残差时序、CDF、3/6/12/24h 预报时效窗；TLE/AOE 一侧才给出龄期模型马氏距离 | 本地已实现 |
| 交会页数据源实装 | 数据源条顺序改为 CDM 第一且默认 CDM；TLE / Ephem / AOE 分别拉取对应筛查交会；「开运星敏」改名且不可选 | 本地已实现 |
| 总览报告下载 | 「报告下载」下拉去掉「数据源健康 (Markdown)」；左侧「数据源健康」面板保留 | 本地已实现 |

单事件详情里既有的「风险演变」图不改。

---

## 3. 研究确认、本轮未做

对照 https://docs.space-safety.starlink.com/ 与产品提供的样图，确认「不必完全一致，有类似效果能解决类似问题即可」。产品只授权先做第 3、4 项。

| 项 | 含义 | 结论 |
|---|---|---|
| 1 | 目标页 Mean Orbital Elements 一类平均根数卡 | 可用现有 TLE / AOE / 精密星历生成类似卡片，本轮未做 |
| 2 | 预报新鲜度 / 陈旧度 | 可做文件龄期、星历历元一类新鲜度；没有光学/雷达独立编目，不能声称同等观测新鲜度。本轮未做 |
| 5 | Launch COLA 发射窗口「挖槽」示意 | 属于教学/概念图，不是本轮交会操作图。本轮未做 |

不要把上述三项写进本轮提交说明，也不要在未授权时开发。

---

## 4. 即将交会总览（第 3 项及后续微调）

交会列表上方、目标侧栏近期事件处，增加 Pc 对最近逼近时间（TCA）的散点图。阈值与平台既有分级一致（`api/src/screen/levels.ts`）：

- ≥ 1e-4 高危
- ≥ 1e-5 警告
- ≥ 1e-7 关注

**数据口径**

- CDM 源：用官方/客户 CDM 的碰撞概率；同一事件多份报文取较大值。
- TLE / Ephem / AOE 源：用该条筛查事件上的本平台筛查 Pc，不回查官方 CDM。
- **Pc 有值且 &lt; 1e-7 的事件不进交会列表、也不画点**；纵轴从 1e-7 起，避免下方空带。无 Pc 的事件仍可留在列表（按脱靶距离查看），但不绘点。筛查里因稀释已按 Pc 口径标成关注及以上的，予以保留。不要为此从库里删除官方 CDM 原文。

**图表交互与样式（按 2026-11-10 反馈已改）**

- 主标题为「即将交会总览」，**无副标题**。
- 高度约 156px，区块内边距收紧。
- 保留当前时刻的竖向虚线，**线上不写「现在」或其它文字**。
- 去掉横轴名称「最近逼近时间」。
- 日期刻度格式为英文月份缩写 + 点 + 日期，例如 `Nov.11`（中英文界面相同）；当天时刻刻度仍为 `12:00`。
- 点击 CDM 点进入 `/conjunctions/{key}`；点击筛查点进入 `/screens/{jobId}`。详情页原有「风险演变」不变。

目标侧栏同样复用该图；`listEvents('7d')` 也会吃到接口侧 Pc &lt; 1e-7 的过滤。

---

## 5. 星历精度比对扩展（第 4 项）

在星历页既有精度比对上增加：

- RTN 残差时间序列
- 残差 CDF
- 预报时效窗：默认完整重叠；可选 3 / 6 / 12 / 24 小时（窗沿 ±45 分钟）
- 均方根跟随当前画出的点
- 马氏距离：仅当一侧是 TLE 或 AOE、并使用筛查龄期模型 σ 时给出；OCM×OCM 不编造马氏距离；不要画假的 1σ/3σ 带
- ITC / 本地导入仍不支持本次比对，保持既有能力边界，不要声称已支持

---

## 6. 交会页数据源实装

此前交会页的数据源条是 Stage-1 占位，切换只改「context」标签，不改变下方列表和图。现已接到真实查询。

**条上的源**

- 顺序：**CDM（缺省）**、TLE、Ephem、AOE、开运星敏。
- 默认选中 CDM（`space-track-cdm`）。不要把上次点过的 TLE 写进 localStorage。
- AOE 文案就是「AOE」，不再写「AOE + 星历」。
- 「Optical / Stargaze」改为「开运星敏」，**禁用、不可选**；本轮不实现光学 SSA。产品界面不要出现 Stargaze 等第三方商业 SSA 品牌名。

**接口** `GET /cgi/events?window=&scope=&eventSource=cdm|tle|ephem|aoe`（缺省 `cdm`）。原有字段 `dataSource`（`system_pool | org_credential`）含义不变，不要复用这个名字。

| eventSource | 行为 |
|---|---|
| `cdm` | 沿用 `sat_cdm` 聚合；客户上传 CDM 仍按组织隔离；`scope=mine` 仍按已认领/关注 NORAD 过滤 |
| `tle` / `ephem` / `aoe` | 查本组织 `conjunction_events` ⋈ `screening_jobs`，要求 `jobs.primary_source` 匹配、`status='done'`、`org_id` 为调用者组织。无组织账号得到空列表，不串组织。`scope=mine` 使用与 CDM 相同的认领/关注 NORAD 限制 |
| 其它值（含光学） | 空列表。各源之间**不互相回退** |

**去重**：无序目标对 + TCA 落入约 5 分钟岛内，保留 Pc 更高者，其次更新的 `job_id`。

**映射**：筛查行带上筛查 Pc / 等级；`cdmCount` 在有 `cdm_id` 时为 1 否则 0；来源文案如「TLE 筛查」。事件 key 为 `scr-{jobId}-{eventId}`，禁止拿这种 key 去打 CDM 详情接口。路由增加 `screens/:id?`，打开 `/screens/{jobId}` 时筛查页选中对应任务。

**空态**：该组织没有以对应主星源跑完的筛查任务时，提示例如「暂无 TLE 筛查交会，请在筛查页用 TLE 主星源发起任务」。不要自动发起筛查。

---

## 7. 总览「报告下载」调整

总览页「报告下载」下拉只保留：

- 组织日报摘要 (CSV)
- 关注事件包 (CSV)

去掉「数据源健康 (Markdown)」选项及对应导出分支。左侧「数据源健康」状态面板保留，不在本轮删除。

---

## 8. 应提交的文件

### 8.1 即将交会总览与交会页数据源

| 文件 | 说明 |
|---|---|
| `web/src/components/PcTcaChart.vue` | **新建**。Pc–TCA 散点、1e-7 下限、无副标题、当前时刻无文字虚线、日期 `Nov.11` |
| `web/src/components/EChart.vue` | 支持点击 |
| `web/src/views/conjunctions/index.vue` | 接入数据源查询、总览图、高度与空态、点击跳转 |
| `web/src/views/objects/index.vue` | 目标侧栏复用总览图 |
| `web/src/api/events.ts` | `eventSource`、`jobId`、`eventDetailPath()`、关注阈值过滤辅助 |
| `api/src/routes/events.ts` | `GET /cgi/events` 增加 `eventSource` |
| `api/src/db/screenDb.ts` | `listOrgScreenEvents()`、`countDoneScreenJobs()` |
| `web/src/composables/useDataSource.ts` | CDM 第一且默认；开运星敏禁用 |
| `web/src/components/DataSourceBar.vue` | 文案、禁用态、短标签 i18n |
| `web/src/router/index.ts` | `screens/:id?` |
| `web/src/views/screens/index.vue` | 按路由 id 选中任务 |
| `web/src/i18n/messages.ts` | 总览图、数据源、筛查来源、空态等中英词条（同文件也含报告下载词条调整） |

### 8.2 星历精度比对

| 文件 | 说明 |
|---|---|
| `web/src/components/AccuracyResidualCharts.vue` | **新建**。残差时序、CDF、时效窗 |
| `web/src/views/ephemerides/index.vue` | 接入扩展图 |
| `web/src/api/ephemerides.ts` | 比对接口类型/字段补齐 |
| `api/src/services/accuracyCompare.ts` | 残差、CDF、时效窗与马氏距离口径 |

### 8.3 总览报告下载

| 文件 | 说明 |
|---|---|
| `web/src/views/overview/index.vue` | 去掉「数据源健康」报告选项与 Markdown 导出 |
| `web/src/i18n/messages.ts` | 删除 `ov.reportHealth`（见上，不要重复提交） |

### 8.4 文档

| 文件 | 说明 |
|---|---|
| `docs/29-Openspace-Safety-28之后更新说明-2026-11-10.md` | 本文 |
| `docs/28-Openspace-Safety-超管数据运维改动与部署说明-2026-11-10.md` | **只允许在文末增加一行指向本文**，不要改 28 既有正文 |

### 8.5 不要提交

- `data/ephemerides/` 及清单、下载缓存、OCM/ITC 样例（本机拉取产物）
- `Temp/`、`osp-starlink-src/`、`api/_probe.mjs`、`api/_probe2.mjs`
- `api/src/routes/satTle.ts`、`api/src/routes/objects.ts`、以及工作区里仅有文件头 BOM/编码杂质的改动（如 `web/src/views/settings/index.vue` 若仍只是文件头差异）：**与本轮无关，不要带上**
- 不要改 `/opt/openspace/api/.env`，也不要把本地 `.env` 打进部署包

---

## 9. 提交与部署（待明确指示后再做）

未接到 Jeffrey 的提交 / 推送 / 部署指示前，**不要**执行本节。

若之后执行：

1. 在笔记本仓库 `D:\项目\Openspace Safety` 操作，确认当前 `HEAD` 为 `9ec0963`，并与 `origin/main` 一致。
2. 只暂存 §8.1～§8.4 列出的文件。
3. 提交说明建议：`feat: 交会 Pc-TCA 总览与多源筛查事件，扩展星历精度比对`。
4. 在现有 `main` 上直接 commit，**不要** rebase / reset 到更早的提交。
5. 部署生产仍走既有流程：`/opt/openspace`，systemd `openspace-api`，Nginx `/cgi` → `127.0.0.1:1234`；先备份再覆盖产物；**禁止覆盖** `/opt/openspace/api/.env`。
6. 本地开发当前是前端 `http://localhost:1233/`、API `1235`（Vite 把 `/cgi` 代理到 1235）。若本轮改了 API，部署或本地验收前需重新构建并重启 API。前端 `hmr` 为关闭状态，改完后需刷新页面。

---

## 10. 本地验收要点

- `vue-tsc -b` 已通过。API `tsc` 仍可能只有既有的 `constellationSnapshot.ts` 报错，本轮事件/筛查/精度文件不应新增错误。
- 刷新 `http://localhost:1233/conjunctions`：数据源 CDM 在第一位且默认选中；开运星敏灰色不可点；总览无副标题；当前时刻有竖虚线但无文字；日期为 `Nov.11` 这类格式；低于 1e-7 的点不再出现，纵轴从 1e-7 起。
- 切换 TLE / Ephem / AOE 必须真正换一批事件。若该组织还没有用对应主星源跑完的筛查任务，对应页为空，这是预期行为。
- 刷新总览：报告下载只有两种 CSV，不再出现「数据源健康」；左侧数据源健康面板仍在。
- 星历精度比对：能看到残差时序、CDF 与时效窗；ITC/本地导入仍提示不支持，不要当成回归失败。

---

## 11. 不要做

- 不要重做或回滚《28》已推送的下载加速 / AOE 筛查 / 数字步进器。
- 不要实现开运星敏 / 光学 / 雷达 SSA，不要在产品文案里写第三方商业 SSA 品牌名。
- 不要自动发起筛查任务来「填满」空的 TLE/Ephem/AOE 页。
- 不要从数据库删除官方 CDM；1e-7 只是列表与图的显示过滤。
- 未经指示不要提交、推送或部署。

---

**文档结束（29 · 2026-11-10）**

后续安全加固（星历接口登录、API 非 root、目录权限）见《30》。
