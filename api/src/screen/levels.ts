/**
 * 危险等级统一口径（R1-1）：筛查产出与 CDM 入站共用同一套阈值与聚合规则。
 *
 * 判定顺序：
 *  1) 官方/自算 Pc：≥1e-4 红 / ≥1e-5 橙 / ≥1e-7 黄；
 *  2) 稀释兜底：中心 Pc 低但 PcMax ≥1e-4 → 黄（diluted）；
 *  3) 距离兜底（仅当无 Pc，即官方 CDM 未给出碰撞概率时）：脱靶 ≤1 km 橙 / ≤5 km 黄。
 *     该档为「距离关注」，用于官方 CDM 只发布高 Pc 报文、中间档缺数据时的诚实分层，
 *     不代表碰撞认证结论（见开源 Pc 标注：作业辅助，非认证 CARA）。
 */
export type EventLevel = 'red' | 'orange' | 'yellow' | 'low'

export const LEVEL_RANK: Record<EventLevel, number> = { red: 3, orange: 2, yellow: 1, low: 0 }

export const PC_RED = 1e-4
export const PC_ORANGE = 1e-5
export const PC_YELLOW = 1e-7

/** 无 Pc 时的距离兜底门限（km） */
export const MISS_ORANGE_KM = 1
export const MISS_YELLOW_KM = 5

/** 分级依据：Pc 判定 / 距离兜底 / 不足 */
export type LevelBasis = 'pc' | 'miss' | 'none'

export interface LevelResult {
  level: EventLevel
  diluted: boolean
  basis: LevelBasis
}

/**
 * 筛查产出口径：低于黄档且未稀释 → 返回 null（该事件不落库）。
 * pcMax 用于稀释判断（中心 Pc 低但最大 Pc 达红档）。
 */
export function levelOfPc(pc: number, pcMax = 0): { level: Exclude<EventLevel, 'low'>; diluted: boolean } | null {
  if (pc >= PC_RED) return { level: 'red', diluted: false }
  if (pc >= PC_ORANGE) return { level: 'orange', diluted: false }
  if (pc >= PC_YELLOW) return { level: 'yellow', diluted: false }
  if (pcMax >= PC_RED) return { level: 'yellow', diluted: true }
  return null
}

/**
 * 事件聚合口径（CDM 列表 / 日报 / 态势云）：总是返回等级，低档落 low。
 * 官方 CDM 只发布高 Pc 报文时，用脱靶距离补齐橙/黄档，避免列表只剩红/灰。
 */
export function levelOfEvent(
  pc: number | null,
  missKm: number | null,
  pcMax: number | null = null
): LevelResult {
  if (pc !== null && Number.isFinite(pc)) {
    const byPc = levelOfPc(pc, pcMax ?? 0)
    if (byPc) return { level: byPc.level, diluted: byPc.diluted, basis: 'pc' }
  }
  if (missKm !== null && Number.isFinite(missKm)) {
    if (missKm <= MISS_ORANGE_KM) return { level: 'orange', diluted: false, basis: 'miss' }
    if (missKm <= MISS_YELLOW_KM) return { level: 'yellow', diluted: false, basis: 'miss' }
  }
  return { level: 'low', diluted: false, basis: 'none' }
}
