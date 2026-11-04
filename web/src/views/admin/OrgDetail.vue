<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AuthError } from '@/api/auth'
import {
  adminCreateMember,
  adminGetOrg,
  adminUpdateOrg,
  adminSetQuotaOverride,
  adminClearQuotaOverride,
  adminSetFlagOverride,
  adminClearFlagOverride,
  type AdminMember,
  type AdminOrg,
  type AdminQuotaRow,
  type AdminFlagRow
} from '@/api/admin'

const route = useRoute()
const router = useRouter()
const orgId = Number(route.params.id)

const org = ref<AdminOrg | null>(null)
const members = ref<AdminMember[]>([])
const quotas = ref<AdminQuotaRow[]>([])
const flags = ref<AdminFlagRow[]>([])
const loading = ref(true)
const error = ref('')
const msg = ref('')

const edit = ref({ plan: 'free', status: 'active', notes: '' })
const busyOrg = ref(false)
const memberForm = ref({ email: '', password: '', displayName: '', role: 'org_member' })
const busyMember = ref(false)
const memberError = ref('')

/** 每行 override 输入框（key → 输入值字符串） */
const quotaInputs = ref<Record<string, string>>({})
const busyQuota = ref('')
/** 每行开关忙碌态 */
const busyFlag = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await adminGetOrg(orgId)
    org.value = d.org
    members.value = d.members
    quotas.value = d.quotas || []
    flags.value = d.flags || []
    edit.value = { plan: d.org.plan, status: d.org.status, notes: d.org.notes || '' }
    syncInputs()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

/** 输入框对齐服务端行（override ?? 空） */
function syncInputs() {
  const next: Record<string, string> = {}
  for (const q of quotas.value) next[q.feature] = q.override === null ? '' : String(q.override)
  quotaInputs.value = next
}

/** scope 四档文案 */
const scopeText: Record<number, string> = { 0: '不开放', 1: '样例窗', 2: '托管相关', 3: '全量公开池' }
/** Pc 位图分解文案 */
const PC_BITS: Array<{ bit: number; name: string }> = [
  { bit: 1, name: 'Foster' },
  { bit: 2, name: 'Chan' },
  { bit: 4, name: 'Alfano' },
  { bit: 8, name: '官方CDM' }
]
function displayValue(q: AdminQuotaRow): string {
  if (q.unit === 'scope') return `${q.effective}（${scopeText[q.effective] ?? '未知'}）`
  if (q.unit === 'bitmap') {
    const names = PC_BITS.filter((b) => (q.effective & b.bit) !== 0).map((b) => b.name)
    return `${q.effective}（${names.join('+') || '无'}）`
  }
  if (q.unit === 'days') return `${q.effective} 天`
  return String(q.effective)
}
function displayDefault(q: AdminQuotaRow): string {
  if (q.unit === 'scope') return `${q.default}（${scopeText[q.default] ?? '未知'}）`
  if (q.unit === 'bitmap') {
    const names = PC_BITS.filter((b) => (q.default & b.bit) !== 0).map((b) => b.name)
    return `${q.default}（${names.join('+') || '无'}）`
  }
  return String(q.default)
}

/** 保存数字 override */
async function saveQuota(q: AdminQuotaRow) {
  const raw = (quotaInputs.value[q.feature] ?? '').trim()
  if (busyQuota.value) return
  const n = Number(raw)
  if (raw === '' || !Number.isInteger(n) || n < 0) {
    error.value = `${q.label}：请输入非负整数（留空表示清除覆盖后保存无效，请用「恢复默认」）`
    return
  }
  if (q.override !== null && n === q.override) {
    msg.value = `${q.label}：覆盖值未变化`
    return
  }
  error.value = ''
  msg.value = ''
  busyQuota.value = q.feature
  try {
    const row = await adminSetQuotaOverride(orgId, q.feature, n)
    replaceQuota(row)
    msg.value = `${q.label}：override 已设为 ${n}，立即生效（写审计）`
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyQuota.value = ''
  }
}

/** 恢复档位默认（清除 override） */
async function resetQuota(q: AdminQuotaRow) {
  if (busyQuota.value) return
  error.value = ''
  msg.value = ''
  busyQuota.value = q.feature
  try {
    const row = await adminClearQuotaOverride(orgId, q.feature)
    replaceQuota(row)
    quotaInputs.value[q.feature] = ''
    msg.value = `${q.label}：已恢复档位默认（${row.default}），立即生效（写审计）`
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyQuota.value = ''
  }
}

