import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/AppShell.vue'),
      children: [
        { path: '', name: 'overview', component: () => import('@/views/overview/index.vue'), meta: { title: 'Overview' } },
        { path: 'objects', name: 'objects', component: () => import('@/views/objects/index.vue'), meta: { title: 'Objects', requiresAuth: true } },
        { path: 'trajectories', name: 'trajectories', component: () => import('@/views/trajectories/index.vue'), meta: { title: 'Trajectories' } },
        { path: 'conjunctions', name: 'conjunctions', component: () => import('@/views/conjunctions/index.vue'), meta: { title: 'Conjunctions' } },
        { path: 'screens', name: 'screens', component: () => import('@/views/screens/index.vue'), meta: { title: 'Screens', requiresAuth: true } },
        { path: 'conjunctions/:id', name: 'conjunction-detail', component: () => import('@/views/conjunctions/Detail.vue'), meta: { title: 'Conjunction Detail' } },
        { path: 'ephemerides', name: 'ephemerides', component: () => import('@/views/ephemerides/index.vue'), meta: { title: 'Ephemerides' } },
        { path: 'simulation', redirect: '/situation' },
        { path: 'ai', name: 'ai', component: () => import('@/views/ai/index.vue'), meta: { title: 'AI' } },
        { path: 'docs', name: 'docs', component: () => import('@/views/docs/index.vue'), meta: { title: 'Docs' } },
        { path: 'situation/:type?', name: 'situation', component: () => import('@/views/situation/index.vue'), meta: { title: 'Situation' } }
      ]
    },
    { path: '/login', name: 'login', component: () => import('@/views/login/index.vue'), meta: { title: 'Login' } },
    {
      path: '/admin',
      component: () => import('@/views/admin/AdminLayout.vue'),
      meta: { title: 'Admin', requiresAuth: true, requiresPlatform: true },
      children: [
        { path: '', redirect: '/admin/orgs' },
        { path: 'orgs', name: 'admin-orgs', component: () => import('@/views/admin/Orgs.vue'), meta: { title: 'Admin · Orgs', requiresAuth: true, requiresPlatform: true } },
        { path: 'orgs/:id', name: 'admin-org-detail', component: () => import('@/views/admin/OrgDetail.vue'), meta: { title: 'Admin · Org Detail', requiresAuth: true, requiresPlatform: true } },
        { path: 'audit', name: 'admin-audit', component: () => import('@/views/admin/Audit.vue'), meta: { title: 'Admin · Audit', requiresAuth: true, requiresPlatform: true } }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

/**
 * 登录守卫基建（Epic A3/B1）：默认全站公开（态势/星历等浏览不受限），
 * 需要登录的业务路由标记 meta.requiresAuth=true 即被拦截；
 * requiresPlatform 进一步要求平台侧角色（超管 /admin 独立布局，不进客户侧栏）。
 */
router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true
  const auth = useAuthStore()
  await auth.init()
  if (!(auth.token && auth.user)) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.requiresPlatform) {
    const role = auth.user.role
    if (role !== 'platform_super_admin' && role !== 'platform_ops') {
      return { path: '/' }
    }
  }
  return true
})

export default router
