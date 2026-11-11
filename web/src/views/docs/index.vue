<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAuthStore } from '@/stores/auth'
import {
  listDocuments,
  getDocument,
  deleteDocument,
  unpinDocument,
  downloadDocumentFile,
  fetchDocumentHtml,
  pushPinnedDocument,
  type DocumentDetail,
  type UserDocument
} from '@/api/documents'
import { AuthError } from '@/api/auth'

const { t, isZh } = useI18n()
const auth = useAuthStore()

const loading = ref(true)
const loadError = ref('')
const items = ref<UserDocument[]>([])
const quotaUsed = ref(0)
const quotaMax = ref<number | null>(null)
const canPin = ref(false)
const selectedId = ref('')
const detail = ref<DocumentDetail | null>(null)
const detailLoading = ref(false)
const actionMsg = ref('')
const busy = ref('')
const pinInput = ref<HTMLInputElement | null>(null)
const htmlSrc = ref('')
const htmlFrame = ref<HTMLIFrameElement | null>(null)
let htmlObjectUrl = ''

function revokeHtmlPreview() {
  if (htmlObjectUrl) {
    URL.revokeObjectURL(htmlObjectUrl)
    htmlObjectUrl = ''
  }
  htmlSrc.value = ''
}

function isHtmlDocument(doc: { mime?: string; title?: string; preview?: { kind?: string } } | null): boolean {
  if (!doc) return false
  if (doc.preview?.kind === 'html') return true
  const mime = (doc.mime || '').toLowerCase()
  const title = (doc.title || '').toLowerCase()
  return mime === 'text/html' || mime === 'application/xhtml+xml' || title.endsWith('.html') || title.endsWith('.htm')
}

/** 去掉脚本与危险属性，再放入 sandbox iframe（无 allow-scripts / allow-same-origin）。 */
function sanitizeHtmlDocument(raw: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(raw, 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, link, base, meta[http-equiv]').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value || ''
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name)
        continue
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') &&
        /^\s*(javascript:|vbscript:|data:text\/html)/i.test(value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
  })
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

async function prepareHtmlPreview(doc: DocumentDetail) {
  revokeHtmlPreview()
  if (!isHtmlDocument(doc)) return
  const raw = await fetchDocumentHtml(doc.id)
  const safe = sanitizeHtmlDocument(raw)
  const blob = new Blob([safe], { type: 'text/html;charset=utf-8' })
  htmlObjectUrl = URL.createObjectURL(blob)
  htmlSrc.value = htmlObjectUrl
}

/** sandbox 默认禁止框架内跳转，目录锚点要在可读 contentDocument 里自行滚动。 */
function bindHtmlFrameNav() {
  const doc = htmlFrame.value?.contentDocument
  if (!doc) return
  if (doc.documentElement.dataset.ospTocBound === '1') return
  doc.documentElement.dataset.ospTocBound = '1'
  const style = doc.createElement('style')
  style.textContent = 'html { scroll-behavior: smooth; } section, h2 { scroll-margin-top: 12px; }'
  doc.head.appendChild(style)
  doc.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (!href.startsWith('#') || href === '#') return
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* keep raw id */
    }
    const el = doc.getElementById(id) || doc.getElementsByName(id)[0]
    if (!el) return
    e.preventDefault()
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function syncTitle() {
  document.title = isZh.value ? 'Openspace Safety · 我的文档' : 'Openspace Safety · My Documents'
}
watch(isZh, syncTitle, { immediate: true })
onMounted(syncTitle)
onUnmounted(() => {
  revokeHtmlPreview()
  document.title = 'Openspace Safety · Operator Console'
})

function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const usageText = computed(() => {
  if (quotaMax.value == null) return ''
  return t('docs.usage', { used: quotaUsed.value, max: quotaMax.value })
})

