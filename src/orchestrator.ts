/**
 * The deep research workflows, ported from WorkBuddy gpt-researcher-team's
 * research-chief-editor protocol. Three workflows, exactly as the original:
 *
 *   Workflow A (full)    Phase 1 初调 → Phase 2 大纲 → [用户确认大纲] →
 *                        Phase 3 逐章 调研→审稿→修订(≤3轮) → Phase 4 框架 → Phase 5 发布
 *   Workflow B (quick)   同 A，但 3 章、跳过审稿修订、免大纲确认，报告标注「未经审稿」
 *   Workflow C (single)  Phase 1(范围收窄) → 单章 调研→审稿循环 → 编排器直接拼装（无 Phase 2/4/5 成员）
 *
 * Phase 3 chapter dispatch follows the original: ≤5 chapters SERIAL (each
 * finished chapter's ≤100-char summary + new sources flow to the next), >5
 * parallel with a consistency warning.
 *
 * Degradation rules (超时降级 / 失败兜底) cover the original's full table:
 * member dispatch failure ⇒ one retry (in dispatch.ts) ⇒ per-phase degrade;
 * round 3 review is a forced PASS with carry-over warnings.
 */
import { dispatchMember, extractJson, type AppContext, type DispatchOpts, type DispatchResult } from './dispatch.js'
import type { ChapterState, ResearchCard } from './card.js'
import { cardDigest, nowDate } from './card.js'
import { assessDraft, type DraftKind } from './assess.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as status from './status.js'

export type ProgressFn = (line: string) => void

/** Optional live-status tracking hook (phase number + the progress line). */
export interface RunTracker {
  /** Called on every progress line; `phase` is 0-5. */
  progress(phase: number, line: string): void
  /** A member dispatch started/settled (label WITHOUT the team prefix). */
  member(label: string, event: 'start' | { settle: 'ok' | 'timeout' | 'error' | 'degraded' }): void
  /** Chapter table replaced (call on every chapter transition). */
  chapters(chapters: status.ChapterProgress[]): void
}

const MAX_REVIEW_ROUNDS = 3
/** 原协议：来源池下限（Phase 1）与每章来源下限（Phase 3）。 */
const MIN_POOL_SOURCES = 8
const MIN_CHAPTER_SOURCES = 5
/** 串行调度阈值：≤5 章串行，>5 章并行（原协议「并行加速」条款）。 */
const SERIAL_MAX_SECTIONS = 5
/** 成稿质量门：章节成稿最短长度（原协议 800-1500 字/章）。 */
const CHAPTER_MIN_CHARS = 800

const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    date: { type: 'string' },
    sections: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    /** 季要纲判定的章节独立性（原版协议中主理人的并行判断，由大纲产出者承担）. */
    parallel: { type: 'boolean' },
  },
  required: ['title', 'date', 'sections', 'rationale', 'parallel'],
  additionalProperties: false,
}

const FRAME_SCHEMA = {
  type: 'object',
  properties: {
    table_of_contents: { type: 'string' },
    introduction: { type: 'string' },
    conclusion: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['table_of_contents', 'introduction', 'conclusion', 'sources'],
  additionalProperties: false,
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'REVISE'] },
    must_fix: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    carry_over: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'must_fix', 'suggestions', 'carry_over'],
  additionalProperties: false,
}

/** Where a pipeline stopped (only full mode pauses; others run to completion). */
export type PipelineStop = 'completed' | 'awaiting-outline-confirm'

/**
 * Thrown when the pipeline observes an aborted exec signal: the card keeps
 * everything already produced and the run resumes from its checkpoint —
 * unlike a member failure, an interrupt must NOT fall through the
 * degradation table (that would overwrite finished chapters with
 * placeholders and let the pipeline write a garbage report).
 */
export class ResearchInterrupted extends Error {
  constructor(detail: string) {
    super(`研究已中断（${detail}）。已完成的工作保留在断点中——带 planId（或同课题重新调用）即可从断点续跑，已完成章节不会重做；如需全新研究传 forceNew=true`)
    this.name = 'ResearchInterrupted'
  }
}

/** Shared options for every pipeline entry point. */
export interface RunOptions {
  /** Outline feedback from the user (planId round 2+); re-plans Phase 2. */
  outlineFeedback?: string
  /** Skip the outline-confirmation pause (full mode, unattended scenarios). */
  skipConfirm?: boolean
  /** Called after each durable milestone; the host persists the card here. */
  onCheckpoint?: () => void
  /** Workspace root — enables the workspace rescue path when a member writes
   * its draft into a file instead of returning it inline. */
  wsRoot?: string
}

/** Shared dispatch/tracker plumbing for every pipeline entry point. */
function makeRuntime(
  ctx: AppContext,
  card: ResearchCard,
  parent: unknown,
  signal: AbortSignal,
  progress: ProgressFn,
  track: RunTracker | undefined,
): {
  P: (phase: number, line: string) => void
  D: (role: DispatchOpts['role'], label: string, task: string, opts?: Partial<DispatchOpts>) => Promise<DispatchResult>
  syncChapters: (over: (s: ChapterState) => Partial<status.ChapterProgress>) => void
} {
  const LABEL_PREFIX = '🔬 [深度研究] '
  return {
    P: (phase, line) => {
      progress(line)
      track?.progress(phase, line)
      // 过程日志随参数卡落 checkpoint：超时/重派/降级不再只存在于内存与子代理 transcript。
      card.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
      if (card.log.length > 200) card.log.splice(0, card.log.length - 200)
    },
    D: (role, label, task, opts) => {
      // 中断感知：派发前 signal 已中止 → 直接中断（不再走降级表）
      if (signal.aborted) throw new ResearchInterrupted(`signal 已中止，${label} 不再派出`)
      track?.member(label, 'start')
      return dispatchMember(ctx, { parent, signal, role, label: LABEL_PREFIX + label, task, ...opts })
        .then((r) => {
          track?.member(label, { settle: r.ok ? 'ok' : (r.stopReason === 'timeout' ? 'timeout' : 'error') })
          // 成员结算时 signal 已中止（用户点了停止，子代理被级联取消）→ 中断而非降级
          if (signal.aborted) throw new ResearchInterrupted(`${label} 执行中被中止`)
          return r
        }, (e: unknown) => {
          track?.member(label, { settle: 'error' })
          throw e
        })
    },
    syncChapters: (over) => {
      track?.chapters(card.sections.map((s) => ({
        index: s.index,
        title: s.title,
        reviewRound: s.reviewRound,
        status: 'drafting',
        ...over(s),
      })))
    },
  }
}

