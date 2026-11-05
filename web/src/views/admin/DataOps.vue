<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  adminDailyFetchStatus,
  adminTriggerDailyFetch,
  type DailyFetchSourceResult,
  type DailyFetchStatus
} from '@/api/admin'
import { AuthError } from '@/api/auth'

const st = ref<DailyFetchStatus | null>(null)
const loading = ref(false)
const running = ref(false)
const error = ref('')
const result = ref<Record<string, DailyFetchSourceResult> | null>(null)
const triggeredBy = ref('')

/** 出门标准以 GP + CDM 为准；AOE 本轮暂不接入（只展示状态，不作为验收项） */
const SOURCES: Array<{ key: string; label: string; note?: string }> = [
  { key: 'spacetrack_gp', label: 'Space-Track GP（TLE）' },
  { key: 'spacetrack_cdm', label: 'Space-Track CDM（交会报文）' },
  { key: 'aoe', label: 'AOE（预留）', note: '本轮不接入，不计入出门标准' }
]

const busy = computed(() => running.value || (st.value?.running ?? false))

async function load() {
  loading.value = true
  error.value = ''
  try {
    st.value = await adminDailyFetchStatus()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    loading.value = false
  }
}

async function trigger() {
  if (busy.value) return
  running.value = true
  error.value = ''
  result.value = null
  try {
    const r = await adminTriggerDailyFetch()
    result.value = r.results
    triggeredBy.value = r.triggered_by
    await load()
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : String((e as Error).message || e)
  } finally {
    running.value = false
  }
}

function batchOf(key: string) {
  return st.value?.last_batch?.[key] ?? null
}
function lastOk(key: string): string {
  return st.value?.last_success?.[key] || '—'
}
function statusChip(s: string | undefined): { text: string; cls: string } {
  if (s === 'success') return { text: '成功', cls: 'ok' }
  if (s === 'failed') return { text: '失败', cls: 'bad' }
  if (s === 'running') return { text: '运行中', cls: 'warn' }
  return { text: '无记录', cls: '' }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>数据运维 · 日更</h1>
        <p class="sub">
          每日定时采集 Space-Track GP（TLE）与 CDM；出门标准以 GP + CDM 的上次成功时间为准，AOE 本轮不接入。
        </p>
      </div>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
        <button type="button" class="btn primary" :disabled="busy" @click="trigger">
          {{ busy ? '日更运行中…' : '手动触发日更' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="result" class="ok-msg">
      已由 {{ triggeredBy }} 触发：
      <span v-for="(r, k) in result" :key="k" class="res">
        {{ k }} = {{ r.status }}<template v-if="r.status === 'failed'">（{{ r.message }}）</template>
      </span>
    </div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>数据源</th>
            <th>最近批次</th>
            <th>状态</th>
            <th>计数（总 / 新增 / 更新 / 跳过）</th>
            <th>上次成功</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && !st"><td colspan="6" class="empty">加载中…</td></tr>
          <tr v-else-if="!st"><td colspan="6" class="empty">暂无数据</td></tr>
          <tr v-for="s in SOURCES" :key="s.key">
            <td>{{ s.label }}</td>
            <td class="mono">{{ batchOf(s.key)?.id ?? '—' }}</td>
            <td>
              <span class="chip" :class="statusChip(batchOf(s.key)?.status).cls">
                {{ statusChip(batchOf(s.key)?.status).text }}
              </span>
            </td>
            <td class="mono">
              <template v-if="batchOf(s.key)">
                {{ batchOf(s.key)!.total }} / {{ batchOf(s.key)!.inserted }} /
                {{ batchOf(s.key)!.updated }} / {{ batchOf(s.key)!.skipped }}
              </template>
              <template v-else>—</template>
            </td>
            <td class="mono">{{ lastOk(s.key) }}</td>
            <td class="dim">
              <template v-if="batchOf(s.key)?.error_message">{{ batchOf(s.key)!.error_message }}</template>
              <template v-else>{{ s.note || '—' }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="hint">
      手动触发为同步执行（GP → CDM → AOE 串行），期间接口会等待本次全部源完成；AOE 未配置 token 时其批次会记失败但不影响 GP/CDM。
    </p>
  </div>
</template>

<style scoped lang="scss" src="./admin.scss"></style>
<style scoped lang="scss">
.res {
  margin-right: 10px;
  font-family: var(--mono);
  font-size: 11px;
}
</style>
