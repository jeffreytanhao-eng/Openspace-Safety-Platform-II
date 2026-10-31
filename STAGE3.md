# Stage 3 — data + situation catalog

- MySQL: Docker `openspace-mysql` :13306 / DB `openspace` (api/.env)
- API: http://127.0.0.1:1235  (Vite proxies /cgi → 1235; UI http://127.0.0.1:1234/)
- Catalog: `/cgi/catalog/stats|tles|cdms` from `sat_tle` / `sat_cdm`
- Models (own): `web/public/models` — 96 GLB/GLTF copied from old platform `public/map/type/gltf`
- Situation: SatListPanel + up to 400 Cesium point overlay from catalog; GLB via `/models/manifest.json` later

## t168u (2026-10-29 Asia/Shanghai)
- TYPE_LABEL: 卫星/碎片/残骸/未知 + normalizeObjectType (TBA→未知)
- catalogPoints: PointPrimitiveCollection + PolylineCollection orbits (selected + ≤18 visible)
- SatListPanel: 空间站/星座/国旗/目标卡片 + select→orbit
- AppShell → /situation; sit-back → /
- DB: TLE 35773 (P19223/D12377/RB2285/U+TBA1888), CDM 245


## t168u bugfix (2026-10-29 Asia/Shanghai)
- Root: limit 400; toggle blocked last type (未知 stuck when solo); station/cons wiped list / no ensureSelected
- Fix: loadAllTles paging; API limit 25k + multi-type; legend buttons freely toggle; ensureSelectedItem + cons orbitCap 48
- Verified: P19223 D12377 RB2285 U1888; STARLINK 11261/6 pages; CSS 48274 ISS 25544


## t170u (2026-10-29 Asia/Shanghai)
- Root1: SceneCore watch skipped empty tles → Cesium leftovers when all type chips off
- Root2: rebuildOrbits still drew selected/focus orbits when activeTypes=[]
- Root3: orbit samples used per-time gstime→ECEF (ground-track mess / fan rays); old platform uses ECI ring (eciToScene) / fixed orientation
- Fix: clearAllVisuals on empty types; watch clears on []; fixed-gmst inertial ring; drop degenerate paths
- Verified: ISS fixed-gmst 73/73 samples, jump~8deg; vite transform ok


## t181u (2026-10-30 Asia/Shanghai) — Cesium+Three hybrid design + scaffold
- Doc: `docs/cesium-three.md` (roles, sync, LOD, data vs server.jsc, Linux, old bugs)
- `catalogCloudThree.ts`: THREE.Points cloud + selected orbit Lines; soft 12k / cons 5k; chip-gated empty purge
- `SceneCore`: cloud on Three overlay; clears Cesium catalog leftovers; empty-default chips unchanged
- Caps raised: SatListPanel 10k/5k; useCatalog materialize ≤12k (API still ≤25k)
- Not this pass: GLB InstancedMesh LOD, heat Points, screen-space pick, station focus Mesh

## t184u (2026-10-30 Asia/Shanghai) — first-paint optimize
- SceneCore: no mount constellation; chips → snapshot cloud (chunked); drop tles→scene watch
- catalogCloudThree: `initCatalogCloudFromSnapshot` + rAF fill; lazy orbits on select; soft coast
- useCatalog: IndexedDB snapshot cache; materialize default cap 400 (list)
- SatListPanel: idle-warm snapshot; LIST_PAGE 400; empty chips unchanged
- API constellation cache TTL 5 min

## t186u (2026-10-30 Asia/Shanghai) — 卫星-only empty + cloud speed
- Root: index syncEmptyCatalogFilter @0/+500ms wiped chip-on snapshot paint
- Fix: remove delayed empty sync; SceneCore paintSeq; toggle emits types immediately
- Speed: FILL_FIRST 5000 / FILL_CHUNK 6000; list refresh debounced separately
- normalizeObjectType: treat ROCKET_BODY like ROCKET BODY

## t187u (2026-10-30 Asia/Shanghai) — 卫星-only still empty
- Exact bug: `ensureGroup` → `disposeCloud`/`clearCatalogCloud` bumped `cloudGen` after `const gen=++cloudGen`,
  so first chip-on hit `if (gen !== cloudGen) return {plotted:0}`. Second toggle (加碎片) worked.
- Fix: ensureGroup tears down without bumping cloudGen; take gen after ensureGroup.

## t188u (2026-10-30 Asia/Shanghai) — remove SatList stats
- Removed header filtered/tlesTotal (e.g. 400/19223) under 太空安全目标列表
- Removed loadNote scene/list stats (列表 · 场景快照 / 场景采样 / 已载入)
- File: web/src/views/situation/SatListPanel.vue only

## t189u (2026-10-30 Asia/Shanghai) — CN/EN i18n
- Lightweight Pinia locale store (default zh), localStorage key osp-locale
- Toggle top-right AppShell + situation
- Files: web/src/i18n/messages.ts, stores/locale.ts, composables/useI18n.ts, layouts/AppShell.vue, views/*

## t191u (2026-10-30 Asia/Shanghai) — embed situation in AppShell
- Removed shell:bare from /situation; /simulation redirects to /situation
- Stripped situation chrome: logo, titlebar, CN/EN, bottom-right dual clock, 主界面 back
- Keeps docks / timeline / heatmap / edge tags; AppShell header+rail+clock remain

## t192u (2026-10-30 Asia/Shanghai)
- 安全热力图: UI stub (notReady); API helpers exist in sat_public.ts but situation dock does not draw heat clouds
- 初始化窗口: SceneCore.reinitViewport() only — no window.location.reload / AppShell remount

### t193u Starlink GLB near InstancedMesh (2026-10-30)
- Assets: `web/public/models/starlink-flat-wing.glb` (+ LOD gltfs); manifest `starlink` URL
- `catalogCloudThree.ts`: load GLB once, normalize maxDim=0.011, Y-up→+Z; InstancedMesh ≤64 when camera–sat < 2.2 (Earth R=1); far stay Points; match STARLINK/星链
- `SceneCore.vue`: `updateCatalogCloud(simMs, camera)`

### t194u SatListPanel button channels (2026-10-30)
- Align with old platform: type chips / 位置展示 / 星座展示 / 轨道展示 are independent
- SceneCore: showStation / showConstellation / showConsOrbit; catalogCloudThree consShowMap+stationFocus
- Fixed: cons no longer hijacks search keyword; orbit is real toggle not a text note; stationShow wired

### t195u/t196u Starlink match + all cons orbits + hide filter status (2026-10-30)
- Root cause Starlink empty: cloud cons=`星链` vs card key=`Starlink`; entryShown used consShowOf(consName)
- Fix: consToken aliases + match against map keys via matchesConsKey
- OneWeb orbits: upgrade ALL members from tle_lines; CONS_ORBIT_CAP_HARD=800; color #81d4fa
- t196u: remove loadNote under type chips (已关闭全部类型过滤)
