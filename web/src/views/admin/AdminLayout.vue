<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useRoute } from 'vue-router'
import logoUrl from '@/assets/logo/openspace-logo.png'
import { useI18n } from '@/composables/useI18n'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()

function isActive(path: string) {
  return route.path === path || (path !== '/admin' && route.path.startsWith(path))
}

function signOut() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="admin">
    <header class="topbar">
      <div class="brand">
        <img class="logo" :src="logoUrl" alt="Openspace" />
        <div class="titles">
          <div class="name">平台管理 · Admin</div>
          <div class="sub">Openspace Safety · Platform Console</div>
        </div>
      </div>
      <div class="right">
        <span class="who">{{ auth.user?.email }}</span>
        <button type="button" class="btn ghost" @click="router.push('/')">返回控制台</button>
        <button type="button" class="btn ghost" @click="signOut">退出</button>
      </div>
    </header>

    <div class="body">
      <aside class="side">
        <RouterLink to="/admin/orgs" class="side-item" :class="{ on: isActive('/admin/orgs') }">
          客户组织
        </RouterLink>
        <RouterLink to="/admin/claims" class="side-item" :class="{ on: isActive('/admin/claims') }">
          认领审核
        </RouterLink>
        <RouterLink to="/admin/audit" class="side-item" :class="{ on: isActive('/admin/audit') }">
          审计日志
        </RouterLink>
        <RouterLink to="/admin/data-ops" class="side-item" :class="{ on: isActive('/admin/data-ops') }">
          数据运维
        </RouterLink>
      </aside>
      <main class="main">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.admin {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-shell);
}
.topbar {
  height: 52px;
  flex: 0 0 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-rail);
}
.brand { display: flex; align-items: center; gap: 10px; }
.logo { width: 34px; height: 34px; object-fit: contain; opacity: 0.92; }
.titles .name { font-size: 14px; font-weight: 650; color: var(--text); }
.titles .sub { font-size: 10px; color: var(--text-dim); margin-top: 1px; }
.right { display: flex; align-items: center; gap: 8px; }
.who { font-size: 11px; color: var(--text-dim); }
.btn {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
}
.btn:hover { color: var(--text); background: var(--bg-hover); }
.body { flex: 1; min-height: 0; display: flex; }
.side {
  width: 172px;
  flex: 0 0 172px;
  border-right: 1px solid var(--border);
  background: var(--bg-rail);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.side-item {
  display: block;
  padding: 9px 12px;
  border-radius: 6px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid transparent;
}
.side-item:hover { background: var(--bg-hover); color: var(--text); }
.side-item.on { background: var(--accent-soft); border-color: rgba(74, 125, 154, 0.35); color: var(--text); }
.main { flex: 1; min-width: 0; overflow: auto; padding: 18px 20px; }
</style>