async function loadList(keepId?: string) {
  loading.value = true
  loadError.value = ''
  try {
    const data = await listDocuments()
    items.value = data.items || []
    quotaUsed.value = data.quota?.used ?? 0
    quotaMax.value = data.quota?.max ?? null
    canPin.value = !!data.viewer?.canPin
    const prefer = keepId || selectedId.value
    if (prefer && items.value.some((it) => it.id === prefer)) {
      selectedId.value = prefer
      await loadDetail(prefer)
    } else if (items.value.length) {
      selectedId.value = items.value[0].id
      await loadDetail(items.value[0].id)
    } else {
      selectedId.value = ''
      detail.value = null
      revokeHtmlPreview()
    }
  } catch (e) {
    loadError.value = e instanceof AuthError || e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadDetail(id: string) {
  detailLoading.value = true
  revokeHtmlPreview()
  try {
    detail.value = await getDocument(id)
    if (detail.value && isHtmlDocument(detail.value)) {
      try {
        await prepareHtmlPreview(detail.value)
      } catch (e) {
        actionMsg.value = e instanceof Error ? e.message : t('docs.noPreview')
      }
    }
  } catch (e) {
    detail.value = null
    actionMsg.value = e instanceof Error ? e.message : t('docs.noPreview')
  } finally {
    detailLoading.value = false
  }
}

function select(item: UserDocument) {
  selectedId.value = item.id
  actionMsg.value = ''
  void loadDetail(item.id)
}

async function onDownload() {
  const doc = detail.value
  if (!doc) return
  busy.value = 'download'
  actionMsg.value = ''
  try {
    await downloadDocumentFile(doc.id, doc.title)
  } catch (e) {
    actionMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

async function onDelete() {
  const doc = detail.value
  if (!doc || !doc.canDelete) return
  if (!window.confirm(t('docs.deleteConfirm'))) return
  busy.value = 'delete'
  actionMsg.value = ''
  try {
    await deleteDocument(doc.id)
    actionMsg.value = t('docs.deleted')
    await loadList()
  } catch (e) {
    actionMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

async function onUnpin() {
  const doc = detail.value
  if (!doc || !doc.canUnpin) return
  busy.value = 'unpin'
  actionMsg.value = ''
  try {
    await unpinDocument(doc.id)
    actionMsg.value = t('docs.unpinned')
    await loadList(doc.id)
  } catch (e) {
    actionMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

function pickPin() {
  pinInput.value?.click()
}

async function onPinPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = 'pin'
  actionMsg.value = ''
  try {
    const saved = await pushPinnedDocument(file)
    actionMsg.value = t('docs.pushOk')
    await loadList(saved.id)
  } catch (e) {
    actionMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  void auth.init().then(() => loadList())
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ t('docs.title') }}</h1>
        <p>{{ t('docs.sub') }}</p>
      </div>
      <div class="actions">
        <span v-if="usageText" class="usage">{{ usageText }}</span>
        <button v-if="canPin" type="button" class="btn" :disabled="busy === 'pin'" @click="pickPin">
          {{ busy === 'pin' ? t('docs.pushing') : t('docs.pushPin') }}
        </button>
        <input ref="pinInput" type="file" hidden @change="onPinPicked" />
      </div>
    </header>
    <p v-if="actionMsg" class="status">{{ actionMsg }}</p>

    <section class="split">
      <aside class="list-pane">
        <div v-if="loading" class="empty">{{ t('docs.loading') }}</div>
        <div v-else-if="loadError" class="empty">
          {{ t('docs.loadFail') }}：{{ loadError }}
          <button type="button" class="btn" @click="loadList()">{{ t('docs.retry') }}</button>
        </div>
        <div v-else-if="!items.length" class="empty">{{ t('docs.empty') }}</div>
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="doc-item"
          :class="{ on: selectedId === item.id }"
          @click="select(item)"
        >
          <div class="doc-top">
            <span v-if="item.pinned" class="badge">{{ t('docs.pinned') }}</span>
            <span class="name">{{ item.title }}</span>
          </div>
          <div class="meta">
            <span>{{ fmtSize(item.size) }}</span>
            <span>{{ item.createdAt }}</span>
            <span v-if="item.createdByName">{{ t('docs.createdBy', { name: item.createdByName }) }}</span>
          </div>
        </button>
      </aside>

      <section class="reader">
        <div v-if="!selectedId" class="empty">{{ t('docs.readerEmpty') }}</div>
        <div v-else-if="detailLoading && !detail" class="empty">{{ t('docs.loading') }}</div>
        <template v-else-if="detail">
          <header class="reader-h">
            <div>
              <div class="r-title">
                <span v-if="detail.pinned" class="badge">{{ t('docs.pinned') }}</span>
                {{ detail.title }}
              </div>
              <div class="r-sub">
                <span>{{ fmtSize(detail.size) }}</span>
                <span>{{ detail.createdAt }}</span>
                <span v-if="detail.createdByName">{{ t('docs.createdBy', { name: detail.createdByName }) }}</span>
              </div>
            </div>
            <div class="r-actions">
              <button type="button" class="btn" :disabled="busy === 'download'" @click="onDownload">
                {{ busy === 'download' ? t('docs.downloading') : t('docs.download') }}
              </button>
              <button v-if="detail.canUnpin" type="button" class="btn" :disabled="busy === 'unpin'" @click="onUnpin">
                {{ t('docs.unpin') }}
              </button>
              <button v-if="detail.canDelete" type="button" class="btn danger" :disabled="busy === 'delete'" @click="onDelete">
                {{ busy === 'delete' ? t('docs.deleting') : t('docs.delete') }}
              </button>
            </div>
          </header>
          <div v-if="htmlSrc" class="preview-wrap html-wrap">
            <iframe
              ref="htmlFrame"
              class="html-frame"
              sandbox="allow-same-origin"
              referrerpolicy="no-referrer"
              :src="htmlSrc"
              title="document-preview"
              @load="bindHtmlFrameNav"
            />
          </div>
          <div v-else-if="isHtmlDocument(detail)" class="empty">{{ t('docs.loading') }}</div>
          <div v-else-if="detail.preview?.kind === 'text'" class="preview-wrap">
            <pre class="preview">{{ detail.preview.text }}</pre>
            <div v-if="detail.preview.truncated" class="trunc">{{ t('docs.truncated') }}</div>
          </div>
          <div v-else class="empty">{{ t('docs.binaryHint') }}</div>
        </template>
        <div v-else class="empty">{{ t('docs.noPreview') }}</div>
      </section>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px 24px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
h1 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}
.head p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.usage {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-variant-numeric: tabular-nums;
}
.status {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 10px;
}
.list-pane,
.reader {
  min-height: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.doc-item {
  appearance: none;
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  padding: 10px 12px;
  cursor: pointer;
}
.doc-item:hover { background: var(--bg-deep); }
.doc-item.on { background: rgba(127, 176, 255, 0.08); }
.doc-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name {
  font-size: 12px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta, .r-sub {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.badge {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #5a3b00;
  background: #ffd978;
  border-radius: 3px;
  padding: 1px 6px;
}
.reader-h {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}
.r-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
  word-break: break-all;
}
.r-actions { display: flex; gap: 6px; flex: none; }
.preview-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.html-wrap { background: #0b1220; }
.html-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #0b1220;
}
.preview {
  flex: 1;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.trunc {
  padding: 6px 12px 10px;
  font-size: 11px;
  color: var(--text-dim);
  border-top: 1px dashed var(--border);
}
.empty {
  padding: 16px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}
.btn {
  appearance: none;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}
.btn:hover { color: var(--accent-strong); border-color: var(--accent); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn.danger { color: var(--danger, #d35); border-color: rgba(221, 51, 85, 0.45); }
@media (max-width: 860px) {
  .split { grid-template-columns: 1fr; }
}
</style>
