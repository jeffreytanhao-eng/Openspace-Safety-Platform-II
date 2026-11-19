<script setup lang="ts">
/**
 * 国家国旗小图标（发射预报用）：内置常见航天发射国简化 SVG，免外部图片依赖。
 * 入参 code 为任意文本线索（接口 site.country.code 实际是「发射场, 国家」全名，
 * 另建议一并传入中英文国名），按关键词识别国家；无法识别时降级为地球图标。
 */
import { computed } from 'vue'

const props = defineProps<{ code?: string | null }>()

/** 五角星多边形点位：r 为外接圆半径，rot 为旋转角（度），默认尖角朝上 */
function star(cx: number, cy: number, r: number, rot = 0): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.382
    const a = ((-90 + rot + i * 36) * Math.PI) / 180
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** 小星让一个尖角指向大星中心（标准五星红旗取角规则） */
function aimAt(cx: number, cy: number, tx: number, ty: number): number {
  return (Math.atan2(ty - cy, tx - cx) * 180) / Math.PI + 90
}

/** 五星红旗：30×20 网格按 0.7 缩放到 21×14 视框（大星半径 3→2.1，小星 1→0.7） */
const CN_FLAG = (() => {
  const bx = 3.5
  const by = 3.5
  const small: Array<[number, number]> = [
    [7, 1.4],
    [8.4, 2.8],
    [8.4, 4.9],
    [7, 6.3]
  ]
  const parts = [
    '<rect width="21" height="14" fill="#de2910"/>',
    `<polygon fill="#ffde00" points="${star(bx, by, 2.1)}"/>`
  ]
  for (const [x, y] of small) {
    parts.push(`<polygon fill="#ffde00" points="${star(x, y, 0.7, aimAt(x, y, bx, by))}"/>`)
  }
  return parts.join('')
})()

const FLAGS: Record<string, string> = {
  us: '<rect width="21" height="14" fill="#fff"/><g fill="#b22234"><rect width="21" height="1.08"/><rect width="21" height="1.08" y="2.15"/><rect width="21" height="1.08" y="4.31"/><rect width="21" height="1.08" y="6.46"/><rect width="21" height="1.08" y="8.62"/><rect width="21" height="1.08" y="10.77"/><rect width="21" height="1.08" y="12.92"/></g><rect width="8.6" height="7.5" fill="#3c3b6e"/>',
  cn: CN_FLAG,
  ru: '<rect width="21" height="14" fill="#fff"/><rect width="21" height="4.66" y="4.67" fill="#0039a6"/><rect width="21" height="4.67" y="9.33" fill="#d52b1e"/>',
  jp: '<rect width="21" height="14" fill="#fff"/><circle cx="10.5" cy="7" r="3.6" fill="#bc002d"/>',
  in: '<rect width="21" height="14" fill="#fff"/><rect width="21" height="4.67" fill="#ff9933"/><rect width="21" height="4.67" y="9.33" fill="#138808"/><circle cx="10.5" cy="7" r="1.85" fill="none" stroke="#000080" stroke-width="0.7"/>',
  fr: '<rect width="21" height="14" fill="#fff"/><rect width="7" height="14" fill="#0055a4"/><rect width="7" height="14" x="14" fill="#ef4135"/>',
  nz: '<rect width="21" height="14" fill="#00247d"/><path d="M0 0l9 6M9 0L0 6" stroke="#fff" stroke-width="1.2"/><path d="M0 0l9 6M9 0L0 6" stroke="#cc142b" stroke-width="0.55"/><g fill="#cc142b"><circle cx="14" cy="4" r="0.9"/><circle cx="17" cy="7" r="0.9"/><circle cx="14" cy="10" r="0.9"/><circle cx="18" cy="10.5" r="0.9"/></g>',
  kr: '<rect width="21" height="14" fill="#fff"/><circle cx="10.5" cy="7" r="3" fill="#0047a0"/><path d="M7.5 7a3 3 0 0 1 6 0z" fill="#cd2e3a"/>',
  ir: '<rect width="21" height="14" fill="#fff"/><rect width="21" height="4.67" fill="#239f40"/><rect width="21" height="4.67" y="9.33" fill="#da0000"/>',
  il: '<rect width="21" height="14" fill="#fff"/><rect width="21" height="1.8" y="1" fill="#0038b8"/><rect width="21" height="1.8" y="11.2" fill="#0038b8"/><path d="M10.5 4.4l1.9 3.3h-3.8z" fill="none" stroke="#0038b8" stroke-width="0.7"/><path d="M10.5 9.6l-1.9-3.3h3.8z" fill="none" stroke="#0038b8" stroke-width="0.7"/>',
  kp: '<rect width="21" height="14" fill="#024fa2"/><rect width="21" height="8.8" y="2.6" fill="#ed1c27"/><circle cx="6.6" cy="7" r="2.5" fill="#fff"/><path fill="#ed1c27" d="M6.6 5.2l.55 1.7h1.75l-1.4 1.05.5 1.7-1.4-1.05-1.4 1.05.5-1.7-1.4-1.05h1.75z"/>',
  br: '<rect width="21" height="14" fill="#009c3b"/><path d="M10.5 1.8L19 7l-8.5 5.2L2 7z" fill="#ffdf00"/><circle cx="10.5" cy="7" r="2.4" fill="#002776"/>',
  au: '<rect width="21" height="14" fill="#00247d"/><path d="M0 0l9 6M9 0L0 6" stroke="#fff" stroke-width="1.2"/><path d="M0 0l9 6M9 0L0 6" stroke="#c8102e" stroke-width="0.5"/><path d="M4.5 0v6M0 3h9" stroke="#fff" stroke-width="1.6"/><path d="M4.5 0v6M0 3h9" stroke="#c8102e" stroke-width="0.9"/><g fill="#fff"><circle cx="15" cy="4" r="0.8"/><circle cx="17.5" cy="7.5" r="0.9"/><circle cx="14" cy="10" r="0.8"/><circle cx="18.5" cy="11" r="0.7"/><circle cx="12.5" cy="6.5" r="0.5"/></g>',
  gb: '<rect width="21" height="14" fill="#012169"/><path d="M0 0l21 14M21 0L0 14" stroke="#fff" stroke-width="2.6"/><path d="M0 0l21 14M21 0L0 14" stroke="#c8102e" stroke-width="1.1"/><path d="M10.5 0v14M0 7h21" stroke="#fff" stroke-width="3.4"/><path d="M10.5 0v14M0 7h21" stroke="#c8102e" stroke-width="1.8"/>',
  kz: '<rect width="21" height="14" fill="#00afca"/><circle cx="10.5" cy="5.8" r="1.9" fill="#fec50c"/><rect x="9" y="11.3" width="3" height="1" fill="#fec50c"/>',
  ae: '<rect width="21" height="14" fill="#fff"/><rect width="21" height="4.67" fill="#00732f"/><rect width="21" height="4.67" y="9.33" fill="#000"/><rect width="5.4" height="14" fill="#ff0000"/>'
}

