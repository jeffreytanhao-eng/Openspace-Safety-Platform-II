<script setup lang="ts">
/**
 * R2-21 账号页；R2-26 布局重排（身份 → 修改密码 → 档位与权限 → 升级申请 → 组织成员）
 * + 左侧分段锚点 + 主区可滚动 + 配额紧凑网格。
 * R2-28 普通用户可提交 VIP 升级申请；R2-30 组织管理员可管理最多 3 名成员。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  AuthError,
  authChangePassword,
  authOrgQuota,
  authGetUpgradeRequest,
  authSubmitUpgradeRequest,
  authListOrgMembers,
  authCreateOrgMember,
  authRemoveOrgMember,
  authUpdateBio,
  type QuotaItem,
  type UpgradeRequest,
  type OrgMember
} from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const auth = useAuthStore()

const isVip = computed(() => auth.user?.isVip === true || auth.org?.plan === 'vip')

const statusLabel = computed(() => {
  const s = auth.org?.status
  if (!s) return '—'
  return t(`acct.status.${s}` as Parameters<typeof t>[0])
})

const planLabel = computed(() => {
  if (auth.user?.isVip) return t('acct.plan.vip')
  if (auth.org) return t(`acct.plan.${auth.org.plan}` as Parameters<typeof t>[0])
  return t('acct.plan.normal')
})

/** 组织内身份：管理员 / 成员；无组织时显示普通账号，平台账号显示平台角色 */
const orgRoleLabel = computed(() => {
  const role = auth.user?.role
  if (!role) return '—'
  if (role === 'platform_super_admin' || role === 'platform_ops') {
    return t(`acct.role.${role}` as Parameters<typeof t>[0])
  }
  if (!auth.org) return t('acct.role.normalUser')
  return role === 'org_admin' ? t('acct.orgRole.admin') : t('acct.orgRole.member')
})

/** 档位徽标：普通绿 / VIP 金色 / 超管红（账号级 VIP 与 VIP 管理员同为金色） */
const badgeKind = computed(() => {
  const role = auth.user?.role || ''
  if (role.startsWith('platform_')) return 'super'
  if (auth.org?.plan === 'vip') return role === 'org_admin' ? 'vip-admin' : 'vip-member'
  if (auth.user?.isVip) return 'vip-admin'
  return 'normal'
})

const badgeLabel = computed(() => {
  if (badgeKind.value === 'super') return t('acct.badge.super')
  return planLabel.value
})

/* ---------------- 账号简介 ---------------- */

const bioEditing = ref(false)
const bioDraft = ref('')
const bioSaving = ref(false)
const bioDone = ref('')
const bioError = ref('')
const bioText = computed(() => auth.user?.bio || '')

/** 点击「更新」：先展开输入框，再次点击时保存并收起 */
function onBioAction() {
  if (bioSaving.value) return
  if (bioEditing.value) {
    void saveBio()
    return
  }
  bioError.value = ''
  bioDone.value = ''
  bioDraft.value = ''
  bioEditing.value = true
}

async function saveBio() {
  bioError.value = ''
  bioDone.value = ''
  const v = bioDraft.value.trim()
  if (Array.from(v).length > 20) {
    bioError.value = t('acct.bioTooLong')
    return
  }
  bioSaving.value = true
  try {
    const r = await authUpdateBio(v)
    if (auth.user) auth.user.bio = r.bio
    bioEditing.value = false
    bioDraft.value = ''
    bioDone.value = t('acct.bioDone')
  } catch (e) {
    bioError.value = e instanceof AuthError ? e.message : t('acct.bioFail')
  } finally {
    bioSaving.value = false
  }
}

/* ---------------- 分段锚点 ---------------- */

const scrollEl = ref<HTMLElement | null>(null)
const activeKey = ref('identity')

const navItems = computed(() => {
  const items: Array<{ key: string; label: string }> = [
    { key: 'identity', label: t('acct.identity') },
    { key: 'password', label: t('acct.changePwd') },
    { key: 'plan', label: t('acct.plan') }
  ]
  if (showUpgrade.value) items.push({ key: 'upgrade', label: t('acct.upgrade') })
  if (canManageMembers.value) items.push({ key: 'members', label: t('acct.members') })
  return items
})

