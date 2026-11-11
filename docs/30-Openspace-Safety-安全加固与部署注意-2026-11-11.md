# Openspace Safety — 安全加固与部署注意

| 项 | 内容 |
|---|---|
| **文档编号** | 30 |
| **日期** | 2026-11-11 |
| **对应说明** | 生产安全加固：星历只读接口需登录、API 改为非 root 运行并收紧目录权限、API 仅监听 127.0.0.1。配套部署后脚本，避免后续更新把加固盖掉。 |
| **代码状态** | 已写入本机仓库。是否提交 / 推送 / 部署以 Jeffrey 指示为准（本轮已在生产应用，见第 5 节）。 |
| **仓库真相源** | 笔记本 `D:\项目\Openspace Safety`（`main`） |
| **约束** | 不要改文档 21～29 正文（仅在 29 文末加一行指向本文）；不要覆盖生产 `/opt/openspace/api/.env` 的内容；不要把 API 监听改回 `0.0.0.0`；不要对 `/opt/openspace` 再执行 `chmod 777`；不要删除 systemd drop-in；未接到指示不要提交或推送。 |

---

## 1. 为什么必须知会 TRAE

本次有两类改动，**都会被下一次按旧方式部署盖掉**，所以必须把本文交给 TRAE，并按第 4 节改部署步骤：

1. **代码**（在本机仓库，需进入他们下次构建所依据的提交）：
   - `GET /cgi/ephemerides`、`/file`、`/meta/:id`、`/versions`、`/versions/:id/content` 全部 `requireAuth`；版本列表/正文额外做可见性校验；列表不再返回服务器绝对路径 `resolvedRoot`。
   - `POST /cgi/sat_tle/constellation/cache-clear` 改为登录 + 平台超管。
   - API 默认监听 `127.0.0.1`（可用环境变量 `API_LISTEN` 覆盖，生产不要设成 `0.0.0.0`）。
2. **主机状态**（不在 Git 里，但会被「以 root 重启 / chmod 777 / 重写 unit」冲掉）：
   - systemd 通过 drop-in 以用户 `openspace` 运行 API。
   - `/opt/openspace` 目录权限收紧（见脚本）。

如果只部署 GitHub 上**尚未包含上述代码**的 tip，生产会重新失去星历登录保护，并可能再次监听 `0.0.0.0`。请先合入本机这些改动再构建部署。

---

## 2. 代码要点（给实现与验收）

- 前端登录门已要求先登录；星历相关请求本来就会带 `Authorization`。未登录访问上述接口应返回 401，登录后列表/文件/版本与改前一致（可见性规则不变：public / vip / private + 业主）。
- 元数据查询失败时，文件接口改为 503，不再「查不着权限就直接读文件」。
- 非超管查询版本历史必须带 `norad`。
- 不要改 `/opt/openspace/api/.env` 的键值；监听地址走代码默认值即可，不必在 `.env` 里加 `API_LISTEN`。
- 本机开发：API 仍可由 Vite 代理到 `127.0.0.1:1235`，默认监听本机即可。

---

## 3. 主机加固要点

- 系统用户：`openspace`（nologin）。
- systemd drop-in（保留，不要删）：`/etc/systemd/system/openspace-api.service.d/hardening.conf`  
  内容为 `User=openspace` 与 `Group=openspace`。仓库副本：`deploy/openspace-api.service.d/hardening.conf`。
- 权限由脚本统一设置：根目录 `755`；`api`/`data` 属主 `openspace`，目录 `750`、文件 `640`；`.env` 保持 `640` 且不改内容；`web` 属主 `openspace:www-data`，供 nginx 读取。
- nginx 反代仍指向 `127.0.0.1:1234`。不要用仓库里 `deploy/nginx/openspace.conf` 整份覆盖生产（那是容器 1233 配置）。可选片段见 `deploy/nginx/hardening-snippets.conf`（拒绝 `.bak` / `.sql` / `.env` 下载；HSTS 只加在 443 域名块）。

---

## 4. TRAE 部署时必须做的（每次同步代码之后）

在把构建产物同步到 `/opt/openspace` 之后、重启服务之前：

```bash
bash /opt/openspace/deploy/scripts/apply-openspace-host-hardening.sh
systemctl restart openspace-api
systemctl status openspace-api --no-pager
```

脚本可重复执行。它会重建 drop-in、收紧权限，**不会改 `.env` 内容**。

请不要：

- `chmod -R 777 /opt/openspace`
- 用没有 `User=openspace` 的 unit 直接覆盖后却删掉 `openspace-api.service.d`
- 把 `app.listen` 改回 `0.0.0.0`，或在生产 `.env` 设置 `API_LISTEN=0.0.0.0`
- 覆盖 `/opt/openspace/api/.env`

验收：

- 未带 token：`GET /cgi/ephemerides` 与 `/cgi/ephemerides/versions?norad=100001` 返回 401。
- 登录后：星历列表、态势星历轨迹、版本内容正常。
- `ss -lntp | grep 1234` 应显示 `127.0.0.1:1234`，进程用户为 `openspace`（不是 root）。
- `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/index.html.bak.20261110-184634` 在加上 nginx 片段后应为 403（若尚未合并片段，此项可暂缓）。

---

## 5. 本轮已在生产做的主机操作（2026-11-11）

应用代码构建产物与上述加固脚本；不改 `.env` 内容。详情以当时操作记录为准。

---

## 6. 不要做

- 不要重做或回滚《28》《29》已交付的功能。
- 不要开启 ufw（有锁死 SSH 风险）；安全组继续挡 1234 / 3306 即可。
- 不要在本轮改测试账号密码、关闭 SSH root、或重写文档 21～29 正文。
- 未经指示不要提交、推送。

---

**文档结束（30 · 2026-11-11）**
