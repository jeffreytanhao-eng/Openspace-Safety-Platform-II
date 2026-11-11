# Openspace Safety — 我的文档

| 项 | 内容 |
|---|---|
| **文档编号** | 31 |
| **日期** | 2026-11-11 |
| **对应说明** | 侧栏「文档」改为「我的文档」；总览报告与星历源文件可存入个人/共享文档库；超管可向全员推送置顶文档。 |
| **约束** | 未接到指示不要提交、推送或部署；不要改 `.env` 内容。存储目录权限不要 `chmod 777`。新接口全部 `requireAuth`。 |

## 接口

- `GET /cgi/documents` 列表 + 配额（置顶不计入用量）
- `GET /cgi/documents/:id` 元数据 + 预览（无权或不存在统一返回「文档不存在」）
- `GET /cgi/documents/:id/file` 下载原文件
- `POST /cgi/documents/from-report` 保存总览当前报告正文
- `POST /cgi/documents/from-ephemeris` 拷贝当前用户已有权查看的星历源文件
- `POST /cgi/documents/pin` 超管推送置顶（请求体为原始字节）
- `POST /cgi/documents/:id/unpin` 超管取消置顶
- `DELETE /cgi/documents/:id` 删除（创建者或超管；VIP 同事只读）

## 规则

- 普通/免费：个人可见，最多 50 份（非置顶）。
- VIP（账号 `isVip` 或组织档位 `vip`）：同组织共享，最多 500 份；同事可看可下载，不能删除他人文档。`org_admin` 与成员相同，不能删同事文档。
- 置顶：所有登录用户可见，不占份额；仅超管可推送 / 取消置顶 / 删除。
- 展示文件名：`{base}_{yyyyMMdd-HHmmss}{ext}`，时区 Asia/Shanghai，重名追加 `-2`、`-3`。
- 磁盘：应用 data 根下 `user-documents/`，文件名=服务端 UUID。启动时 `ensureUserDocsSchema()` 幂等建表（对照 `api/sql/002_user_documents.sql`）。
- 阅读栏：CSV/文本/JSON/Markdown 直接预览；`.gz` 解压后预览前 200 KB；HTML 以沙箱 iframe（无脚本、无同源）展示，图片用文档内嵌 data URI；其他类型仅元数据 + 下载。
- 超管置顶可带 `X-Title` 作为干净展示名（不加时间戳）；未提供时仍为 `{base}_{yyyyMMdd-HHmmss}{ext}`。

安全加固（文档 30）对本功能仍然适用：新接口需登录；文件落在 data 目录而非 `web/dist`；生产 API 不要监听 `0.0.0.0`。
