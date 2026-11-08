<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import { AuthError } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

type Mode = 'login' | 'register'
const mode = ref<Mode>('login')
const busy = ref(false)
const error = ref('')

const email = ref('')
const password = ref('')
const displayName = ref('')
const showPassword = ref(false)

const redirectTarget = computed(() => {
  const r = route.query.redirect
  return typeof r === 'string' && r.startsWith('/') ? r : '/'
})

function switchMode(m: Mode) {
  mode.value = m
  error.value = ''
}

async function submit() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (mode.value === 'login') {
      await auth.login(email.value.trim(), password.value)
    } else {
      await auth.register({
        email: email.value.trim(),
        password: password.value,
        displayName: displayName.value.trim() || undefined
      })
    }
    // redirect 优先；平台侧账号进 /admin；其余回总览
    if (redirectTarget.value !== '/') {
      router.push(redirectTarget.value)
    } else if (auth.user && auth.user.role.startsWith('platform_')) {
      router.push('/admin')
    } else {
      router.push('/')
    }
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="card">
      <div class="badge">{{ t('auth.badge') }}</div>
      <h1>{{ mode === 'login' ? t('auth.titleLogin') : t('auth.titleRegister') }}</h1>

      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab"
          :class="{ on: mode === 'login' }"
          role="tab"
          :aria-selected="mode === 'login'"
          @click="switchMode('login')"
        >{{ t('auth.tabLogin') }}</button>
        <button
          type="button"
          class="tab"
          :class="{ on: mode === 'register' }"
          role="tab"
          :aria-selected="mode === 'register'"
          @click="switchMode('register')"
        >{{ t('auth.tabRegister') }}</button>
      </div>

      <form @submit.prevent="submit">
        <label class="field">
          <span>{{ mode === 'login' ? t('auth.loginId') : t('auth.email') }}</span>
          <input
            v-model="email"
            :type="mode === 'login' ? 'text' : 'email'"
            name="email"
            autocomplete="username"
            required
            :placeholder="mode === 'login' ? t('auth.loginIdPh') : t('auth.emailPh')"
          />
        </label>
        <label class="field">
          <span>{{ t('auth.password') }}</span>
          <div class="pwd-row">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              name="password"
              required
              :minlength="mode === 'register' ? 8 : undefined"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              :placeholder="mode === 'register' ? t('auth.passwordHint') : ''"
            />
            <button
              type="button"
              class="pwd-eye"
              :aria-label="showPassword ? t('auth.hidePwd') : t('auth.showPwd')"
              :title="showPassword ? t('auth.hidePwd') : t('auth.showPwd')"
              @click="showPassword = !showPassword"
            >
              <svg
                v-if="showPassword"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
              >
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <svg
                v-else
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </label>
        <label v-if="mode === 'register'" class="field">
          <span>{{ t('auth.displayName') }}</span>
          <input
            v-model="displayName"
            type="text"
            name="name"
            autocomplete="name"
            maxlength="64"
            :placeholder="t('auth.displayNamePh')"
          />
        </label>

        <p v-if="mode === 'register'" class="hint">{{ t('auth.registerHint') }}</p>

        <div v-if="error" class="error">{{ error }}</div>

        <button type="submit" class="btn" :disabled="busy">
          {{ busy ? t('auth.submitting') : mode === 'login' ? t('auth.submitLogin') : t('auth.submitRegister') }}
        </button>
      </form>

      <button type="button" class="switch" @click="switchMode(mode === 'login' ? 'register' : 'login')">
        {{ mode === 'login' ? t('auth.toRegister') : t('auth.toLogin') }}
      </button>

      <div class="foot">{{ t('auth.foot') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.login {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--bg-deep);
  padding: 24px;
}
.card {
  width: min(440px, 100%);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
}
.badge {
  display: inline-block;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 8px;
  margin-bottom: 12px;
}
h1 { margin: 0 0 14px; font-size: 22px; font-weight: 650; color: var(--text); }

.tabs {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 16px;
}
.tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  cursor: pointer;
}
.tab + .tab { border-left: 1px solid var(--border); }
.tab.on { color: var(--text); background: var(--accent-soft); }

form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field span {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}
.field input {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-deep);
  color: var(--text);
  border-radius: 6px;
  padding: 9px 11px;
  font-size: 13px;
  outline: none;
}
.field input::placeholder { color: var(--text-dim); }
.field input:focus { border-color: var(--accent); }

.pwd-row { position: relative; display: flex; }
.pwd-row input { flex: 1 1 auto; padding-right: 42px; }
.pwd-eye {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1;
}
.pwd-eye svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pwd-eye:hover { color: var(--text); background: var(--bg-hover); }

.hint { margin: 0; font-size: 11px; line-height: 1.6; color: var(--text-dim); }

.error {
  font-size: 12px;
  line-height: 1.5;
  color: #f0846a;
  background: rgba(240, 132, 106, 0.08);
  border: 1px solid rgba(240, 132, 106, 0.35);
  border-radius: 5px;
  padding: 8px 10px;
}

.btn {
  width: 100%;
  appearance: none;
  border: 1px solid rgba(74, 125, 154, 0.5);
  border-radius: 4px;
  padding: 10px 14px;
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  margin-top: 4px;
}
.btn:disabled { opacity: 0.6; cursor: default; }

.switch {
  width: 100%;
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  margin-top: 12px;
}
.switch:hover { color: var(--text); }

.foot { margin-top: 14px; text-align: center; font-size: 11px; color: var(--text-dim); }
</style>
