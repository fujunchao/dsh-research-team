/**
 * The Research Card (研究参数卡) — the single shared context object threaded
 * through all 5 phases, ported from the WorkBuddy team protocol.
 */

export type ExecutionMode = 'full' | 'quick' | 'single'
export type TimeRange = 'last_6_months' | 'last_1_year' | 'last_2_years' | 'last_5_years' | 'all'
export type CitationFormat = 'APA' | 'IEEE' | 'Chicago'
export type OutputFormat = 'markdown' | 'html'

export interface ChapterState {
  index: number
  title: string
  /** 谭溯源 chapter draft (latest revision). */
  draft?: string
  /** 明鉴秋 verdict: PASS / REVISE; undefined before first review. */
  verdict?: 'PASS' | 'REVISE'
  reviewRound: number
  /** 明鉴秋 latest review feedback (when REVISE). */
  feedback?: string
  /** 任润泽 change log from the latest revision. */
  revisionNote?: string
  /** true = 审稿 REVISE 已落定（feedback 待修订处理）；修订完成后清除。断点续跑据此跳过重审直接派修订. */
  reviewPending?: boolean
  /** 第 3 轮强制通过时遗留的审稿警告. */
  carryOverWarnings: string[]
  /** 本章新增来源（来源池增量）. */
  newSources: string[]
  /** 谭溯源章末「本章小结（≤100字）」，串行模式下传给后续章节（原协议「已完成章节摘要」）. */
  summary?: string
}

export interface ResearchCard {
  /** 研究课题. */
  topic: string
  mode: ExecutionMode
  timeRange: TimeRange
  citationFormat: CitationFormat
  outputFormat: OutputFormat
  language: string
  maxSections: number
  /** 季要纲判定的章节独立性：true=可并行调研，false=有依赖需串行；undefined=未判定（回退 >5 章规则）. */
  parallelChapters?: boolean
  /** 用户补充约束. */
  extraConstraints?: string

  /** Phase 1: 谭溯源初步调研摘要. */
  scoutingSummary?: string
  /** Phase 1: 已收集来源池. */
  sourcePool: string[]
  /** Phase 2: 季要纲大纲. */
  title?: string
  sections: ChapterState[]
  /** Phase 4: 程文成 JSON 产出. */
  frame?: {
    table_of_contents: string
    introduction: string
    conclusion: string
    sources: string[]
  }
  /** Phase 5: 傅梓铭最终报告. */
  finalReport?: string
  /** 跨阶段全局警告（初调降级/来源不足等），最终汇入「待完善事项」. */
  globalWarnings: string[]
  /** Progress log lines (进度通报). */
  log: string[]
}

export function nowDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function createCard(input: {
  topic: string
  mode: ExecutionMode
  timeRange: TimeRange
  citationFormat: CitationFormat
  outputFormat: OutputFormat
  language: string
  extraConstraints?: string
  /** full 模式章节数上限（插件配置 maxChapters），quick/single 固定 3/1. */
  maxChapters?: number
}): ResearchCard {
  const maxSections = input.mode === 'full'
    ? Math.min(10, Math.max(1, input.maxChapters ?? 5))
    : input.mode === 'quick' ? 3 : 1
  return {
    ...input,
    maxSections,
    sourcePool: [],
    sections: [],
    globalWarnings: [],
    log: [],
  }
}

/** Compact card digest injected into every member dispatch. */
export function cardDigest(card: ResearchCard): string {
  const lines: string[] = []
  lines.push(`【研究参数卡】`)
  lines.push(`- 课题: ${card.topic}`)
  lines.push(`- 执行模式: ${card.mode} (maxSections=${card.maxSections})`)
  lines.push(`- 时效窗口: ${card.timeRange}`)
  lines.push(`- 引用格式: ${card.citationFormat}；输出格式: ${card.outputFormat}`)
  lines.push(`- 语言: ${card.language}`)
  if (card.extraConstraints) lines.push(`- 用户特殊要求: ${card.extraConstraints}`)
  if (card.scoutingSummary) {
    // 初调摘要超长时截断：原协议摘要应 500-1000 字，实测模型可能输出 2 万+ 字符；
    // 全量内联会淹没章节任务指令、放大成员输出失稳（2026-09-26 冒烟实证：摘要
    // 28044 字符 → 章节调研两次输出英文笔记未过质量门）。
    const MAX_SUMMARY_CHARS = 6000
    const summary = card.scoutingSummary.length > MAX_SUMMARY_CHARS
      ? `${card.scoutingSummary.slice(0, MAX_SUMMARY_CHARS)}\n…（初调摘要共 ${card.scoutingSummary.length} 字符，已截断至 ${MAX_SUMMARY_CHARS}；完整全文见 checkpoint）`
      : card.scoutingSummary
    lines.push(`\n【Phase 1 初调摘要】\n${summary}`)
  }
  if (card.sourcePool.length > 0) {
    lines.push(`\n【已收集来源池】共 ${card.sourcePool.length} 条：`)
    for (const s of card.sourcePool) lines.push(`  ${s}`)
  }
  if (card.title) lines.push(`\n【报告标题】${card.title}`)
  if (card.sections.length > 0) {
    lines.push(`\n【大纲】共 ${card.sections.length} 章：`)
    for (const s of card.sections) {
      const flags: string[] = []
      if (s.verdict) flags.push(`审稿=${s.verdict}`)
      if (s.draft) flags.push(`已有草稿(${s.draft.length}字)`)
      lines.push(`  ${s.index}. ${s.title}${flags.length ? ` [${flags.join(', ')}]` : ''}`)
    }
  }
  // 已完成章节摘要（≤100字/章）：串行模式下后续章节与审稿/框架阶段据此保持跨章上下文。
  const summarized = card.sections.filter((s) => s.summary)
  if (summarized.length > 0) {
    lines.push(`\n【已完成章节摘要】`)
    for (const s of summarized) lines.push(`  第${s.index}章 ${s.title}：${s.summary}`)
  }
  return lines.join('\n')
}