function brief(r: DispatchResult, who: string): string {
  if (r.ok) return r.text
  const detail = r.diagnostic ? ` (${r.diagnostic.slice(0, 200)})` : ''
  throw new Error(`${who} 未正常完成 (stopReason=${r.stopReason}${detail})`)
}

/**
 * 工作区成稿抢救：成员（glm-5.3-flash 实证常态，火影 run + 两轮冒烟均如此）常把
 * 成稿写进工作区文件，而最终输出只回传元话语前言——火影 run 的审稿人/发布员就是
 * 靠手动读文件救回的。质量门拦截后扫描 sinceMs 之后修改的最新 .md（工作区根 +
 * reports/ 两层），内容过成稿质量门则采纳为产出；否则返回 undefined 走原降级路径。
 */
async function rescueDraftFromWorkspace(
  wsRoot: string,
  sinceMs: number,
  gate: { kind: DraftKind; minChars: number },
): Promise<string | undefined> {
  try {
    const dirs = [wsRoot, join(wsRoot, 'reports')]
    let best: { path: string; mtimeMs: number } | undefined
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue
        const p = join(dir, e.name)
        const st = await stat(p).catch(() => undefined)
        if (!st || st.mtimeMs < sinceMs) continue
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }
      }
    }
    if (!best) return undefined
    const text = await readFile(best.path, 'utf8')
    if (!assessDraft(text, gate).ok) return undefined
    return text
  } catch {
    return undefined
  }
}

/**
 * 质量门失败后的统一抢救包装：stopReason=quality-gate 且给了 wsRoot 时，
 * 尝试从工作区文件恢复成稿；成功则返回合成的成功结果（stopReason='rescued-from-workspace'）。
 */
async function rescueIfGated(
  r: DispatchResult,
  wsRoot: string | undefined,
  sinceMs: number,
  gate: { kind: DraftKind; minChars: number },
): Promise<DispatchResult> {
  if (!r.ok && r.stopReason === 'quality-gate' && wsRoot) {
    const rescued = await rescueDraftFromWorkspace(wsRoot, sinceMs, gate)
    if (rescued !== undefined) return { ok: true, text: rescued, stopReason: 'rescued-from-workspace' }
  }
  return r
}

/**
 * 派发成员并过成稿质量门：产出若是占位骨架/工作笔记/元话语而非成稿，
 * 附重派原因再派一次；仍不过门则以 ok:false（stopReason='quality-gate'）返回，
 * 由调用方走各自降级路径。派发本身的单次重试与中断感知语义由 D（dispatchMember）保持。
 */
async function dispatchWithGate(
  D: ReturnType<typeof makeRuntime>['D'],
  P: ReturnType<typeof makeRuntime>['P'],
  role: DispatchOpts['role'],
  label: string,
  retryLabel: string,
  task: string,
  gate: { kind: DraftKind; minChars: number },
): Promise<DispatchResult> {
  let r = await D(role, label, task)
  let verdict = assessDraft(r.ok ? r.text : '', gate)
  if (r.ok && !verdict.ok) {
    P(3, `⚠️ ${label} 产出未过成稿质量门（${verdict.reasons.slice(0, 2).join('；')}）— 重派一次`)
    // 重派要求前置到任务最前（长任务卡会淹没尾部指令，2026-09-26 冒烟实证）。
    const retryTask = `【重派硬性要求（最高优先级，先读这段再干活）】上一次你的最终输出被判定为"非成稿"：${verdict.reasons.join('；')}。本次必须：\n1. 最终输出文本 = 完整成稿全文${gate.kind === 'chapter' ? '（从「## 第 N 章」标题行开始、含数据表格，以「本章新增来源」清单与【本章小结】结束）' : '（Part 1 完整修订稿 + Part 2 修改说明，以 --- 分隔）'}；\n2. 全程中文；\n3. 禁止使用任何写文件/创建文件工具——成稿只允许出现在最终输出文本里（编排器只取最终输出文本，文件内容不会被转发）；\n4. 禁止英文过程自述（I'll / Let me / JACKPOT / Word count 等）、写作计划与占位符（[N paragraphs]、[≤100字] 等）；\n5. 若你此前已把成稿写入工作区文件，直接把该文件内容全文复制进最终输出即可，不要重做调研。\n\n【原任务】\n${task}`
    r = await D(role, retryLabel, retryTask)
    verdict = assessDraft(r.ok ? r.text : '', gate)
  }
  if (r.ok && !verdict.ok) {
    return { ...r, ok: false, stopReason: 'quality-gate', diagnostic: `成稿质量门未通过：${verdict.reasons.slice(0, 2).join('；')}` }
  }
  return r
}

/** Parse the source-pool section out of Tan's scouting reply. */
function harvestSourcePool(text: string): string[] {
  // 章节产出的标记是「本章新增来源」，初调产出是「已收集来源池」；都取最后一次出现，
  // 避免成员在前文复述产出格式时误切到格式说明段（v0.4.3 及之前章节新增来源一直没被收进来源池）。
  const idx = Math.max(text.lastIndexOf('本章新增来源'), text.lastIndexOf('已收集来源池'))
  if (idx < 0) return []
  const tail = text.slice(idx)
  const out: string[] = []
  for (const line of tail.split('\n').slice(1)) {
    const t = line.trim()
    if (!t) continue
    if (/^#{1,6}\s/.test(t)) continue
    if (/^[-*]?\s*\d+\./.test(t) || /^[-*]\s/.test(t)) out.push(t.replace(/^[-*]\s*/, ''))
    else if (out.length > 0 && t.startsWith('[')) out.push(t)
  }
  return out
}

/** Split Tan's chapter output into (draft, ≤100-char summary, new sources). */
function harvestChapterParts(text: string): { draft: string; summary?: string } {
  const marker = '【本章小结】'
  // 取最后一次出现：成稿的小结在末尾，前文复述产出格式时可能出现同名标记。
  const idx = text.lastIndexOf(marker)
  const body = idx < 0 ? text : text.slice(0, idx)
  let summary = idx < 0 ? undefined : text.slice(idx + marker.length).trim()
  if (summary !== undefined) {
    // 小结后可能还跟着「本章新增来源」清单，截到该标题为止。
    const stop = summary.search(/^#{0,3}\s*本章新增来源/m)
    if (stop > 0) summary = summary.slice(0, stop).trim()
  }
  return { draft: stripMemberPreamble(body.trim()), summary: summary || undefined }
}

/**
 * Members sometimes leak working notes / outline drafts ahead of the real
 * chapter (verified in live runs: multiple `## 第 N 章` headings in one
 * output). Keep only from the LAST chapter heading when that happens.
 */
function stripMemberPreamble(text: string): string {
  const re = /^#{1,3}[ \t]*第[ \t]*\d+[ \t]*章.*$/gm
  const heads = [...text.matchAll(re)]
  if (heads.length < 2) return text
  return text.slice(heads[heads.length - 1].index ?? 0).trim()
}

/** Count distinct URLs cited in a piece of markdown text. */
function countDistinctUrls(text: string): number {
  return new Set((text.match(/\((https?:\/\/[^)\s]+)\)/g) ?? []).map((m) => m.slice(1, -1))).size
}

/** Extract deduped [title](url) references from a chapter draft (single mode). */
function extractReferences(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (seen.has(m[2])) continue
    seen.add(m[2])
    out.push(`- ${m[1]} [${m[2]}](${m[2]})`)
  }
  return out
}

