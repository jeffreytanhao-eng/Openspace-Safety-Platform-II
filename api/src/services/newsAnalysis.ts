/**
 * 资讯摘要扩写与「影响分析」生成（与发射翻译共用同一套火山方舟 Ark 配置）。
 * - 摘要：由 LLM 在原文基础上扩写成 100-150 字中文（卡片简介仍单行省略，详情展示全文）；
 * - 影响分析：约 100 字，聚焦对中国的影响；
 * - 日切任务批量生成并落库；详情接口发现缺失或摘要过短时单条补生成并回写。
 */
import { getLaunchTranslateConfig } from './launchTranslate.js'

export interface NewsBrief {
  title: string
  summary: string
  media: string
}

export interface NewsInsight {
  summary: string
  analysis: string
}

/** 摘要低于该字数视为过短，下次日切/详情访问时重新扩写 */
export const SUMMARY_MIN = 80

const TIMEOUT_MS = 90_000
/** 推理模型单次输出较大，控制在 4 条/次 */
const BATCH_SIZE = 4

function parseItems(content: string): Record<number, NewsInsight> {
  let text = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  if (!text) throw new Error('模型返回空内容')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON')
  text = text.slice(start, end + 1)
  const parsed = JSON.parse(text) as {
    items?: Array<{ i?: number; summary?: string; analysis?: string }>
  }
  const out: Record<number, NewsInsight> = {}
  for (const it of parsed.items || []) {
    if (typeof it.i !== 'number') continue
    const summary = typeof it.summary === 'string' ? it.summary.trim() : ''
    const analysis = typeof it.analysis === 'string' ? it.analysis.trim() : ''
    if (summary || analysis) out[it.i] = { summary, analysis }
  }
  return out
}

async function requestInsights(briefs: NewsBrief[]): Promise<Record<number, NewsInsight>> {
  const cfg = await getLaunchTranslateConfig()
  if (!cfg.enabled) throw new Error('LLM 未启用')
  if (!cfg.api_key) throw new Error('未配置 API Key')

  const payload = {
    model: cfg.model,
    temperature: 0.35,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是中国航天与太空安全领域的资深编辑与分析员。根据用户给出的资讯数组（title 标题、summary 原文摘要、media 媒体），为每条输出两项：\n' +
          '1) summary：100-150 字的简体中文摘要。在原文摘要基础上补全关键事实（谁、何时、做了什么、为何重要），' +
          '可结合标题与媒体背景，但不得编造原文没有的具体数字、人名或事件细节；语言平实，不要标题党，不要分点。\n' +
          '2) analysis：约 100 字（90-110 字，2-3 句）的「对中国的影响分析」。聚焦对中国太空资产与发射活动的直接/间接影响、' +
          '军事与安全含义、政策与产业链影响，以及值得关注的应对点；客观具体，信息不足时用「可能」「有待观察」。\n' +
          '只输出严格 JSON：{"items":[{"i":0,"summary":"...","analysis":"..."}]}，i 与输入下标一致。'
      },
      { role: 'user', content: JSON.stringify(briefs) }
    ]
  }

  const r = await fetch(`${cfg.base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return parseItems(body.choices?.[0]?.message?.content || '')
}

/** 批量生成摘要与影响分析，返回 输入下标 → 结果；单批失败只记日志，不阻断日切 */
export async function generateNewsInsights(briefs: NewsBrief[]): Promise<Map<number, NewsInsight>> {
  const out = new Map<number, NewsInsight>()
  for (let i = 0; i < briefs.length; i += BATCH_SIZE) {
    const chunk = briefs.slice(i, i + BATCH_SIZE)
    try {
      const result = await requestInsights(chunk)
      Object.entries(result).forEach(([idx, insight]) => {
        const local = Number(idx)
        if (Number.isInteger(local) && local >= 0 && local < chunk.length) out.set(i + local, insight)
      })
    } catch (e) {
      console.warn('[news-insight] batch failed:', (e as Error).message)
    }
  }
  return out
}

/** 单条生成（详情懒加载兜底），失败返回 null */
export async function generateNewsInsight(brief: NewsBrief): Promise<NewsInsight | null> {
  const map = await generateNewsInsights([brief])
  return map.get(0) || null
}
