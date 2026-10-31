<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
import { conjunctionById, objectById } from '@/composables/useMockCatalog'

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id || ''))
const conj = computed(() => conjunctionById(id.value))
const primary = computed(() => (conj.value ? objectById(conj.value.primaryId) : undefined))
const secondary = computed(() => (conj.value ? objectById(conj.value.secondaryId) : undefined))

function stub(action: string) {
  window.alert(`Stage 2 stub: ${action} (no backend)`)
}
</script>

<template>
  <div v-if="!conj" class="page">
    <p>{{ t('conj.notFound') }}</p>
    <button type="button" class="btn" @click="router.push('/conjunctions')">{{ t('conj.backList') }}</button>
  </div>
  <div v-else class="page">
    <header class="head">
      <div>
        <button type="button" class="link" @click="router.push('/conjunctions')">{{ t('conj.back') }}</button>
        <h1>
          <span class="pill" :class="conj.risk">{{ conj.risk }}</span>
          {{ primary?.name }} × {{ secondary?.name }}
        </h1>
        <p>TCA {{ conj.tcaUtc.replace('T', ' ').replace('Z', '') }} UTC · {{ conj.source }}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn" @click="stub('Download CDM / report')">{{ t('conj.download') }}</button>
        <button type="button" class="btn" @click="stub('Print report')">{{ t('conj.print') }}</button>
      </div>
    </header>

    <section class="kpi">
      <div class="card"><div class="k">Pc</div><div class="v mono">{{ conj.pc }}</div></div>
      <div class="card"><div class="k">{{ t('conj.missDist') }}</div><div class="v mono">{{ conj.missKm.toFixed(3) }} km</div></div>
      <div class="card"><div class="k">{{ t('conj.relVel') }}</div><div class="v mono">{{ conj.relVelKms.toFixed(2) }} km/s</div></div>
      <div class="card"><div class="k">TCA</div><div class="v mono sm">{{ conj.tcaUtc.replace('T', ' ').replace('Z', '') }}</div></div>
    </section>

    <section class="grid">
      <aside class="panel">
        <div class="ph">{{ t('conj.primaryObj') }}</div>
        <div class="obj-name">{{ primary?.name }}</div>
        <dl class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ primary?.norad }}</dd></div>
          <div><dt>{{ t('obj.operator') }}</dt><dd>{{ primary?.operator }}</dd></div>
          <div><dt>{{ t('obj.col.constellation') }}</dt><dd>{{ primary?.constellation }}</dd></div>
          <div><dt>{{ t('obj.maneuverable') }}</dt><dd>{{ primary?.maneuverable ? t('obj.yes') : t('obj.no') }}</dd></div>
          <div><dt>Ephem</dt><dd>{{ primary?.ephemFreshness }}</dd></div>
        </dl>
        <RouterLink v-if="primary" class="btn" :to="`/objects`">{{ t('conj.viewObjects') }}</RouterLink>
      </aside>

      <aside class="panel">
        <div class="ph">{{ t('conj.secondaryObj') }}</div>
        <div class="obj-name">{{ secondary?.name }}</div>
        <dl class="kv">
          <div><dt>NORAD</dt><dd class="mono">{{ secondary?.norad }}</dd></div>
          <div><dt>{{ t('obj.operator') }}</dt><dd>{{ secondary?.operator }}</dd></div>
          <div><dt>{{ t('obj.col.constellation') }}</dt><dd>{{ secondary?.constellation }}</dd></div>
          <div><dt>{{ t('obj.maneuverable') }}</dt><dd>{{ secondary?.maneuverable ? t('obj.yes') : t('obj.no') }}</dd></div>
          <div><dt>Ephem</dt><dd>{{ secondary?.ephemFreshness }}</dd></div>
        </dl>
      </aside>

      <section class="panel wide">
        <div class="ph">{{ t('conj.missVec') }}</div>
        <div class="vec">
          <div><span>{{ t('conj.radial') }}</span><strong class="mono">{{ conj.missRadialM }} m</strong></div>
          <div><span>{{ t('conj.intrack') }}</span><strong class="mono">{{ conj.missIntrackM }} m</strong></div>
          <div><span>{{ t('conj.crosstrack') }}</span><strong class="mono">{{ conj.missCrosstrackM }} m</strong></div>
        </div>
        <div class="viz" aria-hidden="true">
          <div class="orbit a" />
          <div class="orbit b" />
          <div class="dot" />
          <div class="cap">{{ t('conj.tcaPoint') }}</div>
        </div>
        <p class="note">{{ t('conj.note') }}</p>
      </section>
    </section>
  </div>
</template>

<style scoped lang="scss">
.page {
  height: 100%; overflow: auto; padding: 12px 14px 40px;
  display: flex; flex-direction: column; gap: 12px;
}
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.link {
  appearance: none; border: none; background: transparent; color: var(--accent-strong);
  font-size: 12px; cursor: pointer; padding: 0; margin-bottom: 6px;
}
h1 {
  margin: 0; font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.head p { margin: 4px 0 0; font-size: 11px; color: var(--text-dim); }
.actions { display: flex; gap: 6px; }
.btn {
  appearance: none; border: 1px solid var(--border-strong); background: var(--bg-panel);
  color: var(--text-muted); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.btn:hover { color: var(--text); }
.pill {
  font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-muted); font-weight: 650;
}
.pill.high { color: var(--danger); border-color: rgba(196, 91, 91, 0.45); }
.pill.warn { color: var(--warn); border-color: rgba(196, 146, 74, 0.45); }
.pill.watch { color: var(--watch); border-color: rgba(168, 154, 92, 0.4); }
.pill.low { color: var(--text-dim); }

.kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.card {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
}
.k { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.v { margin-top: 4px; font-size: 18px; font-weight: 650; color: var(--text); }
.v.sm { font-size: 13px; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
}
.panel {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
}
.panel.wide { grid-column: 1 / -1; }
.ph { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.obj-name { font-size: 14px; font-weight: 650; margin-bottom: 10px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
.kv div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
}
.kv dt { margin: 0; font-size: 10px; color: var(--text-dim); }
.kv dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; }
.vec {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;
}
.vec div {
  background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; display: flex; flex-direction: column; gap: 4px;
}
.vec span { font-size: 10px; color: var(--text-dim); }
.viz {
  position: relative; height: 140px; border-radius: 8px; border: 1px solid var(--border);
  background: radial-gradient(circle at 40% 55%, #1a2430 0%, var(--bg-deep) 70%);
  overflow: hidden;
}
.orbit {
  position: absolute; border: 1px solid rgba(74, 125, 154, 0.45); border-radius: 50%;
  top: 50%; left: 40%; transform: translate(-50%, -50%);
}
.orbit.a { width: 180px; height: 70px; }
.orbit.b {
  width: 160px; height: 100px; border-style: dashed; border-color: rgba(196, 146, 74, 0.45);
  transform: translate(-50%, -50%) rotate(28deg);
}
.dot {
  position: absolute; width: 8px; height: 8px; border-radius: 50%;
  background: var(--danger); top: 48%; left: 52%;
  box-shadow: 0 0 10px rgba(196, 91, 91, 0.6);
}
.cap {
  position: absolute; right: 12px; bottom: 10px; font-size: 10px; color: var(--text-dim);
}
.note { margin: 10px 0 0; font-size: 11px; color: var(--text-dim); }
</style>
