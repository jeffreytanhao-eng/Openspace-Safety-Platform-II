/**
 * 态势页预加载：从其它页面进入时，主要等待来自路由分包下载与 Cesium（约 4.8MB）解析。
 * 空闲/导航悬停时预热，首次进入可省掉这段等待；重复调用幂等。
 */
let routeWarm = false
let cesiumWarm = false

/** 路由分包（很小）：空闲即取 */
export function preloadSituationRoute(): void {
  if (routeWarm) return
  routeWarm = true
  void import('@/views/situation/index.vue').catch(() => {
    routeWarm = false
  })
}

/** Cesium 运行时（约 4.8MB）：导航悬停或更长空闲期才取 */
export function preloadSituationCesium(): void {
  if (cesiumWarm) return
  cesiumWarm = true
  // 必须在 import('cesium') 之前设置：Cesium 运行时据此定位 Workers/Assets/ThirdParty
  window.CESIUM_BASE_URL = import.meta.env.BASE_URL + 'cesium/'
  void import('cesium').catch(() => {
    cesiumWarm = false
  })
}

export function preloadSituationScene(): void {
  preloadSituationRoute()
  preloadSituationCesium()
}
