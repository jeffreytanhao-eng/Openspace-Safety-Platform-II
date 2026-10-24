import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 移动端判定（与样式里的 html.is-mobile 同口径，最大宽度 900px） */
export function useDevice() {
  const isMobile = ref(false)
  let mq: MediaQueryList | null = null
  const sync = () => {
    isMobile.value = !!mq?.matches
    document.documentElement.classList.toggle('is-mobile', isMobile.value)
  }
  onMounted(() => {
    mq = window.matchMedia('(max-width: 900px)')
    sync()
    mq.addEventListener('change', sync)
  })
  onBeforeUnmount(() => mq?.removeEventListener('change', sync))
  return { isMobile }
}