/** De-duplicate source-pool lines (URL+title identical after trimming). */
function dedupeSources(sources: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sources) {
    const key = s.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export async function runResearch(
  ctx: AppContext,
  card: ResearchCard,
  parent: unknown,
  signal: AbortSignal,
  progress: ProgressFn,
  track?: RunTracker,
  opts?: RunOptions,
): Promise<PipelineStop> {
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)

  // ───────────────────────── Phase 1: 初调（谭溯源） ─────────────────────────
  // 断点自检：已有初调摘要（上次 run 已完成 Phase 1）则直接跳过
  if (!card.scoutingSummary) {
    P(1, `▶ Phase 1/5 初始调研 — 谭溯源 (topic-researcher)`)
    const narrow = card.mode === 'single' ? '（单章研究：范围收窄至该子课题本身，不做全域铺开）' : ''
    const scoutTask = `模式：初步调研（Phase 1）${narrow}。\n\n${cardDigest(card)}\n\n请对上述课题执行广泛初调，按你角色定义的「模式一」产出：500-1000 字研究摘要（覆盖定义背景/主流观点与争议/关键数据/主要参与者/最新趋势，全部带真实超链接引用）+ 末尾「已收集来源池」清单（≥8-15 条）。摘要正文严格控制在 500-1000 字（来源池清单另列、不计入字数）——超长摘要会被编排器截断，后续阶段拿不到被截掉的部分。`
    const scoutRaw = await D('topic-researcher', '谭溯源·初步调研', scoutTask)
    // 超时但已有部分文本 → 采用部分结果继续（原协议降级表）；完全无文本 → 如实报错
    if (!scoutRaw.ok && !scoutRaw.text) {
      throw new Error(`Phase 1 初调失败（${scoutRaw.diagnostic ?? scoutRaw.stopReason}）：来源不可得时不得编造，建议补充关键词或收紧研究范围后重试`)
    }
    if (!scoutRaw.ok) {
      P(1, `⚠️ Phase 1 超时/降级 — 采用部分初调结果，摘要可能不完整（${scoutRaw.diagnostic ?? scoutRaw.stopReason}）`)
      card.globalWarnings.push('初调阶段超时降级，摘要可能不完整')
    }
    card.scoutingSummary = scoutRaw.text
    card.sourcePool = dedupeSources(harvestSourcePool(scoutRaw.text))
    if (card.sourcePool.length < MIN_POOL_SOURCES) {
      P(1, `⚠️ 初调来源池仅 ${card.sourcePool.length} 条（目标 ≥${MIN_POOL_SOURCES}），后续章节需自行补充真实来源`)
      card.globalWarnings.push(`初调来源池仅 ${card.sourcePool.length} 条（目标 ≥${MIN_POOL_SOURCES}）`)
    }
    P(1, `✅ Phase 1 完成 — 摘要 ${scoutRaw.text.length} 字，来源池 ${card.sourcePool.length} 条`)
    opts?.onCheckpoint?.()
  }

  // ───────────────── Phase 2: 大纲（季要纲；single 模式跳过 → 直接单章） ─────────────────
  if (card.mode === 'single') {
    card.title = card.title ?? card.topic
    // 断点自检：已有单章（含草稿/审稿状态）不重建，否则会清掉 checkpoint 里的成果
    if (card.sections.length === 0) {
      card.sections = [{ index: 1, title: card.topic, reviewRound: 0, carryOverWarnings: [], newSources: [] }]
    }
    syncChapters(() => ({}))
    P(2, `✅ 单章模式 — 跳过大纲规划，直接进入单章研究`)
  } else if (card.sections.length === 0 || opts?.outlineFeedback) {
    // 断点自检：已有大纲（上次 run 已确认/已产出）则跳过；带反馈则重新规划
    P(2, `▶ Phase 2/5 大纲规划 — 季要纲 (research-planner)${opts?.outlineFeedback ? '（按用户反馈修订大纲）' : ''}`)
    const feedbackNote = opts?.outlineFeedback ? `\n\n【用户对上一版大纲的反馈（必须吸收）】\n${opts.outlineFeedback}` : ''
    const outlineTask = `${cardDigest(card)}${feedbackNote}\n\n请基于 Phase 1 初调摘要${opts?.outlineFeedback ? '和用户反馈' : ''}规划报告章节大纲。max_sections=${card.maxSections}。同时判定章节独立性：若各章主题彼此独立、无需前后文传递（如并列的维度/方案/市场），parallel=true（并行调研，更快）；若存在递进/依赖关系需要上一章结论，parallel=false（串行调研，跨章上下文传递）。输出 JSON（title/date/sections/rationale/parallel）。`
    const outlineRaw = await D('research-planner', '季要纲·大纲规划', outlineTask, {
      forceJson: true,
      outputSchema: OUTLINE_SCHEMA,
    })
    let outline: { title: string; sections: string[]; parallel?: boolean }
    try {
      const parsed = (outlineRaw.structured ?? extractJson(outlineRaw.text)) as { title: string; sections: string[]; parallel?: boolean }
      if (!parsed?.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) throw new Error('empty outline')
      outline = parsed
    } catch {
      // 降级：编排器基于初调摘要生成简化 3 章占位大纲（原协议降级表）；独立性未判定
      P(2, `⚠️ Phase 2 降级 — 季要纲未正常完成（${(outlineRaw.diagnostic ?? outlineRaw.text.slice(0, 80)).slice(0, 120)}），使用 3 章占位大纲`)
      outline = {
        title: card.topic,
        sections: [`${card.topic}：概述与背景`, `${card.topic}：现状与分析`, `${card.topic}：趋势与展望`],
      }
    }
    card.title = outline.title
    if (typeof outline.parallel === 'boolean') card.parallelChapters = outline.parallel
    card.sections = outline.sections.slice(0, card.maxSections).map((t, i) => ({
      index: i + 1,
      title: t,
      reviewRound: 0,
      carryOverWarnings: [],
      newSources: [],
    }))
    P(2, `✅ Phase 2 完成 — 《${card.title}》共 ${card.sections.length} 章${card.parallelChapters !== undefined ? `（季要纲判定：${card.parallelChapters ? '章节独立，可并行调研' : '章节有依赖，串行调研'}）` : ''}：${card.sections.map((s) => s.title).join(' / ')}`)
    syncChapters(() => ({}))
    opts?.onCheckpoint?.()

    // full 模式在大纲确认点暂停（quick 免确认，原协议 Workflow B；
    // skipOutlineConfirm 供全自动场景一次跑完）
    if (card.mode === 'full' && !opts?.skipConfirm) {
      return 'awaiting-outline-confirm'
    }
  }

  await executePhases(ctx, card, parent, signal, progress, track, opts)
  return 'completed'
}

