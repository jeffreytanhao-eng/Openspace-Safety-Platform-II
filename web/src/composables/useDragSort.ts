/**
 * 长按拖动排序（鼠标左键）：
 *  - 按下 100ms 且位移不超过 6px 进入拖动，避免与普通点击冲突；
 *  - 拖动中根据指针位置找到目标条目，把源条目移动到目标位置；
 *  - 松开后回调 onDrop，由调用方决定是否落库；
 *  - 拖动结束后的 click 会在捕获阶段被吞掉，防止误触打开详情。
 */
import { onBeforeUnmount, ref } from 'vue'

interface DragSortOptions {
  /** 可拖动条目选择器（条目需带 data-drag-id） */
  itemSelector: string
  /** 源条目被拖到目标条目位置时回调，id 均来自 data-drag-id */
  onMove: (fromId: string, toId: string) => void
  /** 拖动结束（含未发生位移的长按） */
  onDrop: () => void
  /** 禁用条件，如平台只读账号或搜索过滤中 */
  disabled?: () => boolean
}

const HOLD_MS = 100
const MOVE_TOLERANCE = 6
/** 拖动结束到 click 事件之间的保护窗口 */
const CLICK_GUARD_MS = 120

export function useDragSort(opts: DragSortOptions) {
  const dragId = ref('')
  let pressTimer: number | null = null
  let startX = 0
  let startY = 0
  let fromId = ''
  let active = false
  let prevUserSelect = ''
  let prevCursor = ''

  function swallowClick(e: Event) {
    e.stopPropagation()
    e.preventDefault()
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || e.pointerType !== 'mouse' || opts.disabled?.()) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, a, textarea, select, [contenteditable="true"]')) return
    const item = target.closest<HTMLElement>(opts.itemSelector)
    const id = item?.dataset.dragId || ''
    if (!id) return
    fromId = id
    startX = e.clientX
    startY = e.clientY
    clearPress()
    pressTimer = window.setTimeout(activate, HOLD_MS)
    window.addEventListener('pointermove', onPressMove)
    window.addEventListener('pointerup', onPressEnd)
    window.addEventListener('pointercancel', onPressEnd)
  }

  function activate() {
    pressTimer = null
    active = true
    dragId.value = fromId
    prevUserSelect = document.body.style.userSelect
    prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    window.addEventListener('click', swallowClick, true)
  }

  function onPressMove(e: PointerEvent) {
    if (!active) {
      // 长按判定前发生明显位移：视为普通点击/选择，不进入拖动
      if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
        clearPress()
      }
      return
    }
    e.preventDefault()
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    const item = el?.closest<HTMLElement>(opts.itemSelector)
    const overId = item?.dataset.dragId || ''
    if (overId && overId !== fromId) opts.onMove(fromId, overId)
  }

  function onPressEnd() {
    const wasActive = active
    clearPress()
    if (!wasActive) return
    active = false
    dragId.value = ''
    document.body.style.userSelect = prevUserSelect
    document.body.style.cursor = prevCursor
    // pointerup 之后浏览器才派发 click，延迟解除保护
    window.setTimeout(() => window.removeEventListener('click', swallowClick, true), CLICK_GUARD_MS)
    opts.onDrop()
  }

  function clearPress() {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer)
      pressTimer = null
    }
    window.removeEventListener('pointermove', onPressMove)
    window.removeEventListener('pointerup', onPressEnd)
    window.removeEventListener('pointercancel', onPressEnd)
  }

  onBeforeUnmount(() => {
    clearPress()
    window.removeEventListener('click', swallowClick, true)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  })

  return { dragId, onPointerDown }
}
