<script setup lang="ts">
/**
 * R2-21 账号页：身份 / 档位与权限（只读）/ 修改密码 / 升级续费占位。
 * 不提供任何自助升档入口；改密只作用于当前登录账号。
 */
import { computed, onMounted, ref } from 'vue'
import { AuthError, authChangePassword, authOrgQuota, type QuotaItem } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const auth = useAuthStore()

const quotaItems = ref<QuotaItem[]>([])
const quotaLoading = ref(false)
const quotaError = ref('')

const roleLabel = computed(() => {
  const role = auth.user?.role
  if (!role) return '—'
  return t(`acct.role.${role}` as Parameters<typeof t>[0])
})

const statusLabel = computed(() => {
  const s = auth.org?.status
  if (!s) return '—'
  return t(`acct.status.${s}` as Parameters<typeof t>[0])
})

async function loadQuota() {
  if (!auth.org) return
  quotaLoading.value = true
  quotaError.value = ''
  try {
    const r = await authOrgQuota()
    quotaItems.value = r.items || []
  } catch (e) {
    quotaError.value = e instanceof AuthError ? e.message : t('acct.quotaFail')
  } finally {
    quotaLoading.value = false
  }
}

function quotaText(item: QuotaItem): string {
  if (item.limit === null) return t('acct.unlimited')
  return `${item.usage} / ${item.limit}`
}

// ---- 修改密码 ----
const oldPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const pwdSaving = ref(false)
const pwdError = ref('')
const pwdDone = ref('')

async function submitPwd() {
  pwdError.value = ''
  pwdDone.value = ''
  if (newPwd.value.length < 8) {
    pwdError.value = t('acct.pwdTooShort')
    return
  }
  if (newPwd.value !== confirmPwd.value) {
    pwdError.value = t('acct.pwdMismatch')
    return
  }
  if (newPwd.value === oldPwd.value) {
    pwdError.value = t('acct.pwdSame')
    return
  }
  pwdSaving.value = true
  try {
    await authChangePassword(oldPwd.value, newPwd.value)
    oldPwd.value = ''
    newPwd.value = ''
    confirmPwd.value = ''
    pwdDone.value = t('acct.pwdDone')
  } catch (e) {
    pwdError.value = e instanceof AuthError ? e.message : '密码修改失败'
  } finally {
    pwdSaving.value = false
  }
}

onMounted(loadQuota)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>{{ t('acct.title') }}</h1>
        <p class="sub">{{ t('acct.sub') }}</p>
      </div>
    </div>

    <section class="card">
      <h2>{{ t('acct.identity') }}</h2>
      <dl class="kv">
        <div><dt>{{ t('acct.displayName') }}</dt><dd>{{ auth.user?.displayName || '—' }}</dd></div>
        <div><dt>{{ t('acct.email') }}</dt><dd class="mono">{{ auth.user?.email || '—' }}</dd></div>
        <div><dt>{{ t('acct.role') }}</dt><dd>{{ roleLabel }}</dd></div>
      </dl>
    </section>

    <section class="card">
      <h2>{{ t('acct.plan') }}</h2>
      <template v-if="auth.org">
        <dl class="kv">
          <div><dt>{{ t('acct.orgName') }}</dt><dd>{{ auth.org.name }}</dd></div>
          <div><dt>{{ t('acct.planLabel') }}</dt><dd><span class="chip">{{ auth.org.plan }}</span></dd></div>
          <div><dt>{{ t('acct.orgStatus') }}</dt><dd>{{ statusLabel }}</dd></div>
        </dl>

        <div class="quota">
          <div class="quota-title">{{ t('acct.quota') }}</div>
          <p v-if="quotaLoading" class="dim">{{ t('acct.quotaLoading') }}</p>
          <p v-else-if="quotaError" class="dim">{{ quotaError }}</p>
          <table v-else-if="quotaItems.length" class="tbl quota-tbl">
            <tbody>
              <tr v-for="item in quotaItems" :key="item.key">
                <td>{{ item.label }}</td>
                <td class="mono num">{{ quotaText(item) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="dim">{{ t('acct.noOrg') }}</p>

      <div class="cap">
        <div class="quota-title">{{ t('acct.capability') }}</div>
        <ul>
          <li>{{ t('acct.capOwner') }}</li>
          <li>{{ t('acct.capNormal') }}</li>
          <li>{{ t('acct.capQuota') }}</li>
        </ul>
      </div>
    </section>

    <section class="card">
      <h2>{{ t('acct.changePwd') }}</h2>
      <form class="pwd-form" @submit.prevent="submitPwd">
        <label>
          <span>{{ t('acct.oldPwd') }}</span>
          <input v-model="oldPwd" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>{{ t('acct.newPwd') }}</span>
          <input v-model="newPwd" type="password" autocomplete="new-password" required />
        </label>
        <label>
          <span>{{ t('acct.confirmPwd') }}</span>
          <input v-model="confirmPwd" type="password" autocomplete="new-password" required />
        </label>
        <p v-if="pwdError" class="error inline">{{ pwdError }}</p>
        <p v-if="pwdDone" class="ok-note inline">{{ pwdDone }}</p>
        <div class="pwd-actions">
          <button type="submit" class="btn primary" :disabled="pwdSaving">
            {{ pwdSaving ? t('acct.saving') : t('acct.savePwd') }}
          </button>
        </div>
      </form>
    </section>

    <section class="card">
      <h2>{{ t('acct.upgrade') }}</h2>
      <p class="dim">{{ t('acct.upgradeHint') }}</p>
      <button type="button" class="btn" disabled>{{ t('acct.upgradeBtn') }}</button>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.head h1 { font-size: 18px; margin: 0 0 4px; color: var(--text); }
.sub { margin: 0; font-size: 12px; color: var(--text-dim); }
.card {
  border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px;
  background: var(--bg-panel); display: flex; flex-direction: column; gap: 10px;
}
.card h2 { margin: 0; font-size: 13px; color: var(--text); font-weight: 600; }
.kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
.kv dt { font-size: 11px; color: var(--text-dim); }
.kv dd { margin: 3px 0 0; font-size: 13px; color: var(--text); word-break: normal; overflow-wrap: break-word; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
  border: 1px solid var(--border); color: var(--text-muted);
}
.quota-title { font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
.quota-tbl { max-width: 420px; }
.quota-tbl td { padding: 4px 6px; font-size: 12px; border-bottom: 1px dashed var(--border); }
.quota-tbl td.num { text-align: right; color: var(--text); }
.cap ul { margin: 0; padding-left: 18px; }
.cap li { font-size: 12px; color: var(--text-muted); line-height: 1.7; }
.pwd-form { display: flex; flex-direction: column; gap: 10px; max-width: 360px; }
.pwd-form label { display: flex; flex-direction: column; gap: 4px; }
.pwd-form label span { font-size: 11px; color: var(--text-dim); }
.pwd-form input {
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-size: 13px; padding: 7px 9px; outline: none;
}
.pwd-form input:focus { border-color: var(--watch); }
.pwd-actions { display: flex; justify-content: flex-end; }
.dim { color: var(--text-dim); font-size: 12px; margin: 0; }
.mono { font-family: var(--mono, ui-monospace, monospace); }
.inline { margin: 0; }
@media (max-width: 720px) {
  .kv { grid-template-columns: 1fr; }
}
</style>
