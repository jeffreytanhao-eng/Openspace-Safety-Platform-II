import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { messages, type Locale, type MessageKey } from '@/i18n/messages'

const STORAGE_KEY = 'osp-locale'

function readInitial(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* ignore */
  }
  return 'zh'
}

export const useLocaleStore = defineStore('locale', () => {
  const locale = ref<Locale>(readInitial())

  watch(
    locale,
    (v) => {
      try {
        localStorage.setItem(STORAGE_KEY, v)
      } catch {
        /* ignore */
      }
      if (typeof document !== 'undefined') {
        document.documentElement.lang = v === 'zh' ? 'zh-CN' : 'en'
      }
    },
    { immediate: true }
  )

  function t(key: MessageKey, params?: Record<string, string | number>): string {
    const table = messages[locale.value] || messages.zh
    let s = (table[key] as string) ?? (messages.zh[key] as string) ?? String(key)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return s
  }

  function setLocale(next: Locale) {
    locale.value = next
  }

  function toggle() {
    locale.value = locale.value === 'zh' ? 'en' : 'zh'
  }

  const isZh = computed(() => locale.value === 'zh')

  return { locale, isZh, t, setLocale, toggle }
})
