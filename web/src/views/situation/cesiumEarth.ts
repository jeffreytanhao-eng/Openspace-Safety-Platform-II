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
 * 离线数据（不使用 Cesium ion / token；默认不请求境外底图，避免国内网络卡住启动）：
 *   · 影像：configureEarthBase() 可接离线瓦片包（xyz / tms / arcgis MapServer 三种形态）；
 *     未配置时直接用随包分发的 NaturalEarthII（public/cesium/Assets），不再回落到
 *     ArcGIS Online；自定义瓦片不可用时同样退回 NaturalEarthII，保证不会出现纯黑地球；
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
/** 松手后的拖拽惯性帧（destroyCesium 需取消） */
let dragInertiaRaf = 0
/** 窗口失焦兜底复位（destroyCesium 需移除） */
let dragBlurHandler: (() => void) | null = null
/** When set, left-drag orbits around this ECEF point (sat track); else around Earth center. */
let orbitFocusCart: import('cesium').Cartesian3 | null = null
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

/** 按配置创建自定义底图图层。未配置 imageryUrl 时返回 null，由内置 NaturalEarthII 兜底。 */
async function createImageryLayer(): Promise<import('cesium').ImageryLayer | null> {
  const Cs = Cesium as CesiumModule
  const { imageryUrl, imageryKind, maximumLevel } = baseCfg
  if (!imageryUrl) return null
  try {
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
    // arcgis：MapServer REST（仅在显式配置了本地/自建地址时使用，不再默认访问公网）
    const provider = await Cs.ArcGisMapServerImageryProvider.fromUrl(imageryUrl, { credit: '' })
    return new Cs.ImageryLayer(provider)
  } catch (e) {
    console.warn('[cesiumEarth] 自定义影像不可用，改用内置离线底图：', e)
    return null
  }
}

/**
 * 南极补丁层（只补南极）：ArcGIS World Imagery 是 Web Mercator 切片，覆盖止于 ±85.05°，
 * 更靠极处会露出 globe.baseColor。南极冰盖近纯白，深色圆帽与冰盖对比强烈，故仍补一张
 * 纯白贴图（-90°~-84°，与影像有效范围留重叠）。
 *
 * 北极不铺任何补丁：旧项目（openspace-safety-platform）原方案就是不打补丁，
 * ±85° 以上直接露 baseColor；此前叠加的合成极冠贴图会在极区产生放射状拉伸与接缝亮环，
 * 已按原方案移除。
 */
const SOUTH_POLAR_CAP_LAT = 84
async function createSouthPolarCapLayer(): Promise<import('cesium').ImageryLayer | null> {
  const Cs = Cesium as CesiumModule
  const url = `${import.meta.env.BASE_URL}tiles/polar/south.png`
  // 贴图 1024×256；Cesium 1.146 的 SingleTileImageryProvider 要求显式传入 tileWidth/tileHeight
  const TILE_W = 1024
  const TILE_H = 256
  try {
    // 用图片解码探测可用性：HEAD 请求在并发初始化时可能被浏览器中止（ERR_ABORTED），
    // 导致补丁被误判为缺失而跳过，这里改为真实加载一次（命中 HTTP 缓存）。
    const ok = await new Promise<boolean>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth > 0)
      img.onerror = () => resolve(false)
      img.src = url
    })
    if (!ok) return null
    return new Cs.ImageryLayer(
      new Cs.SingleTileImageryProvider({
        url,
        rectangle: Cs.Rectangle.fromDegrees(-180, -90, 180, -SOUTH_POLAR_CAP_LAT),
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        credit: ''
      })
    )
  } catch (e) {
    console.warn('[cesiumEarth] 南极补丁不可用：', e)
    return null
  }
}

/**
 * Cesium 自带离线底图（Assets/Textures/NaturalEarthII，随 public/cesium 分发）。
 * 无外网或在线瓦片不可达时保证地球有可见贴图，避免整颗球呈纯黑。
 */
