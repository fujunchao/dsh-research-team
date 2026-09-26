/**
 * 成稿质量门（draft quality gate）：拦截"写作计划/工作笔记/元话语"冒充章节成稿。
 *
 * 2026-09-26 火影 run 实证三类泄漏形态（证据：审稿 feedback + 子代理 transcript）：
 *  1. 占位骨架 —— "Final structure:" + `[6 prose paragraphs, ~1400字]` / `[table ~24 rows, 5 cols]`，悬空 ### 收尾；
 *  2. 英文写作/核证笔记 —— "JACKPOT — the last search revealed…"、"Word count check"、"Now assemble…"；
 *  3. 元话语前言 —— 把全文写进工作区文件后只回传"已写入 xx.md，以下为全文回传"（正文缺失）。
 *
 * 编排器在落档/送审/修订回写前调用本模块；不合格 → 重派一次，仍不合格 → 降级。
 * 纯函数、零依赖；单测见 test/assess.test.js（先 build 出 lib/assess.js 再跑）。
 */

export type DraftKind = 'chapter' | 'revision'

export interface DraftAssessment {
  ok: boolean
  /** 不合格理由（中文，可直接进重派警告 / carryOverWarnings / 进度行）。 */
  reasons: string[]
}

export interface AssessOptions {
  kind: DraftKind
  /** 最短成稿长度（字符）。章节缺省 800；修订由调用方按原稿长度折算传入。 */
  minChars?: number
}

/** 占位骨架形态（匹配前先剥离 [标题](URL) 链接，避免误伤正常引用）。 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[(?:[^\]\n]{0,40}?)(?:prose\s+paragraph|paragraphs?|bullets?|rows?|cols?|columns?|tables?)(?:[^\]\n]{0,40}?)\]/i,
  /\[[^\]\n]{0,10}(?:约|~|≈|≤)\s?\d+\s?(?:字|行|条|个|段)[^\]\n]{0,10}\]/,
  /\[\d+\s?(?:字|行|条|个|段)[^\]\n]{0,20}?\]/,
]

/** 英文过程自述（强特征词全文匹配；弱特征词锚定行首，降低误伤）。 */
const META_STRONG_PATTERNS: RegExp[] = [
  /\bJACKPOT\b/,
  /\bWord count\b/i,
  /\bFinal structure\b/i,
  /\bFile written\b/i,
  /\bNow assemble\b/i,
  /\bGood confirmations?\b/i,
  /\bOption \([A-Z]\) it is\b/,
]
const META_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:let me|i'll|i will|i need to|i should|i'm going to)\b/im,
  /^\s*excellent[.!,]/im,
  /^\s*wait[-—,]\s/im,
]

/** 悬空收尾：以未闭合标题行或"以下为全文"式引导句结尾（疑似截断/仅回传前言）。 */
function trailingHang(text: string): boolean {
  const t = text.trimEnd()
  if (/(?:^|\n)#{1,6}\s*$/.test(t)) return true
  // "以下为全文回传。"式引导句：短语后允许极短后缀与句号收尾。
  if (/(?:以下为全文|以下为完整|全文如下|修订稿如下|如下为全文)[^\n。；;]{0,10}[。.!?]?\s*$/i.test(t)) return true
  if (/(?:reproduce the content|full text below|as follows)[^\n]{0,30}[:：。]?\s*$/i.test(t)) return true
  return false
}

/** 中文字符占比（成稿必须是中文正文；英文笔记会显著低于 0.3）。 */
function cjkRatio(text: string): number {
  const chars = [...text.replace(/\s/g, '')]
  if (chars.length === 0) return 0
  const cjk = chars.filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).length
  return cjk / chars.length
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[0].trim().slice(0, 60)
  }
  return undefined
}

/** 评估一段成员输出是否为合格成稿；ok=false 时 reasons 给出可直接转述的理由。 */
export function assessDraft(text: string, opts: AssessOptions): DraftAssessment {
  const reasons: string[] = []
  const raw = (text ?? '').trim()
  const minChars = opts.minChars ?? 800

  if (raw.length < minChars) {
    reasons.push(`输出长度仅 ${raw.length} 字符（低于成稿下限 ${minChars}）`)
  }

  const stripped = raw.replace(/\[[^\]\n]*\]\([^)\s]*\)/g, '')
  const placeholder = firstMatch(stripped, PLACEHOLDER_PATTERNS)
  if (placeholder) reasons.push(`含占位符骨架（如 "${placeholder}"）而非实际内容`)

  const meta = firstMatch(raw, [...META_STRONG_PATTERNS, ...META_LINE_PATTERNS])
  if (meta) reasons.push(`含英文过程自述/元话语（如 "${meta}"）`)

  const ratio = cjkRatio(raw)
  if (ratio < 0.3) reasons.push(`中文字符占比仅 ${Math.round(ratio * 100)}%（成稿必须为中文正文）`)

  if (opts.kind === 'chapter') {
    if (!raw.includes('【本章小结】')) reasons.push('缺少协议产出标记【本章小结】')
    if (!raw.includes('本章新增来源') && !raw.includes('已收集来源池')) reasons.push('缺少「本章新增来源」来源清单')
  }

  if (trailingHang(raw)) reasons.push('以悬空标题或"以下为全文"式引导句收尾（疑似截断/仅回传前言）')

  return { ok: reasons.length === 0, reasons }
}
