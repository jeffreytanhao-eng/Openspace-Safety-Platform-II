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
app.component('OspNumberInput', OspNumberInput)
app.use(createPinia())
app.use(router)
app.use(ElementPlus)
app.mount('#app')
