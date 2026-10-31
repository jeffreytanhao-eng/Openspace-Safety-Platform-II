export type Risk = 'high' | 'warn' | 'watch' | 'low'

export interface SpaceObject {
  id: string
  name: string
  norad: string
  operator: string
  constellation: string
  orbit: 'LEO' | 'MEO' | 'GEO'
  maneuverable: boolean
  ephemFreshness: 'fresh' | 'stale' | 'missing'
  ephemAgeH: number
  status: 'active' | 'decayed' | 'spare'
  country: string
}

export interface Trajectory {
  id: string
  objectId: string
  name: string
  source: string
  startUtc: string
  endUtc: string
  stepS: number
  points: number
}

export interface Conjunction {
  id: string
  primaryId: string
  secondaryId: string
  tcaUtc: string
  missKm: number
  pc: string
  risk: Risk
  relVelKms: number
  missRadialM: number
  missIntrackM: number
  missCrosstrackM: number
  source: string
  window: string
}

export interface EphemerisFile {
  id: string
  objectId: string
  name: string
  norad: string
  format: 'ITC' | 'OEM' | 'OCM' | 'TLE'
  points: number
  step: string
  range: string
  status: 'synced' | 'local' | 'stale' | 'uploading' | 'error'
  size: string
  covariance: boolean
  updatedAt: string
}

export const OBJECTS: SpaceObject[] = [
  { id: 'o1', name: 'STARLINK-38124', norad: '38124', operator: 'SpaceX', constellation: 'Starlink', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 2, status: 'active', country: 'USA' },
  { id: 'o2', name: 'STARLINK-38128', norad: '38128', operator: 'SpaceX', constellation: 'Starlink', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 2, status: 'active', country: 'USA' },
  { id: 'o3', name: 'STARLINK-37711', norad: '37711', operator: 'SpaceX', constellation: 'Starlink', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 4, status: 'active', country: 'USA' },
  { id: 'o4', name: 'STARLINK-5315', norad: '5315', operator: 'SpaceX', constellation: 'Starlink', orbit: 'LEO', maneuverable: true, ephemFreshness: 'stale', ephemAgeH: 36, status: 'active', country: 'USA' },
  { id: 'o5', name: 'DEMO-42007', norad: '42007', operator: 'Demo Ops', constellation: 'Demo-LEO B', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 6, status: 'active', country: 'CN' },
  { id: 'o6', name: 'DEMO-99103', norad: '99103', operator: 'Demo Ops', constellation: 'CubeSat Pack', orbit: 'LEO', maneuverable: false, ephemFreshness: 'stale', ephemAgeH: 72, status: 'active', country: 'CN' },
  { id: 'o7', name: 'COSMOS 1408 DEB', norad: '49044', operator: '—', constellation: 'Debris', orbit: 'LEO', maneuverable: false, ephemFreshness: 'missing', ephemAgeH: 0, status: 'decayed', country: 'RU' },
  { id: 'o8', name: 'IRIDIUM 33 DEB', norad: '36516', operator: '—', constellation: 'Debris', orbit: 'LEO', maneuverable: false, ephemFreshness: 'missing', ephemAgeH: 0, status: 'decayed', country: '—' },
  { id: 'o9', name: 'CHAMRAN-1', norad: '56240', operator: 'ISA', constellation: 'Other', orbit: 'LEO', maneuverable: false, ephemFreshness: 'stale', ephemAgeH: 48, status: 'active', country: 'IR' },
  { id: 'o10', name: 'CZ-8A R/B', norad: '57320', operator: '—', constellation: 'Rocket Body', orbit: 'LEO', maneuverable: false, ephemFreshness: 'missing', ephemAgeH: 0, status: 'active', country: 'CN' },
  { id: 'o11', name: 'DEMO-42001', norad: '42001', operator: 'Demo Ops', constellation: 'Demo-LEO B', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 5, status: 'spare', country: 'CN' },
  { id: 'o12', name: 'STARLINK-38123', norad: '38123', operator: 'SpaceX', constellation: 'Starlink', orbit: 'LEO', maneuverable: true, ephemFreshness: 'fresh', ephemAgeH: 3, status: 'active', country: 'USA' }
]

export const TRAJECTORIES: Trajectory[] = [
  { id: 't1', objectId: 'o1', name: 'SL38124-ITC-72h', source: 'Ephemeris Simulation', startUtc: '2026-10-22T04:05:42Z', endUtc: '2026-10-25T04:04:42Z', stepS: 60, points: 4320 },
  { id: 't2', objectId: 'o2', name: 'SL38128-OEM-72h', source: 'Ephemeris Simulation', startUtc: '2026-10-22T04:05:42Z', endUtc: '2026-10-25T04:04:42Z', stepS: 60, points: 4320 },
  { id: 't3', objectId: 'o5', name: 'D42007-OEM-48h', source: 'AOE + Ephemeris', startUtc: '2026-10-26T00:00:00Z', endUtc: '2026-10-28T00:00:00Z', stepS: 30, points: 5760 },
  { id: 't4', objectId: 'o6', name: 'D99103-TLE-prop', source: 'TLE Propagation', startUtc: '2026-10-27T00:00:00Z', endUtc: '2026-10-30T00:00:00Z', stepS: 120, points: 2160 },
  { id: 't5', objectId: 'o3', name: 'SL37711-ITC-72h', source: 'Ephemeris Simulation', startUtc: '2026-10-22T04:05:42Z', endUtc: '2026-10-25T04:04:42Z', stepS: 60, points: 4320 },
  { id: 't6', objectId: 'o12', name: 'SL38123-ITC-72h', source: 'Ephemeris Simulation', startUtc: '2026-10-22T04:05:42Z', endUtc: '2026-10-25T04:04:42Z', stepS: 60, points: 4320 }
]

