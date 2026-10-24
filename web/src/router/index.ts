import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/situation'
    },
    {
      path: '/situation/:type?',
      name: 'situation',
      component: () => import('@/views/situation/index.vue')
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/situation'
    }
  ]
})

export default router
