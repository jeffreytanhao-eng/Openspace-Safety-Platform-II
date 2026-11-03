/**
 * Chan / Alfano 碰撞概率方法（E3 多算法比对）。
 * 移植自 SatGuard 参考实现（github.com/cesabici-bit/satguard，src/satguard/assess/）：
 *  - chan2D   : 非中心 χ² 的 Poisson 混合级数（Chan 2008 §4；各向异性用等效方差近似）
 *  - alfano1D : 极坐标角向积分 Bessel I0 降维的一维积分（Alfano 2005）
 * 三方法共用同源输入（encounterPlane 投影结果）：交会平面内 miss 分量 (mx, my)
 * 与联合协方差 2x2 投影 c2，单位 km / km²；Foster = pc.ts 的 2D 数值盘积分作基准。
 * 注：Chan/Alfano 对强各向异性是近似（级数 u 项用几何平均方差 / 径向指数用
 * trace(C⁻¹)/2），Foster 数值积分无此近似，方法间小差异属预期，由一致性灯呈现。
 */
import type { Mat2 } from './pc.js'
import { gaussLegendre64 } from './pc.js'

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/** 对称 2x2 解析特征分解：特征值升序 + 对应单位列向量（v1 对应 l1） */
export function eigh2x2(c: Mat2): { vals: [number, number]; vecs: [[number, number], [number, number]] } {
  const { c11, c12, c22 } = c
  const halfT = (c11 + c22) / 2
  const d = Math.hypot((c11 - c22) / 2, c12)
  const l1 = halfT - d
  const l2 = halfT + d
  // c12≈0 时特征向量为坐标轴（l1 取较小对角元对应的轴）；否则取第二行零化向量 [l1−c22, c12]
  let v1: [number, number]
  if (Math.abs(c12) <= 1e-12 * Math.max(Math.abs(c11), Math.abs(c22), 1e-300)) {
    v1 = c11 <= c22 ? [1, 0] : [0, 1]
  } else {
    v1 = [l1 - c22, c12]
  }
  const n = Math.hypot(v1[0], v1[1])
  v1 = [v1[0] / n, v1[1] / n]
  return { vals: [l1, l2], vecs: [v1, [-v1[1], v1[0]]] }
}

/** 修正第一类零阶 Bessel：I0(x) = Σ (x²/4)^k / (k!)²，幂级数递推 */
export function besselI0(x: number): number {
  const ax = Math.abs(x)
  if (ax < 1e-12) return 1
  const half = (ax * ax) / 4
  let sum = 1
  let term = 1
  for (let k = 1; k < 200; k++) {
    term *= half / (k * k)
    sum += term
    if (term < 1e-18 * sum) break
  }
  return sum
}

/** 近圆协方差（两特征值比 ∈ (0.99,1.01)）共用的一阶精确式 */
function circularFirstOrder(dSq: number, hbrKm: number, s1: number, s2: number): number {
  const s = (s1 + s2) / 2
  return clamp01(((hbrKm * hbrKm) / (2 * s)) * Math.exp(-dSq / (2 * s)))
}

/**
 * Chan 方法：非中心 χ² Poisson 混合级数。
 * miss 旋到主轴 → nc = μ1²/σ1² + μ2²/σ2²，u = R²/(2√(σ1²σ2²))（几何平均等效方差），
 * Pc = exp(−nc/2)·Σ_k (nc/2)^k/k!·[1 − exp(−u)·Σ_{j≤k} u^j/j!]（200 项封顶）。
 */
export function chan2D(mx: number, my: number, c: Mat2, hbrKm: number): number {
  if (!(hbrKm > 0)) return 0
  const { vals, vecs } = eigh2x2(c)
  const [s1, s2] = vals
  if (!(s1 > 0) || !(s2 > 0)) return 0
  if (![mx, my].every((x) => Number.isFinite(x))) return 0

  const ratio = s1 / s2
  if (ratio > 0.99 && ratio < 1.01) {
    return circularFirstOrder(mx * mx + my * my, hbrKm, s1, s2)
  }

  const mu1 = vecs[0][0] * mx + vecs[0][1] * my
  const mu2 = vecs[1][0] * mx + vecs[1][1] * my
  const nc = (mu1 * mu1) / s1 + (mu2 * mu2) / s2
  const u = (hbrKm * hbrKm) / (2 * Math.sqrt(s1 * s2))
  const ncHalf = nc / 2
  const expNegU = Math.exp(-u)

  let pc = 0
  let poisson = Math.exp(-ncHalf) // k=0：exp(−nc/2)·(nc/2)^0/0!
  let uj = 1 // u^j/j! 递推项
  let inner = 1 // Σ_{j≤k} u^j/j!
  for (let k = 0; k < 200; k++) {
    if (k > 0) {
      poisson *= ncHalf / k
      uj *= u / k
      inner += uj
    }
    pc += poisson * (1 - expNegU * inner)
    if (k > 5 && Math.abs(poisson) < 1e-16) break
  }
  return clamp01(pc)
}

/**
 * Alfano 方法：极坐标角向积分用 Bessel I0 降维后的一维数值积分（SatGuard 校正式）。
 * Pc = exp(−c)/√det · ∫₀^R r·exp(−a·r²)·I0(r·|C⁻¹μ|) dr，
 * a = trace(C⁻¹)/2，c = μᵀC⁻¹μ/2，μ = (mx, my)；GL64 节点积分。
 */
export function alfano1D(mx: number, my: number, c: Mat2, hbrKm: number): number {
  if (!(hbrKm > 0)) return 0
  if (![mx, my].every((x) => Number.isFinite(x))) return 0
  const det = c.c11 * c.c22 - c.c12 * c.c12
  if (!(det > 0) || !Number.isFinite(det)) return 0
  const inv11 = c.c22 / det
  const inv12 = -c.c12 / det
  const inv22 = c.c11 / det

  // 近圆且无相关：与 Chan 圆分支同式（SatGuard 同口径）
  const ratio = c.c11 / c.c22
  if (ratio > 0.99 && ratio < 1.01 && Math.abs(c.c12) < 1e-10 * Math.abs(c.c11)) {
    return circularFirstOrder(mx * mx + my * my, hbrKm, c.c11, c.c22)
  }

  const invMx = inv11 * mx + inv12 * my
  const invMy = inv12 * mx + inv22 * my
  const a = 0.5 * (inv11 + inv22)
  const cExp = 0.5 * (mx * invMx + my * invMy)
  const bNorm = Math.hypot(invMx, invMy)

  const { x: gx, w: gw } = gaussLegendre64()
  const halfR = hbrKm / 2
  let sum = 0
  for (let i = 0; i < gx.length; i++) {
    const r = halfR * (gx[i] + 1)
    const expo = -a * r * r
    if (expo < -700) continue
    sum += gw[i] * r * Math.exp(expo) * besselI0(r * bNorm)
  }
  return clamp01((Math.exp(-cExp) / Math.sqrt(det)) * halfR * sum)
}
