# Cesium + Three hybrid architecture (Openspace Safety)

Status: design locked for Stage 3→4 · scaffold started 2026-10-30 (Asia/Shanghai)  
Audience: Jeffrey / 原型开发助手 · path `D:\项目\Openspace Safety`

## 1. Why hybrid

Cesium alone (PointPrimitiveCollection) melts past ~2k–4k points on typical laptops once orbits + lighting run.  
The old Openspace-Safety-Platform kept **Cesium for Earth** and put **the satellite cloud in Three.js** (InstancedMesh / Points). New project already has the Cesium base + Three overlay shell (`cesiumEarth.ts` / `SceneCore.vue`); this pass moves **catalog points off Cesium** into Three so the 2000 Cesium cap is no longer the ceiling.

Product constraint (memory): operator dashboard, not classroom 大屏 — empty globe until type chips on; watermark「谭谈」; Linux/Docker deploy.

## 2. Roles

| Layer | Owns | Does **not** own |
|-------|------|------------------|
| **Cesium** (`cesiumEarth.ts`) | WGS84 globe, imagery/terrain (offline packs), atmosphere, sun lighting / terminator, **camera + pointer input** (canvas zIndex 0) | Per-sat points, heat clouds, starfield |
| **Three** (`SceneCore` + modules) | Transparent overlay canvas (zIndex 1, `pointer-events: none`), starfield / sun / moon markers, **depth occluder** sphere (`colorWrite: false`), **catalog point cloud**, selected orbits, (later) heat Points, focus meshes | Camera authority — always slave to Cesium |
| **Vue panels** | Type chips, sat list, constellation/stations, empty-default `typeF=[]` | Direct WebGL |

Frame order (must stay this order):

1. Advance sim clock (pause while Cesium interacting)
2. Update Three sky markers
3. Update catalog cloud positions (throttled)
4. `renderCesium(simMs)`
5. `syncCameraToThree(camera, simMs)` — only bridge; Three never drives Cesium
6. `renderer.render(threeScene, camera)`

## 3. Coordinate contract (single source)

Defined in `web/src/views/situation/scene.ts` + `cesiumEarth.ts`:

- **Three scene = ECI-flavoured axes**: `scene = (x, z, -y) * KM_TO_SCENE` with `EARTH_RADIUS_KM = 6371`, `EARTH_R = 1`
- **Cesium = ECEF metres (WGS84)**
- Bridge only via `sceneToCartesian` / `cartesianToScene` / `syncCameraToThree` / `setCameraFromScene`
- Orbit polylines: **inertial ECI ring at fixed GMST** (not per-sample ECEF) — avoids ground-track fan rays (t170u bug)

## 4. LOD / caps (progressive)

| Tier | Mechanism | Soft / hard |
|------|-----------|-------------|
| **Data sample** | `/cgi/catalog/tles?limit=` + stride sample in `useCatalog.materializeSample` | Overview soft **10000**, constellation soft **5000**, API hard **25000** |
| **Three points** | One `THREE.Points` BufferGeometry (DynamicDrawUsage); type color in `color` attr | Soft **12000**, hard **20000** this pass — no GLB dump |
| **Orbits** | Few `THREE.Line` rings for selection / focus only | Default **8**, hard **16** |
| **Model LOD** (later) | Old BaseScene: per-type `InstancedMesh` low→med→high via `maybeSwitchModelLod` | **Not in this pass** — GLB only for station focus later |
| **Update rate** | Throttle SGP4 rewrite: ~10 Hz light / ~6 Hz when N>3k | Prevents main-thread melt |

Distance LOD: stride-hide far points by camera–sat distance without rebuilding geometry (zero buffer pos; keep last scene xyz for distance). Mid ≥2.8R stride 3, far ≥5.5R stride 8; round-robin SGP4 budget per tick.

## 5. Data load vs old `server.jsc`

Old path (Windows / bytenode, **not portable to Linux**):

- `/cgi/sat_tle/constellation` snapshot: backend pre-propagates x/y/z + vx/vy/vz at one `snap` time
- Frontend IndexedDB cache + warp-smooth when snap epoch jumps
- Full cloud reveal gated; heat via `/cgi2/heat/*` sidecar

New path (Linux-friendly Express + MySQL Docker `:13306`):

- `/cgi/catalog/stats|tles|cdms` from `sat_tle` / `sat_cdm`
- Client-side `satellite.js` propagate for visible sample only
- Prefetch: compact constellation **metadata** without 35k `tle_lines` strings
- Materialize: only when chips on → capped `/catalog/tles` pages with TLE lines
- Heat: **out of scope** until ops/product ask — do not port heat-core / cgi2 into new deploy this pass

Do **not** reintroduce bytenode `server.jsc` or Windows-only binaries.

## 6. Known old bugs to avoid (from BaseScene + our t168–t180)