export const CONJUNCTIONS: Conjunction[] = [
  { id: 'c1', primaryId: 'o2', secondaryId: 'o7', tcaUtc: '2026-10-29T14:22:11Z', missKm: 0.84, pc: '1.3e-4', risk: 'high', relVelKms: 12.4, missRadialM: -210, missIntrackM: 780, missCrosstrackM: 95, source: 'Space-Track CDM', window: '24h' },
  { id: 'c2', primaryId: 'o3', secondaryId: 'o8', tcaUtc: '2026-10-31T06:15:33Z', missKm: 1.42, pc: '2.4e-4', risk: 'high', relVelKms: 10.1, missRadialM: 340, missIntrackM: -1200, missCrosstrackM: 180, source: 'Space-Track CDM', window: '7d' },
  { id: 'c3', primaryId: 'o1', secondaryId: 'o4', tcaUtc: '2026-10-29T09:51:47Z', missKm: 2.67, pc: '2.1e-5', risk: 'warn', relVelKms: 5.14, missRadialM: 120, missIntrackM: 2510, missCrosstrackM: -640, source: 'TLE + Ephemeris', window: '24h' },
  { id: 'c4', primaryId: 'o5', secondaryId: 'o10', tcaUtc: '2026-10-31T18:33:02Z', missKm: 7.55, pc: '3.1e-5', risk: 'warn', relVelKms: 8.2, missRadialM: -80, missIntrackM: 6400, missCrosstrackM: 2100, source: 'AOE + Ephemeris', window: '7d' },
  { id: 'c5', primaryId: 'o6', secondaryId: 'o10', tcaUtc: '2026-10-30T02:08:19Z', missKm: 5.03, pc: '4.6e-6', risk: 'watch', relVelKms: 9.7, missRadialM: 450, missIntrackM: 4800, missCrosstrackM: -900, source: 'AOE + Ephemeris', window: '3d' },
  { id: 'c6', primaryId: 'o12', secondaryId: 'o9', tcaUtc: '2026-10-30T11:40:55Z', missKm: 12.1, pc: '8.2e-7', risk: 'watch', relVelKms: 11.2, missRadialM: -20, missIntrackM: 11000, missCrosstrackM: 3200, source: 'TLE Propagation', window: '3d' },
  { id: 'c7', primaryId: 'o1', secondaryId: 'o5', tcaUtc: '2026-10-28T21:05:00Z', missKm: 18.4, pc: '2.0e-7', risk: 'low', relVelKms: 6.3, missRadialM: 90, missIntrackM: 17000, missCrosstrackM: -4000, source: 'Ephemeris Simulation', window: '7d' }
]

export const EPHEMERIDES: EphemerisFile[] = [
  { id: 'e1', objectId: 'o1', name: 'STARLINK-38124', norad: '38124', format: 'ITC', points: 4320, step: '60 s', range: '10-22 ~ 10-25 UTC', status: 'synced', size: '1.2 MB', covariance: false, updatedAt: '2026-10-29 08:12' },
  { id: 'e2', objectId: 'o2', name: 'STARLINK-38128', norad: '38128', format: 'OEM', points: 4320, step: '60 s', range: '10-22 ~ 10-25 UTC', status: 'synced', size: '980 KB', covariance: true, updatedAt: '2026-10-29 08:10' },
  { id: 'e3', objectId: 'o5', name: 'DEMO-42007', norad: '42007', format: 'OEM', points: 2880, step: '30 s', range: '10-26 ~ 10-28 UTC', status: 'local', size: '640 KB', covariance: false, updatedAt: '2026-10-28 19:40' },
  { id: 'e4', objectId: 'o6', name: 'DEMO-99103', norad: '99103', format: 'TLE', points: 0, step: '—', range: 'catalog epoch', status: 'stale', size: '—', covariance: false, updatedAt: '2026-10-26 02:00' },
  { id: 'e5', objectId: 'o3', name: 'STARLINK-37711', norad: '37711', format: 'ITC', points: 4320, step: '60 s', range: '10-22 ~ 10-25 UTC', status: 'synced', size: '1.1 MB', covariance: false, updatedAt: '2026-10-29 07:55' },
  { id: 'e6', objectId: 'o12', name: 'STARLINK-38123', norad: '38123', format: 'ITC', points: 4320, step: '60 s', range: '10-22 ~ 10-25 UTC', status: 'error', size: '1.0 MB', covariance: false, updatedAt: '2026-10-29 06:20' }
]

export function objectById(id: string) {
  return OBJECTS.find((o) => o.id === id)
}

export function conjunctionById(id: string) {
  return CONJUNCTIONS.find((c) => c.id === id)
}
