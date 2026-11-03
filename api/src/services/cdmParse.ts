/**
 * CDM 报文解析器（Epic E2）：客户上传 KVN（CCSDS CDM）/ XML / Space-Track JSON 三种格式。
 *
 * 归一化输出 CdmParsed，字段对齐 sat_cdm 表：
 *  - KVN：行式 `KEY = value`，按 META_START 块内 `OBJECT = OBJECT_A/B` 上下文取双方身份；
 *  - XML：<segment> 两段分别为主/副星元数据，单次出现字段全局抓取；
 *  - JSON：Space-Track cdm_public 平铺键（SAT_1_ID / TCA / PC …），即 C1 日更格式。
 */
import { parseUtc } from '../utils/time.js'

export interface CdmParsed {
  cdmId: string
  creationDate: Date | null
  originator: string
  tca: Date | null
  noradA: number | null
  nameA: string
  noradB: number | null
  nameB: string
  missDistanceKm: number | null
  relSpeedKmS: number | null
  collisionProbability: number | null
  hardBodyRadiusM: number | null
  rawJson: string
}

export interface ParseResult {
  parsed: CdmParsed[]
  failed: number
}

/* ------------------------------ 工具函数 ------------------------------ */

/** 从 KVN/XML 值中提取首个数字：'4.2 km' / '[ 1.23e-5 ]' → 4.2 / 1.23e-5 */
function firstNumber(v: string): number | null {
  const m = /-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(v)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function cleanStr(v: string): string {
  return v.trim().replace(/\s+/g, ' ')
}

function dateOf(v: string): Date | null {
  const s = cleanStr(v).replace(/\s+UTC\s*$/i, '')
  return parseUtc(s)
}

/* ------------------------------- KVN ---------------------------------- */

interface ObjCtx {
  name: string
  norad: number | null
}

function parseKvnOne(block: string): CdmParsed | null {
  const kv = new Map<string, string>()
  const objects: Record<'A' | 'B', ObjCtx> = {
    A: { name: '', norad: null },
    B: { name: '', norad: null }
  }
  let cur: 'A' | 'B' | null = null
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('COMMENT')) continue
    const m = /^([A-Z_0-9]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    // KVN 数组带单位与方括号：[ 1 2 3 ] km → 去方括号，保留数字与单位供 firstNumber
    val = val.replace(/^\[/, ' ').replace(/\]\s*[a-zA-Z/]*\s*$/, ' ')
    kv.set(key, val)
    if (key === 'OBJECT') {
      const up = val.toUpperCase()
      if (up.includes('OBJECT_A') || up === 'A') cur = 'A'
      else if (up.includes('OBJECT_B') || up === 'B') cur = 'B'
      continue
    }
    if (cur && key === 'OBJECT_NAME') objects[cur].name = cleanStr(val)
    if (cur && key === 'NORAD_CAT_ID') {
      const n = firstNumber(val)
      objects[cur].norad = n === null ? null : Math.trunc(n)
    }
  }

  const tca = kv.get('TIME_OF_CLOSEST_APPROACH') ? dateOf(kv.get('TIME_OF_CLOSEST_APPROACH')!) : null
  if (!tca || (objects.A.norad === null && objects.B.norad === null)) return null

  const cdmId = cleanStr(kv.get('MESSAGE_ID') ?? '') || ''
  const miss = kv.get('MISS_DISTANCE') ? firstNumber(kv.get('MISS_DISTANCE')!) : null
  const rel = kv.get('RELATIVE_SPEED') ? firstNumber(kv.get('RELATIVE_SPEED')!) : null
  const pc = kv.get('PROBABILITY_OF_COLLISION') ? firstNumber(kv.get('PROBABILITY_OF_COLLISION')!) : null
  const hbr = kv.get('HBR') ? firstNumber(kv.get('HBR')!) : null

  return {
    cdmId,
    creationDate: kv.get('CREATION_DATE') ? dateOf(kv.get('CREATION_DATE')!) : null,
    originator: cleanStr(kv.get('ORIGINATOR') ?? ''),
    tca,
    noradA: objects.A.norad,
    nameA: objects.A.name,
    noradB: objects.B.norad,
    nameB: objects.B.name,
    missDistanceKm: miss,
    relSpeedKmS: rel,
    collisionProbability: pc,
    hardBodyRadiusM: hbr,
    rawJson: JSON.stringify({ format: 'kvn', text: block.slice(0, 64 * 1024) })
  }
}

/* -------------------------------- XML ---------------------------------- */

interface XmlTag {
  key: string
  raw: string
  value: string
  index: number
}

/** 顺序抽取 XML 标签（大小写不敏感），记录起始位置以区分主/副星 segment */
function xmlTags(text: string): XmlTag[] {
  const tags: XmlTag[] = []
  const re = /<([A-Za-z_0-9:]+)>\s*([^<>]*?)\s*<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tags.push({ key: m[1].toUpperCase(), raw: m[1], value: cleanStr(m[2]), index: m.index })
  }
  return tags
}

