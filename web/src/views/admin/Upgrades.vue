<script setup lang="ts">
/**
 * R2-28：VIP 升级申请审核。
 * 通过 = 该账号获得用户级 VIP（仍需超管建组织并指定为管理员后才能业主认领）；
 * 驳回 = 写原因，用户可在账号页修改理由后重新提交。
 */
import { onMounted, ref } from 'vue'
import { AuthError } from '@/api/auth'
import {
  adminListUpgradeRequests,
  adminApproveUpgradeRequest,
  adminRejectUpgradeRequest,
  type AdminUpgradeRequest
} from '@/api/admin'

const items = ref<AdminUpgradeRequest[]>([])
const status = ref<'pending' | 'all'>('pending')
const loading = ref(false)
const error = ref('')
const notice = ref('')
const busyId = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await adminListUpgradeRequests(status.value)
    items.value = r.items
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

async function setStatus(s: 'pending' | 'all') {
  status.value = s
  await load()
}

async function approve(row: AdminUpgradeRequest) {
  if (!window.confirm(`通过 ${row.email} 的 VIP 升级申请？`)) return
  busyId.value = row.id
  error.value = ''
  notice.value = ''
  try {
    await adminApproveUpgradeRequest(row.id)
    notice.value = `已通过 ${row.email} 的升级申请，可在「客户组织」中以该账号开通组织。`
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyId.value = null
  }
}

async function reject(row: AdminUpgradeRequest) {
  const note = window.prompt(`驳回 ${row.email} 的升级申请，请填写原因（可选）：`, '')
  if (note === null) return
  busyId.value = row.id
  error.value = ''
  notice.value = ''
  try {
    await adminRejectUpgradeRequest(row.id, note.trim())
    notice.value = `已驳回 ${row.email} 的升级申请。`
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyId.value = null
  }
}

const statusText: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回'
}
const statusClass: Record<string, string> = {
  pending: 'pending',
  approved: 'claimed',
  rejected: 'rejected'
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

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>升级申请</h1>
        <p class="sub">普通账号申请升级为 VIP；通过后由超管创建组织并指定其为组织管理员。</p>
      </div>
      <div class="tabs">
        <button type="button" class="btn" :class="{ on: status === 'pending' }" @click="setStatus('pending')">
          待审核
        </button>
        <button type="button" class="btn" :class="{ on: status === 'all' }" @click="setStatus('all')">
          全部
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok-note">{{ notice }}</p>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>ID</th><th>账号</th><th>姓名</th><th>理由</th><th>状态</th><th>提交时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="7" class="empty">加载中…</td></tr>
          <tr v-else-if="!items.length"><td colspan="7" class="empty">暂无申请</td></tr>
          <tr v-for="r in items" :key="r.id">
            <td class="mono">{{ r.id }}</td>
            <td class="mono">{{ r.email }}</td>
            <td>{{ r.display_name || '—' }}</td>
            <td class="delta">{{ r.reason || '—' }}</td>
            <td>
              <span class="chip" :class="statusClass[r.status]">{{ statusText[r.status] || r.status }}</span>
              <div v-if="r.status === 'rejected' && r.review_note" class="note">{{ r.review_note }}</div>
            </td>
            <td class="mono">{{ fmtTime(r.created_at) }}</td>
            <td class="ops">
              <template v-if="r.status === 'pending'">
                <button type="button" class="btn small primary" :disabled="busyId === r.id" @click="approve(r)">
                  通过
                </button>
                <button type="button" class="btn small danger" :disabled="busyId === r.id" @click="reject(r)">
                  驳回
                </button>
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
.tabs { display: flex; gap: 8px; align-items: center; }
.tabs .btn.on { border-color: var(--watch); color: var(--text); }
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
.note { margin-top: 4px; font-size: 11px; color: var(--text-dim); }
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