function replaceQuota(row: AdminQuotaRow) {
  const i = quotas.value.findIndex((q) => q.feature === row.feature)
  if (i >= 0) quotas.value[i] = row
}

/** 切换功能开关 */
async function toggleFlag(f: AdminFlagRow) {
  if (busyFlag.value) return
  error.value = ''
  msg.value = ''
  busyFlag.value = f.key
  try {
    const row = await adminSetFlagOverride(orgId, f.key, !f.enabled)
    const i = flags.value.findIndex((x) => x.key === row.key)
    if (i >= 0) flags.value[i] = row
    msg.value = `${f.label}：已${row.enabled ? '开启' : '关闭'}，立即生效（写审计）`
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyFlag.value = ''
  }
}

/** 功能开关恢复目录默认 */
async function resetFlag(f: AdminFlagRow) {
  if (busyFlag.value) return
  error.value = ''
  msg.value = ''
  busyFlag.value = f.key
  try {
    const row = await adminClearFlagOverride(orgId, f.key)
    const i = flags.value.findIndex((x) => x.key === row.key)
    if (i >= 0) flags.value[i] = row
    msg.value = `${f.label}：已恢复目录默认（${row.default ? '开' : '关'}），立即生效（写审计）`
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyFlag.value = ''
  }
}

async function saveOrg() {
  if (busyOrg.value) return
  msg.value = ''
  error.value = ''
  busyOrg.value = true
  try {
    org.value = await adminUpdateOrg(orgId, {
      plan: edit.value.plan,
      status: edit.value.status,
      notes: edit.value.notes
    })
    msg.value = '已保存（写审计）'
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyOrg.value = false
  }
}

async function addMember() {
  if (busyMember.value) return
  memberError.value = ''
  busyMember.value = true
  try {
    await adminCreateMember(orgId, {
      email: memberForm.value.email.trim(),
      password: memberForm.value.password,
      displayName: memberForm.value.displayName.trim() || undefined,
      role: memberForm.value.role
    })
    memberForm.value = { email: '', password: '', displayName: '', role: 'org_member' }
    await load()
  } catch (e) {
    memberError.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busyMember.value = false
  }
}

