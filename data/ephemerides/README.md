# 本地星历样本（Starlink 公开）

路径：`data/ephemerides/`（相对仓库根）。

## 两种公开格式（下载方式不同）

| 格式 | 公开位置 | 更新 | 说明 |
|------|----------|------|------|
| **OCM** | `https://starlink.com/public-files/ephemerides/STARLINK-XXXXX.txt`（按卫星名直链） | 约每小时 | 主力高精度 CCSDS OCM（含 TRAJ / COV / MAN） |
| **Modified ITC** | `https://api.starlink.com/public-files/ephemerides/`，经 `MANIFEST.txt` 列出文件名再下载 | 约每 8 小时 | 较早公开格式 |

## 布局

| 路径 | 说明 |
|------|------|
| `itc/*.txt.gz` | 真实 Modified ITC（gzip 落盘） |
| `ocm/STARLINK-*.ocm.txt.gz` | **真实** Starlink OCM（直链下载后本地 gzip；**禁止** ITC→OCM 派生） |
| `index.json` | 列表元数据（点数、步长、时间范围、协方差、机动摘要等） |
| `MANIFEST.txt(.gz)` | ITC 公开清单快照 |
| `scripts/rebuild-index.mjs` | 从本地真实 ITC+OCM 重建 index（不生成 OCM） |

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

# 重建 index
node scripts/rebuild-index.mjs
```

勿下载完整 ~11k ITC 目录。API：`GET /cgi/ephemerides`；`GET /cgi/ephemerides/file?path=ocm/...`。

## 压缩约定（`.gz` 落盘）

- 官方样本以 **`*.txt.gz` / `*.ocm.txt.gz` 压缩存放**（省空间；与旧平台一致）。
- **不要批量解成明文 `.txt`**：`GET /cgi/ephemerides/file?path=...` 在服务端用 `zlib.gunzipSync` 解压后返回纯文本；
  前端 `fetchEphemerisText` 拿到的已是解压正文，解析器不感知 gzip。
- `?download=1` 时仍下发原始 gzip（`Content-Type: application/gzip`）。
- 下载脚本：curl 拿到明文后再 `gzip -c9` 写入 `ocm/` / `itc/`（见上方示例）。
