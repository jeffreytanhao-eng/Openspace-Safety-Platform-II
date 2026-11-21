#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
全球等经纬度影像 → Cesium 离线 TMS 瓦片包（geodetic 剖面，覆盖 ±90°，无极区空缺）

用法（仓库根目录）：
    python web/scripts/build-imagery-tiles.py --input <全球2:1影像.tif> \
        [--out web/public/tiles/earth] [--max-level 5] [--tile 256] [--quality 82]

输出（供 cesiumEarth.ts 的 imageryKind: 'tms' 使用）：
    <out>/tilemapresource.xml      SRS=EPSG:4326、Origin(-180,-90)，Cesium 据此选 GeographicTilingScheme
    <out>/<z>/<x>/<y>.jpg          y 自南向北计数（TMS 约定）

层级与墨卡托切片的区别：level 0 = 2×1 个瓦片（每片 180°×180°），DOM 一直铺到 ±90°，
因此南北极不会被裁掉，也不需要额外的极区补丁层。
"""
import argparse
import os
import sys
import time

from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # 21600×10800 会触发 DOS 保护阈值


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--out', default='web/public/tiles/earth')
    p.add_argument('--max-level', type=int, default=5)
    p.add_argument('--tile', type=int, default=256)
    p.add_argument('--quality', type=int, default=82)
    return p.parse_args()


def write_tms_xml(out_dir, max_level, tile):
    """geodetic 剖面：level L 每瓦片覆盖 180/2^L 度。"""
    sets = []
    for level in range(max_level + 1):
        upp = 180.0 / (tile * (1 << level))
        sets.append(
            f'    <TileSet href="{level}" units-per-pixel="{upp:.12g}" order="{level}"/>'
        )
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">
  <Title>OpenSpace Safety offline imagery</Title>
  <Abstract>Natural Earth II (public domain) global equirectangular tiles</Abstract>
  <SRS>EPSG:4326</SRS>
  <BoundingBox minx="-180" miny="-90" maxx="180" maxy="90"/>
  <Origin x="-180" y="-90"/>
  <TileFormat width="{tile}" height="{tile}" mime-type="image/jpeg" extension="jpg"/>
  <TileSets profile="geodetic">
{chr(10).join(sets)}
  </TileSets>
</TileMap>
"""
    with open(os.path.join(out_dir, 'tilemapresource.xml'), 'w', encoding='utf-8') as f:
        f.write(xml)


def save_level(img, level, out_dir, tile, quality):
    """把整层图像切成 x=2^(L+1)、y=2^L 的瓦片；y 轴翻转为 TMS（自南向北）。"""
    x_count = 2 << level
    y_count = 1 << level
    for tx in range(x_count):
        d = os.path.join(out_dir, str(level), str(tx))
        os.makedirs(d, exist_ok=True)
        for row in range(y_count):
            box = (
                tx * tile,
                row * tile,
                (tx + 1) * tile,
                (row + 1) * tile,
            )
            img.crop(box).save(
                os.path.join(d, f'{y_count - 1 - row}.jpg'),
                'JPEG',
                quality=quality,
                optimize=True,
                subsampling=0,
            )
    return x_count * y_count


def main():
    args = parse_args()
    src_path = args.input
    out_dir = args.out
    tile = args.tile
    max_level = args.max_level
    os.makedirs(out_dir, exist_ok=True)

    t0 = time.time()
    print(f'读取 {src_path}')
    src = Image.open(src_path)
    if src.mode != 'RGB':
        src = src.convert('RGB')
    sw, sh = src.size
    if abs(sw / sh - 2.0) > 0.01:
        print(f'警告：源图不是 2:1（{sw}×{sh}），瓦片会出现拉伸', file=sys.stderr)

    # 最深层先一次性重采样到位，之后逐级减半（避免多次大图 LANCZOS）
    top_w = tile * (2 << max_level)
    top_h = tile * (1 << max_level)
    print(f'源图 {sw}×{sh} → 最大层级 L{max_level} = {top_w}×{top_h}')
    level_img = src.resize((top_w, top_h), Image.LANCZOS)
    del src

    for level in range(max_level, -1, -1):
        w = tile * (2 << level)
        h = tile * (1 << level)
        if level_img.size != (w, h):
            level_img = level_img.resize((w, h), Image.LANCZOS)
        n = save_level(level_img, level, out_dir, tile, args.quality)
        print(f'  L{level}: {2 << level}×{1 << level} 瓦片 ({n})  '
              f'{time.time() - t0:.0f}s')
    level_img.close()

    write_tms_xml(out_dir, max_level, tile)

    total = 0
    for root, _dirs, files in os.walk(out_dir):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    tiles = sum(len(files) for _r, _d, files in os.walk(out_dir)) - 1
    print(f'完成：{tiles} 瓦片，{total / 1048576:.1f} MB，耗时 {time.time() - t0:.0f}s')
    print(f'输出：{os.path.abspath(out_dir)}')


if __name__ == '__main__':
    main()
