/**
 * 碰撞概率 Pc（Foster 2D 交会平面法 + Alfano 缩放得 PcMax）。
 * 与前端 src/views/situation/ephem/probability.ts 同一算法、同一实现细节；
 * 两侧结果可互相校验（P5 CDM 对比验证会用到）。
 */
import type { Vec3 } from './frames.js'
import { cross, dot, norm3 } from './frames.js'

interface Mat2 {
  c11: number
  c12: number
  c22: number
}

export interface PcInput {
  /** TCA 处相对位置（J2000，km）：对方 − 本星 */
  missVec: Vec3
  /** TCA 处相对速度（J2000，km/s） */
  relVelVec: Vec3
  covA: Float64Array
  covB: Float64Array
  hbrKm: number
}

export interface PcResult {
  pc: number
  pcMax: number
  diluted: boolean
}

const DANGER_PC = 1e-4

let glCache: { x: number[]; w: number[] } | null = null

function gaussLegendre64(): { x: number[]; w: number[] } {
  if (glCache) return glCache
  const n = 64
  const x = new Array<number>(n)
  const w = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let pp = 0
    for (let it = 0; it < 100; it++) {
      let p1 = 1
      let p2 = 0
      for (let j = 0; j < n; j++) {
        const p3 = p2
        p2 = p1
        p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1)
      }
      pp = (n * (z * p1 - p2)) / (z * z - 1)
      const z1 = z
      z = z1 - p1 / pp
      if (Math.abs(z - z1) < 1e-15) break
    }
    x[i] = z
    w[i] = 2 / ((1 - z * z) * pp * pp)
  }
  glCache = { x, w }
  return glCache
}

function positionBlock(cov: Float64Array): number[] | null {
  if (!cov || cov.length < 36) return null
  const out = [cov[0], cov[1], cov[2], cov[6], cov[7], cov[8], cov[12], cov[13], cov[14]]
  return out.every((x) => Number.isFinite(x)) ? out : null
}

function diskGaussIntegral(mx: number, my: number, c: Mat2, radiusKm: number): number {
  if (!(radiusKm > 0)) return 0
  const det = c.c11 * c.c22 - c.c12 * c.c12
  if (!(det > 0) || !Number.isFinite(det)) return 0
  const inv11 = c.c22 / det
  const inv12 = -c.c12 / det
  const inv22 = c.c11 / det
  if (![inv11, inv12, inv22].every((x) => Number.isFinite(x))) return 0

  const { x: gx, w: gw } = gaussLegendre64()
  const halfR = radiusKm / 2
  let sum = 0
  for (let i = 0; i < gx.length; i++) {
    const r = halfR * (gx[i] + 1)
    const wr = halfR * gw[i]
    for (let j = 0; j < gx.length; j++) {
      const th = Math.PI * (gx[j] + 1)
      const wth = Math.PI * gw[j]
      const dx = r * Math.cos(th) - mx
      const dy = r * Math.sin(th) - my
      const expo = -0.5 * (inv11 * dx * dx + 2 * inv12 * dx * dy + inv22 * dy * dy)
      if (expo < -700) continue
      sum += wr * wth * r * Math.exp(expo)
    }
  }
  const pdf = sum / (2 * Math.PI * Math.sqrt(det))
  return Number.isFinite(pdf) ? Math.min(1, Math.max(0, pdf)) : 0
}

function pcWithScale(k: number, mx: number, my: number, c: Mat2, radiusKm: number): number {
  return diskGaussIntegral(mx, my, { c11: c.c11 * k, c12: c.c12 * k, c22: c.c22 * k }, radiusKm)
}

const SCALE_MIN = 1e-3
const SCALE_MAX = 1e2
const SCALE_N = 48

export function collisionProbability(input: PcInput): PcResult {
  const zero: PcResult = { pc: 0, pcMax: 0, diluted: false }
  const { missVec, relVelVec, covA, covB, hbrKm } = input
  if (!(hbrKm > 0)) return zero
  if (![...missVec, ...relVelVec].every((x) => Number.isFinite(x))) return zero
  const vn = norm3(relVelVec)
  if (!(vn > 1e-9)) return zero

  const pa = positionBlock(covA)
  const pb = positionBlock(covB)
  if (!pa || !pb) return zero

  const n: Vec3 = [relVelVec[0] / vn, relVelVec[1] / vn, relVelVec[2] / vn]
  const md = dot(missVec, n)
  let xh: Vec3 = [missVec[0] - md * n[0], missVec[1] - md * n[1], missVec[2] - md * n[2]]
  let xn = norm3(xh)
  if (!(xn > 1e-9)) {
    const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const d0 = dot(ref, n)
    xh = [ref[0] - d0 * n[0], ref[1] - d0 * n[1], ref[2] - d0 * n[2]]
    xn = norm3(xh)
    if (!(xn > 1e-12)) return zero
  }
  xh = [xh[0] / xn, xh[1] / xn, xh[2] / xn]
  const yh = cross(n, xh)

  const c = new Array<number>(9)
  for (let i = 0; i < 9; i++) c[i] = pa[i] + pb[i]
  c[1] = c[3] = (c[1] + c[3]) / 2
  c[2] = c[6] = (c[2] + c[6]) / 2
  c[5] = c[7] = (c[5] + c[7]) / 2
  const proj = (u: Vec3, v: Vec3): number =>
    u[0] * (c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) +
    u[1] * (c[3] * v[0] + c[4] * v[1] + c[5] * v[2]) +
    u[2] * (c[6] * v[0] + c[7] * v[1] + c[8] * v[2])
  const c2: Mat2 = { c11: proj(xh, xh), c12: proj(xh, yh), c22: proj(yh, yh) }

  const mx = dot(missVec, xh)
  const my = dot(missVec, yh)

  const pc = pcWithScale(1, mx, my, c2, hbrKm)
  let pcMax = pc
  const logMin = Math.log10(SCALE_MIN)
  const logStep = (Math.log10(SCALE_MAX) - logMin) / (SCALE_N - 1)
  for (let i = 0; i < SCALE_N; i++) {
    const k = 10 ** (logMin + i * logStep)
    const v = pcWithScale(k, mx, my, c2, hbrKm)
    if (v > pcMax) pcMax = v
  }

  return { pc, pcMax, diluted: pcMax >= DANGER_PC && pc < DANGER_PC }
}
