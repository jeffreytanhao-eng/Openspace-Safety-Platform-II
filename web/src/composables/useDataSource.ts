import { ref, computed } from 'vue'

/** Stage 1 mock data-source catalogue — visible operator controls */
export type DataSourceId =
  | 'tle'
  | 'space-track-cdm'
  | 'ephem-sim'
  | 'aoe-ephem'
  | 'stargaze'

export interface DataSourceOption {
  id: DataSourceId
  label: string
  short: string
  desc: string
}

export const DATA_SOURCES: DataSourceOption[] = [
  {
    id: 'tle',
    label: 'TLE Propagation',
    short: 'TLE',
    desc: 'Two-line element catalog propagation (mock)'
  },
  {
    id: 'space-track-cdm',
    label: 'Space-Track CDM',
    short: 'CDM',
    desc: 'Official conjunction data messages'
  },
  {
    id: 'ephem-sim',
    label: 'Ephemeris Simulation',
    short: 'Ephem',
    desc: 'Operator-uploaded precise ephemeris screening'
  },
  {
    id: 'aoe-ephem',
    label: 'AOE + Ephemeris',
    short: 'AOE',
    desc: 'AOE catalog paired with precise ephemeris'
  },
  {
    id: 'stargaze',
    label: 'Optical / Stargaze',
    short: 'Optical',
    desc: 'Sensor-network observations (placeholder)'
  }
]

const selected = ref<DataSourceId>('space-track-cdm')

export function useDataSource() {
  const current = computed(() => DATA_SOURCES.find((d) => d.id === selected.value) || DATA_SOURCES[0])
  function setSource(id: DataSourceId) {
    selected.value = id
  }
  return { selected, current, sources: DATA_SOURCES, setSource }
}