1. **Empty chips leave primitives** — always purge on `activeTypes=[]` (t170u / t171u).
2. **Cesium PointPrimitive dump of Starlink** — never push full constellation into Cesium; sample + Three cloud.
3. **Per-sample ECEF orbits** — fan rays; use fixed-GMST ECI ring.
4. **`InstancedMesh.frustumCulled` default true** — bounding sphere at origin → models vanish when zoomed; set `frustumCulled = false` on instance batches.
5. **Raycaster on InstancedMesh** — tens of ms per pick at 35k; use screen-space project + Earth occlusion test.
6. **Station / focus on point-cloud instance** — wrong mesh / drift / disappear; dedicated Mesh pinned to satrec (old BaseScene comment ~L1822).
7. **LOD rebuild flash** — build new batch then atomically swap; keep old visible until ready.
8. **Cache snap warp** — don’t teleport whole cloud when IndexedDB snap ≠ fresh; warp sim time or smooth offsets.
9. **Heat empty ≠ sidecar down** — heatmap SQL `tca >= NOW()`; past TCA runs show list≠0 but cloud=0 (t180u). Don’t fake data.
10. **Auto-load on mount** — violates empty-default; chips gate all cloud builds.
11. **Dual copy when ephemeris overrides NORAD** — hide catalog instance for that NORAD while eph mesh active.
12. **PC melt from materialize-all** — never map 35k tle_lines into memory just to sample; page with `limit=cap`.

## 7. Module map (target)

```
views/situation/
  SceneCore.vue          # shell: Cesium init, Three overlay, rAF, watch tles
  cesiumEarth.ts         # Cesium only + camera sync
  scene.ts               # shared units / eciToScene / TYPE_COLOR
  starfield.ts           # Three stars
  catalogCloudThree.ts   # NEW: Points + orbit Lines (this scaffold)
  catalogPoints.ts       # LEGACY Cesium points — kept for fallback/reference; SceneCore stops using for cloud
  SatListPanel.vue       # chips empty-default; raised sample caps
composables/useCatalog.ts
docs/cesium-three.md     # this file
```

## 8. Linux / Docker notes

- API + MySQL in Docker; web Vite build is static — no Cesium ion token required (offline imagery/terrain packs under `web/public`).
- Avoid native Windows addons; heat-sidecar/`server.jsc` stay out of new image unless explicitly productized later.
- Paths: forward-slash friendly; no `D:\` assumptions in runtime code.
- Memory: prefer one Three `Points` draw call over thousands of Cesium entities.

## 9. Scaffold this pass (landed)

- [x] Architecture doc (`docs/cesium-three.md`)
- [x] `catalogCloudThree.ts` — THREE.Points cloud + selected orbit Lines, empty purge, throttle
- [x] `SceneCore` wires Three cloud; clears Cesium catalog overlay when building Three path
- [x] Raise panel/materialize soft caps (still chip-gated, empty-default unchanged)
- [x] Distance LOD stride + dirty/budget position updates (`updateCatalogCloud`)
- [x] Cons orbit `LineSegments` batch; ephem multi-rev downsample (~2k) + thick amber MAN `TubeGeometry` (depthTest + Earth occluder)
- [x] Ephem select /「关联至态势」: TRACK_CAM_DIST zoom + track + slower breath reticle (3.2s) + name label (t216/t217)
- [x]「跳转至机动段」: stop track/hide reticle; frame MAN mid at TRACK height; multi-MAN cycle wrap / single re-frame
- [x] t219u: denser ephem poly (16k+chord) / catalog orbits 180; strip embedded chrome; pure radial TRACK cam
- [x] t220u: track = delta-follow + Cesium sync (not radial lock); drag orbits lookAt target
- [ ] Later: screen-space pick, station focus Mesh, optional InstancedMesh GLB per type, heat Points

## 10. Acceptance for hybrid v0

- Cold `/situation`: empty globe (chips off)
- Enable 卫星: denser cloud than 2000 without locking UI (~6–10k soft)
- All chips off: cloud + orbits gone
- Camera drag still Cesium; Three overlay tracks without drift
- Linux build still runs (`docker` / api / web) with no heat port

## 11. First-paint path (t184u)

Expected interactive sequence (empty-default chips):

1. Route `/situation` → Cesium earth + Three stars/sun/moon only (no constellation fetch, no tle_lines, no SGP4).
2. Idle (~0.8–2.5s) or first chip-on → `GET /cgi/sat_tle/constellation` (or IndexedDB hit) compact snapshot with x/y/z.
3. Chip on → `initCatalogCloudFromSnapshot` fills Points in rAF chunks (`FILL_FIRST` then `FILL_CHUNK`); soft coast via vx/vy/vz; **no** client satrec batch.
4. Panel list uses small `/catalog/tles` page (`LIST_PAGE≈400`) for cards only — does **not** drive the globe.
5. Select a target → attach that TLE’s satrec → lazy orbit Line. GLB / multi-orbit still deferred.

Avoided: mount prefetch of 35k TLEs; sync fill of 10k Points; `watch(tles)` rebuilding the cloud.


## 12. t186u bugfix — 卫星-only empty + slow first cloud

Root cause (卫星 only → no points; 卫星+碎片 → OK):
- `index.vue` called `filterCatalogTypes([])` at mount+0 and mount+500ms to “ensure empty globe”.
- Chip-on paint (`paintFromSnapshot(['PAYLOAD'])`) often finished before T+500ms; the timer then **wiped** the cloud.
- Adding 碎片 re-painted after the timer → points appeared (looked like a multi-type-only bug).

Speed vs old BaseScene:
- Old: IDB snapshot → apply precomputed x/y/z immediately; no client SGP4 for overview.
- New bottlenecks that remained: 200ms type debounce before scene emit; FILL_FIRST/CHUNK too small (1.2k/1.8k); redundant clear timer; list materialize competed after emit.

Fixes: remove delayed empty sync; paintSeq; immediate `emit('types')` on toggle; FILL_FIRST=5000 / FILL_CHUNK=6000; normalize `_`→space.
