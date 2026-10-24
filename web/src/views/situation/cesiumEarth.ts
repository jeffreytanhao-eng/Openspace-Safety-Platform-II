/* ============================================================
 * Cesium 底座封装（双引擎混合：Cesium 画地球，Three.js 画卫星/轨道/叠加层）
 *
 * 分层与输入约定（与 BaseScene.vue 的配合）：
 *   · Cesium canvas   —— zIndex 0，承载影像 + 地形 + 大气 + 晨昏光照；位于下层，
 *     **接收原生指针/滚轮事件**（ScreenSpaceCameraController 负责全部相机交互）；
 *   · Three.js canvas —— zIndex 1，透明背景 + pointer-events:none，只做视觉叠加；
 *     BaseScene 的拾取/框选监听挂在容器上（接收 Cesium canvas 冒泡事件），坐标口径不变。
 *
 * 每帧时序（BaseScene 动画循环内）：
 *   1) updateCameraFly —— 焦点飞行期间经 setCameraFromScene 把缓动结果写入 Cesium 相机；
 *   2) renderCesium    —— 把模拟时间注入 Cesium 时钟（驱动晨昏线/光照）并渲染一帧；
 *   3) syncCameraToThree —— 把 Cesium 相机换算到 Three 的 ECI 场景（被动同步），
 *      Three 层所有卫星/轨道/标签/拾取代码保持 ECI 口径**零改动**。
 *
 * 坐标系口径（本文件是 Cesium ↔ 场景换算的唯一出处）：
 *   · Three 场景 = ECI 惯性系：scene = (x, z, -y) · KM_TO_SCENE，1 场景单位 = 6371 km（见 scene.ts）；
 *   · Cesium = WGS84 地固系（ECEF，米）；
 *   · 换算 = 先 Rz(GMST) 把 ECEF 转到 ECI，再做轴映射（两步均为正交变换，方向向量不缩放）。
 *
 * 离线数据（不使用 Cesium ion / token）：
 *   · 影像：configureEarthBase() 接离线瓦片包（xyz / tms / arcgis MapServer 三种形态），
 *     未配置时用 ArcGIS Online 公网服务兜底；
 *   · 地形：自定义 OfflineHeightmap provider 读取 DEM 生成的离线 heightmap 地形包目录
 *     （由 scripts/build-terrain-tiles.mjs 生成，见 createTerrainProvider）。
 * ============================================================ */
import * as THREE from 'three'
import { gstime } from 'satellite.js'
import { EARTH_RADIUS_KM } from './scene'

declare global {
  interface Window {
    CESIUM_BASE_URL?: string
  }
}

type CesiumModule = typeof import('cesium')
type CesiumScene = import('cesium').Scene
type CesiumWidget = import('cesium').CesiumWidget
type Cartesian3 = import('cesium').Cartesian3

/** Cesium 模块单例（initCesium 动态 import 后填充，独立分包惰性加载） */
let Cesium: CesiumModule | null = null
let widget: CesiumWidget | null = null
let scene: CesiumScene | null = null
/** 自定义左键拖拽（绕地心旋转）的事件处理器（initCesium 创建，destroyCesium 销毁） */
let dragHandler: import('cesium').ScreenSpaceEventHandler | null = null
let cesiumReady = false

/* ---------------- 离线数据配置（initCesium 前调用 configureEarthBase 生效） ---------------- */

export interface EarthBaseConfig {
  /** 离线影像瓦片包根地址；空 = ArcGIS Online 公网兜底 */
  imageryUrl?: string
  /** 瓦片包形态：xyz（{z}/{x}/{y} 目录模板） / tms（tilemapresource.xml） / arcgis（MapServer REST） */
  imageryKind?: 'xyz' | 'tms' | 'arcgis'
  /** XYZ 瓦片最大层级（tms/arcgis 由元数据自描述） */
  maximumLevel?: number
  /** 离线地形包目录（heightmap 格式，内含 meta.json；由 scripts/build-terrain-tiles.mjs
   *  从 DEM 生成）；空 = 无地形（WGS84 椭球面） */
  terrainUrl?: string
}

const baseCfg: EarthBaseConfig = {}
export function configureEarthBase(cfg: EarthBaseConfig): void {
  Object.assign(baseCfg, cfg)
}

