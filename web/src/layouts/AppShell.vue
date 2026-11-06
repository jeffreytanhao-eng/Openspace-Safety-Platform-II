<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import logoUrl from '@/assets/logo/openspace-logo.png'
import { useI18n } from '@/composables/useI18n'
import type { MessageKey } from '@/i18n/messages'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const { t, locale, isZh, setLocale } = useI18n()
const auth = useAuthStore()

const bare = computed(() => route.meta.shell === 'bare')
const showChrome = computed(() => !bare.value)

type NavDef = {
  key: string
  labelKey: MessageKey
  hintKey: MessageKey
  to: string
  reserved?: boolean
}

// R2-1：顺序按作业链重排：总览 → 目标 → 星历 → 交会事件 → 筛查 → 态势 → AI(占位) → 文档 → 设置
// 空壳「轨迹」页暂不上侧栏（路由保留，后续接入再放出）。
// AI 侧栏本轮按计划占位保留，不删除入口。
const navDefs: NavDef[] = [
  { key: 'overview', labelKey: 'nav.overview', hintKey: 'nav.overviewHint', to: '/' },
  { key: 'objects', labelKey: 'nav.objects', hintKey: 'nav.objectsHint', to: '/objects' },
  { key: 'ephemerides', labelKey: 'nav.ephemerides', hintKey: 'nav.ephemeridesHint', to: '/ephemerides' },
  { key: 'conjunctions', labelKey: 'nav.conjunctions', hintKey: 'nav.conjunctionsHint', to: '/conjunctions' },
  { key: 'screens', labelKey: 'nav.screens', hintKey: 'nav.screensHint', to: '/screens' },
  { key: 'simulation', labelKey: 'nav.situation', hintKey: 'nav.situationHint', to: '/situation' },
  { key: 'ai', labelKey: 'nav.ai', hintKey: 'nav.aiHint', to: '/ai' },
  { key: 'docs', labelKey: 'nav.docs', hintKey: 'nav.docsHint', to: '/docs' },
  { key: 'settings', labelKey: 'nav.settings', hintKey: 'nav.settingsHint', to: '/settings' }
]

const query = ref('')
const nav = computed(() => {
  const q = query.value.trim().toLowerCase()
  const items = navDefs.map((n) => ({
    ...n,
    label: t(n.labelKey),
    hint: t(n.hintKey)
  }))
  if (!q) return items
  return items.filter(
    (n) =>
      n.label.toLowerCase().includes(q) ||
      n.hint.toLowerCase().includes(q) ||
      n.key.includes(q)
  )
})

const activeKey = computed(() => {
  const name = String(route.name || '')
  if (name === 'overview' || route.path === '/') return 'overview'
  if (name === 'situation') return 'simulation'
  if (name === 'conjunction-detail' || route.path.startsWith('/conjunctions')) return 'conjunctions'
  return name || 'overview'
})

const planLabel = computed(() => (auth.org ? auth.org.plan.toUpperCase() : ''))

function signOut() {
  auth.logout()
  router.push('/login')
}

