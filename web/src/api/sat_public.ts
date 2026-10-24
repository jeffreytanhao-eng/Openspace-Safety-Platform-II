/**
 * 前台公开卫星接口（/cgi 免登录）
 * 供免登录页面（如 /test 3D 轨道视图）消费，与后台 /api 卫星逻辑保持一致。
 * 类型收口于 ./satTypes，保证字段结构前后端一致；函数走 httpCgi（baseURL='/cgi'），不触发登录校验。
 */
import { httpCgi } from '@/utils/request'
import type { ConstellationSnapshot, SatTleItem } from './satTypes'
import type { ConstellationItem } from './satTypes'
import type { ConjEvent, ConjQuery } from './satTypes'
import type { KgNeighbors } from './satTypes'

/** 三维视图数据源：tle=国际库（sat_tle，默认）/ aoe=太空地图 AOE 库（sat_aoe）。
 *  两套接口同构（点云 / TLE 两行 / 详情），仅路径前缀不同，故这里用 source 参数切换。 */
export type SatSource = 'tle' | 'aoe'

/** 数据源 → 接口路径前缀（非法值按国际库处理，与后端 constellationSnapshot 的回退口径一致） */
function satPrefix(source: SatSource = 'tle') {
  return source === 'aoe' ? '/sat_aoe' : '/sat_tle'
}

/** 星座点云坐标（后端按 SGP4 一次性传播全部在轨物体，t 为 unix ms 快照）
 *  紧凑数组 + 名称/枚举字典（不下发 TLE），用 decodeConstellation() 还原成对象数组；
 *  超时仍放宽到 90s 作为低速公网链路的兜底（后端已做进程内缓存，正常为秒级返回）。
 *  source：'tle' 国际库（默认）/ 'aoe' AOE 库，两库响应结构完全一致。 */
export function listConstellationPublic(t?: number, source: SatSource = 'tle') {
  return httpCgi<ConstellationSnapshot>({
    url: `${satPrefix(source)}/constellation`,
    method: 'get',
    timeout: 90000,
    params: t != null ? { t } : undefined
  })
}

/** 全部在轨物体的 TLE 两行（免登录）：点云接口已不带 TLE，
 *  画轨道线 / 悬停预览 / 过境轨迹时按需拉取一次并缓存 satrec。返回 [norad_id, tle_line1, tle_line2]。 */
export function listTleLinesPublic(source: SatSource = 'tle') {
  return httpCgi<{ total: number; list: [number, string, string][] }>({
    url: `${satPrefix(source)}/tle_lines`,
    method: 'get',
    timeout: 90000
  })
}

/** 单星详情（全字段，含 TLE 两行，供 3D 视图使用）；来源需与当前点云一致 */
export function getSatDetailPublic(noradId: number | string, source: SatSource = 'tle') {
  return httpCgi<SatTleItem>({ url: `${satPrefix(source)}/detail/${noradId}`, method: 'get' })
}

/** 轨道要素历史采样点（epoch = TLE 历元 ISO；高度 / 半长轴单位 km，周期单位分钟，角度单位度） */
export interface SatHistoryPoint {
  epoch: string
  apogee: number | null
  perigee: number | null
  semimajor_axis: number | null
  period: number | null
  ecc: number | null
  incl: number | null
}

/** 单星轨道要素历史（/situation 卫星详情面板「轨道高度变化图」+ 近地点变化率用，免登录只读）：
 *  数据源为归档历史 + 当前行，按 TLE 历元升序；来源需与当前点云一致。 */
export interface SatHistoryResult {
  norad_id: number
  object_name: string
  object_type: string
  regime: string
  source: SatSource
  total: number
  points: SatHistoryPoint[]
}

export function getSatHistoryPublic(noradId: number | string, source: SatSource = 'tle') {
  return httpCgi<SatHistoryResult>({ url: `${satPrefix(source)}/history/${noradId}`, method: 'get' })
}

/** 全部星座（下拉用，免登录） */
export function listAllConstellationsPublic() {
  return httpCgi<ConstellationItem[]>({ url: '/sat_constellation/all', method: 'get' })
}

/** 卫星所属星座条目（sat_constellation 主表的精简字段） */
export interface SatOfConstellation {
  id: number
  name: string
  /** 规划卫星总数（多星座时按此降序，规模大的在前） */
  plan_count?: number
  /** 该星座实际关联的载荷卫星数（口径同 /sat_constellation/all 的 satellite_count） */
  satellite_count?: number
}

/** 某颗卫星所属星座（/situation 卫星详情面板用，免登录、只读） */
export function listSatConstellationsPublic(noradId: number | string) {
  return httpCgi<SatOfConstellation[]>({ url: `/sat_constellation/of/${noradId}`, method: 'get' })
}

