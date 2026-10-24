import type { EphemFrame, Vec3 } from './types'
import { EARTH_OMEGA, gmstRad } from './time'

function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}

/**
 * 计算 UVW（= RSW/RTN）基，返回 3x3 行主序矩阵：
 * 第 0 行 U = r̂，第 1 行 V = Ŵ × Û，第 2 行 W = (r×v)/|r×v|。
 */
export function uvwBasis(r: Vec3, v: Vec3): number[][] {
  const rn = norm3(r) || 1
  const u: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn]
  const h = cross(r, v)
  const hn = norm3(h)
  let w: Vec3
  if (hn < 1e-12) {
    // 退化情形：速度与位置共线，随便取一个正交方向
    w = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const d = u[0] * w[0] + u[1] * w[1] + u[2] * w[2]
    w = [w[0] - d * u[0], w[1] - d * u[1], w[2] - d * u[2]]
    const wn2 = norm3(w) || 1
    w = [w[0] / wn2, w[1] / wn2, w[2] / wn2]
  } else {
    w = [h[0] / hn, h[1] / hn, h[2] / hn]
  }
  const vv = cross(w, u)
  return [
    [u[0], u[1], u[2]],
    [vv[0], vv[1], vv[2]],
    [w[0], w[1], w[2]]
  ]
}

/**
 * 用 3x3 旋转矩阵 m 左右夹乘 6x6 协方差（位置块与速度块分别旋转）：
 * out = M · C · Mᵀ，其中 M = blockdiag(m, m)。
 */
export function rotateCov6(cov: Float64Array, m: number[][]): Float64Array {
  const out = new Float64Array(36)
  for (let bi = 0; bi < 2; bi++) {
    for (let bj = 0; bj < 2; bj++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let s = 0
          for (let k = 0; k < 3; k++) {
            for (let l = 0; l < 3; l++) {
              s += m[i][k] * cov[(bi * 3 + k) * 6 + (bj * 3 + l)] * m[j][l]
            }
          }
          out[(bi * 3 + i) * 6 + (bj * 3 + j)] = s
        }
      }
    }
  }
  return out
}

/**
 * UVW（RTN）协方差 → ECI 协方差。
 * 基矩阵 B 的行为 U/V/W，则坐标变换矩阵为 Bᵀ，故 cov_eci = Bᵀ · cov_uvw · B。
 */
export function uvwCovToEci(cov: Float64Array, r: Vec3, v: Vec3): Float64Array {
  const b = uvwBasis(r, v)
  const t = [
    [b[0][0], b[1][0], b[2][0]],
    [b[0][1], b[1][1], b[2][1]],
    [b[0][2], b[1][2], b[2][2]]
  ]
  return rotateCov6(cov, t)
}

/**
 * ITRF/ECEF → ECI：绕 Z 轴旋转 GMST，速度再补上 ω×r 的牵连项。
 */
export function itrfToEci(r: Vec3, v: Vec3, epochMs: number): { r: Vec3; v: Vec3 } {
  const th = gmstRad(epochMs)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const re: Vec3 = [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]]
  const ve: Vec3 = [
    c * v[0] - s * v[1] - EARTH_OMEGA * re[1],
    s * v[0] + c * v[1] + EARTH_OMEGA * re[0],
    v[2]
  ]
  return { r: re, v: ve }
}

/**
 * 把任意参考系下的状态统一到 ECI。
 * UVW / TEME / EME2000 / ICRF 视为已近似惯性系（直接返回），仅 ITRF 做旋转。
 */
export function frameToEci(
  frame: EphemFrame,
  r: Vec3,
  v: Vec3,
  epochMs: number
): { r: Vec3; v: Vec3 } {
  if (frame === 'ITRF') return itrfToEci(r, v, epochMs)
  return { r: [r[0], r[1], r[2]], v: [v[0], v[1], v[2]] }
}
