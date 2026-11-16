import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'normalize.css'
import './styles/global.scss'
import App from './App.vue'
import OspNumberInput from './components/OspNumberInput.vue'
import router from './router'

const app = createApp(App)

/**
 * 发版瞬间旧页面懒加载的分包会 404（chunk 已被新构建替换）。
 * Vite 会派发 vite:preloadError；这里做一次自动刷新兜底，避免用户看到白屏或报错。
 * 10 秒内只重载一次，防止异常循环。
 */
window.addEventListener('vite:preloadError', () => {
  const key = 'osp.chunk.reloadAt'
  const last = Number(sessionStorage.getItem(key) || 0)
  if (Date.now() - last < 10000) return
  sessionStorage.setItem(key, String(Date.now()))
  location.reload()
})
app.component('OspNumberInput', OspNumberInput)
app.use(createPinia())
app.use(router)
app.use(ElementPlus)
app.mount('#app')