/**
 * Phase 3-5 execution (shared by fresh quick/single runs, confirmed full
 * resumes, and reviseChapter re-runs).
 */
export async function executePhases(
  ctx: AppContext,
  card: ResearchCard,
  parent: unknown,
  signal: AbortSignal,
  progress: ProgressFn,
  track: RunTracker | undefined,
  opts?: RunOptions,
): Promise<void> {
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)
  const quick = card.mode === 'quick'
  const single = card.mode === 'single'
  /** 章节断点命中：已有草稿即不重调研（审稿状态由审稿循环自处理：PASS 跳过、其余进循环）。 */
  const hasDraft = (s: ChapterState): boolean => Boolean(s.draft)
  /** 草稿命中日志：区分“已 PASS 全跳过”与“待审稿只跳调研”。 */
  const draftHitLine = (s: ChapterState): string =>
    `⏭️ 第 ${s.index} 章断点命中（${quick || s.verdict === 'PASS' ? '已 PASS' : '草稿已存在，跳过调研进审稿'}），跳过调研`

  // ───────────────────────── Phase 3: 逐章研究 ─────────────────────────
  // 落档成稿校验：旧断点/异常路径遗留的不合格草稿（占位骨架/元话语/英文笔记）
  // 清除后走正常重研——不得送审，更不得凭审稿人翻工作区文件得到的 PASS 冒充通过稿。
  for (const s of card.sections) {
    if (!s.draft) continue
    const gate = assessDraft(s.draft, { kind: 'chapter', minChars: CHAPTER_MIN_CHARS })
    if (!gate.ok) {
      P(3, `⚠️ 第 ${s.index} 章落档草稿未过成稿质量门（${gate.reasons.slice(0, 2).join('；')}）— 清除草稿，本章重研`)
      s.draft = undefined
      s.summary = undefined
      s.verdict = undefined
      s.reviewRound = 0
      s.reviewPending = undefined
      s.carryOverWarnings.push(`落档草稿未过成稿质量门（${gate.reasons.slice(0, 2).join('；')}），已要求重研`)
    }
  }
  const resumedCount = card.sections.filter(hasDraft).length
  P(3, `▶ Phase 3/5 逐章研究（调研→${quick ? '（快速模式：跳过审稿）' : `审稿→修订，≤${MAX_REVIEW_ROUNDS} 轮`}）${resumedCount > 0 ? `（断点续跑：${resumedCount}/${card.sections.length} 章已有草稿）` : ''}`)
  syncChapters(() => ({ status: undefined }))

  const dispatchChapter = async (s: ChapterState): Promise<void> => {
    const task = `【输出方式（最高优先级）】你的最终输出文本必须就是成稿全文：从「## 第 ${s.index} 章」标题行开始、以「本章新增来源」清单与【本章小结】结束；禁止把成稿写入工作区文件后只回传路径（编排器只取最终输出文本）。\n\n模式：深度研究（Phase 3 章节调研）。\n\n${cardDigest(card)}\n\n本章任务：第 ${s.index} 章「${s.title}」。按你角色「模式二」要求产出完整章节草稿（800-1500 字、≥${MIN_CHAPTER_SOURCES} 来源 ≥3 类型、带真实引用），末尾附「【本章小结】」（≤100 字，供主理人传给后续章节）和「本章新增来源」清单。\n输出纪律：最终输出直接从章节正文第一段开始，禁止输出推理过程、证据盘点、工作笔记或任何元话语；引用一律用 [标题](URL) 行内超链接。\n成稿边界：全程中文，严禁 [N paragraphs]/[≤100字] 类占位符。`
    const dispatchStart = Date.now()
    const gated = await dispatchWithGate(D, P, 'topic-researcher', `谭溯源·第${s.index}章`, `谭溯源·第${s.index}章·重派`, task, { kind: 'chapter', minChars: CHAPTER_MIN_CHARS })
    const r = await rescueIfGated(gated, opts?.wsRoot, dispatchStart, { kind: 'chapter', minChars: CHAPTER_MIN_CHARS })
    if (r.ok && !gated.ok) P(3, `📥 第 ${s.index} 章成稿已从工作区文件恢复（成员最终输出未内联成稿）`)
    try {
      s.draft = brief(r, `第${s.index}章调研`)
    } catch (e) {
      if (e instanceof ResearchInterrupted) throw e
      // 降级：占位章，警告并继续（原协议降级表）
      s.draft = undefined
      s.carryOverWarnings.push(`初稿调研失败：${e instanceof Error ? e.message : String(e)}；本章以大纲要点占位，需专家补研`)
      P(3, `⚠️ 第 ${s.index} 章调研失败（降级：标注占位）— ${s.title}`)
      syncChapters((x) => x.index === s.index ? { status: 'degraded' as const } : {})
      return
    }
    const parts = harvestChapterParts(s.draft)
    s.draft = parts.draft
    s.summary = parts.summary
    s.newSources = harvestSourcePool(r.text)
    card.sourcePool = dedupeSources([...card.sourcePool, ...s.newSources])
    const urls = countDistinctUrls(s.draft)
    if (urls < MIN_CHAPTER_SOURCES) {
      s.carryOverWarnings.push(`本章来源仅 ${urls} 个（要求 ≥${MIN_CHAPTER_SOURCES}），建议专家复核`)
      P(3, `⚠️ 第 ${s.index} 章来源不足（${urls}/${MIN_CHAPTER_SOURCES}）— 已记入待完善事项`)
    }
    P(3, `✅ 第 ${s.index} 章初稿完成 — ${s.title}（新增来源 ${s.newSources.length} 条${s.summary ? '，小结已传递' : ''}）`)
    opts?.onCheckpoint?.()
  }

  // 调度判定（原版协议的主理人判断，由季要纲落在大纲上）：
  // parallelChapters=true → 并行；false → 串行；未判定（旧 checkpoint/降级大纲）→ 回退 >5 章阈值
  const parallel = card.parallelChapters === true
    || (card.parallelChapters === undefined && card.sections.length > SERIAL_MAX_SECTIONS)

  if (parallel) {
    // 并行调研（原协议「并行加速」），跨章一致性风险提示；断点命中的章直接跳过
    const pending = card.sections.filter((s) => !hasDraft(s))
    for (const s of card.sections.filter(hasDraft)) {
      P(3, draftHitLine(s))
    }
    if (pending.length > 0) {
      const why = card.parallelChapters === true ? '季要纲判定：章节彼此独立' : `${card.sections.length} 章 > ${SERIAL_MAX_SECTIONS}`
      P(3, `⚡ ${why}，对未完成 ${pending.length} 章并行调研（跨章一致性风险增加，全部共享同一张研究参数卡）`)
      const settled = await Promise.allSettled(pending.map((s) => dispatchChapter(s)))
      const interrupted = settled.find((r) => r.status === 'rejected' && r.reason instanceof ResearchInterrupted)
      if (interrupted) throw (interrupted as PromiseRejectedResult).reason
      for (const r of settled) {
        if (r.status === 'rejected' && !(r.reason instanceof ResearchInterrupted)) throw r.reason
      }
    }
  } else {
    // 串行——每章完成后小结+新来源随参数卡流入下一章（原协议默认）；断点命中的章跳过
    for (const s of card.sections) {
      if (hasDraft(s)) {
        P(3, draftHitLine(s))
        continue
      }
      syncChapters((x) => x.index === s.index ? { status: 'drafting' as const } : {})
      await dispatchChapter(s)
    }
  }

  if (quick) {
    // Workflow B：跳过 3.2/3.3，章节直接视为通过（报告会标注「未经审稿」）
    for (const s of card.sections) s.verdict = 'PASS'
    P(3, `✅ Phase 3 完成（快速模式，未经审稿）— ${card.sections.length}/${card.sections.length} 章`)
    syncChapters(() => ({ status: 'pass' as const }))
  } else {
    // 3.2 串行审稿-修订循环（跨章一致性优先，与原协议一致）；断点已 PASS 的章跳过
    for (const s of card.sections) {
      if (!s.draft) continue // 降级占位章直接进入警告区
      if (s.verdict === 'PASS') {
        P(3, `⏭️ 第 ${s.index} 章已通过（断点），跳过审稿`)
        continue
      }
      // 断点续跑：reviewPending=true 表示中断前审稿 REVISE 已落定、修订未做——
      // 从当时的轮次直接派任润泽，不浪费一次重审
      let resumePendingRevision = s.reviewPending === true
      for (let round = resumePendingRevision ? Math.max(1, s.reviewRound) : 1; round <= MAX_REVIEW_ROUNDS; round++) {
        s.reviewRound = round
        const forced = round === MAX_REVIEW_ROUNDS
        if (resumePendingRevision) {
          resumePendingRevision = false
          P(3, `⏭️ 第 ${s.index} 章断点命中（审稿意见已落定），跳过重审直接修订`)
        } else {
        P(3, `🔄 第 ${s.index} 章审稿 第 ${round}/${MAX_REVIEW_ROUNDS} 轮 — 明鉴秋 (draft-reviewer)${forced ? '（强制通过轮）' : ''}`)
        syncChapters((x) => x.index === s.index ? { status: 'reviewing' as const } : {})

        const reviewTask = [
          cardDigest(card),
          `\n【本章章节任务】第 ${s.index} 章「${s.title}」`,
          `\n【current_round】${round}/${MAX_REVIEW_ROUNDS}${forced ? '（第 3 轮：强制通过轮，即使发现问题也必须 PASS，未解决问题写入 carry_over）' : ''}`,
          `\n【审查对象】仅审查本消息内嵌的【待审草稿】；不要读取工作区文件（文件内容与本次送审不保证一致，缺内容就是缺内容，如实 REVISE）。`,
          `\n【待审草稿】\n${s.draft}`,
          s.feedback ? `\n【上一轮审稿意见】\n${s.feedback}` : '',
          s.revisionNote ? `\n【上一轮修订说明】\n${s.revisionNote}` : '',
        ].join('\n')

        const review = await D('draft-reviewer', `明鉴秋·第${s.index}章R${round}`, reviewTask, {
          forceJson: true,
          outputSchema: REVIEW_SCHEMA,
        })
        let verdictJson: { verdict: string; must_fix: string[]; suggestions: string[]; carry_over: string[] }
        try {
          verdictJson = (review.structured ?? extractJson(review.text)) as typeof verdictJson
        } catch {
          // 审稿解析失败 → 视为超时降级：PASS 并记录
          verdictJson = { verdict: 'PASS', must_fix: [], suggestions: [], carry_over: [`审稿输出解析失败，未完成全量审查（stopReason=${review.stopReason}）`] }
        }

        let pass = verdictJson.verdict === 'PASS'
        if (forced && !pass) {
          // 第 3 轮强制通过
          pass = true
          verdictJson.carry_over.push(...verdictJson.must_fix)
          P(3, `⏭️ 第 ${s.index} 章第 3 轮强制通过，遗留 ${verdictJson.carry_over.length} 条建议`)
        }

        if (pass) {
          s.verdict = 'PASS'
          s.reviewPending = false
          s.carryOverWarnings.push(...verdictJson.carry_over)
          P(3, `✅ 第 ${s.index} 章审稿通过（${round} 轮）— ${s.title}`)
          syncChapters((x) => x.index === s.index ? { status: 'pass' as const } : {})
          opts?.onCheckpoint?.()
          break
        }

        s.verdict = 'REVISE'
        s.reviewPending = true
        s.feedback = [
          ...verdictJson.must_fix.map((m, i) => `${i + 1}. [必须修改] ${m}`),
          ...verdictJson.suggestions.map((m) => `- [建议] ${m}`),
        ].join('\n')
        opts?.onCheckpoint?.()
        }

        P(3, `✏️ 第 ${s.index} 章退回修订 — 任润泽 (draft-reviser)`)
        syncChapters((x) => x.index === s.index ? { status: 'revising' as const } : {})
        const reviseTask = [
          cardDigest(card),
          `\n【本章章节任务】第 ${s.index} 章「${s.title}」`,
          `\n【current_round】${round}/${MAX_REVIEW_ROUNDS}`,
          `\n【原草稿】\n${s.draft}`,
          `\n【审稿意见】\n${s.feedback}`,
          `\n【输出纪律】Part 1 完整修订稿全文内联 + Part 2 修改说明（以 --- 分隔）；全程中文；严禁把修订稿写入工作区文件后只回传路径或"以下为全文"式引导句。`,
        ].join('\n')
        const reviseGate = { kind: 'revision' as const, minChars: Math.max(CHAPTER_MIN_CHARS, Math.floor((s.draft?.length ?? 0) * 0.6)) }
        const reviseStart = Date.now()
        const gatedRevised = await dispatchWithGate(D, P, 'draft-reviser', `任润泽·第${s.index}章R${round}`, `任润泽·第${s.index}章R${round}·重派`, reviseTask, reviseGate)
        const revised = await rescueIfGated(gatedRevised, opts?.wsRoot, reviseStart, reviseGate)
        if (revised.ok && !gatedRevised.ok) P(3, `📥 第 ${s.index} 章修订稿已从工作区文件恢复（成员最终输出未内联修订稿）`)
        try {
          const revisedText = brief(revised, `第${s.index}章修订`)
          // 任润泽输出 = Part1 修订稿 + Part2 修改说明；按分隔约定拆分
          const splitAt = revisedText.search(/^---\s*$/m)
          s.draft = splitAt > 0 ? revisedText.slice(0, splitAt).trim() : revisedText
          s.revisionNote = splitAt > 0 ? revisedText.slice(splitAt).trim() : ''
          // 修订后内联引用达标 → 清掉调研阶段记下的过期「来源不足」警告
          if (countDistinctUrls(s.draft) >= MIN_CHAPTER_SOURCES) {
            s.carryOverWarnings = s.carryOverWarnings.filter((w) => !w.includes('本章来源仅'))
          }
        } catch (e) {
          if (e instanceof ResearchInterrupted) throw e
          // 降级：保留修订前版本为最终稿（原协议降级表）
          s.carryOverWarnings.push(`修订失败（${e instanceof Error ? e.message : String(e)}），以修订前版本为准`)
          P(3, `⚠️ 第 ${s.index} 章修订失败（降级：保留当前稿）`)
        }
        s.reviewPending = false
        opts?.onCheckpoint?.()
        P(3, `✅ 第 ${s.index} 章修订完成（进入复审）`)
      }
    }
    P(3, `✅ Phase 3 完成 — ${card.sections.filter((s) => s.verdict === 'PASS').length}/${card.sections.length} 章通过`)
  }

  const chaptersBody = card.sections
    .map((s) => `\n## 第 ${s.index} 章：${s.title}\n\n${s.draft ?? '【本章调研失败，仅有大纲要点】'}`)
    .join('\n')
  const allWarnings = [
    ...card.globalWarnings.map((w) => `- **全局**：${w}`),
    ...card.sections.flatMap((s) =>
      s.carryOverWarnings.map((w) => `- **第 ${s.index} 章 ${s.title}**：${w}`),
    ),
  ]

  if (single) {
    // ───────── Workflow C：跳过程文成/傅梓铭，编排器直接拼装单章报告 ─────────
    P(4, `✅ 单章模式 — 跳过报告框架与发布（参考文献由主理人从本章引用中抽取）`)
    const refs = extractReferences(card.sections[0]?.draft ?? '')
    card.frame = {
      table_of_contents: '',
      introduction: '',
      conclusion: '',
      sources: refs,
    }
    card.finalReport = [
      `# ${card.title ?? card.topic}`,
      '',
      `**日期**：${nowDate()}　**执行模式**：单章研究`,
      '',
      chaptersBody,
      '',
      '## 参考文献',
      ...(refs.length > 0 ? refs : ['（本章未收集到带链接的引用来源）']),
      '',
      ...(allWarnings.length > 0 ? ['## 待完善事项', ...allWarnings, ''] : []),
      '---',
      '',
      '> 本报告由 AI 深度研究团队生成，重要决策请经专业人员核验。所有引用来源请用户在重要场景下二次核验时效性与真实性。',
    ].join('\n')
    P(5, `✅ Phase 5 完成 — 单章报告 ${card.finalReport.length} 字`)
    P(5, `🏁 深度研究《${card.title}》完成（单章模式）`)
    return
  }

  // ───────────────────────── Phase 4: 报告框架（程文成） ─────────────────────
  // 断点自检：已有框架（上次 run 已完成 Phase 4）则跳过
  if (card.frame) {
    P(4, `⏭️ Phase 4 断点命中（框架已存在），跳过程文成`)
  } else {
  P(4, `▶ Phase 4/5 报告框架 — 程文成 (report-writer)`)
  const frameTask = `${cardDigest(card)}\n\n【各章节正文（已通过审稿）】\n${chaptersBody}\n\n请按你的 4 步任务产出 JSON：table_of_contents / introduction / conclusion / sources（APA 去重排序，目标 ≥20 来源）。`
  let frame: NonNullable<ResearchCard['frame']>
  let frameDegraded = false
  const frameRaw = await D('report-writer', '程文成·报告框架', frameTask, {
    forceJson: true,
    outputSchema: FRAME_SCHEMA,
  })
  try {
    if (!frameRaw.ok && !frameRaw.text) throw new Error(frameRaw.diagnostic ?? frameRaw.stopReason)
    frame = (frameRaw.structured ?? extractJson(frameRaw.text)) as typeof frame
  } catch (e) {
    // 超时降级：简易占位框架（目录=大纲、引言/结论占位、参考文献=来源池），Phase 5 继续
    frameDegraded = true
    P(4, `⚠️ Phase 4 降级 — 程文成未正常完成（${e instanceof Error ? e.message.slice(0, 120) : String(e)}），使用占位框架`)
    frame = {
      table_of_contents: card.sections.map((s) => `${s.index}. ${s.title}`).join('\n'),
      introduction: `本报告围绕「${card.topic}」展开${card.mode === 'single' ? '专项' : '系统性'}研究，共 ${card.sections.length} 章。（程文成阶段超时降级，引言待补）`,
      conclusion: `本报告完成了「${card.topic}」的多源调研与审稿流程。（程文成阶段超时降级，结论待补）`,
      sources: dedupeSources(card.sourcePool),
    }
  }
  card.frame = frame
  P(4, `✅ Phase 4 完成${frameDegraded ? '（降级）' : ''} — 引言 ${frame.introduction.length} 字 / 结论 ${frame.conclusion.length} 字 / 参考 ${frame.sources.length} 条`)
  opts?.onCheckpoint?.()
  }

  // ───────────────────────── Phase 5: 发布输出（傅梓铭） ─────────────────────
  // 断点自检：已有最终报告（上次 run 已完成 Phase 5，仅差写盘）则跳过
  if (card.finalReport) {
    P(5, `⏭️ Phase 5 断点命中（最终报告已存在），跳过傅梓铭`)
    P(5, `🏁 深度研究《${card.title}》全部阶段完成`)
    return
  }
  P(5, `▶ Phase 5/5 发布输出 — 傅梓铭 (report-publisher)`)
  const quickBanner = quick ? `\n> ⚠️ **本次为快速研究，未经审稿**，结论可靠性低于完整模式，重要决策请以完整模式复核。\n` : ''
  const publishTask = [
    cardDigest(card),
    `\n【报告元数据】标题：${card.title}；日期：${nowDate()}；执行模式：${card.mode}；引用格式：${card.citationFormat}`,
    quickBanner ? `\n【固定提示（置于报告顶部）】\n${quickBanner}` : '',
    `\n【目录（程文成）】\n${card.frame?.table_of_contents ?? ''}`,
    `\n【引言（程文成）】\n${card.frame?.introduction ?? ''}`,
    `\n【各章节正文（已通过审稿）】\n${chaptersBody}`,
    `\n【结论（程文成）】\n${card.frame?.conclusion ?? ''}`,
    `\n【参考文献（程文成）】\n${(card.frame?.sources ?? []).join('\n')}`,
    allWarnings.length > 0 ? `\n【审稿警告清单（汇总到「待完善事项」区）】\n${allWarnings.join('\n')}` : '',
    `\n请执行整合 + Final QA，回传完整 Markdown 报告（${card.outputFormat === 'html' ? '并额外附自包含 HTML 版本' : 'markdown 格式'}）。`,
  ].join('\n')
  const published = await D('report-publisher', '傅梓铭·发布输出', publishTask)
    .then((r) => brief(r, 'Phase 5 发布'))
    .catch((e: unknown) => {
      // 中断不降级：保留断点，等待续跑
      if (e instanceof ResearchInterrupted) throw e
      // 超时降级：主编排器直接拼装最小可用报告，保证产物落盘
      P(5, `⚠️ Phase 5 降级 — 傅梓铭未正常完成，编排器代为拼装`)
      return [
        `# ${card.title ?? card.topic}`,
        '',
        `> 深度研究专家团报告（${nowDate()}）· 发布阶段超时降级拼装`,
        quickBanner,
        card.frame?.table_of_contents ?? '',
        '',
        '## 引言',
        card.frame?.introduction ?? '',
        '',
        chaptersBody,
        '',
        '## 结论',
        card.frame?.conclusion ?? '',
        '',
        '## 参考文献',
        ...(card.frame?.sources ?? []),
        '',
        ...(allWarnings.length > 0 ? ['## 待完善事项', ...allWarnings, ''] : []),
      ].join('\n')
    })
  // quick 免审稿提示插到标题下；降级拼装路径已内嵌时不再重复插
  const bannerLine = quickBanner.trim()
  card.finalReport = quick && published !== undefined && !published.includes(bannerLine)
    ? published.replace(/^(# .*\n)/, `$1\n${bannerLine}\n`)
    : published
  P(5, `✅ Phase 5 完成 — 最终报告 ${card.finalReport.length} 字`)
  opts?.onCheckpoint?.()

  // 整份报告来源总数硬校验（原协议：整份 ≥20 来源）
  const totalSources = countDistinctUrls(card.finalReport ?? '')
  if (totalSources < 20) {
    const note = `整份报告去重来源仅 ${totalSources} 条（目标 ≥20），建议后续补研`
    P(5, `⚠️ ${note}`)
    if (!card.finalReport?.includes('待完善事项')) {
      card.finalReport = `${card.finalReport ?? ''}\n\n## 待完善事项\n\n- ${note}\n`
    }
  }
  P(5, `🏁 深度研究《${card.title}》全部阶段完成`)
}

/** Re-run one chapter (调研→审稿循环) then Phase 4/5 — reviseChapter tool. */
export async function reviseChapter(
  ctx: AppContext,
  card: ResearchCard,
  parent: unknown,
  signal: AbortSignal,
  progress: ProgressFn,
  track: RunTracker | undefined,
  chapterIndex: number,
  chapterFeedback?: string,
  wsRoot?: string,
): Promise<ResearchCard> {
  const s = card.sections.find((x) => x.index === chapterIndex)
  if (!s) throw new Error(`章节 ${chapterIndex} 不存在（大纲共 ${card.sections.length} 章）`)
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)
  const syncChapter = (over: Partial<status.ChapterProgress>): void => {
    syncChapters((x) => x.index === chapterIndex ? over : {})
  }

  P(3, `🔄 重修第 ${chapterIndex} 章「${s.title}」${chapterFeedback ? `（附加要求：${chapterFeedback}）` : ''}`)
  // 重修语义 = 显式重做：清掉目标章状态与下游产物，绕过 executePhases 的断点跳过
  s.reviewRound = 0
  s.verdict = undefined
  s.draft = undefined
  s.summary = undefined
  s.feedback = undefined
  s.revisionNote = undefined
  s.reviewPending = undefined
  s.carryOverWarnings = []
  card.frame = undefined
  card.finalReport = undefined
  if (chapterFeedback) {
    card.extraConstraints = [card.extraConstraints, `第${chapterIndex}章重修要求：${chapterFeedback}`].filter(Boolean).join('；')
  }

  const task = `【输出方式（最高优先级）】你的最终输出文本必须就是成稿全文：从「## 第 ${s.index} 章」标题行开始、以「本章新增来源」清单与【本章小结】结束；禁止把成稿写入工作区文件后只回传路径（编排器只取最终输出文本）。\n\n模式：深度研究（章节重修）。\n\n${cardDigest(card)}\n\n本章任务：重写/深化第 ${s.index} 章「${s.title}」，以最新草稿为起点、按附加要求补强。产出完整章节草稿（800-1500 字、≥${MIN_CHAPTER_SOURCES} 来源 ≥3 类型、带真实引用），末尾附「【本章小结】」和「本章新增来源」清单。\n成稿边界：全程中文，严禁英文过程自述与占位符。`
  const dispatchStart = Date.now()
  const gated = await dispatchWithGate(D, P, 'topic-researcher', `谭溯源·重修第${chapterIndex}章`, `谭溯源·重修第${chapterIndex}章·重派`, task, { kind: 'chapter', minChars: CHAPTER_MIN_CHARS })
  const r = await rescueIfGated(gated, wsRoot, dispatchStart, { kind: 'chapter', minChars: CHAPTER_MIN_CHARS })
  if (r.ok && !gated.ok) P(3, `📥 第 ${chapterIndex} 章重修成稿已从工作区文件恢复（成员最终输出未内联成稿）`)
  s.draft = brief(r, `第${chapterIndex}章重修调研`)
  const parts = harvestChapterParts(s.draft)
  s.draft = parts.draft
  s.summary = parts.summary
  s.newSources = harvestSourcePool(r.text)
  card.sourcePool = dedupeSources([...card.sourcePool, ...s.newSources])

  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    s.reviewRound = round
    const forced = round === MAX_REVIEW_ROUNDS
    P(3, `🔄 第 ${s.index} 章复审 第 ${round}/${MAX_REVIEW_ROUNDS} 轮 — 明鉴秋${forced ? '（强制通过轮）' : ''}`)
    syncChapter({ status: 'reviewing' as const })
    const review = await D('draft-reviewer', `明鉴秋·重修R${round}`, [
      cardDigest(card),
      `\n【本章章节任务】第 ${s.index} 章「${s.title}」`,
      `\n【current_round】${round}/${MAX_REVIEW_ROUNDS}${forced ? '（强制通过轮）' : ''}`,
      `\n【审查对象】仅审查本消息内嵌的【待审草稿】；不要读取工作区文件。`,
      `\n【待审草稿】\n${s.draft}`,
    ].join('\n'), { forceJson: true, outputSchema: REVIEW_SCHEMA })
    let verdictJson: { verdict: string; must_fix: string[]; suggestions: string[]; carry_over: string[] }
    try {
      verdictJson = (review.structured ?? extractJson(review.text)) as typeof verdictJson
    } catch {
      verdictJson = { verdict: 'PASS', must_fix: [], suggestions: [], carry_over: ['审稿输出解析失败，视为通过'] }
    }
    let pass = verdictJson.verdict === 'PASS'
    if (forced && !pass) {
      pass = true
      verdictJson.carry_over.push(...verdictJson.must_fix)
    }
    if (pass) {
      s.verdict = 'PASS'
      s.carryOverWarnings.push(...verdictJson.carry_over)
      syncChapter({ status: 'pass' as const })
      break
    }
    s.feedback = [...verdictJson.must_fix.map((m, i) => `${i + 1}. [必须修改] ${m}`), ...verdictJson.suggestions.map((m) => `- [建议] ${m}`)].join('\n')
    const reviseGate = { kind: 'revision' as const, minChars: Math.max(CHAPTER_MIN_CHARS, Math.floor((s.draft?.length ?? 0) * 0.6)) }
    const reviseStart = Date.now()
    const gatedRevised = await dispatchWithGate(D, P, 'draft-reviser', `任润泽·重修R${round}`, `任润泽·重修R${round}·重派`, [
      cardDigest(card),
      `\n【原草稿】\n${s.draft}`,
      `\n【审稿意见】\n${s.feedback}`,
      `\n【输出纪律】Part 1 完整修订稿全文内联 + Part 2 修改说明（以 --- 分隔）；全程中文；严禁把修订稿写入工作区文件后只回传路径或"以下为全文"式引导句。`,
    ].join('\n'), reviseGate)
    const revised = await rescueIfGated(gatedRevised, wsRoot, reviseStart, reviseGate)
    if (revised.ok && !gatedRevised.ok) P(3, `📥 第 ${chapterIndex} 章重修修订稿已从工作区文件恢复`)
    try {
      const t = brief(revised, '重修修订')
      const splitAt = t.search(/^---\s*$/m)
      s.draft = splitAt > 0 ? t.slice(0, splitAt).trim() : t
      // 修订后内联引用达标 → 清掉调研阶段记下的过期「来源不足」警告
      if (countDistinctUrls(s.draft) >= MIN_CHAPTER_SOURCES) {
        s.carryOverWarnings = s.carryOverWarnings.filter((w) => !w.includes('本章来源仅'))
      }
    } catch {
      s.carryOverWarnings.push('重修修订失败，以修订前版本为准')
    }
  }
  syncChapter({ status: 'pass' as const })

  // 重跑 Phase 4/5（single 模式下为编排器拼装）
  await executePhases(ctx, card, parent, signal, progress, track, { wsRoot })
  return card
}

