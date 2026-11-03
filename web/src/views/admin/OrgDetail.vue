<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AuthError } from '@/api/auth'
import {
  adminCreateMember,
  adminGetOrg,
  adminUpdateOrg,
  type AdminMember,
  type AdminOrg
} from '@/api/admin'

const route = useRoute()
const router = useRouter()
const orgId = Number(route.params.id)

const org = ref<AdminOrg | null>(null)
const members = ref<AdminMember[]>([])
const limits = ref<Array<{ feature: string; limit: number; overridden: boolean }>>([])
const loading = ref(true)
const error = ref('')
const msg = ref('')

const edit = ref({ plan: 'free', status: 'active', notes: '' })
const busyOrg = ref(false)
const memberForm = ref({ email: '', password: '', displayName: '', role: 'org_member' })
const busyMember = ref(false)
const memberError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await adminGetOrg(orgId)
    org.value = d.org
    members.value = d.members
    limits.value = d.limits
    edit.value = { plan: d.org.plan, status: d.org.status, notes: d.org.notes || '' }
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
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
        <h2>生效限额（override ?? 档位默认）</h2>
        <table class="tbl">
          <thead><tr><th>功能键</th><th>限额</th><th>覆盖</th></tr></thead>
          <tbody>
            <tr v-for="l in limits" :key="l.feature">
              <td class="mono">{{ l.feature }}</td>
              <td class="mono">{{ l.limit }}</td>
              <td><span v-if="l.overridden" class="chip warn">override</span><span v-else class="chip">default</span></td>
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