/** ArcGIS Online 世界影像（公网 MapServer，无需 token）：离线包未配置/未就绪时的兜底底图 */
const FALLBACK_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'

/** 按配置创建底图图层（离线包优先，公网兜底）。 */
async function createImageryLayer(): Promise<import('cesium').ImageryLayer> {
  const Cs = Cesium as CesiumModule
  const { imageryUrl, imageryKind, maximumLevel } = baseCfg
  if (imageryUrl) {
    if (imageryKind === 'xyz') {
      // XYZ 目录树瓦片（如 /tiles/{z}/{x}/{y}.png）
      return new Cs.ImageryLayer(
        new Cs.UrlTemplateImageryProvider({ url: imageryUrl, maximumLevel, credit: '' })
      )
    }
    if (imageryKind === 'tms') {
      // TMS 瓦片包（目录含 tilemapresource.xml；GDAL2Tiles / 切图转换产物常用此形态）
      const provider = await Cs.TileMapServiceImageryProvider.fromUrl(
        new Cs.Resource(imageryUrl),
        { credit: '' }
      )
      return new Cs.ImageryLayer(provider)
    }
    // arcgis：MapServer REST（在线服务或静态托管的自建服务）
    const provider = await Cs.ArcGisMapServerImageryProvider.fromUrl(imageryUrl, { credit: '' })
    return new Cs.ImageryLayer(provider)
  }
  const fallback = await Cs.ArcGisMapServerImageryProvider.fromUrl(FALLBACK_IMAGERY_URL, {
    credit: ''
  })
  return new Cs.ImageryLayer(fallback)
}

/* ---------------- 离线 heightmap 地形包（CesiumTerrainProvider 的离线替代） ---------------- */

interface OfflineTerrainMeta {
  scheme?: string
  format?: string
  /** 每瓦片高度图边长（采样点数，2^n+1，如 129） */
  grid: number
  /** 可用的最大瓦片层级（超出部分 Cesium 自动向上采样父瓦片） */
  maxLevel: number
}

/**
 * 创建离线 heightmap 地形 provider：terrainUrl 指向 scripts/build-terrain-tiles.mjs 的产物目录。
 * 瓦片文件 = {terrainUrl}/{level}/{x}/{y}.bin（Int16 米值，行主序北→南、西→东，grid×grid）；
 * 借助 Cesium 内建 CustomHeightmapTerrainProvider：默认 GeographicTilingScheme（2×1 根瓦片），
 * 几何误差/网格化/裙边/法线全部由官方 heightmap 管线处理。
 * 瓦片缺失（超层级/文件缺失）时 callback 返回 undefined，Cesium 视为不可用并自动上采样。
 */
async function createTerrainProvider(): Promise<import('cesium').TerrainProvider | null> {
  const Cs = Cesium as CesiumModule
  if (!baseCfg.terrainUrl) return null
  const base = baseCfg.terrainUrl.replace(/\/+$/, '')
  try {
    const resp = await fetch(`${base}/meta.json`)
    if (!resp.ok) throw new Error(`meta.json HTTP ${resp.status}`)
    const meta = (await resp.json()) as OfflineTerrainMeta
    if (
      meta.format !== 'int16-meters' ||
      !Number.isInteger(meta.grid) ||
      !Number.isInteger(meta.maxLevel)
    ) {
      throw new Error(`meta.json 字段不完整：${JSON.stringify(meta)}`)
    }
    return new Cs.CustomHeightmapTerrainProvider({
      width: meta.grid,
      height: meta.grid,
      credit: '',
      callback(x: number, y: number, level: number): Promise<Int16Array> | undefined {
        // 同步返回 undefined = 瓦片不可用（Cesium 上采样父级）；异步路径 404 时 reject（瓦片标记失败）
        if (level > meta.maxLevel) return undefined
        return fetch(`${base}/${level}/${x}/${y}.bin`)
          .then((r) => {
            if (!r.ok) throw new Error(`地形瓦片 ${level}/${x}/${y} HTTP ${r.status}`)
            return r.arrayBuffer()
          })
          .then((buf) => new Int16Array(buf))
      }
    })
  } catch (e) {
    console.warn('[cesiumEarth] 离线地形包不可用，使用椭球面：', e)
    return null
  }
}

