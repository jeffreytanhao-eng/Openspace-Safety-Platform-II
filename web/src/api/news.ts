/**
 * 每日太空安全资讯（docs/public-api.md 第 6 节）：由后端 /cgi/news 读日切结果并代理外部接口。
 */
import { cgiCall } from './auth'

export interface NewsText {
  en: string
  zh?: string
}

export interface NewsItem {
  id: string
  title: NewsText
  /** 原文发布时间（UTC，ISO 8601） */
  published_at: string
  /** 按 Asia/Shanghai 切日的发布日期 */
  published_date?: string
  media: NewsText
  summary: NewsText
  url: string
  /** 影响分析（LLM 生成，详情接口返回） */
  impact_zh?: string
}

export interface NewsList {
  generated_at: string | null
  plan_date: string
  window_days: number
  count: number
  items: NewsItem[]
}

/** 总览卡片最多 8 条（后端同时按发布时间倒序截断） */
export const NEWS_LIMIT = 8

export function getNews(limit = NEWS_LIMIT): Promise<NewsList> {
  return cgiCall<NewsList>({ method: 'GET', url: '/news', params: { limit } })
}

export function getNewsItem(id: string): Promise<NewsItem> {
  return cgiCall<NewsItem>({ method: 'GET', url: `/news/${encodeURIComponent(id)}` })
}
