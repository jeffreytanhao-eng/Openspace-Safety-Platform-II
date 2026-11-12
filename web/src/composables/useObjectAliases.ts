/**
 * 本组织目标别名：仅认领/关注目标可设置，仅本组织可见。
 * 官方名称与 NORAD 始终保留；有别名时别名作主显示名。
 */
import { onMounted, ref } from 'vue'
import { listObjectAliases, type ObjectAliasItem } from '@/api/objects'

export const ALIAS_MAX_LEN = 64

export function officialName(name: string | null | undefined, norad?: number | null): string {
  const n = String(name || '').trim()
  if (n) return n
  return norad ? `NORAD ${norad}` : ''
}

export function displayName(
  alias: string | null | undefined,
  name: string | null | undefined,
  norad?: number | null
): string {
  const a = String(alias || '').trim()
  return a || officialName(name, norad)
}

export function useObjectAliases(opts?: { autoLoad?: boolean }) {
  const byNorad = ref<Map<number, ObjectAliasItem>>(new Map())
  const loaded = ref(false)
  let inflight: Promise<void> | null = null

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    if (inflight) {
      await inflight
      return
    }
    inflight = (async () => {
      try {
        const items = await listObjectAliases()
        const m = new Map<number, ObjectAliasItem>()
        for (const it of items) m.set(Number(it.noradId), it)
        byNorad.value = m
        loaded.value = true
      } catch {
        byNorad.value = new Map()
        loaded.value = true
      } finally {
        inflight = null
      }
    })()
    await inflight
  }

  function rowOf(norad: number | null | undefined): ObjectAliasItem | undefined {
    if (norad == null) return undefined
    return byNorad.value.get(Number(norad))
  }

  function aliasOf(norad: number | null | undefined): string | null {
    return rowOf(norad)?.alias ?? null
  }

  function officialOf(norad: number | null | undefined, fallback?: string | null): string {
    const row = rowOf(norad)
    return officialName(fallback || row?.name, norad)
  }

  function label(norad: number | null | undefined, fallback?: string | null): string {
    const row = rowOf(norad)
    return displayName(row?.alias, fallback || row?.name, norad)
  }

  if (opts?.autoLoad !== false) onMounted(() => { void load() })

  return { byNorad, loaded, load, rowOf, aliasOf, officialOf, label }
}