/* ---------------- 坐标换算（GMST 缓存 + 场景 ↔ ECEF） ---------------- */

let gstCacheMs = -1
let gstCacheVal = 0
/** GMST（弧度），同帧内多次调用共享缓存（模拟时间逐帧变化，缓存键取整帧的 simTimeMs） */
function gstAt(simTimeMs: number): number {
  if (simTimeMs !== gstCacheMs) {
    gstCacheVal = gstime(new Date(simTimeMs))
    gstCacheMs = simTimeMs
  }
  return gstCacheVal
}

/** 场景点（ECI 口径，1 = R⊕）→ WGS84 地固 Cartesian3（米）。
 *  scene --(逆轴映射)--> ECI(km) --(Rz(-GMST))--> ECEF(m) */
export function sceneToCartesian(p: THREE.Vector3, simTimeMs: number): Cartesian3 {
  const Cs = Cesium as CesiumModule
  const g = gstAt(simTimeMs)
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const exi = p.x * EARTH_RADIUS_KM
  const eyi = -p.z * EARTH_RADIUS_KM
  const ezi = p.y * EARTH_RADIUS_KM
  return new Cs.Cartesian3(
    (exi * cg + eyi * sg) * 1000,
    (-exi * sg + eyi * cg) * 1000,
    ezi * 1000
  )
}

/** WGS84 地固 Cartesian3（米）→ 场景点（ECI 口径）。
 *  ECEF --(Rz(GMST))--> ECI(km) --(轴映射)--> scene */
export function cartesianToScene(c: Cartesian3, simTimeMs: number): THREE.Vector3 {
  const g = gstAt(simTimeMs)
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const X = c.x / 1000
  const Y = c.y / 1000
  const Z = c.z / 1000
  const exi = X * cg - Y * sg
  const eyi = X * sg + Y * cg
  const ezi = Z
  return new THREE.Vector3(
    exi / EARTH_RADIUS_KM,
    ezi / EARTH_RADIUS_KM,
    -eyi / EARTH_RADIUS_KM
  )
}

/** 场景方向单位向量 → ECEF 方向（仅旋转与轴映射，不做单位缩放） */
export function sceneDirToCartesian(v: THREE.Vector3, simTimeMs: number): Cartesian3 {
  const Cs = Cesium as CesiumModule
  const g = gstAt(simTimeMs)
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const dx = v.x
  const dy = -v.z
  const dz = v.y
  return new Cs.Cartesian3(dx * cg + dy * sg, -dx * sg + dy * cg, dz)
}

/* ---------------- 生命周期 ---------------- */

export interface CesiumInitHooks {
  /** 相机开始移动（对齐原 OrbitControls 'start'：交互期间暂停卫星传播保帧率） */
  onMoveStart?: () => void
  /** 相机停止移动（对齐原 OrbitControls 'end'） */
  onMoveEnd?: () => void
}

/**
 * 初始化 Cesium 底座（动态 import，失败返回 false 由调用方降级回 OrbitControls）。
 * 成功后：Cesium canvas 插入 container 最前（zIndex 0，接收输入），并完成场景配置。
 * 注意 configureEarthBase() 须在本函数之前调用（离线包地址在初始化时消费）。
 */
