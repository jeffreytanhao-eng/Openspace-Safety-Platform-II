<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const router = useRouter()
</script>

<template>
  <div class="login">
    <div class="card">
      <div class="badge">{{ t('login.badge') }}</div>
      <h1>{{ t('login.title') }}</h1>
      <p class="lead">
        登录与操作方身份绑定（卫星 / 星座 / 星历归属）将在后续阶段接入。
        Stage 1 不做真实或演示鉴权，也不设置 session 墙。
      </p>
      <ul>
        <li>{{ t('login.li1') }}</li>
        <li>{{ t('login.li2') }}</li>
        <li>{{ t('login.li3') }}</li>
      </ul>
      <button type="button" class="btn" @click="router.push('/')">{{ t('login.enter') }}</button>
      <div class="foot">{{ t('login.foot') }}</div>
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
h1 { margin: 0 0 10px; font-size: 22px; font-weight: 650; color: var(--text); }
.lead { margin: 0 0 12px; color: var(--text-muted); line-height: 1.55; font-size: 13px; }
ul { margin: 0 0 18px; padding-left: 18px; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
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
}
.foot { margin-top: 14px; text-align: center; font-size: 11px; color: var(--text-dim); }
</style>