/** 资料库条目（/cgi/sat_catalog/of/:noradId 下发，sat_catalog 全字段 + 国家中文名/旗帜） */
export interface SatCatalogPublic {
  id: number
  name_cn: string
  name_en?: string
  /** 别名规则串（= ~ 子串 等语义，后台资料库维护） */
  aliases?: string
  /** 用途类型码（见 mui/sat_catalog 的 PURPOSE_TYPES） */
  purpose_type?: string
  country_code?: string
  /** 归属国家/地区中文名（按 country_code JOIN sat_owner 补） */
  country_name?: string
  /** 归属国家/地区旗帜（同上） */
  country_flag?: string
  agency?: string
  orbit_type?: string
  /** ★ 系列/条目级「发射日期」百科原文（卫星百科引导页该系列登记值，**不是这颗卫星的发射日期**） */
  launch_date?: string
  intl_desig?: string
  source?: string
  source_url?: string
  remark?: string
  /** ★ 本星真实发射时间（UTC "YYYY-MM-DD HH:mm:ss"）：按 launch_record（LEFT(sat_tle.intl_desig,8)=launch_tag）补，
   *  与知识图谱「所属发射」同一口径；未命中为 null */
  sat_launch_at?: string | null
  /** 本星所属发射批次 tag（launch_record.launch_tag，同上口径） */
  sat_launch_tag?: string | null
}

/** 某颗卫星命中的资料库条目（/situation 卫星详情面板内联展示，免登录、只读）：
 *  关联口径与知识图谱一致（sat_tle.catalog_id = sat_catalog.id），未命中返回 null（不报错）。 */
export function getSatCatalogOfSatellite(noradId: number | string) {
  return httpCgi<SatCatalogPublic | null>({ url: `/sat_catalog/of/${noradId}`, method: 'get' })
}

/** 知识图谱邻居展开（/situation 卫星详情面板内联展示，免登录、只读）：
 *  查询口径的单一实现是 server/lib/knowledgeGraph.js，与后台 /api/knowledge_graph/neighbors 完全一致。 */
export function getKgNeighborsPublic(params: { type: string; key: string; perEdge?: number }) {
  return httpCgi<KgNeighbors>({ url: '/kg/neighbors', method: 'get', params })
}

/** 碰撞热力事件（CDM：TCA + 双方 NORAD/名称 + 碰撞参数 + TLE/SGP4 传播的 ECI 坐标）
 *  渲染参数（color/risk/dens_boost/metric_text/day）由后端统一计算下发，前端零换算、直接消费。 */
export interface CdmHeatEvent {
  id: number
  cdm_id: string
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number
  rel_speed_km_per_s: number
  collision_probability: number
  hard_body_radius_m: number
  a_x: number; a_y: number; a_z: number
  b_x: number; b_y: number; b_z: number
  mid_x: number; mid_y: number; mid_z: number
  /* ---- 后端下发的渲染参数（前端不再自算配色 / 分级 / 密度） ---- */
  /** 分档配色（按当前来源口径：官方 CDM 按碰撞概率，本项目初筛按最近距离等级） */
  color: string
  /** 归一化风险权重 0~1（驱动热力云半径与核心点尺寸） */
  risk: number
  /** 聚类密度增益（同一片碰撞云内事件越多越大，已含 log2 换算） */
  dens_boost: number
  /** 指标展示文案（官方 CDM = 碰撞概率；本项目初筛 = 最近距离等级文案） */
  metric_text: string
  /** 按日切片归属天（1..days；days<=0「全部」时为 0） */
  day: number
  /* 以下为「本项目 SGP4 初筛」（/cgi/sat_conj/heatmap）与「交会分析」（/cgi/sat_cri/heatmap）专有字段；
     官方 CDM 来源不含这些字段，前端按 [heatSource] 区分口径后使用 */
  cri?: number
  crp?: number
  risk_level?: number
  miss_level?: number
  level?: string
  altitude?: number
}

/** 交会事件一端的经验误差椭球（TCA 处；σ 单位 km） */
export interface ConjEllipsoidSide {
  norad: number
  name: string
  objectType: string
  regime: string
  /** TCA 距该目标 TLE 历元的时长（小时）：σ 的分档依据 */
  dtHours: number
  /** TCA 处 ECI(TEME) 位置 km：椭球中心 */
  pos: { x: number; y: number; z: number }
  /** RTN 基单位向量（ECI 分量）：椭球三轴方向 */
  r: { x: number; y: number; z: number }
  t: { x: number; y: number; z: number }
  n: { x: number; y: number; z: number }
  /** 三轴 σ（km）：径向 / 沿迹 / 法向 */
  sigma: { sr: number; st: number; sn: number }
  /** model = 经验分桶模型；fallback = 无模型时的保守兜底公式 */
  sigmaSource: string
}