async function createOfflineBaseLayer(): Promise<import('cesium').ImageryLayer | null> {
  const Cs = Cesium as CesiumModule
  try {
    const provider = await Cs.TileMapServiceImageryProvider.fromUrl(
      new Cs.Resource(Cs.buildModuleUrl('Assets/Textures/NaturalEarthII')),
      { credit: '' }
    )
    return new Cs.ImageryLayer(provider)
  } catch (e) {
    console.warn('[cesiumEarth] 内置离线底图不可用：', e)
    return null
  }
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

    // 在线/自定义影像可用时不再垫内置离线底图：NaturalEarthII 的亮蓝海洋会在
    // Web Mercator 极区缺口处透出，形成显眼的淡蓝色圆斑（老项目无此垫层，故无此现象）。
    // 仅当在线影像不可用时才用离线底图兜底，避免整颗球纯黑。
    const baseLayer = await createImageryLayer()
    const offlineBase = baseLayer ? null : await createOfflineBaseLayer()
    // 南极补丁只给 Web Mercator 类底图（极区缺口）；内置 NaturalEarthII 已覆盖两极，不再叠纯白帽
    const southCap = baseLayer ? await createSouthPolarCapLayer() : null

    widget = new Cs.CesiumWidget(container, {
      baseLayer: baseLayer ?? false,
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
    if (offlineBase) scene.imageryLayers.add(offlineBase, 0)
    // 南极补丁追加到最上层（在线影像图层之上）
    if (southCap) scene.imageryLayers.add(southCap)

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
    // 地球重心天然保持在屏幕正中。
    //
    // 手感标定（关键）：每像素转角不能是固定的 fovy/画布高，必须乘上「相机到被拖物的距离 / 地球半径」。
    // 拖拽本质是让光标下的地表跟着光标走：相机离地面越远，同样的像素位移对应越大的地表位移，
    // 需要转更多角度；反之贴地时只需要转很小角度。旧实现固定标定等价于只在 2R 视距跟手，
    // 首页 4.5R 时地表只有约 1/3.5 的速度（发涩、打滑），近距跟踪时又过于灵敏。
    //
    // 惯性：Cesium 的阻尼只作用于原生控制器，自写拖拽需要自己做——松手后按最后的屏幕速度衰减继续旋转。
    dragHandler = new Cs.ScreenSpaceEventHandler(widget.canvas)
    let dragging = false
    let lastX = 0
    let lastY = 0
    let lastMoveMs = 0
    /** 屏幕拖拽速度（px/ms），松手后据此做惯性 */
    let velX = 0
    let velY = 0

    /** 当前视距下每像素对应的旋转角（rad/px） */
    const radPerPx = (cam: import('cesium').Camera): number => {
      const canvasH = widget?.canvas.clientHeight || 0
      const fr = cam.frustum as import('cesium').PerspectiveFrustum
      const fovy = (fr as unknown as { fovy?: number }).fovy
      if (!canvasH || typeof fovy !== 'number') return 0
      const earthM = EARTH_RADIUS_KM * 1000
      // 被拖物到相机的距离：普通模式取离地高度，跟踪模式取相机到焦点距离
      const d = orbitFocusCart
        ? Cs.Cartesian3.distance(cam.positionWC, orbitFocusCart)
        : Cs.Cartesian3.magnitude(cam.positionWC) - earthM
      const ratio = Math.min(6, Math.max(0.06, d / earthM))
      return (fovy / canvasH) * ratio
    }

    /** 按屏幕像素位移旋转相机（拖拽与惯性共用） */
    const orbitByPx = (dx: number, dy: number): void => {
      if (!scene || !Cesium) return
      const cam = scene.camera
      const k = radPerPx(cam)
      if (!k) return
      // Track/select focus: orbit around target (old OrbitControls.target = sat), keep looking at it.
      if (orbitFocusCart) {
        const focus = orbitFocusCart
        const offset = Cs.Cartesian3.subtract(cam.positionWC, focus, new Cs.Cartesian3())
        const up = Cs.Ellipsoid.WGS84.geodeticSurfaceNormal(focus, new Cs.Cartesian3())
        const qYaw = Cs.Quaternion.fromAxisAngle(up, -dx * k)
        const mYaw = Cs.Matrix3.fromQuaternion(qYaw)
        let newOffset = Cs.Matrix3.multiplyByVector(mYaw, offset, new Cs.Cartesian3())
        const right = Cs.Cartesian3.cross(up, newOffset, new Cs.Cartesian3())
        if (Cs.Cartesian3.magnitudeSquared(right) > 1e-12) {
          Cs.Cartesian3.normalize(right, right)
          const qPitch = Cs.Quaternion.fromAxisAngle(right, -dy * k)
          const mPitch = Cs.Matrix3.fromQuaternion(qPitch)
          newOffset = Cs.Matrix3.multiplyByVector(mPitch, newOffset, new Cs.Cartesian3())
        }
        const newPos = Cs.Cartesian3.add(focus, newOffset, new Cs.Cartesian3())
        const dir = Cs.Cartesian3.subtract(focus, newPos, new Cs.Cartesian3())
        Cs.Cartesian3.normalize(dir, dir)
        cam.setView({
          destination: newPos,
          orientation: { direction: dir, up }
        })
        return
      }
      // Default: earth-center turntable (keep globe centered).
      cam.rotateLeft(dx * k)
      cam.rotateUp(-dy * k)
    }

    const cancelInertia = () => {
      if (dragInertiaRaf) cancelAnimationFrame(dragInertiaRaf)
      dragInertiaRaf = 0
    }

    /** 松手：按最后的屏幕速度衰减滑行；速度过小直接收尾 */
    const releaseInertia = () => {
      cancelInertia()
      const end = () => {
        velX = 0
        velY = 0
        hooks?.onMoveEnd?.()
      }
      if (Math.hypot(velX, velY) < 0.05) {
        end()
        return
      }
      // 惯性衰减：整体只保留约 6 成甩动速度、90ms 时间常数，避免快速甩动后转过头
      velX *= 0.6
      velY *= 0.6
      let lastT = performance.now()
      const step = (t: number) => {
        const dt = Math.min(50, Math.max(1, t - lastT))
        lastT = t
        const decay = Math.exp(-dt / 90)
        velX *= decay
        velY *= decay
        if (Math.hypot(velX, velY) < 0.02) {
          dragInertiaRaf = 0
          end()
          return
        }
        orbitByPx(velX * dt, velY * dt)
        dragInertiaRaf = requestAnimationFrame(step)
      }
      dragInertiaRaf = requestAnimationFrame(step)
    }

    dragHandler.setInputAction((m: { position: { x: number; y: number } }) => {
      cancelInertia()
      velX = 0
      velY = 0
      dragging = true
      lastX = m.position.x
      lastY = m.position.y
      lastMoveMs = performance.now()
      if (widget) widget.canvas.style.cursor = 'grabbing'
      hooks?.onMoveStart?.()
    }, Cs.ScreenSpaceEventType.LEFT_DOWN)
    dragHandler.setInputAction((m: { endPosition: { x: number; y: number } }) => {
      if (!dragging || !scene || !widget || widget.isDestroyed()) return
      const now = performance.now()
      const dx = m.endPosition.x - lastX
      const dy = m.endPosition.y - lastY
      if (!dx && !dy) return
      lastX = m.endPosition.x
      lastY = m.endPosition.y
      const dt = Math.max(1, now - lastMoveMs)
      lastMoveMs = now
      // 平滑速度：用最近几帧的加权值，避免最后一帧抖动主导惯性
      velX = velX * 0.4 + (dx / dt) * 0.6
      velY = velY * 0.4 + (dy / dt) * 0.6
      orbitByPx(dx, dy)
    }, Cs.ScreenSpaceEventType.MOUSE_MOVE)
    const endDrag = (withInertia: boolean) => {
      if (!dragging) return
      dragging = false
      if (widget) widget.canvas.style.cursor = 'grab'
      if (withInertia) releaseInertia()
      else {
        cancelInertia()
        velX = 0
        velY = 0
        hooks?.onMoveEnd?.()
      }
    }
    // mouseup 在 document 上监听（ScreenSpaceEventHandler 内建）：拖出画布松开同样收尾
    dragHandler.setInputAction(() => endDrag(true), Cs.ScreenSpaceEventType.LEFT_UP)
    // 切走窗口/失焦时收不到 mouseup 的兜底，避免 dragging 卡死
    dragBlurHandler = () => endDrag(false)
    window.addEventListener('blur', dragBlurHandler)

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
    // 触摸设备上禁止浏览器把拖动解释成滚动/缩放手势，否则单指拖拽地球会整页滚动
    widget.canvas.style.touchAction = 'none'
    // 左键可拖拽的操作提示（按下时切换为 grabbing）
    widget.canvas.style.cursor = 'grab'

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

export function getCesiumScene(): import('cesium').Scene | null {
  return scene
}

export function getCesiumModule(): typeof import('cesium') | null {
  return Cesium
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
/**
 * While tracking a sat/ephem: left-drag orbits around this scene-space point (ECEF).
 * Pass null to restore earth-center turntable (home / clear selection).
 */
export function setCameraOrbitFocusScene(pos: THREE.Vector3 | null, simTimeMs: number): void {
  if (!pos) {
    orbitFocusCart = null
    // Restore earth-orbit zoom floor (~0.08 R above ellipsoid)
    if (scene) scene.screenSpaceCameraController.minimumZoomDistance = 0.08 * EARTH_RADIUS_KM * 1000
    return
  }
  if (!cesiumReady || !scene) return
  orbitFocusCart = sceneToCartesian(pos, simTimeMs)
  // Allow close approach while orbiting sat (old SATELLITE_FOCUS_MIN_DIST = 0.01 R)
  scene.screenSpaceCameraController.minimumZoomDistance = 0.01 * EARTH_RADIUS_KM * 1000
}

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
  orbitFocusCart = null
  cesiumReady = false
  scene = null
  if (dragInertiaRaf) cancelAnimationFrame(dragInertiaRaf)
  dragInertiaRaf = 0
  if (dragBlurHandler) window.removeEventListener('blur', dragBlurHandler)
  dragBlurHandler = null
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
