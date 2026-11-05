<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AuthError } from '@/api/auth'
import { adminListAudit, type AuditItem } from '@/api/admin'

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

const pages = () => Math.max(Math.ceil(total.value / limit), 1)

function fmt(before: string | null, after: string | null): string {
  const parts: string[] = []
  if (before) parts.push('前: ' + before)
  if (after) parts.push('后: ' + after)
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
        <h1>审计日志</h1>
        <p class="sub">平台写操作只读记录（actor / org / action / before / after）。</p>
      </div>
      <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr><th>ID</th><th>时间</th><th>操作人</th><th>组织</th><th>动作</th><th>变更内容</th></tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="6" class="empty">加载中…</td></tr>
          <tr v-else-if="!items.length"><td colspan="6" class="empty">暂无记录</td></tr>
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
      <div class="pager">
        <button type="button" class="btn small" :disabled="page <= 1" @click="page--; load()">上一页</button>
        <span>第 {{ page }} / {{ pages() }} 页 · 共 {{ total }} 条</span>
        <button type="button" class="btn small" :disabled="page >= pages()" @click="page++; load()">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
