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

const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    date: { type: 'string' },
    sections: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['title', 'date', 'sections', 'rationale'],
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
    },
    D: (role, label, task, opts) => {
      track?.member(label, 'start')
      return dispatchMember(ctx, { parent, signal, role, label: LABEL_PREFIX + label, task, ...opts })
        .then((r) => {
          track?.member(label, { settle: r.ok ? 'ok' : (r.stopReason === 'timeout' ? 'timeout' : 'error') })
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

/** Parse the source-pool section out of Tan's scouting reply. */
function harvestSourcePool(text: string): string[] {
  const idx = text.indexOf('已收集来源池')
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
  const idx = text.indexOf(marker)
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
  /** Outline feedback from the user (planId round 2+); re-plans Phase 2. */
  outlineFeedback?: string,
  /** Start after Phase 2 (confirmed outline resume); omit for a fresh run. */
  resumeAfterOutline?: boolean,
  /** Skip the outline-confirmation pause (full mode, unattended scenarios). */
  skipConfirm?: boolean,
): Promise<PipelineStop> {
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)

  // ───────────────────────── Phase 1: 初调（谭溯源） ─────────────────────────
  if (!resumeAfterOutline) {
    P(1, `▶ Phase 1/5 初始调研 — 谭溯源 (topic-researcher)`)
    const narrow = card.mode === 'single' ? '（单章研究：范围收窄至该子课题本身，不做全域铺开）' : ''
    const scoutTask = `模式：初步调研（Phase 1）${narrow}。\n\n${cardDigest(card)}\n\n请对上述课题执行广泛初调，按你角色定义的「模式一」产出：500-1000 字研究摘要（覆盖定义背景/主流观点与争议/关键数据/主要参与者/最新趋势，全部带真实超链接引用）+ 末尾「已收集来源池」清单（≥8-15 条）。`
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
  }

  // ───────────────── Phase 2: 大纲（季要纲；single 模式跳过 → 直接单章） ─────────────────
  if (card.mode === 'single') {
    card.title = card.title ?? card.topic
    card.sections = [{ index: 1, title: card.topic, reviewRound: 0, carryOverWarnings: [], newSources: [] }]
    syncChapters(() => ({}))
    P(2, `✅ 单章模式 — 跳过大纲规划，直接进入单章研究`)
  } else if (!resumeAfterOutline || outlineFeedback) {
    P(2, `▶ Phase 2/5 大纲规划 — 季要纲 (research-planner)${outlineFeedback ? '（按用户反馈修订大纲）' : ''}`)
    const feedbackNote = outlineFeedback ? `\n\n【用户对上一版大纲的反馈（必须吸收）】\n${outlineFeedback}` : ''
    const outlineTask = `${cardDigest(card)}${feedbackNote}\n\n请基于 Phase 1 初调摘要${outlineFeedback ? '和用户反馈' : ''}规划报告章节大纲。max_sections=${card.maxSections}。输出 JSON（title/date/sections/rationale）。`
    const outlineRaw = await D('research-planner', '季要纲·大纲规划', outlineTask, {
      forceJson: true,
      outputSchema: OUTLINE_SCHEMA,
    })
    let outline: { title: string; sections: string[] }
    try {
      const parsed = (outlineRaw.structured ?? extractJson(outlineRaw.text)) as { title: string; sections: string[] }
      if (!parsed?.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) throw new Error('empty outline')
      outline = parsed
    } catch {
      // 降级：编排器基于初调摘要生成简化 3 章占位大纲（原协议降级表）
      P(2, `⚠️ Phase 2 降级 — 季要纲未正常完成（${(outlineRaw.diagnostic ?? outlineRaw.text.slice(0, 80)).slice(0, 120)}），使用 3 章占位大纲`)
      outline = {
        title: card.topic,
        sections: [`${card.topic}：概述与背景`, `${card.topic}：现状与分析`, `${card.topic}：趋势与展望`],
      }
    }
    card.title = outline.title
    card.sections = outline.sections.slice(0, card.maxSections).map((t, i) => ({
      index: i + 1,
      title: t,
      reviewRound: 0,
      carryOverWarnings: [],
      newSources: [],
    }))
    P(2, `✅ Phase 2 完成 — 《${card.title}》共 ${card.sections.length} 章：${card.sections.map((s) => s.title).join(' / ')}`)
    syncChapters(() => ({}))

    // full 模式在大纲确认点暂停（quick 免确认，原协议 Workflow B；
    // skipOutlineConfirm 供全自动场景一次跑完）
    if (card.mode === 'full' && !skipConfirm) {
      return 'awaiting-outline-confirm'
    }
  }

  await executePhases(ctx, card, parent, signal, progress, track)
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
): Promise<void> {
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)
  const quick = card.mode === 'quick'
  const single = card.mode === 'single'

  // ───────────────────────── Phase 3: 逐章研究 ─────────────────
  P(3, `▶ Phase 3/5 逐章研究（调研→${quick ? '（快速模式：跳过审稿）' : `审稿→修订，≤${MAX_REVIEW_ROUNDS} 轮`}）`)
  syncChapters(() => ({ status: undefined }))

  const dispatchChapter = async (s: ChapterState): Promise<void> => {
    const task = `模式：深度研究（Phase 3 章节调研）。\n\n${cardDigest(card)}\n\n本章任务：第 ${s.index} 章「${s.title}」。按你角色「模式二」要求产出完整章节草稿（800-1500 字、≥${MIN_CHAPTER_SOURCES} 来源 ≥3 类型、带真实引用），末尾附「【本章小结】」（≤100 字，供主理人传给后续章节）和「本章新增来源」清单。\n输出纪律：最终输出直接从章节正文第一段开始，禁止输出推理过程、证据盘点、工作笔记或任何元话语；引用一律用 [标题](URL) 行内超链接。`
    const r = await D('topic-researcher', `谭溯源·第${s.index}章`, task)
    try {
      s.draft = brief(r, `第${s.index}章调研`)
    } catch (e) {
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
  }

  if (card.sections.length > SERIAL_MAX_SECTIONS) {
    // >5 章：并行（原协议「并行加速」），跨章一致性风险提示
    P(3, `⚡ ${card.sections.length} 章 > ${SERIAL_MAX_SECTIONS}，启用并行调研（跨章一致性风险增加，全部共享同一张研究参数卡）`)
    await Promise.all(card.sections.map((s) => dispatchChapter(s)))
  } else {
    // ≤5 章：串行——每章完成后小结+新来源随参数卡流入下一章（原协议默认）
    for (const s of card.sections) {
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
    // 3.2 串行审稿-修订循环（跨章一致性优先，与原协议一致）
    for (const s of card.sections) {
      if (!s.draft) continue // 降级占位章直接进入警告区
      for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
        s.reviewRound = round
        const forced = round === MAX_REVIEW_ROUNDS
        P(3, `🔄 第 ${s.index} 章审稿 第 ${round}/${MAX_REVIEW_ROUNDS} 轮 — 明鉴秋 (draft-reviewer)${forced ? '（强制通过轮）' : ''}`)
        syncChapters((x) => x.index === s.index ? { status: 'reviewing' as const } : {})

        const reviewTask = [
          cardDigest(card),
          `\n【本章章节任务】第 ${s.index} 章「${s.title}」`,
          `\n【current_round】${round}/${MAX_REVIEW_ROUNDS}${forced ? '（第 3 轮：强制通过轮，即使发现问题也必须 PASS，未解决问题写入 carry_over）' : ''}`,
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
          s.carryOverWarnings.push(...verdictJson.carry_over)
          P(3, `✅ 第 ${s.index} 章审稿通过（${round} 轮）— ${s.title}`)
          syncChapters((x) => x.index === s.index ? { status: 'pass' as const } : {})
          break
        }

        s.verdict = 'REVISE'
        s.feedback = [
          ...verdictJson.must_fix.map((m, i) => `${i + 1}. [必须修改] ${m}`),
          ...verdictJson.suggestions.map((m) => `- [建议] ${m}`),
        ].join('\n')

        P(3, `✏️ 第 ${s.index} 章退回修订 — 任润泽 (draft-reviser)`)
        syncChapters((x) => x.index === s.index ? { status: 'revising' as const } : {})
        const reviseTask = [
          cardDigest(card),
          `\n【本章章节任务】第 ${s.index} 章「${s.title}」`,
          `\n【current_round】${round}/${MAX_REVIEW_ROUNDS}`,
          `\n【原草稿】\n${s.draft}`,
          `\n【审稿意见】\n${s.feedback}`,
        ].join('\n')
        const revised = await D('draft-reviser', `任润泽·第${s.index}章R${round}`, reviseTask)
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
          // 降级：保留修订前版本为最终稿（原协议降级表）
          s.carryOverWarnings.push(`修订失败（${e instanceof Error ? e.message : String(e)}），以修订前版本为准`)
          P(3, `⚠️ 第 ${s.index} 章修订失败（降级：保留当前稿）`)
        }
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

  // ───────────────────────── Phase 5: 发布输出（傅梓铭） ─────────────────────
  P(5, `▶ Phase 5/5 发布输出 — 傅梓铭 (report-publisher)`)
  const quickBanner = quick ? `\n> ⚠️ **本次为快速研究，未经审稿**，结论可靠性低于完整模式，重要决策请以完整模式复核。\n` : ''
  const publishTask = [
    cardDigest(card),
    `\n【报告元数据】标题：${card.title}；日期：${nowDate()}；执行模式：${card.mode}；引用格式：${card.citationFormat}`,
    quickBanner ? `\n【固定提示（置于报告顶部）】\n${quickBanner}` : '',
    `\n【目录（程文成）】\n${frame.table_of_contents}`,
    `\n【引言（程文成）】\n${frame.introduction}`,
    `\n【各章节正文（已通过审稿）】\n${chaptersBody}`,
    `\n【结论（程文成）】\n${frame.conclusion}`,
    `\n【参考文献（程文成）】\n${frame.sources.join('\n')}`,
    allWarnings.length > 0 ? `\n【审稿警告清单（汇总到「待完善事项」区）】\n${allWarnings.join('\n')}` : '',
    `\n请执行整合 + Final QA，回传完整 Markdown 报告（${card.outputFormat === 'html' ? '并额外附自包含 HTML 版本' : 'markdown 格式'}）。`,
  ].join('\n')
  const published = await D('report-publisher', '傅梓铭·发布输出', publishTask)
    .then((r) => brief(r, 'Phase 5 发布'))
    .catch(() => {
      // 超时降级：主编排器直接拼装最小可用报告，保证产物落盘
      P(5, `⚠️ Phase 5 降级 — 傅梓铭未正常完成，编排器代为拼装`)
      return [
        `# ${card.title ?? card.topic}`,
        '',
        `> 深度研究专家团报告（${nowDate()}）· 发布阶段超时降级拼装`,
        quickBanner,
        frame.table_of_contents,
        '',
        '## 引言',
        frame.introduction,
        '',
        chaptersBody,
        '',
        '## 结论',
        frame.conclusion,
        '',
        '## 参考文献',
        ...frame.sources,
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
): Promise<ResearchCard> {
  const s = card.sections.find((x) => x.index === chapterIndex)
  if (!s) throw new Error(`章节 ${chapterIndex} 不存在（大纲共 ${card.sections.length} 章）`)
  const { P, D, syncChapters } = makeRuntime(ctx, card, parent, signal, progress, track)
  const syncChapter = (over: Partial<status.ChapterProgress>): void => {
    syncChapters((x) => x.index === chapterIndex ? over : {})
  }

  P(3, `🔄 重修第 ${chapterIndex} 章「${s.title}」${chapterFeedback ? `（附加要求：${chapterFeedback}）` : ''}`)
  s.reviewRound = 0
  s.verdict = undefined
  s.carryOverWarnings = []
  if (chapterFeedback) {
    card.extraConstraints = [card.extraConstraints, `第${chapterIndex}章重修要求：${chapterFeedback}`].filter(Boolean).join('；')
  }

  const task = `模式：深度研究（章节重修）。\n\n${cardDigest(card)}\n\n本章任务：重写/深化第 ${s.index} 章「${s.title}」，以最新草稿为起点、按附加要求补强。产出完整章节草稿（800-1500 字、≥${MIN_CHAPTER_SOURCES} 来源 ≥3 类型、带真实引用），末尾附「【本章小结】」和「本章新增来源」清单。`
  const r = await D('topic-researcher', `谭溯源·重修第${chapterIndex}章`, task)
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
    const revised = await D('draft-reviser', `任润泽·重修R${round}`, [
      cardDigest(card),
      `\n【原草稿】\n${s.draft}`,
      `\n【审稿意见】\n${s.feedback}`,
    ].join('\n'))
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
  await executePhases(ctx, card, parent, signal, progress, track)
  return card
}

