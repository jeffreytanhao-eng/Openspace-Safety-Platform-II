/**
 * 卫星领域类型收口（卫星类型 / 轨道类型等领域枚举统一定义于此）
 * 供 sat_public.ts 与 /situation 场景消费，字段结构与服务端保持一致。
 */

/* ============================================================
 * TLE / 星座点云（原 views/mui/sat_tle/index.ts）
 * ============================================================ */

export interface SatTleItem {
  id: number
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
  /** 编目国/机构代码（Space-Track COUNTRY_CODE，已按 sat_owner 字典归一，如 PRC→CN） */
  owner_code: string
  /** 编目国/机构中文名（列表接口 JOIN sat_owner 附带） */
  owner_name?: string | null
  /** 编目国/机构旗帜图地址（同上） */
  owner_flag?: string | null
  regime: string
  epoch: string
  mean_motion: number
  mean_motion_dot: number | null
  ecc: number
  incl: number
  raan: number
  arg_perigee: number
  mean_anomaly: number
  bstar: number | null
  rev_num: number
  period: number
  semimajor_axis: number
  apogee: number
  perigee: number
  tle_line1: string
  tle_line2: string
  decay_date?: string | null // Space-Track 不返回该字段，仅前端详情展示兜底
  is_active: number
  source: string
  created_at: string
  updated_at: string
  /** 历元距今天数（后端 DATEDIFF 计算，列表接口附带；null = 无历元） */
  age_days?: number | null
  /** 用途类型码（卫星资料库匹配写入，见下方 PURPOSE_TYPES；不随 TLE 同步变化） */
  purpose_type?: string
  /** 发射地（卫星资料库匹配同步补全：本地发射记录优先，缺失时用 Space-Track satcat 兜底） */
  launch_site?: string
  /** 匹配命中的资料库条目 ID（sat_catalog.id） */
  catalog_id?: number | null
  /** auto=资料库匹配 / manual=管理员手改（手工行不再被匹配覆盖） */
  match_source?: string
}

/** 星座点云坐标（后端按 SGP4 一次性传播全部在轨物体，t 为 unix ms 快照） */
export interface ConstellationPoint {
  norad_id: number
  object_name: string
  object_type: string
  /** 轨道区域代码（LEO/MEO/GEO/HEO/OTHER，用于卫星列表区域筛选） */
  regime?: string
  /** 后端按快照时刻返回的 ECI 一次性位置（前端初始点云） */
  x: number
  y: number
  z: number
  /** 后端同一次传播一并返回的 ECI 速度（km/s），前端初始点云无需再跑一次 SGP4 取速度 */
  vx?: number
  vy?: number
  vz?: number
  /** 轨道高度（km，后端传播时刻计算） */
  alt?: number | null
  /** 所属星座名称列表 */
  cons?: string[]
  /** 编目国代码（owner_code，如 US/CN/CIS；空为 '--'），供「按国家着色」 */
  owner_code?: string
  /** 近地点高度（km，原始 TLE 根数派生量），供「按近地点着色」 */
  perigee?: number | null
  /** 轨道周期（分钟，原始 TLE 根数派生量），供「按周期着色」 */
  period?: number | null
  /** 轨道倾角（度，原始 TLE 根数派生量），供「按倾角着色」 */
  incl?: number | null
}

/** 点云紧凑编码的类型枚举（与后端 POINT_TYPE_KEYS 一致；后端遇表外值会按序追加，
 *  故一律以响应里的 typeIndex 为准，这里只作为缺省兜底） */
export const DEFAULT_POINT_TYPE_KEYS = ['UNKNOWN', 'PAYLOAD', 'ROCKET_BODY', 'DEBRIS']
/** 点云紧凑编码的轨道区域枚举（与后端 POINT_REGIME_KEYS 一致） */
export const DEFAULT_POINT_REGIME_KEYS = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']

/**
 * /sat_tle/constellation 响应（紧凑数组，3.5 万在轨物体必须控体积）
 * list 每项 = [norad_id, nameIdx, typeIdx, regimeIdx, x, y, z, vx, vy, vz, alt, cons,
 *              ownerIdx, perigee, period, incl]，
 * nameIdx / typeIdx / regimeIdx / ownerIdx 分别是 nameIndex / typeIndex / regimeIndex / countryIndex 数组的下标。
 * object_name 走 nameIndex 字典（碎片名前缀高度重复，字典化能砍掉可观体积）。
 * perigee / period / incl 为原始 TLE 根数派生量（km / 分钟 / 度），供前端分类着色。
 * 响应不再下发 TLE 两行（旧版占响应体积约 40%）：需要画轨道时改走 tle_lines 按需拉取。
 */
export interface ConstellationSnapshot {
  total: number
  skipped: number
  t: number
  typeIndex: string[]
  regimeIndex: string[]
  nameIndex: string[]
  /** 编目国代码字典（下标 0 为 '--' 空值），与 list 里的 ownerIdx 对应 */
  countryIndex?: string[]
  list: [
    number, number, number, number, number, number, number, number, number, number,
    number | null, string[], number, number | null, number | null, number | null
  ][]
}