const clockUtc = ref('')
const clockBeijing = ref('')
let clockTimer: number | undefined

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function fmtHMS(d: Date) {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function tick() {
  const now = new Date()
  clockUtc.value = fmtHMS(now)
  const bj = new Date(now.getTime() + 8 * 3600 * 1000)
  clockBeijing.value = `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`
}

onMounted(() => {
  tick()
  clockTimer = window.setInterval(tick, 1000)
  // 恢复登录会话（有 token 时拉取 /auth/me；失败自动清空）
  void auth.init()
})

onUnmounted(() => {
  if (clockTimer) window.clearInterval(clockTimer)
})
</script>

<template>
  <div class="shell" :class="{ bare }">
    <header v-if="showChrome" class="topbar">
      <div class="brand">
        <img class="logo" :src="logoUrl" alt="Openspace" />
        <div class="titles">
          <div class="name">{{ t('appName') }}</div>
          <div v-if="!isZh" class="sub">{{ t('appSub') }}</div>
        </div>
      </div>
      <div class="top-right">
        <template v-if="auth.user">
          <div v-if="auth.org" class="account" :title="auth.user.email">
            <span class="org-name">{{ auth.org.name }}</span>
            <span class="plan-chip" :class="auth.org.plan">{{ planLabel }}</span>
            <span class="user-name">{{ auth.user.displayName || auth.user.email }}</span>
          </div>
          <span v-else class="account" :title="auth.user.email">
            <span class="user-name">{{ auth.user.displayName || auth.user.email }}</span>
          </span>
          <button
            v-if="auth.user.role.startsWith('platform_')"
            type="button"
            class="auth-btn"
            @click="router.push('/admin')"
          >{{ t('auth.adminConsole') }}</button>
          <button type="button" class="auth-btn" @click="router.push('/account')">
            {{ t('auth.account') }}
          </button>
          <button type="button" class="auth-btn" @click="signOut">{{ t('auth.signOut') }}</button>
        </template>
        <button v-else type="button" class="auth-btn" @click="router.push('/login')">
          {{ t('auth.signIn') }}
        </button>
        <div class="lang" role="group" :aria-label="t('langToggle')">
          <button
            type="button"
            class="lang-btn"
            :class="{ on: locale === 'zh' }"
            @click="setLocale('zh')"
          >{{ t('langZh') }}</button>
          <button
            type="button"
            class="lang-btn"
            :class="{ on: locale === 'en' }"
            @click="setLocale('en')"
          >{{ t('langEn') }}</button>
        </div>
        <span class="env">{{ t('staging') }}</span>
      </div>
    </header>

    <div v-if="showChrome" class="body">
      <aside class="rail">
        <div class="search">
          <input v-model="query" type="search" :placeholder="t('searchNav')" />
        </div>
        <nav class="nav">
          <RouterLink
            v-for="item in nav"
            :key="item.key"
            :to="item.to"
            class="nav-item"
            :class="{ on: activeKey === item.key, reserved: item.reserved }"
          >
            <span class="nav-label">{{ item.label }}</span>
            <span class="nav-hint">{{ item.hint }}</span>
            <span v-if="item.reserved" class="tag">RES</span>
          </RouterLink>
        </nav>
        <div class="rail-foot">{{ t('railFoot') }}</div>
      </aside>

      <main class="main">
        <RouterView />
      </main>
    </div>

    <main v-else class="main bare">
      <RouterView />
    </main>

    <div v-if="showChrome" class="corner-clock" aria-live="polite">
      <span class="lbl">UTC</span><span class="val">{{ clockUtc }}</span>
      <span class="sep">|</span>
      <span class="lbl">{{ t('beijing') }}</span><span class="val">{{ clockBeijing }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg-shell);
}

.topbar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 0 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-rail);
  z-index: 20;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.logo {
  width: 39px;
  height: 39px;
  object-fit: contain;
  flex: 0 0 auto;
  opacity: 0.92;
}

.titles .name {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.03em;
  color: var(--text);
  white-space: nowrap;
}
.titles .sub {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 1px;
}

.top-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.top-right .env {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
}

.account {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  min-width: 0;
}
.account .org-name {
  color: var(--text);
  font-weight: 600;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account .user-name {
  color: var(--text-dim);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-chip {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  border-radius: 3px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  background: transparent;
}
.plan-chip.free { color: #9aa7b2; border-color: rgba(154, 167, 178, 0.4); }
.plan-chip.normal { color: #6fb3d8; border-color: rgba(111, 179, 216, 0.45); }
.plan-chip.vip { color: #e0b45c; border-color: rgba(224, 180, 92, 0.5); }

.auth-btn {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  line-height: 1.4;
}
.auth-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.lang {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.lang-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 4px 9px;
  cursor: pointer;
  line-height: 1.2;
}
.lang-btn + .lang-btn {
  border-left: 1px solid var(--border);
}
.lang-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.lang-btn.on {
  color: var(--text);
  background: var(--accent-soft);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.rail {
  width: var(--rail-w);
  flex: 0 0 var(--rail-w);
  background: var(--bg-rail);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.search {
  padding: 12px 10px 8px;
}
.search input {
  width: 100%;
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
  outline: none;
}
.search input::placeholder {
  color: var(--text-dim);
}
.search input:focus {
  border-color: var(--accent);
}

.nav {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  color: var(--text-muted);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nav-item.on {
  background: var(--accent-soft);
  border-color: rgba(74, 125, 154, 0.35);
  color: var(--text);
}
.nav-label {
  font-size: 13px;
  font-weight: 600;
  grid-column: 1;
}
.nav-hint {
  grid-column: 1;
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 1px;
}
.nav-item.on .nav-hint {
  color: var(--text-muted);
}
.tag {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
}
.nav-item.reserved {
  opacity: 0.85;
}

.rail-foot {
  padding: 10px 12px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
}

.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-shell);
}
.main.bare {
  height: 100%;
}

.corner-clock {
  position: absolute;
  right: 14px;
  bottom: 10px;
  z-index: 30;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: rgba(10, 13, 17, 0.85);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  pointer-events: none;
  user-select: none;
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 5px;
  line-height: 1.2;
  .lbl {
    color: var(--text-faint, #6b7280);
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  .val {
    color: var(--text-muted);
  }
  .sep {
    color: var(--text-faint, #6b7280);
    opacity: 0.7;
    margin: 0 1px;
  }
}
</style>