/** 交会事件两端的经验误差椭球（⚠ 经验 σ，非真实协方差） */
export interface ConjEllipsoidResult {
  tca: number | null
  model_source: string
  a: ConjEllipsoidSide | null
  b: ConjEllipsoidSide | null
  note: string
}

/** 取交会事件两端的经验误差椭球（三维场景绘制 + 详情面板展示用） */
export function getConjEllipsoid(params: { norad_a: number; norad_b: number; tca: number }) {
  return httpCgi<ConjEllipsoidResult>({ url: '/sat_conj/ellipsoid', method: 'get', params })
}

/** 图例条目（后端下发，前端直接渲染，不做阈值换算） */
export interface HeatLegendItem {
  color: string
  label: string
  thresh: string
}

/** 按日切片条目（后端下发计数，前端直接渲染） */
export interface HeatDayGroup {
  day: number
  date: string
  count: number
}

/** 碰撞热力接口返回体（两个来源共用同一结构） */
export interface HeatmapResult {
  list: CdmHeatEvent[]
  total: number
  days: number
  /** 实际展示的扫描批次 run_id（仅「本项目 SGP4 初筛」来源返回：总交会库当前批次；官方 CDM 来源为 null） */
  run_id?: number | null
  /** 配色图例（按来源口径，后端生成） */
  legend: HeatLegendItem[]
  /** 按日分组计数（days<=0「全部」时为空数组） */
  day_groups: HeatDayGroup[]
  /** 指标名（'碰撞概率' / '风险等级' / '交会风险概率 CRP'），供面板标题直接展示 */
  metric_label: string
  /** 口径标识（'pc' 官方 CDM 碰撞概率 / 'miss' 本项目初筛风险等级 / 'cri' 交会分析 CRP） */
  metric: 'pc' | 'miss' | 'cri'
}

/** 总交会库批次条目（/cgi/sat_conj/batches 下发，供前台「数据批次」下拉回看历史全量批次） */
export interface ConjBatchItem {
  id: number
  /** 扫描完成时间（DB created_at，YYYY-MM-DD HH:mm:ss） */
  created_at: string
  /** 本批次接近事件总数（含全部等级） */
  events: number
  /** 参与扫描的目标数 */
  total_objects: number
  /** 扫描范围文案（全量批次恒为「全量扫描（全体 × 全体）」） */
  scope: string
  /** 扫描模式（恒为 'all'） */
  mode?: string
}

/** 碰撞热力（免登录，Space-Track 官方 CDM）：未来 heatDays 天窗口内的碰撞事件，可选 norad 只看该卫星（A 或 B）涉及的事件 */
export function getCdmHeatmap(params?: { days?: number; norad?: number }) {
  return httpCgi<HeatmapResult>({
    url: '/sat_cdm/heatmap',
    method: 'get',
    params
  })
}

/** 碰撞热力（免登录，本项目 SGP4 初筛）：sat_conjunction 记录 + 现行 TLE 在 TCA 时刻传播出的 ECI 坐标，
 *  与官方 CDM 同一坐标口径；collision_probability 为 crp（近似交会概率，无协方差，量级与官方 Pc 不可比）。
 *  run_id 可选：不传 = 最近一次全量（全体 × 全体）批次；传入 = 回看指定历史全量批次。 */
export function getConjHeatmap(params?: { days?: number; norad?: number; run_id?: number }) {
  return httpCgi<HeatmapResult>({
    url: '/sat_conj/heatmap',
    method: 'get',
    params
  })
}

/** CDM 交会库表明细行（/cgi/sat_cdm/list 下发）：库表原始字段 + 后端算好的 color / metric_text，
 *  供「CDM 热力」面板的交会数据列表渲染与点选绘制（与 /cgi/sat_conj/list 的含义对称）。 */
export interface CdmListItem {
  id: number
  cdm_id: string
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number
  rel_speed_km_per_s: number
  collision_probability: number
  hard_body_radius_m: number
  /** 分档配色（按官方 CDM 碰撞概率口径，与热力云同一套阈值） */
  color: string
  /** 碰撞概率展示文案 */
  metric_text: string
}

/** CDM 交会明细分页（免登录，Space-Track 官方 CDM）：sat_cdm 库表明细（无坐标），
 *  keyword 匹配 NORAD 编号或名称，dateFrom/dateTo 为 TCA 日期范围；按碰撞概率降序。 */