const statusText: Record<string, string> = { active: '正常', suspended: '已暂停', closed: '已关闭' }
const roleText: Record<string, string> = {
  org_admin: '组织管理员',
  org_member: '成员'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>{{ org?.name || '组织详情' }}</h1>
        <p class="sub">
          <button type="button" class="btn small" @click="router.push('/admin/orgs')">← 返回列表</button>
        </p>
      </div>
    </div>

    <div v-if="loading" class="card">加载中…</div>
    <template v-else>
      <div v-if="error" class="error">{{ error }}</div>
      <div v-if="msg" class="ok-msg">{{ msg }}</div>

      <div class="card">
        <h2>基本信息与档位</h2>
        <div class="grid">
          <label><span>档位</span>
            <select v-model="edit.plan">
              <option value="free">free</option>
              <option value="normal">normal</option>
              <option value="vip">vip</option>
            </select>
          </label>
          <label><span>状态</span>
            <select v-model="edit.status">
              <option value="active">正常（active）</option>
              <option value="suspended">暂停（suspended，登录被拒）</option>
              <option value="closed">关闭（closed）</option>
            </select>
          </label>
        </div>
        <label class="notes"><span>备注（平台内部）</span>
          <textarea v-model="edit.notes" rows="2" maxlength="500" />
        </label>
        <div class="actions">
          <button type="button" class="btn primary" :disabled="busyOrg" @click="saveOrg">
            {{ busyOrg ? '保存中…' : '保存变更' }}
          </button>
        </div>
      </div>

      <div class="card">
        <h2>配额与功能开关</h2>
        <p class="hint" style="margin-top: -6px">
          生效值 = 组织覆盖（override）?? 档位默认，保存后立即生效无需重启；「恢复档位默认」清除覆盖。
          降级后用量超过新上限时冻结新建作业，历史数据完整保留。
        </p>
        <table class="tbl">
          <thead>
            <tr>
              <th>功能键</th>
              <th>档位默认</th>
              <th>组织覆盖（override）</th>
              <th>生效值</th>
              <th>当前用量</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in quotas" :key="q.feature" :class="{ 'over-row': q.usage > q.effective }">
              <td>
                <div>{{ q.label }}</div>
                <div class="mono dim">{{ q.feature }}</div>
              </td>
              <td class="mono">{{ displayDefault(q) }}</td>
              <td>
                <div class="quota-edit">
                  <input
                    v-model="quotaInputs[q.feature]"
                    type="number"
                    min="0"
                    step="1"
                    :placeholder="`留空 = 用默认（${q.default}）`"
                    :disabled="busyQuota === q.feature"
                  />
                  <button
                    type="button"
                    class="btn small primary"
                    :disabled="busyQuota === q.feature"
                    @click="saveQuota(q)"
                  >
                    {{ busyQuota === q.feature ? '…' : '设置' }}
                  </button>
                </div>
              </td>
              <td class="mono">
                {{ displayValue(q) }}
                <span v-if="q.overridden" class="chip warn">override</span>
                <span v-else class="chip">default</span>
              </td>
              <td class="mono" :class="{ over: q.usage > q.effective }">
                {{ q.usage }}/{{ q.effective }}
                <span v-if="q.usage > q.effective" class="chip warn">超额冻结</span>
              </td>
              <td>
                <button
                  v-if="q.overridden"
                  type="button"
                  class="btn small"
                  :disabled="busyQuota === q.feature"
                  @click="resetQuota(q)"
                >
                  恢复档位默认
                </button>
                <span v-else class="dim">—</span>
              </td>
            </tr>
          </tbody>
        </table>

        <h2 style="margin-top: 20px">功能开关（flag）</h2>
        <table class="tbl">
          <thead>
            <tr><th>开关</th><th>目录默认</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="f in flags" :key="f.key">
              <td>
                <div>{{ f.label }} <span class="mono dim">{{ f.key }}</span></div>
                <div class="dim" style="font-size: 12px">{{ f.description }}</div>
              </td>
              <td>{{ f.default ? '开' : '关' }}</td>
              <td>
                <button
                  type="button"
                  class="btn small"
                  :class="f.enabled ? 'on-btn' : 'off-btn'"
                  :disabled="busyFlag === f.key"
                  @click="toggleFlag(f)"
                >
                  {{ f.enabled ? '开启' : '关闭' }}
                </button>
                <span v-if="f.overridden" class="chip warn" style="margin-left: 6px">override</span>
                <span v-else class="chip" style="margin-left: 6px">default</span>
              </td>
              <td>
                <button
                  v-if="f.overridden"
                  type="button"
                  class="btn small"
                  :disabled="busyFlag === f.key"
                  @click="resetFlag(f)"
                >
                  恢复默认
                </button>
                <span v-else class="dim">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>成员（{{ members.length }}）</h2>
        <table class="tbl">
          <thead><tr><th>ID</th><th>邮箱</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody>
            <tr v-for="m in members" :key="m.id">
              <td class="mono">{{ m.id }}</td>
              <td>{{ m.email }}</td>
              <td>{{ m.display_name }}</td>
              <td>{{ roleText[m.role] || m.role }}</td>
              <td>{{ m.status === 'active' ? '正常' : '停用' }}</td>
              <td class="mono">{{ m.created_at }}</td>
            </tr>
            <tr v-if="!members.length"><td colspan="6" class="empty">无成员</td></tr>
          </tbody>
        </table>

        <h2 style="margin-top: 16px">新建成员</h2>
        <form @submit.prevent="addMember">
          <div class="grid">
            <label><span>邮箱 *</span><input v-model="memberForm.email" type="email" required /></label>
            <label><span>密码 *</span><input v-model="memberForm.password" type="password" required minlength="8" placeholder="至少 8 位" /></label>
            <label><span>姓名</span><input v-model="memberForm.displayName" maxlength="64" placeholder="选填" /></label>
            <label><span>角色</span>
              <select v-model="memberForm.role">
                <option value="org_member">成员</option>
                <option value="org_admin">组织管理员</option>
              </select>
            </label>
          </div>
          <div v-if="memberError" class="error">{{ memberError }}</div>
          <div class="actions">
            <button type="submit" class="btn primary" :disabled="busyMember">
              {{ busyMember ? '创建中…' : '创建成员' }}
            </button>
            <span class="hint">受 members_max 档位限额约束（超限返回升级提示）</span>
          </div>
        </form>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
