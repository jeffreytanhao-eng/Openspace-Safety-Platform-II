import { ref, computed } from 'vue'

/** Operator-facing data-source catalogue (conjunctions + simulation). */
export type DataSourceId =
  | 'space-track-cdm'
  | 'tle'
  | 'ephem-sim'
  | 'aoe-ephem'
  | 'stargaze'

export type EventSource = 'cdm' | 'tle' | 'ephem' | 'aoe'

export interface DataSourceOption {
  id: DataSourceId
  label: string
  short: string
  desc: string
  disabled?: boolean
}

export const DATA_SOURCES: DataSourceOption[] = [
  {
    id: 'space-track-cdm',
    label: 'CDM',
    short: 'CDM',
    desc: 'Official conjunction data messages'
  },
  {
    id: 'tle',
    label: 'TLE Propagation',
    short: 'TLE',
    desc: 'Two-line element catalog propagation'
  },
  {
    id: 'ephem-sim',
    label: 'Ephemeris Simulation',
    short: 'Ephem',
    desc: 'Operator-uploaded precise ephemeris screening'
  },
  {
    id: 'aoe-ephem',
    label: 'AOE',
    short: 'AOE',
    desc: 'AOE catalog source'
  },
  {
    id: 'stargaze',
    label: '开运星敏',
    short: '开运星敏',
    desc: 'Not available in this release',
    disabled: true
  }
]

/** Map the bar selection to GET /events?eventSource=; 开运星敏 is not implemented. */
export const EVENT_SOURCE_BY_DS: Record<DataSourceId, EventSource | null> = {
  'space-track-cdm': 'cdm',
  tle: 'tle',
  'ephem-sim': 'ephem',
  'aoe-ephem': 'aoe',
  stargaze: null
}

const selected = ref<DataSourceId>('space-track-cdm')

export function useDataSource() {
  const current = computed(() => DATA_SOURCES.find((d) => d.id === selected.value) || DATA_SOURCES[0])
  function setSource(id: DataSourceId) {
    const opt = DATA_SOURCES.find((d) => d.id === id)
    if (!opt || opt.disabled) return
    selected.value = id
  }
  return { selected, current, sources: DATA_SOURCES, setSource }
}