export function listCdmPublic(params?: { page?: number; pageSize?: number; keyword?: string; dateFrom?: string; dateTo?: string }) {
  return httpCgi<{ list: CdmListItem[]; total: number; page: number; pageSize: number }>({
    url: '/sat_cdm/list',
    method: 'get',
    params
  })
}

/** 总交会库批次列表（免登录，本项目 SGP4 初筛）：最近 N 个「全体 × 全体」全量批次，供前台回看历史总库 */
export function getConjBatches(limit?: number) {
  return httpCgi<{ list: ConjBatchItem[]; total: number }>({
    url: '/sat_conj/batches',
    method: 'get',
    params: limit ? { limit } : undefined
  })
}

/** 接近事件分页（免登录，本项目 SGP4 初筛）：总交会库当前批次的接近事件明细，
 *  与后台 /api/sat_conj/list 同一过滤口径（关键词 / 等级 / TCA 日期范围 / run_id），
 *  不做 SGP4 传播、不限等级（含「关注 info」），按最近距离升序。
 *  供前台碰撞热力面板「本批次交会数据」列表检索。 */
export function listConjPublic(params?: ConjQuery) {
  return httpCgi<{ list: ConjEvent[]; total: number; page: number; pageSize: number; run_id: number | null }>({
    url: '/sat_conj/list',
    method: 'get',
    params
  })
}

/** 交会分析库表明细行（/cgi/sat_cri/list 下发）：sat_cri_conjunction 原始字段（CRI/CRP 风险指数模型，
 *  《空间物体交会风险指数模型》2026-1，无协方差）+ 后端按 CRP 五级算好的 color / metric_text，
 *  供「交会分析热力」面板的列表渲染与点选绘制（与 /cgi/sat_conj/list、/cgi/sat_cdm/list 含义对称）。 */
export interface CriListItem {
  id: number
  run_id: number
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  /** 最近距离（km） */
  min_distance: number
  /** 相对速度（km/s） */
  rel_speed: number
  altitude: number
  /** 交会风险指数 CRI */
  cri: number
  /** 交会风险概率 CRP */
  crp: number
  /** CRP 五级风险（1 极高 ~ 5 极低） */
  risk_level: number
  /** 最近距离五级（1 ~ 5） */
  miss_level: number
  level: 'danger' | 'warning' | 'info'
  /** 分档配色（按 CRP 五级口径，与热力云同一套阈值） */
  color: string
  /** 风险文案（极高 / 高 / 中 / 低 / 极低） */
  metric_text: string
}

/** 交会分析热力（免登录，本项目 CRI/CRP 风险指数模型）：sat_cri_conjunction 记录 + 现行 TLE 在 TCA 时刻
 *  传播出的 ECI 坐标，与 /cgi/sat_conj/heatmap、/cgi/sat_cdm/heatmap 同一坐标口径（三来源可在同场景直接对比）。
 *  collision_probability 为 CRP（交会风险概率），按 PDF 的 CRI/CRP 模型算得，非官方 Pc。
 *  run_id 可选：不传 = 最近一次全量（全体 × 全体）批次；传入 = 回看指定历史全量批次。 */
export function getCriHeatmap(params?: { days?: number; norad?: number; run_id?: number }) {
  return httpCgi<HeatmapResult>({
    url: '/sat_cri/heatmap',
    method: 'get',
    params
  })
}

/** 交会分析明细分页（免登录，本项目 CRI/CRP 模型）：当前批次（heatBatchRunId 指定 / 后端默认最近全量批次）
 *  的交会事件明细，检索口径与 /cgi/sat_conj/list 一致（关键词 / 等级 / TCA 日期范围 / run_id），
 *  按最近距离升序；color / metric_text 由后端按 CRP 五级算好下发。 */
export function listCriPublic(params?: ConjQuery) {
  return httpCgi<{ list: CriListItem[]; total: number; page: number; pageSize: number; run_id: number | null }>({
    url: '/sat_cri/list',
    method: 'get',
    params
  })
}

/** 交会分析批次列表（免登录，本项目 CRI/CRP 模型）：最近 N 个「全体 × 全体」全量批次，供前台回看历史 */
export function getCriBatches(limit?: number) {
  return httpCgi<{ list: ConjBatchItem[]; total: number }>({
    url: '/sat_cri/batches',
    method: 'get',
    params: limit ? { limit } : undefined
  })
}

export type { ConstellationPoint, SatTleItem, ConstellationSnapshot } from './satTypes'
export { decodeConstellation } from './satTypes'
export type { ConstellationItem } from './satTypes'
export type { ConjEvent, ConjQuery } from './satTypes'