/** 把紧凑点云还原成对象数组（前端内部统一用对象，避免各处再记下标） */
export function decodeConstellation(res: ConstellationSnapshot | null | undefined): ConstellationPoint[] {
  const list = res?.list
  if (!Array.isArray(list)) return []
  const types = res?.typeIndex?.length ? res.typeIndex : DEFAULT_POINT_TYPE_KEYS
  const regimes = res?.regimeIndex?.length ? res.regimeIndex : DEFAULT_POINT_REGIME_KEYS
  const names = res?.nameIndex || []
  const countries = res?.countryIndex || []
  return list.map((r) => ({
    norad_id: r[0],
    object_name: names[r[1]] || '',
    object_type: types[r[2]] || 'UNKNOWN',
    regime: regimes[r[3]] || 'OTHER',
    x: r[4],
    y: r[5],
    z: r[6],
    vx: r[7],
    vy: r[8],
    vz: r[9],
    alt: r[10],
    cons: r[11] || [],
    owner_code: countries[r[12]] || '--',
    perigee: r[13] ?? null,
    period: r[14] ?? null,
    incl: r[15] ?? null
  }))
}

/* ============================================================
 * 星座（原 views/mui/sat_constellation/index.ts）
 * ============================================================ */

export interface ConstellationItem {
  id: number
  code: string
  name: string
  name_en: string
  regime: string
  regime_label: string
  status: string
  plan_count: number
  keywords: string[]
  satellite_count: number
  /** 已关联但非载荷卫星的数量（箭体 / 碎片 / 未知物体）：>0 表示该星座关联数据混入了非卫星 */
  mixed_count?: number
  created_at: string
  updated_at: string
}

/* ============================================================
 * 交会事件（原 views/mui/sat_conj/index.ts）
 * ============================================================ */

export interface ConjEvent {
  id: number
  run_id: number
  norad_a: number
  name_a: string
  type_a: string
  norad_b: number
  name_b: string
  type_b: string
  tca: string
  min_distance: number
  rel_speed: number
  altitude: number
  cri: number
  crp: number
  risk_level: number
  miss_level: number
  level: 'danger' | 'warning' | 'info'
  created_at: string
  /** 目标 A / B 的 TLE 历元距今天数（后端按需回查下发）。
   *  本模块目标是「全部在轨物体」，不按 TLE 时效过滤 —— 陈旧 TLE 的位置已不可信，
   *  前端据此在目标 A/B 上标注；null = 无历元或查不到。 */
  age_a?: number | null
  age_b?: number | null
}

export interface ConjQuery {
  page?: number
  pageSize?: number
  keyword?: string
  level?: string
  dateFrom?: string
  dateTo?: string
  /** 指定批次回显（扫描日志「查看」）；不传 = 默认最近一次全量批次 */
  run_id?: number
}

/* ============================================================
 * 知识图谱（原 views/mui/kg/index.ts，仅保留邻居展开所需类型）
 * ============================================================ */

export type KgType =
  | 'satellite'
  | 'rocket_body'
  | 'launch'
  | 'vehicle'
  | 'site'
  | 'owner'
  | 'catalog'
  | 'constellation'

/** 图谱节点 */
export interface KgNode {
  id: string
  name: string
  type: KgType
  sub: string
  size: number
}

/** 图谱连线 */
export interface KgEdge {
  source: string
  target: string
  label: string
}

/** 中心节点（无 size，由前端按中心固定值渲染） */
export interface KgCenter {
  id: string
  name: string
  type: KgType
  sub: string
}

/** 邻居展开结果 */
export interface KgNeighbors {
  center: KgCenter
  nodes: KgNode[]
  edges: KgEdge[]
  /** 每类邻居的真实总数（前端提示「共 N 个，已展开 M 个」） */
  totals: Record<string, number>
  /** 被 perEdge 截断的类型 */
  truncated: Record<string, boolean>
}

/* ============================================================
 * 卫星资料库用途类型（原 views/mui/sat_catalog/index.ts）
 * ============================================================ */

/** 用途类型（purpose_type）10 类码 → 中文标签（与后端 lib/satCatalogMatch.js 的 PURPOSE_TYPES 一致） */
export const PURPOSE_TYPES: Record<string, string> = {
  surveying: '测绘',
  navigation: '导航',
  tech_test: '技术试验',
  military: '军事',
  science: '科学与教育',
  meteorology: '气象',
  communication: '通信',
  remote_sensing: '遥感',
  on_orbit_service: '在轨服务',
  other: '其他'
}

/** 用途类型下拉选项 */
export const PURPOSE_OPTIONS = Object.entries(PURPOSE_TYPES).map(([value, label]) => ({ value, label }))

export function purposeLabel(code?: string) {
  return PURPOSE_TYPES[String(code || '')] || ''
}