export async function initCesium(container: HTMLElement, hooks?: CesiumInitHooks): Promise<boolean> {
  if (cesiumReady) return true
  try {
    // 必须在 import('cesium') 之前设置：Cesium 运行时据此定位 Workers/Assets/ThirdParty。
    // 用运行时 window 而非构建期 define：vite 的 define 不会作用到 optimizeDeps 预构建产物，dev 下会失效。
    window.CESIUM_BASE_URL = import.meta.env.BASE_URL + 'cesium/'
    Cesium = await import('cesium')
    const Cs = Cesium

    const baseLayer = await createImageryLayer()

    widget = new Cs.CesiumWidget(container, {
      baseLayer,
      scene3DOnly: true,
      // 渲染并入 BaseScene 动画循环（renderCesium 手动逐帧驱动），避免双 RAF 抢帧导致相机错位
      useDefaultRenderLoop: false,
      contextOptions: {
        webgl: { alpha: true, antialias: true, powerPreference: 'high-performance' }
      },
      // 归属信息容器挂在游离 div 上（不在页面显示）
      creditContainer: document.createElement('div'),
      msaaSamples: 4
    })
    scene = widget.scene

    // 星空 / 太阳 / 月亮由 Three 层负责（ECI 口径，与卫星、星官同一套视觉）；
    // Cesium 只保留地球本体 + 大气辉光 + 晨昏光照。
    if (scene.skyBox) scene.skyBox.show = false
    if (scene.sun) scene.sun.show = false
    if (scene.moon) scene.moon.show = false
    const globe = scene.globe
    // 昼夜晨昏线随模拟时间（clock 由 renderCesium 每帧注入 simTimeMs）
    globe.enableLighting = true
    globe.dynamicAtmosphereLighting = true
    // 瓦片未落定时的球体底色（与原 Three 地球暗色系一致）
    globe.baseColor = Cs.Color.fromCssColorString('#0b1526')
    globe.maximumScreenSpaceError = 2

    // 相机交互（原 OrbitControls 的职责整体移交）：
    const c = scene.screenSpaceCameraController
    c.enableCollisionDetection = true // 不穿地形/椭球（替代原每帧 clampCameraOutsideEarth）
    // 与原限位口径对齐：min 1.08R（≈510km 高度）/ max 400R（≈254 万 km，看全整个星座）
    c.minimumZoomDistance = 0.08 * EARTH_RADIUS_KM * 1000
    c.maximumZoomDistance = 400 * EARTH_RADIUS_KM * 1000
    // 滚轮缩放沿用默认 zoomEventTypes（含 WHEEL）。
    // 左键拖拽不用默认 ROTATE（它绕「拾取的地表点」旋转，地心会被转离屏幕中心），
    // 改用下方自定义的绕地心旋转；enableTilt 一并关闭（中键倾斜同样会把地心推出屏幕中心）。
    c.enableRotate = false
    c.enableTilt = false

    // 自定义左键拖拽：camera.rotateLeft/rotateUp 绕「参考系中心（地心）」旋转，
    // 地球重心天然保持在屏幕正中。每像素转角 = 相机视场角 / 画布高（固定标定），
    // 任意缩放档位下地表都近似跟手移动（手感等同拖动地球仪）。
    // moveStart/moveEnd 事件由 Cesium 相机按帧间位移自动触发（滚轮缩放同样适用），
    // 按下/松开时再手动补一发让 userInteracting 冻结即时生效（处理幂等，双触发无害）。
    dragHandler = new Cs.ScreenSpaceEventHandler(widget.canvas)
    let dragging = false
    let lastX = 0
    let lastY = 0
    dragHandler.setInputAction((m: { position: { x: number; y: number } }) => {
      dragging = true
      lastX = m.position.x
      lastY = m.position.y
      hooks?.onMoveStart?.()
    }, Cs.ScreenSpaceEventType.LEFT_DOWN)
    dragHandler.setInputAction((m: { endPosition: { x: number; y: number } }) => {
      if (!dragging || !scene || !widget || widget.isDestroyed()) return
      const dx = m.endPosition.x - lastX
      const dy = m.endPosition.y - lastY
      lastX = m.endPosition.x
      lastY = m.endPosition.y
      const canvas = widget.canvas
      const fr = scene.camera.frustum as import('cesium').PerspectiveFrustum
      const fovy = (fr as unknown as { fovy?: number }).fovy
      if (!canvas.clientHeight || typeof fovy !== 'number') return
      const k = fovy / canvas.clientHeight
      // 符号约定（CesiumWidget 已把 constrainedAxis 设为 UNIT_Z，rotateLeft/Up 是绕世界 Z 轴 /
      // 东向切轴的「转台式」旋转，永不侧滚）：
      //   拖右（dx>0）→ 地球随光标右移 → 相机绕地心向西（rotateLeft 内部即此符号，实测正确）；
      //   拖下（dy>0）→ 地球随光标下移 → 相机绕地心向北。注意 rotateUp(+) 语义是「视线上抬」
      //   即画面上移，与拖拽方向相反，因此取负号。
      scene.camera.rotateLeft(dx * k)
      scene.camera.rotateUp(-dy * k)
    }, Cs.ScreenSpaceEventType.MOUSE_MOVE)
    const endDrag = () => {
      if (!dragging) return
      dragging = false
      hooks?.onMoveEnd?.()
    }
    // mouseup 在 document 上监听（ScreenSpaceEventHandler 内建）：拖出画布松开同样收尾
    dragHandler.setInputAction(endDrag, Cs.ScreenSpaceEventType.LEFT_UP)

    // 相机移动开始/结束（对齐原 controls 'start'/'end' → userInteracting 暂停卫星传播）
    if (hooks?.onMoveStart) scene.camera.moveStart.addEventListener(hooks.onMoveStart)
    if (hooks?.onMoveEnd) scene.camera.moveEnd.addEventListener(hooks.onMoveEnd)

    // 画布分层：Cesium 在下（zIndex 0，接收输入）；Three 画布由 BaseScene 置 zIndex 1 + pointer-events:none
    widget.canvas.style.position = 'absolute'
    widget.canvas.style.inset = '0'
    widget.canvas.style.zIndex = '0'
    // canvas 是替换元素：absolute+inset:0 而 width auto 时保持固有 300×150（CSS 2.1 §10.3.8 不会被拉伸）。
    // 官方 widgets.css 的 `.cesium-widget canvas { width/height:100% }` 本项目未引入，必须显式拉伸，
    // 否则 resize() 读到的 clientWidth/Height 恒为 300×150，地球被压在左上角。
    widget.canvas.style.width = '100%'
    widget.canvas.style.height = '100%'

    // 离线地形包：异步挂载，失败/未配置回退椭球面（不阻塞地球出图）
    createTerrainProvider().then((tp) => {
      if (tp && scene && widget && !widget.isDestroyed()) scene.terrainProvider = tp
    })

    cesiumReady = true
    return true
  } catch (e) {
    console.error('[cesiumEarth] Cesium 初始化失败：', e)
    destroyCesium()
    return false
  }
}

