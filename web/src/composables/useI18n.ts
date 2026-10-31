import { storeToRefs } from 'pinia'
import { useLocaleStore } from '@/stores/locale'

/** Lightweight i18n: default zh; toggle CN/EN. */
export function useI18n() {
  const store = useLocaleStore()
  const { locale, isZh } = storeToRefs(store)
  return {
    locale,
    isZh,
    t: store.t,
    setLocale: store.setLocale,
    toggle: store.toggle
  }
}
