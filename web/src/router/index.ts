import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/AppShell.vue'),
      children: [
        { path: '', name: 'overview', component: () => import('@/views/overview/index.vue'), meta: { title: 'Overview' } },
        { path: 'objects', name: 'objects', component: () => import('@/views/objects/index.vue'), meta: { title: 'Objects' } },
        { path: 'trajectories', name: 'trajectories', component: () => import('@/views/trajectories/index.vue'), meta: { title: 'Trajectories' } },
        { path: 'conjunctions', name: 'conjunctions', component: () => import('@/views/conjunctions/index.vue'), meta: { title: 'Conjunctions' } },
        { path: 'conjunctions/:id', name: 'conjunction-detail', component: () => import('@/views/conjunctions/Detail.vue'), meta: { title: 'Conjunction Detail' } },
        { path: 'ephemerides', name: 'ephemerides', component: () => import('@/views/ephemerides/index.vue'), meta: { title: 'Ephemerides' } },
        { path: 'simulation', redirect: '/situation' },
        { path: 'ai', name: 'ai', component: () => import('@/views/ai/index.vue'), meta: { title: 'AI' } },
        { path: 'docs', name: 'docs', component: () => import('@/views/docs/index.vue'), meta: { title: 'Docs' } },
        { path: 'situation/:type?', name: 'situation', component: () => import('@/views/situation/index.vue'), meta: { title: 'Situation' } }
      ]
    },
    { path: '/login', name: 'login', component: () => import('@/views/login/index.vue'), meta: { title: 'Login (reserved)' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