export function isCesiumReady(): boolean {
  return cesiumReady
}

export function getCesiumCanvas(): HTMLCanvasElement | null {
  return widget ? widget.canvas : null
}

/** 容器尺寸变化时同步 Cesium 画布（BaseScene 的 onResize 内调用） */
export function resizeCesium(): void {
  if (widget && !widget.isDestroyed()) widget.resize()
}

/** 画质分档（与卫星侧 high/mid/low 同档）：只影响 Cesium 自身渲染开销 */
export function applyCesiumQuality(tier: 'high' | 'mid' | 'low'): void {
  if (!widget || !scene || widget.isDestroyed()) return
  // low 档降到 1x CSS 分辨率省 GPU；影像网格误差阈值逐档放宽（瓦片请求更少）
  widget.useBrowserRecommendedResolution = tier !== 'low'
  scene.globe.maximumScreenSpaceError = tier === 'high' ? 1.5 : tier === 'mid' ? 2.5 : 4
  try {
    scene.msaaSamples = tier === 'high' ? 4 : 1
  } catch {
    /* 旧设备不支持 MSAA 时忽略 */
  }
}

/* ---------------- 每帧：渲染 + 相机同步 ---------------- */

const _sDir = new THREE.Vector3()
const _sUp = new THREE.Vector3()
const _sLook = new THREE.Vector3()

/** 渲染一帧 Cesium：先注入模拟时间（驱动晨昏线/光照），再手动渲染（useDefaultRenderLoop=false） */
export function renderCesium(simTimeMs: number): void {
  if (!cesiumReady || !Cesium || !widget || widget.isDestroyed()) return
  widget.clock.currentTime = Cesium.JulianDate.fromDate(new Date(simTimeMs))
  widget.clock.shouldAnimate = false
  widget.render()
}

/**
 * 被动相机同步：Cesium 相机（ECEF 米）→ Three 相机（ECI 场景）。
 * 位置 = Rz(GMST) + 轴映射 + /6371km；方向/上向量只做旋转与轴映射（保持单位长度）。
 * Three 层的卫星/轨道/标签/拾取全部基于 dst 相机，口径与原实现完全一致。
 */
