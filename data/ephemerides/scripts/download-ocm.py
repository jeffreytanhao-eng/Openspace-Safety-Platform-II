# 最终版：从 MANIFEST 挑最新 STARLINK，下载 10 份 OCM（全文件检测 COV/MAN）
import urllib.request
import urllib.error
import gzip
import os
import json
import re
import sys
import time
from datetime import datetime, timezone

BASE_URL = "https://starlink.com/public-files/ephemerides"
MANIFEST_URL = "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt"
ROOT = os.path.dirname(__file__)
# 脚本位于 data/ephemerides/scripts/，落盘目录为同级 ocm/（data/ephemerides/ocm/）
OUT_DIR = os.path.abspath(os.path.join(ROOT, "..", "ocm"))

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept": "text/plain,*/*", "Accept-Encoding": "gzip", "Referer": "https://starlink.com/"}

os.makedirs(OUT_DIR, exist_ok=True)

# 已入库的 STARLINK 序号（name 口径），新增下载时排除
EXISTING = {1540, 1549, 37711, 38054, 38107, 38117, 38122, 38123, 38124, 38128}


def fetch_text(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
        if resp.headers.get("Content-Encoding", "") == "gzip" or raw[:2] == b"\x1f\x8b":
            return gzip.decompress(raw).decode("utf-8", "replace")
        return raw.decode("utf-8", "replace")
    except Exception:
        return None


def parse_manifest() -> list[int]:
    """MANIFEST ITC 文件名 → NORAD 列表（按生成时间戳降序）"""
    text = fetch_text(MANIFEST_URL)
    if not text:
        return []
    rows = []
    for line in text.splitlines():
        m = re.search(r'MEME_\d+_STARLINK-(\d+)_(\d+)_\w+_(\d+)_', line)
        if m:
            norad, designator, ts = int(m.group(1)), int(m.group(2)), int(m.group(3))
            rows.append((norad, designator, ts))
    rows.sort(key=lambda x: (x[2], x[1]), reverse=True)
    return rows


def download_ocm(norad: int) -> dict | None:
    text = fetch_text(f"{BASE_URL}/STARLINK-{norad}.txt")
    if not text or ("CCSDS_OCM" not in text and "ODS_VERSION" not in text[:500]):
        return None
    # 全文件检测（COV/MAN 数据在文件中后部）
    has_cov = bool(re.search(r'COV_REF_FRAME|COV_TYPE|COVARIANCE', text))
    has_man = bool(re.search(r'^MAN_ID\s*=|MAN_START', text, re.M))

    shard = str(norad // 1000).zfill(3)
    out_sub = os.path.join(OUT_DIR, shard)
    os.makedirs(out_sub, exist_ok=True)
    out_path = os.path.join(out_sub, f"STARLINK-{norad}.ocm.txt.gz")
    with gzip.open(out_path, "wb", compresslevel=9) as f:
        f.write(text.encode("utf-8"))

    # 提取元信息
    created = (re.search(r'CREATION_DATE = (\S+)', text) or [None, ""])[1]
    start = (re.search(r'START_TIME = (\S+)', text) or [None, ""])[1]
    stop = (re.search(r'STOP_TIME = (\S+)', text) or [None, ""])[1]
    n_man = len(re.findall(r'^MAN_START', text, re.M))

    return {
        "norad": norad, "name": f"STARLINK-{norad}",
        "has_cov": has_cov, "has_man": has_man, "man_count": n_man,
        "created": created, "start": start, "stop": stop,
        "text_kb": round(len(text.encode("utf-8")) / 1024, 1),
        "path": os.path.relpath(out_path, ROOT),
    }


def main():
    target = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    print(f"目标 {target} 份 OCM（全文件检测 COV/MAN）\n")

    print("解析 MANIFEST 挑选最新活跃卫星...")
    rows = parse_manifest()
    print(f"  MANIFEST 条目: {len(rows)}")
    # 最新时间戳的 NORAD（排除已有）
    fresh = [r[0] for r in rows if r[0] not in EXISTING]
    fresh = list(dict.fromkeys(fresh))
    print(f"  最新活跃(排除已有{len(EXISTING)}个)前20: {fresh[:20]}")

    candidates = fresh  # 只下载新增，已有星历不覆盖
    print(f"  候选总数: {len(candidates)}\n")

    results = []
    for i, norad in enumerate(candidates):
        if len(results) >= target:
            break
        label = "已有(更新)" if norad in EXISTING else "新增"
        print(f"[{i+1}] STARLINK-{norad} ({label}) ...", end=" ", flush=True)
        r = download_ocm(norad)
        if r is None:
            print("skip")
            time.sleep(0.3)
            continue
        r["tier"] = "cov+man" if (r["has_cov"] and r["has_man"]) else ("cov-only" if r["has_cov"] else ("man-only" if r["has_man"] else "bare"))
        results.append(r)
        print(f"✓ [{r['tier']}] {r['text_kb']}KB 机动{r['man_count']}段 {r['created'][:19]}")
        time.sleep(0.3)

    print(f"\n=== 完成 {len(results)} 份 ===")
    for r in results:
        tags = [t for t, ok in [("COV", r["has_cov"]), ("MAN", r["has_man"])] if ok]
        print(f"  {r['name']:20s} {r['text_kb']:7.1f}KB [{r['tier']:8s}] {','.join(tags) or '无'}  机动{r['man_count']}段  {r['start'][:10]}~{r['stop'][:10]}")

    cov_man = [r for r in results if r["has_cov"] and r["has_man"]]
    print(f"\nCOV+MAN: {len(cov_man)}/{len(results)}")

    manifest = {
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "items": results,
    }
    mp = os.path.join(OUT_DIR, "_download_manifest.json")
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"清单: {mp}")


if __name__ == "__main__":
    main()
