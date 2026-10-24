/**
 * 背景星空 —— 装饰性星点层
 *
 * 历史上项目曾有「随机撒点」的星空背景，后被三垣二十八宿 / 西方 88 星座取代而移除，
 * 画面底色变成纯黑。现按需求恢复「背景有星」的观感：重新引入一层与星官体系解耦的
 * 稠密星点，只做装饰（无天文含义）。与既有分层错开：三垣二十八宿 / 88 星座星点在
 * 半径 150 的壳上（见 lunarMansions.MANSION_RADIUS），本层放 170 的外壳，太阳标记
 * （SUN_MARKER_DIST = 200）仍在其外，互不重叠。
 *
 * ── 实现要点 ────────────────────────────────────────────────
 *  · 确定性伪随机（LCG）：每次构建结果完全一致，热重建 / 页面切换星象不跳变；
 *  · 均匀球面分布（z = 2u−1 法），两极不聚堆；
 *  · 两档尺寸：暗星占绝大多数、亮星少量点缀，加色混合下层次自然；
 *  · 色温微差（冷蓝 / 中性白 / 暖黄）近似真实星表的色指数分布；
 *  · depthTest 默认开启 + 隐形遮挡球（BaseScene.cesiumOccluder）最先写深度 ——
 *    星点转到地球背面即被正确遮挡；
 *  · raycast 置空：纯装饰层，不参与任何拾取。
 */
import * as THREE from 'three'

/** 背景星空壳半径（场景单位，1 = 地球半径） */
const STAR_SHELL_R = 170
/** 暗星 / 亮星数量与点尺寸（世界单位；sizeAttenuation 下随距离缩放） */
const DIM_COUNT = 2200
const BRIGHT_COUNT = 260
const DIM_SIZE = 1.2
const BRIGHT_SIZE = 2.4

/** 确定性伪随机数（LCG）：每次构建序列一致，避免热重建 / 页面切换时星象跳变 */
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 软圆点贴图：中心亮核快速衰减，加色混合下呈自然星点（程序化生成，不引入图片资源） */
function starSpriteTexture(size = 64): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  const gd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gd.addColorStop(0, 'rgba(255,255,255,1)')
  gd.addColorStop(0.3, 'rgba(255,255,255,0.85)')
  gd.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gd
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 星点色温：冷蓝 / 中性白 / 微冷白 / 暖黄（权重偏中性，近似真实色指数分布） */
const STAR_TINTS = [
  new THREE.Color(0xcfe0ff),
  new THREE.Color(0xffffff),
  new THREE.Color(0xf5f8ff),
  new THREE.Color(0xffedc8)
]

export function buildStarfield(): THREE.Group {
  const group = new THREE.Group()
  const tex = starSpriteTexture()

  /** 构建一档星点层（暗星 / 亮星各一层，尺寸与亮度区间不同） */
  const buildLayer = (count: number, size: number, opacity: number, bMin: number, bMax: number, seed: number) => {
    const rng = makeRng(seed)
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    const c = new THREE.Color()
    for (let i = 0; i < count; i++) {
      // 均匀球面分布：天顶角余弦均匀取 [-1,1]，方位角均匀取 [0,2π)
      const z = rng() * 2 - 1
      const phi = rng() * Math.PI * 2
      const rxy = Math.sqrt(Math.max(0, 1 - z * z))
      pos[i * 3] = Math.cos(phi) * rxy * STAR_SHELL_R
      pos[i * 3 + 1] = z * STAR_SHELL_R
      pos[i * 3 + 2] = Math.sin(phi) * rxy * STAR_SHELL_R
      // 色温 + 亮度抖动（暗星压得更暗，拉开远近层次）
      c.copy(STAR_TINTS[(rng() * STAR_TINTS.length) | 0])
      const b = bMin + rng() * (bMax - bMin)
      col[i * 3] = c.r * b
      col[i * 3 + 1] = c.g * b
      col[i * 3 + 2] = c.b * b
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      map: tex,
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity
    }))
    pts.frustumCulled = false
    pts.raycast = () => {} // 纯装饰层，不参与拾取
    group.add(pts)
  }

  buildLayer(DIM_COUNT, DIM_SIZE, 0.8, 0.4, 0.9, 20260101)
  buildLayer(BRIGHT_COUNT, BRIGHT_SIZE, 1.0, 0.85, 1.0, 20260202)
  return group
}
