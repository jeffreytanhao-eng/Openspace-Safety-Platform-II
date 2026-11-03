/**
 * 坐标系与协方差旋转（Epic E1，移植自参考项目 heat-sidecar/src/screen/frames.ts，同算法）。
 *
 * 所有距离 / 协方差 / Pc 一律在 J2000（EME2000）中计算：
 * SGP4 输出 TEME，与 J2000 相差岁差 + 章动（2020s 约 8~45 km），必须显式转换。
 * 渲染用的 a_* / b_* / mid_* 再转回 TEME（km），与态势场景其它卫星口径一致。
 */

export type Vec3 = [number, number, number]

/** 儒略日（UTC） */
export function julianDate(utcMs: number): number {
  return utcMs / 86400000 + 2440587.5
}

const ARCSEC_RAD = Math.PI / (180 * 3600)

type Mat3 = [Vec3, Vec3, Vec3]

function mulMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
  ]
}

function mulMatT(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]
  ]
}

function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return out
}

function rotX(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c]
  ]
}

function rotY(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c]
  ]
}

function rotZ(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1]
  ]
}

/** J2000 → 瞬时真赤道真春分点（IAU-76 岁差 + IAU-80 章动 4 主项） */
function j2000ToTod(utcMs: number): Mat3 {
  const t = (julianDate(utcMs) - 2451545.0) / 36525
  const t2 = t * t
  const t3 = t2 * t

  const zeta = (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_RAD
  const zed = (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_RAD
  const theta = (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_RAD
  const precession = mulMat3(mulMat3(rotZ(-zed), rotY(theta)), rotZ(-zeta))

  const deg = Math.PI / 180
  const l = (134.96298 + 477198.867398 * t + 0.0086972 * t2) * deg
  const lp = (357.52772 + 35999.05034 * t - 0.0001603 * t2) * deg
  const f = (93.27191 + 483202.017538 * t - 0.0036825 * t2) * deg
  const d = (297.85036 + 445267.11148 * t - 0.0019142 * t2) * deg
  const om = (125.04452 - 1934.136261 * t + 0.0020708 * t2) * deg

  const NUT: [number, number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5]
  ]
  let dPsi = 0
  let dEps = 0
  for (const [cl, clp, cf, cd, com, p0, p1, e0, e1] of NUT) {
    const arg = cl * l + clp * lp + cf * f + cd * d + com * om
    dPsi += (p0 + p1 * t) * Math.sin(arg)
    dEps += (e0 + e1 * t) * Math.cos(arg)
  }
  const epsMean = (84381.448 - 46.815 * t - 0.00059 * t2 + 0.001813 * t3) * ARCSEC_RAD
  const dpsi = dPsi * 1e-4 * ARCSEC_RAD
  const deps = dEps * 1e-4 * ARCSEC_RAD
  const nutation = mulMat3(mulMat3(rotX(-(epsMean + deps)), rotZ(-dpsi)), rotX(epsMean))

  return mulMat3(nutation, precession)
}

/** TEME → J2000（速度用同一旋转矩阵，忽略旋转率项） */
export function temeToJ2000(r: Vec3, v: Vec3, utcMs: number): { r: Vec3; v: Vec3 } {
  const m = j2000ToTod(utcMs)
  return { r: mulMatT(m, r), v: mulMatT(m, v) }
}

/** J2000 → TEME（渲染用） */
export function j2000ToTeme(r: Vec3, v: Vec3, utcMs: number): { r: Vec3; v: Vec3 } {
  const m = j2000ToTod(utcMs)
  return { r: mulMat(m, r), v: mulMat(m, v) }
}

/* ---------------- 向量 / 基 / 协方差旋转 ---------------- */

export function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** UVW（= RSW/RTN）基，行向量 [U,V,W] */
export function uvwBasis(r: Vec3, v: Vec3): Mat3 {
  const rn = norm3(r) || 1
  const u: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn]
  const h = cross(r, v)
  const hn = norm3(h)
  let w: Vec3
  if (hn < 1e-12) {
    let ref: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const d0 = dot(ref, u)
    ref = [ref[0] - d0 * u[0], ref[1] - d0 * u[1], ref[2] - d0 * u[2]]
    const rn2 = norm3(ref) || 1
    w = [ref[0] / rn2, ref[1] / rn2, ref[2] / rn2]
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

/** out = M·C·Mᵀ（M = blockdiag(m,m)，6x6 行主序） */
export function rotateCov6(cov: Float64Array, m: Mat3): Float64Array {
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

/** UVW 协方差 → ECI(J2000)：cov_eci = Bᵀ·cov_uvw·B */
export function uvwCovToEci(cov: Float64Array, r: Vec3, v: Vec3): Float64Array {
  const b = uvwBasis(r, v)
  const t: Mat3 = [
    [b[0][0], b[1][0], b[2][0]],
    [b[0][1], b[1][1], b[2][1]],
    [b[0][2], b[1][2], b[2][2]]
  ]
  return rotateCov6(cov, t)
}

/** 21 项下三角（行主序 C11,C21,C22,C31,…）→ 6x6 对称阵 */
export function fromLower21(vals: ArrayLike<number>, offset = 0): Float64Array {
  const out = new Float64Array(36)
  let k = offset
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j <= i; j++) {
      const x = vals[k++] ?? 0
      out[i * 6 + j] = x
      out[j * 6 + i] = x
    }
  }
  return out
}
