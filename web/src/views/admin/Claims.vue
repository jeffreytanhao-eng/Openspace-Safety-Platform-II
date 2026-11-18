<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { AuthError } from '@/api/auth'
import {
  adminListObjectClaims,
  adminApproveObjectClaim,
  adminRejectObjectClaim,
  adminReleaseOwner,
  type AdminObjectClaim,
  type ObjectClaimStatus
} from '@/api/admin'

const { t } = useI18n()

const status = ref<ObjectClaimStatus | 'all'>('pending')
const items = ref<AdminObjectClaim[]>([])
const loading = ref(false)
const error = ref('')
const msg = ref('')
const acting = ref(0)

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

/**
 * 审核操作弹层：内置浏览器会屏蔽 window.confirm / window.prompt（直接返回 null），
 * 导致按钮“点了没反应”，因此改用页面内弹层收集意见。
 */
type DialogMode = 'approve' | 'reject' | 'revoke'
const dialogMode = ref<DialogMode | null>(null)
const dialogRow = ref<AdminObjectClaim | null>(null)
const dialogNote = ref('')
const dialogBusy = ref(false)
const dialogError = ref('')

const dialogText = computed(() => {
  const r = dialogRow.value
  if (!r || !dialogMode.value) return ''
  const name = r.name ? `${r.name}（NORAD ${r.norad_id}）` : `NORAD ${r.norad_id}`
  const org = r.org_name || `#${r.org_id}`
  if (dialogMode.value === 'approve') {
    return `通过 ${name} 的业主认领？通过后该目标全局唯一归属 ${org}。`
  }
  if (dialogMode.value === 'reject') {
    return `驳回 ${name} 的业主认领，可填写原因（将回传给申请方）。`
  }
  return `撤销 ${org} 对 ${name} 的业主认领？撤销后该目标恢复为无业主状态，已绑定的星历会解除绑定，档案参数一并删除，操作不可恢复。`
})

const dialogConfirmText = computed(() => {
  if (dialogMode.value === 'approve') return '确认通过'
  if (dialogMode.value === 'reject') return '确认驳回'
  return '确认撤销'
})

function openDialog(mode: DialogMode, row: AdminObjectClaim): void {
  dialogMode.value = mode
  dialogRow.value = row
  dialogNote.value = ''
  dialogError.value = ''
}

function closeDialog(): void {
  if (dialogBusy.value) return
  dialogMode.value = null
  dialogRow.value = null
  dialogNote.value = ''
}

async function confirmDialog(): Promise<void> {
  const row = dialogRow.value
  const mode = dialogMode.value
  if (!row || !mode || dialogBusy.value) return
  dialogBusy.value = true
  dialogError.value = ''
  error.value = ''
  msg.value = ''
  acting.value = row.id
  try {
    if (mode === 'approve') {
      await adminApproveObjectClaim(row.id, dialogNote.value)
      msg.value = `NORAD ${row.norad_id} 认领已通过`
    } else if (mode === 'reject') {
      await adminRejectObjectClaim(row.id, dialogNote.value)
      msg.value = `NORAD ${row.norad_id} 认领已驳回`
    } else {
      await adminReleaseOwner(row.norad_id)
      msg.value = `NORAD ${row.norad_id} 业主认领已撤销`
    }
    dialogMode.value = null
    dialogRow.value = null
    dialogNote.value = ''
    await load()
  } catch (e) {
    dialogError.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    dialogBusy.value = false
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

/**
 * R2-25：历史直写标记。
 * 规则仅看数据形态：owner 且已 claimed 且无审核人/审核时间 —— 对任意 NORAD 一视同仁，
 * 不按星座或组织做特例；不自动撤销、不改写历史数据。
 */
function isLegacyDirect(row: AdminObjectClaim): boolean {
  return row.claim_status === 'claimed' && !row.reviewed_by && !row.reviewed_at
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
            <td>
              <span class="chip" :class="row.claim_status">{{ STATUS_LABEL[row.claim_status] }}</span>
              <span
                v-if="isLegacyDirect(row)"
                class="chip legacy"
                :title="t('adm.claims.legacyTip')"
              >{{ t('adm.claims.legacy') }}</span>
            </td>
            <td class="delta">{{ row.review_note || '—' }}</td>
            <td class="ops">
              <template v-if="row.claim_status === 'pending'">
                <button type="button" class="btn small primary" :disabled="acting === row.id" @click="openDialog('approve', row)">通过</button>
                <button type="button" class="btn small danger" :disabled="acting === row.id" @click="openDialog('reject', row)">驳回</button>
              </template>
              <button
                v-else-if="row.claim_status === 'claimed'"
                type="button"
                class="btn small danger"
                :disabled="acting === row.id"
                @click="openDialog('revoke', row)"
              >
                {{ acting === row.id ? '撤销中…' : '撤销认领' }}
              </button>
              <span v-else class="mono dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="dialogMode" class="mask" @click.self="closeDialog">
      <div class="dlg">
        <h3>{{ dialogMode === 'approve' ? '通过认领' : dialogMode === 'reject' ? '驳回认领' : '撤销认领' }}</h3>
        <p class="dlg-text">{{ dialogText }}</p>
        <label v-if="dialogMode !== 'revoke'" class="dlg-field">
          <span>{{ dialogMode === 'reject' ? '驳回原因' : '审核意见' }}</span>
          <textarea
            v-model="dialogNote"
            rows="3"
            maxlength="255"
            :placeholder="dialogMode === 'reject' ? '会回传给申请方，可留空' : '可选'"
          ></textarea>
        </label>
        <div v-if="dialogError" class="error">{{ dialogError }}</div>
        <div class="dlg-ops">
          <button type="button" class="btn" :disabled="dialogBusy" @click="closeDialog">取消</button>
          <button
            type="button"
            class="btn"
            :class="dialogMode === 'approve' ? 'primary' : 'danger'"
            :disabled="dialogBusy"
            @click="confirmDialog"
          >
            {{ dialogBusy ? '处理中…' : dialogConfirmText }}
          </button>
        </div>
      </div>
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
.chip.legacy {
  margin-left: 6px;
  color: #d9a441;
  border-color: rgba(217, 164, 65, 0.5);
  background: rgba(217, 164, 65, 0.08);
}
.mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.dlg {
  width: min(440px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}
.dlg h3 { margin: 0; font-size: 14px; color: var(--text); }
.dlg-text { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-muted); }
.dlg-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-dim); }
.dlg-field textarea {
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 6px 8px;
}
.dlg-ops { display: flex; justify-content: flex-end; gap: 8px; }
</style>