function gotoSection(key: string) {
  activeKey.value = key
  const host = scrollEl.value
  const el = host?.querySelector<HTMLElement>(`[data-sec="${key}"]`)
  if (host && el) host.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
}

function onScroll() {
  const host = scrollEl.value
  if (!host) return
  const top = host.scrollTop + 24
  let current = navItems.value[0]?.key ?? 'identity'
  for (const item of navItems.value) {
    const el = host.querySelector<HTMLElement>(`[data-sec="${item.key}"]`)
    if (el && el.offsetTop <= top) current = item.key
  }
  activeKey.value = current
}

/* ---------------- 配额 ---------------- */

const quotaItems = ref<QuotaItem[]>([])
const quotaLoading = ref(false)
const quotaError = ref('')

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

/** 普通账号与个人工作区不展示「单位成员数」配额，成员能力仅正式 VIP 组织具备 */
const visibleQuotaItems = computed(() =>
  quotaItems.value.filter((i) => auth.org?.plan === 'vip' || i.key !== 'members_max')
)

/* ---------------- 修改密码 ---------------- */

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

/* ---------------- R2-28 升级申请 ---------------- */

const upgradeStatus = ref<'none' | 'pending' | 'approved' | 'rejected'>('none')
const upgradeRequest = ref<UpgradeRequest | null>(null)
const upgradeReason = ref('')
const upgradeBusy = ref(false)
const upgradeError = ref('')
const upgradeLoading = ref(false)
/** VIP（组织档位或用户级）不显示升级申请；已通过同样隐藏 */
const showUpgrade = computed(() => !isVip.value && upgradeStatus.value !== 'approved')

async function loadUpgrade() {
  upgradeLoading.value = true
  try {
    const r = await authGetUpgradeRequest()
    upgradeStatus.value = r.status
    upgradeRequest.value = r.request
  } catch {
    upgradeStatus.value = 'none'
    upgradeRequest.value = null
  } finally {
    upgradeLoading.value = false
  }
}

async function submitUpgrade() {
  upgradeError.value = ''
  upgradeBusy.value = true
  try {
    const r = await authSubmitUpgradeRequest(upgradeReason.value.trim())
    upgradeRequest.value = r
    upgradeStatus.value = r.status
    upgradeReason.value = ''
  } catch (e) {
    upgradeError.value = e instanceof AuthError ? e.message : t('acct.upgradeError')
  } finally {
    upgradeBusy.value = false
  }
}

/* ---------------- R2-30 组织成员 ---------------- */

const canManageMembers = computed(
  () => auth.user?.role === 'org_admin' && auth.org?.plan === 'vip' && auth.org?.status === 'active'
)
const members = ref<OrgMember[]>([])
const memberMax = ref(3)
const membersLoading = ref(false)
const membersError = ref('')
const memberForm = ref({ email: '', password: '', displayName: '' })
const memberBusy = ref(false)
const memberBusyId = ref<number | null>(null)

const memberUsage = computed(() => members.value.length)
const memberFull = computed(() => memberUsage.value >= memberMax.value)

async function loadMembers() {
  if (!canManageMembers.value) return
  membersLoading.value = true
  membersError.value = ''
  try {
    const r = await authListOrgMembers()
    members.value = r.items || []
    memberMax.value = r.max || 3
  } catch (e) {
    membersError.value = e instanceof AuthError ? e.message : t('acct.memberLoadFail')
  } finally {
    membersLoading.value = false
  }
}

async function addMember() {
  membersError.value = ''
  memberBusy.value = true
  try {
    await authCreateOrgMember({
      email: memberForm.value.email.trim(),
      password: memberForm.value.password,
      displayName: memberForm.value.displayName.trim() || undefined
    })
    memberForm.value = { email: '', password: '', displayName: '' }
    await loadMembers()
    await loadQuota()
  } catch (e) {
    membersError.value = e instanceof AuthError ? e.message : t('acct.memberCreateFail')
  } finally {
    memberBusy.value = false
  }
}

