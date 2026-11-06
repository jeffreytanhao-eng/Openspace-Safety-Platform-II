<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AuthError } from '@/api/auth'
import {
  adminListObjectClaims,
  adminApproveObjectClaim,
  adminRejectObjectClaim,
  type AdminObjectClaim,
  type ObjectClaimStatus
} from '@/api/admin'

const status = ref<ObjectClaimStatus | 'all'>('pending')
const items = ref<AdminObjectClaim[]>([])
const loading = ref(false)
const error = ref('')
const msg = ref('')
const acting = ref(0)
const note = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await adminListObjectClaims(status.value)
    items.value = d.items
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

async function approve(row: AdminObjectClaim) {
  if (!window.confirm(`通过 NORAD ${row.norad_id} 的业主认领？通过后该目标全局唯一归属 ${row.org_name}。`)) return
  acting.value = row.id
  error.value = ''
  msg.value = ''
  try {
    await adminApproveObjectClaim(row.id, note.value)
    msg.value = `NORAD ${row.norad_id} 认领已通过`
    note.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    acting.value = 0
  }
}

async function reject(row: AdminObjectClaim) {
  const reason = window.prompt(`驳回 NORAD ${row.norad_id} 的业主认领，请填写原因（将回传给申请方）`, note.value)
  if (reason === null) return
  acting.value = row.id
  error.value = ''
  msg.value = ''
  try {
    await adminRejectObjectClaim(row.id, reason)
    msg.value = `NORAD ${row.norad_id} 认领已驳回`
    note.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    acting.value = 0
  }
}

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
    hour12: false
  }).format(d)
}

const STATUS_LABEL: Record<ObjectClaimStatus, string> = {
  pending: '待审核',
  claimed: '已通过',
  rejected: '已驳回'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>认领审核</h1>
        <p class="sub">VIP 组织提交的业主认领申请：通过后目标全局唯一归属该组织，仅其业主可维护参数与上传星历。</p>
      </div>
      <div class="actions">
        <select v-model="status" class="sel" @change="load">
          <option value="pending">待审核</option>
          <option value="claimed">已通过</option>
          <option value="rejected">已驳回</option>
          <option value="all">全部</option>
        </select>
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="msg" class="ok-note">{{ msg }}</div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr><th>ID</th><th>NORAD</th><th>组织</th><th>申请人</th><th>提交时间</th><th>状态</th><th>审核意见</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="8" class="empty">加载中…</td></tr>
          <tr v-else-if="!items.length"><td colspan="8" class="empty">暂无记录</td></tr>
          <tr v-for="row in items" :key="row.id">
            <td class="mono">{{ row.id }}</td>
            <td class="mono">{{ row.norad_id }}</td>
            <td>{{ row.org_name || `#${row.org_id}` }}</td>
            <td>{{ row.user_email || '—' }}</td>
            <td class="mono">{{ fmtTime(row.created_at) }}</td>
            <td><span class="chip" :class="row.claim_status">{{ STATUS_LABEL[row.claim_status] }}</span></td>
            <td class="delta">{{ row.review_note || '—' }}</td>
            <td class="ops">
              <template v-if="row.claim_status === 'pending'">
                <button type="button" class="btn small primary" :disabled="acting === row.id" @click="approve(row)">通过</button>
                <button type="button" class="btn small danger" :disabled="acting === row.id" @click="reject(row)">驳回</button>
              </template>
              <span v-else class="mono dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped lang="scss">
.page { display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.head h1 { font-size: 18px; margin: 0 0 4px; color: var(--text); }
.sub { margin: 0; font-size: 12px; color: var(--text-dim); }
.actions { display: flex; gap: 8px; align-items: center; }
.sel, .btn {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  padding: 6px 10px;
  cursor: pointer;
}
.btn:hover { color: var(--text); background: var(--bg-hover); }
.btn.primary { color: var(--ok, #63b463); border-color: rgba(99, 180, 99, 0.4); }
.btn.danger { color: var(--danger, #d38); border-color: rgba(220, 90, 90, 0.4); }
.btn.small { padding: 3px 8px; font-size: 11px; }
.error { color: var(--danger, #d38); font-size: 12px; }
.ok-note { color: var(--ok, #63b463); font-size: 12px; }
.card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel); overflow: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th, .tbl td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.tbl th { font-size: 11px; color: var(--text-dim); font-weight: 600; white-space: nowrap; }
.tbl td { color: var(--text-muted); }
.mono { font-family: var(--font-mono, monospace); }
.dim { color: var(--text-dim); }
.empty { text-align: center; color: var(--text-dim); padding: 18px 0; }
.delta { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 6px; }
.chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 3px;
  border: 1px solid var(--border);
  font-size: 11px;
}
.chip.pending { color: #d9a441; border-color: rgba(217, 164, 65, 0.4); }
.chip.claimed { color: var(--ok, #63b463); border-color: rgba(99, 180, 99, 0.4); }
.chip.rejected { color: var(--danger, #d38); border-color: rgba(220, 90, 90, 0.4); }
</style>
