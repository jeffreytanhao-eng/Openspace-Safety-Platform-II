# 本地星历样本（Starlink 公开）

路径：`data/ephemerides/`（相对仓库根）。

## 三种导入方法（文件入库 + 元数据写 MySQL）

### 方法 A：星历管理页「选择目录」按钮（几十~几百份，推荐新手操作）

1. 打开星历管理页 `/ephemerides`
2. 点击「选择目录」→ 选中存放星历的文件夹
3. 系统自动做三件事：识别格式（ITC/OCM）→ 元数据写入 MySQL `ephemeris` 表 → 原始文件 gzip 压缩后按 NORAD 千位分片落盘（如 NORAD 37711 → `itc/037/`）
4. 完成后列表自动刷新回第 1 页，数据库中可立即搜索到

**限制**：单文件 ≤ 12 MB；浏览器逐个上传，上万份不建议用此方式（页面需一直开着）。

### 方法 B：直接放服务器目录 + rebuild（万级推荐，离线批量）

1. 把文件放进 `data/ephemerides/itc/` 或 `data/ephemerides/ocm/`（子目录任意，扫描是递归的，可按日期/批次分子目录）
2. 触发增量入库（三选一）：

```bash
# 方式 1：命令行脚本
cd data/ephemerides && node scripts/rebuild-index.mjs

# 方式 2：直接调后端接口
curl -X POST http://127.0.0.1:1235/cgi/ephemerides/rebuild

# 方式 3：重启 API 进程（启动时自动增量扫描）
```

3. 增量机制：已入库文件按 mtime+size 自动跳过，只解析新增/变更文件；同时清理已删除文件的脏行、同步导出 `index.json` 作为回退兜底

**要求**：文件必须是 `.txt.gz` 压缩格式（目录扫描只识别 `.txt.gz`）。若手上是大量明文 `.txt`，要么走方法 A（前端自动压缩），要么需要扩展 rebuild 逻辑。

### 方法 C：API 单文件上传（脚本/CI 场景）

```bash
curl -X POST -H "Content-Type: application/octet-stream" \
  --data-binary @STARLINK-XXX.txt.gz \
  "http://127.0.0.1:1235/cgi/ephemerides/upload?name=STARLINK-XXX.txt.gz"
```

返回 `action` 字段：`added`（新增）/ `updated`（同 NORAD+格式覆盖）/ `skipped`（同名跳过）。

## 两种公开格式（下载方式不同）

| 格式 | 公开位置 | 更新 | 说明 |
|------|----------|------|------|
| **OCM** | `https://starlink.com/public-files/ephemerides/STARLINK-XXXXX.txt`（按卫星名直链） | 约每小时 | 主力高精度 CCSDS OCM（含 TRAJ / COV / MAN） |
| **Modified ITC** | `https://api.starlink.com/public-files/ephemerides/`，经 `MANIFEST.txt` 列出文件名再下载 | 约每 8 小时 | 较早公开格式 |

## 布局

| 路径 | 说明 |
|------|------|
| `itc/*.txt.gz` | 真实 Modified ITC（gzip 落盘；上传的新文件按 NORAD 千位分片到 `itc/<nnn>/` 子目录） |
| `ocm/STARLINK-*.ocm.txt.gz` | **真实** Starlink OCM（直链下载后本地 gzip；**禁止** ITC→OCM 派生；同样支持 `<nnn>/` 分片子目录） |
| `index.json` | 列表元数据快照（无 MySQL 部署的兜底数据源；入库后由 rebuild 自动导出） |
| `MANIFEST.txt(.gz)` | ITC 公开清单快照 |
| `scripts/rebuild-index.mjs` | 调用后端 `POST /cgi/ephemerides/rebuild` 增量扫描入库（解析逻辑在 `api/src/ephem/`） |

## 元数据库（MySQL，万级文件架构）

- 元数据存 MySQL 表 `ephemeris`（幂等建表于 API 启动时；原始 .txt.gz 留在文件系统，**不入库 blob**）；
- API 启动时自动：建表 → 首次从 index.json 迁移 → 增量扫描（按 mtime+size 只解析新/变文件）；
- 上传入库：`POST /cgi/ephemerides/upload?name=<文件名>`（原始字节流，内容自动识别 OCM/ITC，
  同名文件跳过，同 NORAD+格式 旧版被新版替换）；
- 列表接口：`GET /cgi/ephemerides?page=1&size=20&format=ITC&q=37711`（分页/筛选/搜索；
  不带 `page` 时为 legacy 全量模式，上限 5000 条）；
- **MySQL 不可用时全部接口自动回退 index.json**（现状行为，星历功能零回归；入库/上传需要 MySQL）。

## 刷新样本

```bash
# OCM（直链，与 ITC 不同）：curl 解压传输编码后本地再 gzip
curl -L --compressed -H "Accept: text/plain,*/*" \
  -o /tmp/STARLINK-38128.ocm.txt \
  https://starlink.com/public-files/ephemerides/STARLINK-38128.txt
gzip -c9 /tmp/STARLINK-38128.ocm.txt > ocm/STARLINK-38128.ocm.txt.gz

# ITC（经 MANIFEST）
curl -L -H "Accept-Encoding: gzip" -o itc/FOO.txt.gz \
  https://api.starlink.com/public-files/ephemerides/FOO.txt

# 增量扫描入库（MySQL）+ 导出 index.json 快照
node scripts/rebuild-index.mjs
```

勿下载完整 ~11k ITC 目录。API：`GET /cgi/ephemerides`（支持 `page/size/format/q/keys`）；`GET /cgi/ephemerides/file?path=ocm/...`；`POST /cgi/ephemerides/upload?name=...`；`POST /cgi/ephemerides/rebuild`。

## 压缩约定（`.gz` 落盘）

- 官方样本以 **`*.txt.gz` / `*.ocm.txt.gz` 压缩存放**（省空间；与旧平台一致）。
- **不要批量解成明文 `.txt`**：`GET /cgi/ephemerides/file?path=...` 在服务端用 `zlib.gunzipSync` 解压后返回纯文本；
  前端 `fetchEphemerisText` 拿到的已是解压正文，解析器不感知 gzip。
- `?download=1` 时仍下发原始 gzip（`Content-Type: application/gzip`）。
- 下载脚本：curl 拿到明文后再 `gzip -c9` 写入 `ocm/` / `itc/`（见上方示例）。