/** 精确 ISO 代码（alpha-3 / alpha-2）→ 旗帜 */
const ALIAS: Record<string, string> = {
  USA: 'us', US: 'us', CHN: 'cn', CN: 'cn', RUS: 'ru', RU: 'ru', JPN: 'jp', JP: 'jp',
  IND: 'in', IN: 'in', FRA: 'fr', FR: 'fr', GUF: 'fr', NZL: 'nz', NZ: 'nz',
  KOR: 'kr', KR: 'kr', IRN: 'ir', IR: 'ir', ISR: 'il', IL: 'il', PRK: 'kp', KP: 'kp',
  BRA: 'br', BR: 'br', AUS: 'au', AU: 'au', GBR: 'gb', GB: 'gb', KAZ: 'kz', KZ: 'kz',
  ARE: 'ae', AE: 'ae'
}

/** 名称关键词（长词在前，避免 "korea" 抢先匹配北/南朝鲜） */
const HINTS: Array<[string, string]> = [
  ['north korea', 'kp'], ['朝鲜', 'kp'],
  ['south korea', 'kr'], ['republic of korea', 'kr'], ['韩国', 'kr'],
  ['united states', 'us'], ['usa', 'us'], ['美国', 'us'],
  ['people\'s republic of china', 'cn'], ['china', 'cn'], ['中国', 'cn'],
  ['russian federation', 'ru'], ['russia', 'ru'], ['俄罗斯', 'ru'],
  ['japan', 'jp'], ['日本', 'jp'],
  ['india', 'in'], ['印度', 'in'],
  ['french guiana', 'fr'], ['france', 'fr'], ['法属圭亚那', 'fr'], ['法国', 'fr'],
  ['new zealand', 'nz'], ['新西兰', 'nz'],
  ['iran', 'ir'], ['伊朗', 'ir'],
  ['israel', 'il'], ['以色列', 'il'],
  ['brazil', 'br'], ['巴西', 'br'],
  ['australia', 'au'], ['澳大利亚', 'au'],
  ['united kingdom', 'gb'], ['英国', 'gb'],
  ['kazakhstan', 'kz'], ['哈萨克斯坦', 'kz'],
  ['united arab emirates', 'ae'], ['阿联酋', 'ae'],
  ['korea', 'kr']
]

const inner = computed(() => {
  const raw = (props.code || '').trim()
  if (!raw) return ''
  const exact = ALIAS[raw.toUpperCase()]
  if (exact) return FLAGS[exact]
  const text = raw.toLowerCase()
  for (const [needle, key] of HINTS) {
    if (text.includes(needle)) return FLAGS[key]
  }
  return ''
})
</script>

<template>
  <span class="flag" aria-hidden="true">
    <svg viewBox="0 0 21 14">
      <template v-if="inner">
        <g v-html="inner" />
      </template>
      <template v-else>
        <rect width="21" height="14" fill="#2b3a4a" />
        <circle cx="10.5" cy="7" r="3.6" fill="none" stroke="#7f93a8" stroke-width="0.8" />
        <path d="M6.9 7h7.2M10.5 3.4c1.9 2.2 1.9 5 0 7.2c-1.9-2.2-1.9-5 0-7.2z" fill="none" stroke="#7f93a8" stroke-width="0.7" />
      </template>
    </svg>
  </span>
</template>

<style scoped>
.flag {
  display: inline-flex;
  flex: 0 0 auto;
  width: 18px;
  height: 12px;
  border-radius: 2px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}
.flag svg { display: block; width: 100%; height: 100%; }
</style>
