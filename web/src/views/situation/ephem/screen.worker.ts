/**
 * 威胁筛选 Worker：把「星历 × 全目录」的粗筛/精筛移出主线程，避免 72h × 数千目标的
 * 传播计算卡住三维渲染与交互。
 *
 * 两种任务：
 * - full：本星状态序列 × 预过滤后的目录快照 → 威胁事件（progress + done）；
 * - pairs：机动前/后两套状态序列 × Top-20 对手 → 单对重筛对比行（pairsDone）。
 */
import { screenEphemeris, screenPair } from './screening'
import type { CatalogSnapshotEntry, PairCompareRow, PairTarget, ScreenOptions } from './screening'
import type { EphemSet, EphemState, ThreatEvent } from './types'

export interface ScreenRequest {
  type?: 'full'
  id: string
  norad: number
  /** 本星名称：筛选内核按「名称 + NORAD」排除自身，缺了名称会漏掉自身 */
  name?: string
  states: EphemState[]
  catalog: CatalogSnapshotEntry[]
  opt: ScreenOptions
}

/** 机动前后对比：同一批对手分别对「原方案 / 机动后」两套状态重筛 */
export interface PairScreenRequest {
  type: 'pairs'
  id: string
  norad: number
  statesBefore: EphemState[]
  statesAfter: EphemState[]
  others: PairTarget[]
  opt: ScreenOptions
}

export type ScreenResponse =
  | { type: 'progress'; p: number }
  | { type: 'done'; events: ThreatEvent[] }
  | { type: 'pairsDone'; rows: PairCompareRow[] }
  | { type: 'error'; message: string }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ScreenRequest | PairScreenRequest>) => void) | null
  postMessage: (data: ScreenResponse) => void
}

ctx.onmessage = (e) => {
  try {
    const d = e.data
    if (d.type === 'pairs') {
      const before = { id: d.id, norad: d.norad, states: d.statesBefore }
      const after = { id: d.id, norad: d.norad, states: d.statesAfter }
      const rows: PairCompareRow[] = []
      for (let i = 0; i < d.others.length; i++) {
        const other = d.others[i]
        const b = screenPair(before, other, d.opt)
        if (b) rows.push({ norad: other.norad, name: other.name, before: b, after: screenPair(after, other, d.opt) })
        // 进度节流：每 25% 回一次
        const p = (i + 1) / d.others.length
        if (p >= 1 || Math.floor(p * 4) !== Math.floor((i / d.others.length) * 4)) {
          ctx.postMessage({ type: 'progress', p })
        }
      }
      ctx.postMessage({ type: 'pairsDone', rows })
      return
    }

    const { id, norad, name, states, catalog, opt } = d
    // screenEphemeris 只用到 name / states / id / norad，这里按结构构造最小对象
    const set = { id, norad, name, states } as unknown as EphemSet
    let lastTick = 0
    const events = screenEphemeris(set, catalog, opt, (p) => {
      // 进度节流：每 5% 才回一次消息，避免主线程被消息淹没
      if (p - lastTick >= 0.05 || p >= 1) {
        lastTick = p
        ctx.postMessage({ type: 'progress', p })
      }
    })
    ctx.postMessage({ type: 'done', events })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error)?.message || '筛选失败' })
  }
}