async function removeMember(m: OrgMember) {
  if (!window.confirm(t('acct.memberRemoveConfirm', { name: m.display_name || m.email }))) return
  membersError.value = ''
  memberBusyId.value = m.id
  try {
    await authRemoveOrgMember(m.id)
    await loadMembers()
    await loadQuota()
  } catch (e) {
    membersError.value = e instanceof AuthError ? e.message : t('acct.memberRemoveFail')
  } finally {
    memberBusyId.value = null
  }
}

onMounted(async () => {
  void loadUpgrade()
  await nextTick()
  onScroll()
})

// 会话恢复完成后才知道当前等级/组织：VIP 模板的配额与成员数据在 org 就绪时补载
watch(
  () => auth.org?.id,
  (id) => {
    if (!id) return
    void loadQuota()
    void loadMembers()
  },
  { immediate: true }
)
</script>

<template>
  <div class="acct-wrap">
    <aside class="acct-nav">
      <button
        v-for="item in navItems"
        :key="item.key"
        type="button"
        class="nav-item"
        :class="{ on: activeKey === item.key }"
        @click="gotoSection(item.key)"
      >
        {{ item.label }}
      </button>
    </aside>

    <div class="acct-main">
      <header class="head">
        <div>
          <h1>{{ t('acct.title') }}</h1>
        </div>
      </header>

      <div ref="scrollEl" class="acct-scroll" @scroll="onScroll">
        <div class="page">
          <div class="row-2">
          <section class="card" data-sec="identity">
            <h2>{{ t('acct.identity') }}</h2>
            <dl class="kv kv-1">
              <div><dt>{{ t('acct.displayName') }}</dt><dd>{{ auth.user?.displayName || '—' }}</dd></div>
              <div><dt>{{ t('acct.email') }}</dt><dd class="mono">{{ auth.user?.email || '—' }}</dd></div>
            </dl>
            <div class="bio-block">
              <div class="bio-label">{{ t('acct.bio') }}</div>
              <div class="bio-row">
                <span class="bio-text" :class="{ empty: !bioText }">
                  {{ bioText || t('acct.bioEmpty') }}
                </span>
                <button type="button" class="btn small" :disabled="bioSaving" @click="onBioAction">
                  {{ bioSaving ? t('acct.saving') : t('acct.bioUpdate') }}
                </button>
              </div>
              <input
                v-if="bioEditing"
                v-model="bioDraft"
                type="text"
                maxlength="20"
                @keyup.enter="saveBio"
              />
              <p v-if="bioError" class="error inline">{{ bioError }}</p>
              <p v-else-if="bioDone" class="ok-note inline">{{ bioDone }}</p>
            </div>
            <!-- VIP 模板：组织信息（普通模板不渲染） -->
            <div v-if="isVip && auth.org" class="org-block">
              <div class="quota-title">{{ t('acct.orgInfo') }}</div>
              <dl class="kv kv-2">
                <div><dt>{{ t('acct.orgName') }}</dt><dd>{{ auth.org?.personal ? (auth.user?.displayName || auth.user?.email || t('acct.noOrgShort')) : (auth.org?.name || t('acct.noOrgShort')) }}</dd></div>
                <div><dt>{{ t('acct.orgRole') }}</dt><dd>{{ orgRoleLabel }}</dd></div>
                <div v-if="auth.org"><dt>{{ t('acct.orgStatus') }}</dt><dd>{{ statusLabel }}</dd></div>
              </dl>
            </div>
          </section>

          <section class="card" data-sec="password">
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
        </div>

        <section class="card" data-sec="plan">
          <h2>{{ t('acct.plan') }}</h2>
          <dl class="kv">
            <div>
              <dt>{{ t('acct.planLabel') }}</dt>
              <dd>
                <span class="chip" :class="badgeKind">{{ badgeLabel }}</span>
              </dd>
            </div>
          </dl>

          <!-- VIP 模板：配额用量（普通模板只展示档位徽标） -->
          <div v-if="isVip && auth.org" class="quota">
              <div class="quota-title">{{ t('acct.quota') }}</div>
              <p v-if="quotaLoading" class="dim">{{ t('acct.quotaLoading') }}</p>
              <p v-else-if="quotaError" class="dim">{{ quotaError }}</p>
              <div v-else-if="visibleQuotaItems.length" class="quota-grid">
                <div v-for="item in visibleQuotaItems" :key="item.key" class="q-item">
                  <span class="q-label">{{ item.label }}</span>
                  <span class="q-val mono">{{ quotaText(item) }}</span>
                </div>
              </div>
            </div>

        </section>

        <section v-if="showUpgrade" class="card" data-sec="upgrade">
          <h2>{{ t('acct.upgrade') }}</h2>
          <p class="dim">{{ t('acct.upgradeHint') }}</p>
          <p v-if="upgradeLoading" class="dim">{{ t('acct.quotaLoading') }}</p>
          <template v-else-if="upgradeStatus === 'pending'">
            <button type="button" class="btn" disabled>{{ t('acct.upgradePending') }}</button>
          </template>
          <template v-else>
            <p v-if="upgradeStatus === 'rejected'" class="hint warn">
              {{ t('acct.upgradeRejected') }}
              <template v-if="upgradeRequest?.review_note"> · {{ upgradeRequest.review_note }}</template>
            </p>
            <form class="upgrade-form" @submit.prevent="submitUpgrade">
              <label>
                <span>{{ t('acct.upgradeReason') }}</span>
                <textarea v-model="upgradeReason" rows="3" maxlength="500" />
              </label>
              <p v-if="upgradeError" class="error inline">{{ upgradeError }}</p>
              <div class="pwd-actions">
                <button type="submit" class="btn primary" :disabled="upgradeBusy">
                  {{ upgradeBusy ? t('acct.saving') : t('acct.upgradeSubmit') }}
                </button>
              </div>
            </form>
          </template>
        </section>

        <!-- VIP 模板：组织成员（普通模板与升级申请互斥） -->
        <section v-if="canManageMembers" class="card" data-sec="members">
          <h2>
            {{ t('acct.members') }}
            <span class="chip">{{ memberUsage }} / {{ memberMax }}</span>
          </h2>
          <p class="dim">{{ t('acct.membersHint') }}</p>

          <p v-if="membersLoading" class="dim">{{ t('acct.quotaLoading') }}</p>
          <ul v-else class="member-list">
            <li v-for="m in members" :key="m.id">
              <div class="m-main">
                <span class="m-name">{{ m.display_name || m.email }}</span>
                <span class="m-mail mono">{{ m.email }}</span>
              </div>
              <button
                type="button"
                class="btn small danger"
                :disabled="memberBusyId === m.id"
                @click="removeMember(m)"
              >
                {{ memberBusyId === m.id ? t('acct.saving') : t('acct.memberRemove') }}
              </button>
            </li>
            <li v-if="!members.length" class="dim">{{ t('acct.memberEmpty') }}</li>
          </ul>

          <form class="member-form" @submit.prevent="addMember">
            <label>
              <span>{{ t('acct.memberEmail') }}</span>
              <input v-model="memberForm.email" type="email" required />
            </label>
            <label>
              <span>{{ t('acct.memberDisplayName') }}</span>
              <input v-model="memberForm.displayName" type="text" maxlength="64" />
            </label>
            <label>
              <span>{{ t('acct.memberPassword') }}</span>
              <input v-model="memberForm.password" type="password" minlength="8" required />
            </label>
            <p v-if="membersError" class="error inline">{{ membersError }}</p>
            <div class="pwd-actions">
              <button type="submit" class="btn primary" :disabled="memberBusy || memberFull">
                {{ memberFull ? t('acct.memberFull') : memberBusy ? t('acct.saving') : t('acct.memberAdd') }}
              </button>
            </div>
          </form>
        </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.acct-wrap {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 14px;
}
.acct-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-self: start;
  padding-top: 6px;
}
.nav-item {
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-left: 2px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  padding: 2px 10px 7px;
  cursor: pointer;
}
.nav-item:hover { color: var(--text); }
.nav-item.on { color: var(--text); border-left-color: var(--watch); background: var(--bg-panel); }
.acct-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.head { flex: 0 0 auto; padding: 9px 10px 12px 0; }
.head h1 { font-size: 18px; margin: 0 0 4px; color: var(--text); }
.acct-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  padding-right: 10px;
  scrollbar-width: thin;
}
.page { display: flex; flex-direction: column; gap: 12px; max-width: 760px; padding-bottom: 24px; }
.row-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.org-block { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.kv.kv-1 { grid-template-columns: minmax(0, 1fr); }
.kv.kv-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.bio-block { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
.bio-label { font-size: 11px; color: var(--text-dim); }
.bio-row { display: flex; align-items: center; gap: 8px; }
.bio-text { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
.bio-text.empty { color: var(--text-dim); }
.bio-block input {
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-size: 12px; padding: 6px 9px; outline: none; font-family: inherit;
}
.bio-block input:focus { border-color: var(--watch); }
.card {
  border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
  background: var(--bg-panel); display: flex; flex-direction: column; gap: 10px;
}
.card h2 { margin: 0; font-size: 14px; color: var(--text); font-weight: 600; display: flex; align-items: center; gap: 8px; }
.kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
.kv dt { font-size: 11px; color: var(--text-dim); }
.kv dd { margin: 3px 0 0; font-size: 12px; color: var(--text-muted); word-break: normal; overflow-wrap: break-word; }
.chip {
  display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 11px;
  border: 1px solid var(--border); color: var(--text-muted);
}
.chip.vip { margin-left: 6px; border-color: var(--watch); color: var(--watch); }
.chip.normal { color: #63b463; border-color: rgba(99, 180, 99, 0.45); }
.chip.vip-member { color: #d9c04a; border-color: rgba(217, 192, 74, 0.45); }
.chip.vip-admin { color: #e0b45c; border-color: rgba(224, 180, 92, 0.5); }
.chip.super { color: #d95a5a; border-color: rgba(217, 90, 90, 0.45); }
.quota-title { font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
.quota-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 12px; }
.q-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  border-bottom: 1px dashed var(--border); padding: 4px 2px; min-width: 0;
}
.q-label { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-val { font-size: 12px; color: var(--text); white-space: nowrap; }
.pwd-form, .upgrade-form, .member-form { display: flex; flex-direction: column; gap: 10px; max-width: 380px; }
.pwd-form label, .upgrade-form label, .member-form label { display: flex; flex-direction: column; gap: 4px; }
.pwd-form label span, .upgrade-form label span, .member-form label span { font-size: 11px; color: var(--text-dim); }
.pwd-form input, .upgrade-form textarea, .member-form input {
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-size: 12px; padding: 6px 9px; outline: none; font-family: inherit;
}
.pwd-form input:focus, .upgrade-form textarea:focus, .member-form input:focus { border-color: var(--watch); }
.upgrade-form textarea { resize: vertical; }
.pwd-actions { display: flex; justify-content: flex-end; }
.btn {
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
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.dim { color: var(--text-dim); font-size: 12px; margin: 0; }
.mono { font-family: var(--mono, ui-monospace, monospace); }
.inline { margin: 0; }
.error { color: var(--danger, #d38); font-size: 12px; }
.ok-note { color: var(--ok, #63b463); font-size: 12px; }
.hint.warn { color: var(--warn, #c9a227); }
.member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.member-list li {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border-bottom: 1px solid var(--border); padding: 8px 2px;
}
.m-main { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.m-name { font-size: 12px; color: var(--text); }
.m-mail { font-size: 11px; color: var(--text-dim); }
@media (max-width: 760px) {
  .acct-wrap { grid-template-columns: 1fr; }
  .acct-nav { flex-direction: row; flex-wrap: wrap; }
  .row-2 { grid-template-columns: 1fr; }
  .kv { grid-template-columns: 1fr; }
  .quota-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
