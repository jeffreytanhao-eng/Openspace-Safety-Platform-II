<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { AuthError } from '@/api/auth'
import { adminListAudit, type AuditItem } from '@/api/admin'
import CompactPager from '@/components/CompactPager.vue'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const items = ref<AuditItem[]>([])
const total = ref(0)
const page = ref(1)
const limit = 50
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await adminListAudit(page.value, limit)
    items.value = d.items
    total.value = d.total
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

const totalPages = computed(() => Math.max(Math.ceil(total.value / limit), 1))

watch(page, () => {
  void load()
})
watch(totalPages, (n) => {
  if (page.value > n) page.value = n
  if (page.value < 1) page.value = 1
})

function parseMaybe(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function compact(v: unknown): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function summaryOf(v: unknown): string {
  if (v && typeof v === 'object' && 'summary' in v && typeof (v as { summary?: unknown }).summary === 'string') {
    return String((v as { summary: string }).summary)
  }
  return ''
}

function fmt(before: string | null, after: string | null): string {
  const b = parseMaybe(before)
  const a = parseMaybe(after)
  const summary = summaryOf(a) || summaryOf(b)
  if (summary) return summary
  const parts: string[] = []
  const bs = compact(b)
  const as = compact(a)
  if (bs) parts.push('前: ' + bs)
  if (as) parts.push('后: ' + as)
  return parts.join('　') || '—'
}

/** R2-4：审计时间本地化（Asia/Shanghai） */
function fmtTime(v: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (!Number.isFinite(d.getTime())) return v
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d)
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>{{ t('adm.audit.title') }}</h1>
        <p class="sub">{{ t('adm.audit.sub') }}</p>
      </div>
      <button type="button" class="btn" :disabled="loading" @click="load">{{ t('adm.audit.refresh') }}</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>ID</th>
            <th>{{ t('adm.audit.col.time') }}</th>
            <th>{{ t('adm.audit.col.actor') }}</th>
            <th>{{ t('adm.audit.col.org') }}</th>
            <th>{{ t('adm.audit.col.action') }}</th>
            <th>{{ t('adm.audit.col.delta') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="6" class="empty">{{ t('adm.audit.loading') }}</td></tr>
          <tr v-else-if="!items.length"><td colspan="6" class="empty">{{ t('adm.audit.empty') }}</td></tr>
          <tr v-for="a in items" :key="a.id">
            <td class="mono">{{ a.id }}</td>
            <td class="mono">{{ fmtTime(a.created_at) }}</td>
            <td>{{ a.actor_email }}</td>
            <td class="mono">{{ a.org_id ?? '—' }}</td>
            <td><span class="chip">{{ a.action }}</span></td>
            <td class="delta">{{ fmt(a.before_json, a.after_json) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="pager-wrap">
        <CompactPager v-model:page="page" :total-pages="totalPages" :disabled="loading" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
<style scoped>
.pager-wrap {
  padding: 8px 12px 10px;
  min-width: 0;
}
.delta {
  max-width: 520px;
  overflow-wrap: anywhere;
}
</style>