export function syncCameraToThree(dst: THREE.PerspectiveCamera, simTimeMs: number): void {
  if (!cesiumReady || !scene || !widget || widget.isDestroyed()) return
  const g = gstAt(simTimeMs)
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const cam = scene.camera
  const k = 1 / (EARTH_RADIUS_KM * 1000) // 米 → 场景单位
  const p = cam.positionWC
  dst.position.set((p.x * cg - p.y * sg) * k, p.z * k, -(p.x * sg + p.y * cg) * k)
  const d = cam.directionWC
  _sDir.set(d.x * cg - d.y * sg, d.z, -(d.x * sg + d.y * cg))
  const u = cam.upWC
  _sUp.set(u.x * cg - u.y * sg, u.z, -(u.x * sg + u.y * cg))
  dst.up.copy(_sUp)
  _sLook.copy(dst.position).add(_sDir)
  dst.lookAt(_sLook)
  // 视锥对齐（PerspectiveFrustum）：fovy 为竖直视角（与 three 的 fov 同口径）
  const fr = cam.frustum as import('cesium').PerspectiveFrustum
  const fovy = (fr as unknown as { fovy?: number }).fovy
  if (typeof fovy === 'number' && fr.aspectRatio) {
    dst.fov = (fovy * 180) / Math.PI
    dst.aspect = fr.aspectRatio
    dst.updateProjectionMatrix()
  }
}

/**
 * 焦点飞行逐帧写入（updateCameraFly 调用）：把场景空间的机位/视线/上向量设进 Cesium 相机。
 * 用户交互（未飞行期间）不调用本函数——Cesium 的 ScreenSpaceCameraController 自主驱动相机。
 */
export function setCameraFromScene(
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  up: THREE.Vector3,
  simTimeMs: number
): void {
  if (!cesiumReady || !Cesium || !scene || widget?.isDestroyed()) return
  scene.camera.setView({
    destination: sceneToCartesian(pos, simTimeMs),
    orientation: {
      direction: sceneDirToCartesian(dir, simTimeMs),
      up: sceneDirToCartesian(up, simTimeMs)
    }
  })
}

/* ---------------- 屏幕拾取 ---------------- */

export interface EarthPickResult {
  lon: number
  lat: number
  /** 离地高度（米，含地形；椭球交点时为椭球高） */
  heightM: number
}

/** 屏幕点 → 地表经纬高：优先取含地形的真实地表（pickPosition，依赖深度纹理），
 *  失败/不支持退回 WGS84 椭球交点（pickEllipsoid，与原数学球拾取同口径的升级版）。 */
export function pickEarthLonLat(clientX: number, clientY: number): EarthPickResult | null {
  if (!cesiumReady || !Cesium || !scene || !widget || widget.isDestroyed()) return null
  const Cs = Cesium
  const rect = widget.canvas.getBoundingClientRect()
  const win = new Cs.Cartesian2(clientX - rect.left, clientY - rect.top)
  let carto: import('cesium').Cartographic | undefined
  if (scene.pickPositionSupported) {
    const p = scene.pickPosition(win)
    // pickPosition 对天空像素会按远平面重构出远离地球的伪坐标，用高度上限剔除
    if (p) {
      const c = Cs.Cartographic.fromCartesian(p)
      if (c && c.height < 1e8) carto = c
    }
  }
  if (!carto) {
    const p = scene.camera.pickEllipsoid(win, scene.globe.ellipsoid)
    if (p) carto = Cs.Cartographic.fromCartesian(p)
  }
  if (!carto) return null
  return {
    lon: Cs.Math.toDegrees(carto.longitude),
    lat: Cs.Math.toDegrees(carto.latitude),
    heightM: carto.height
  }
}

/* ---------------- 销毁 ---------------- */

/** 销毁 Cesium 底座（BaseScene onBeforeUnmount 调用，先于 Three 资源回收） */
export function destroyCesium(): void {
  cesiumReady = false
  scene = null
  if (dragHandler && !dragHandler.isDestroyed()) dragHandler.destroy()
  dragHandler = null
  if (widget && !widget.isDestroyed()) {
    try {
      widget.destroy()
    } catch {
      /* 忽略销毁异常（上下文丢失等） */
    }
  }
  widget = null
  Cesium = null
}
