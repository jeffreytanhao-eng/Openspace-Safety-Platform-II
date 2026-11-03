<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AuthError } from '@/api/auth'
import { adminCreateOrg, adminListOrgs, type AdminOrg } from '@/api/admin'

const router = useRouter()
const items = ref<AdminOrg[]>([])
const loading = ref(false)
const error = ref('')

const wizardOpen = ref(false)
const busy = ref(false)
const wizError = ref('')
const form = ref({ name: '', plan: 'free', adminEmail: '', adminPassword: '', adminDisplayName: '' })

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = (await adminListOrgs()).items
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

async function submitWizard() {
  if (busy.value) return
  wizError.value = ''
  busy.value = true
  try {
    await adminCreateOrg({
      name: form.value.name.trim(),
      plan: form.value.plan,
      adminEmail: form.value.adminEmail.trim(),
      adminPassword: form.value.adminPassword,
      adminDisplayName: form.value.adminDisplayName.trim() || undefined
    })
    wizardOpen.value = false
    form.value = { name: '', plan: 'free', adminEmail: '', adminPassword: '', adminDisplayName: '' }
    await load()
  } catch (e) {
    wizError.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busy.value = false
  }
}

const statusText: Record<string, string> = {
  active: '正常',
  suspended: '已暂停',
  closed: '已关闭'
}
const statusClass: Record<string, string> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>客户组织</h1>
        <p class="sub">开通、升降档与生命周期管理；全部写操作进审计。</p>
      </div>
      <button type="button" class="btn primary" @click="wizardOpen = !wizardOpen">
        {{ wizardOpen ? '收起开通向导' : '+ 开通组织' }}
      </button>
    </div>

    <div v-if="wizardOpen" class="card wizard">
      <h2>开通新组织</h2>
      <form @submit.prevent="submitWizard">
        <div class="grid">
          <label><span>组织名称 *</span><input v-model="form.name" required maxlength="128" /></label>
          <label><span>初始档位</span>
            <select v-model="form.plan">
              <option value="free">free</option>
              <option value="normal">normal</option>
              <option value="vip">vip</option>
            </select>
          </label>
          <label><span>管理员邮箱 *</span><input v-model="form.adminEmail" type="email" required /></label>
          <label><span>管理员密码 *</span><input v-model="form.adminPassword" type="password" required minlength="8" placeholder="至少 8 位" /></label>
          <label><span>管理员姓名</span><input v-model="form.adminDisplayName" maxlength="64" placeholder="选填" /></label>
        </div>
        <div v-if="wizError" class="error">{{ wizError }}</div>
        <div class="actions">
          <button type="submit" class="btn primary" :disabled="busy">{{ busy ? '开通中…' : '开通' }}</button>
        </div>
      </form>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>ID</th><th>组织名称</th><th>档位</th><th>状态</th><th>成员</th><th>创建时间</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="7" class="empty">加载中…</td></tr>
          <tr v-else-if="!items.length"><td colspan="7" class="empty">暂无组织</td></tr>
          <tr v-for="o in items" :key="o.id">
            <td class="mono">{{ o.id }}</td>
            <td>{{ o.name }}</td>
            <td><span class="chip plan" :class="o.plan">{{ o.plan.toUpperCase() }}</span></td>
            <td><span class="chip" :class="statusClass[o.status]">{{ statusText[o.status] || o.status }}</span></td>
            <td class="mono">{{ o.members ?? '—' }}</td>
            <td class="mono">{{ o.created_at }}</td>
            <td><button type="button" class="btn" @click="router.push(`/admin/orgs/${o.id}`)">详情</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