function parseXmlOne(xml: string): CdmParsed | null {
  const tags = xmlTags(xml)
  if (!tags.length) return null

  // 按 <segment ...> 边界切分对象上下文；无 segment 时用 SAT_1_*/SAT_2_* 平铺键
  const segBounds: number[] = []
  const segRe = /<segment[\s>]/gi
  let sm: RegExpExecArray | null
  while ((sm = segRe.exec(xml)) !== null) segBounds.push(sm.index)

  const objects: Record<'A' | 'B', ObjCtx> = {
    A: { name: '', norad: null },
    B: { name: '', norad: null }
  }
  const flat: Map<string, string> = new Map()

  if (segBounds.length >= 2) {
    const bounds = [...segBounds, xml.length]
    for (let s = 0; s < 2; s++) {
      const ctx = s === 0 ? objects.A : objects.B
      const lo = bounds[s]
      const hi = bounds[s + 1] ?? xml.length
      for (const t of tags) {
        if (t.index < lo || t.index >= hi) continue
        if (t.key === 'OBJECT_NAME' && !ctx.name) ctx.name = t.value
        if (t.key === 'NORAD_CAT_ID' && ctx.norad === null) {
          const n = firstNumber(t.value)
          ctx.norad = n === null ? null : Math.trunc(n)
        }
      }
    }
  } else {
    for (const t of tags) if (!flat.has(t.key)) flat.set(t.key, t.value)
    const n1 = flat.has('SAT_1_ID') ? firstNumber(flat.get('SAT_1_ID')!) : null
    const n2 = flat.has('SAT_2_ID') ? firstNumber(flat.get('SAT_2_ID')!) : null
    objects.A.norad = n1 === null ? null : Math.trunc(n1)
    objects.A.name = flat.get('SAT_1_NAME') ?? ''
    objects.B.norad = n2 === null ? null : Math.trunc(n2)
    objects.B.name = flat.get('SAT_2_NAME') ?? ''
  }

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const t = tags.find((x) => x.key === k)
      if (t) return t.value
    }
    return ''
  }

  const tca = dateOf(pick('TCA', 'TIME_OF_CLOSEST_APPROACH'))
  if (!tca) return null

  const missNum = firstNumber(pick('MISS_DISTANCE'))
  // MISS_DISTANCE 单位换算：Space-Track 平铺 XML 为米，CCSDS 为 km——带 ' m' 单位后缀按米处理
  const missRaw = pick('MISS_DISTANCE')
  const missKm =
    missNum === null ? null : /\bkm\b/i.test(missRaw) || !/\bm\b/i.test(missRaw) ? missNum : missNum / 1000

  return {
    cdmId: pick('CDM_ID', 'MESSAGE_ID'),
    creationDate: dateOf(pick('CREATED', 'CREATION_DATE')),
    originator: pick('ORIGINATOR'),
    tca,
    noradA: objects.A.norad,
    nameA: objects.A.name,
    noradB: objects.B.norad,
    nameB: objects.B.name,
    missDistanceKm: missKm,
    relSpeedKmS: firstNumber(pick('RELATIVE_SPEED')),
    collisionProbability: firstNumber(pick('PC', 'PROBABILITY_OF_COLLISION')),
    hardBodyRadiusM: firstNumber(pick('HBR', 'HARD_BODY_RADIUS')),
    rawJson: JSON.stringify({ format: 'xml', text: xml.slice(0, 64 * 1024) })
  }
}

/* -------------------------------- JSON --------------------------------- */

function parseJsonOne(item: Record<string, unknown>): CdmParsed | null {
  const s = (k: string): string => (item[k] === null || item[k] === undefined ? '' : String(item[k]).trim())
  const n = (k: string): number | null => {
    if (item[k] === null || item[k] === undefined || item[k] === '') return null
    const v = Number(item[k])
    return Number.isFinite(v) ? v : null
  }
  const tca = parseUtc(s('TCA'))
  if (!tca) return null
  const missM = n('MIN_RNG')
  const noradA = n('SAT_1_ID')
  const noradB = n('SAT_2_ID')
  return {
    cdmId: s('CDM_ID'),
    creationDate: parseUtc(s('CREATED')) ?? parseUtc(s('CREATION_DATE')),
    originator: s('ORIGINATOR'),
    tca,
    noradA: noradA === null ? null : Math.trunc(noradA),
    nameA: s('SAT_1_NAME'),
    noradB: noradB === null ? null : Math.trunc(noradB),
    nameB: s('SAT_2_NAME'),
    missDistanceKm: missM === null ? null : missM / 1000, // MIN_RNG 单位为米
    relSpeedKmS: n('RELATIVE_SPEED'),
    collisionProbability: n('PC'),
    hardBodyRadiusM: n('HBR'),
    rawJson: JSON.stringify({ format: 'json', data: item })
  }
}

/* ------------------------------- 入口 ---------------------------------- */

/** 解析一段上传文本（自动识别格式；多条报文自动拆分） */
export function parseCdmText(text: string): ParseResult {
  const parsed: CdmParsed[] = []
  let failed = 0
  const head = text.replace(/^\uFEFF/, '').trimStart()

  if (head.startsWith('[') || head.startsWith('{')) {
    // Space-Track JSON：数组或单对象
    try {
      const j = JSON.parse(head) as unknown
      const list = Array.isArray(j) ? j : [j]
      for (const item of list) {
        const r = parseJsonOne(item as Record<string, unknown>)
        if (r) parsed.push(r)
        else failed++
      }
    } catch {
      failed++
    }
    return { parsed, failed }
  }

  if (head.startsWith('<')) {
    // XML：按 <?xml / <CDM 根元素边界拆分多报文
    const chunks = head
      .split(/<\?xml[^>]*\?>/i)
      .map((c) => c.trim())
      .filter(Boolean)
    for (const c of chunks) {
      const r = parseXmlOne(c)
      if (r) parsed.push(r)
      else failed++
    }
    return { parsed, failed }
  }

  // KVN：按 CCSDS_CDM_VERS 报文头拆分
  const blocks = head
    .split(/(?=CCSDS_CDM_VERS\s*=)/i)
    .map((b) => b.trim())
    .filter(Boolean)
  for (const b of blocks) {
    const r = parseKvnOne(b)
    if (r) parsed.push(r)
    else failed++
  }
  return { parsed, failed }
}
