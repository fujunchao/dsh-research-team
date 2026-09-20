/**
 * The 5-phase deep research workflow, ported from WorkBuddy
 * gpt-researcher-team's research-chief-editor protocol:
 *
 *   Phase 1  初调           谭溯源 topic-researcher   (scouting summary + source pool)
 *   Phase 2  大纲规划       季要纲 research-planner   (JSON outline)
 *   Phase 3  逐章研究       谭溯源 → 明鉴秋 → 任润泽  (≤3 review rounds)
 *   Phase 4  报告框架       程文成 report-writer      (intro/conclusion/TOC/refs JSON)
 *   Phase 5  发布输出       傅梓铭 report-publisher   (final QA + assembled report)
 *
 * Degradation rules (超时降级 / 失败兜底) follow the same table as the
 * original: member failure ⇒ one retry ⇒ degrade per-phase; round 3 review
 * is a forced PASS with carry-over warnings.
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
): Promise<ResearchCard> {
  /** Progress line: forwards to the caller AND the optional live tracker. */
  const P = (phase: number, line: string): void => {
    progress(line)
    track?.progress(phase, line)
  }
  /** Label prefix so every member child session is recognizable in the UI. */
  const LABEL_PREFIX = '🔬 [深度研究] '
  const D = (role: DispatchOpts['role'], label: string, task: string, opts?: Partial<DispatchOpts>) => {
    track?.member(label, 'start')
    return dispatchMember(ctx, { parent, signal, role, label: LABEL_PREFIX + label, task, ...opts })
      .then((r) => {
        track?.member(label, { settle: r.ok ? 'ok' : (r.stopReason === 'timeout' ? 'timeout' : 'error') })
        return r
      }, (e: unknown) => {
        track?.member(label, { settle: 'error' })
        throw e
      })
  }
  /** Refresh the tracker's chapter table from the card. */
  const syncChapters = (over: (s: ChapterState) => Partial<status.ChapterProgress>): void => {
    track?.chapters(card.sections.map((s) => ({
      index: s.index,
      title: s.title,
      reviewRound: s.reviewRound,
      status: 'drafting',
      ...over(s),
    })))
  }

  // ───────────────────────── Phase 1: 初调（谭溯源） ─────────────────────────
  P(1, `▶ Phase 1/5 初始调研 — 谭溯源 (topic-researcher)`)
  const scoutTask = `模式：初步调研（Phase 1）。\n\n${cardDigest(card)}\n\n请对上述课题执行广泛初调，按你角色定义的「模式一」产出：500-1000 字研究摘要（覆盖定义背景/主流观点与争议/关键数据/主要参与者/最新趋势，全部带真实超链接引用）+ 末尾「已收集来源池」清单（≥8-15 条）。`
  const scout = brief(await D('topic-researcher', '谭溯源·初步调研', scoutTask), 'Phase 1 初调')
  card.scoutingSummary = scout
  card.sourcePool = harvestSourcePool(scout)
  P(1, `✅ Phase 1 完成 — 摘要 ${scout.length} 字，来源池 ${card.sourcePool.length} 条`)

  // ───────────────────────── Phase 2: 大纲（季要纲） ─────────────────────────
  P(2, `▶ Phase 2/5 大纲规划 — 季要纲 (research-planner)`)
  const outlineTask = `${cardDigest(card)}\n\n请基于 Phase 1 初调摘要规划报告章节大纲。max_sections=${card.maxSections}。输出 JSON（title/date/sections/rationale）。`
  const outlineRaw = await D('research-planner', '季要纲·大纲规划', outlineTask, {
    forceJson: true,
    outputSchema: OUTLINE_SCHEMA,
  })
  let outline: { title: string; sections: string[]; rationale: string }
  try {
    outline = (outlineRaw.structured ?? extractJson(outlineRaw.text)) as typeof outline
  } catch {
    throw new Error('Phase 2 大纲 JSON 解析失败：' + outlineRaw.text.slice(0, 300))
  }
  card.title = outline.title
  card.sections = outline.sections.slice(0, card.maxSections).map((t, i) => ({
    index: i + 1,
    title: t,
    reviewRound: 0,
    carryOverWarnings: [],
    newSources: [],
  }))
  P(2, `✅ Phase 2 完成 — 《${card.title}》共 ${card.sections.length} 章：${outline.sections.join(' / ')}`)
  syncChapters(() => ({}))

  // ───────────────────────── Phase 3: 逐章研究（并行调研 → 串行审稿修订循环） ─────────────
  P(3, `▶ Phase 3/5 逐章研究（调研→审稿→修订，≤${MAX_REVIEW_ROUNDS} 轮）`)
  syncChapters(() => ({ status: 'drafting' as const }))

  // 3.1 并行调研：每章一个谭溯源副本，共享同一张研究参数卡
  const chapterDrafts = await Promise.all(
    card.sections.map((s) => {
      const task = `模式：深度研究（Phase 3 章节调研）。\n\n${cardDigest(card)}\n\n本章任务：第 ${s.index} 章「${s.title}」。按你角色「模式二」要求产出完整章节草稿（800-1500 字、≥5 来源 ≥3 类型、带真实引用），并附「本章新增来源」清单。`
      return D('topic-researcher', `谭溯源·第${s.index}章`, task)
        .then((r) => ({ s, r: brief(r, `第${s.index}章调研`) }))
        .catch((e: unknown) => ({ s, err: e instanceof Error ? e.message : String(e) }))
    }),
  )
  for (const item of chapterDrafts) {
    const s = item.s as ChapterState
    if ('err' in item) {
      s.draft = undefined
      s.carryOverWarnings.push(`初稿调研失败：${item.err}；本章以大纲要点占位，需专家补研`)
      P(3, `⚠️ 第 ${s.index} 章调研失败（降级：标注占位）— ${s.title}`)
      syncChapters((x) => x.index === s.index ? { status: 'degraded' as const } : {})
    } else {
      s.draft = item.r
      s.newSources = harvestSourcePool(item.r)
      if (s.newSources.length > 0) card.sourcePool.push(...s.newSources)
      P(3, `✅ 第 ${s.index} 章初稿完成 — ${s.title}（新增来源 ${s.newSources.length} 条）`)
    }
  }

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
      const revisedText = brief(revised, `第${s.index}章修订`)
      // 任润泽输出 = Part1 修订稿 + Part2 修改说明；按分隔约定拆分
      const splitAt = revisedText.search(/^---\s*$/m)
      s.draft = splitAt > 0 ? revisedText.slice(0, splitAt).trim() : revisedText
      s.revisionNote = splitAt > 0 ? revisedText.slice(splitAt).trim() : ''
      P(3, `✅ 第 ${s.index} 章修订完成（进入复审）`)
    }
  }
  P(3, `✅ Phase 3 完成 — ${card.sections.filter((s) => s.verdict === 'PASS').length}/${card.sections.length} 章通过`)

  // ───────────────────────── Phase 4: 报告框架（程文成） ─────────────────────
  P(4, `▶ Phase 4/5 报告框架 — 程文成 (report-writer)`)
  const chaptersBody = card.sections
    .map((s) => `\n## 第 ${s.index} 章：${s.title}\n\n${s.draft ?? '【本章调研失败，仅有大纲要点】'}`)
    .join('\n')
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
  const allWarnings = card.sections.flatMap((s) =>
    s.carryOverWarnings.map((w) => `- **第 ${s.index} 章 ${s.title}**：${w}`),
  )
  const publishTask = [
    cardDigest(card),
    `\n【报告元数据】标题：${card.title}；日期：${nowDate()}；执行模式：${card.mode}；引用格式：${card.citationFormat}`,
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
    .catch((e: unknown) => {
      // 超时降级：主编排器直接拼装最小可用报告，保证产物落盘
      P(5, `⚠️ Phase 5 降级 — 傅梓铭未正常完成（${e instanceof Error ? e.message.slice(0, 120) : String(e)}），编排器代为拼装`)
      return [
        `# ${card.title ?? card.topic}`,
        '',
        `> 深度研究专家团报告（${nowDate()}）· 发布阶段超时降级拼装`,
        '',
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
  card.finalReport = published
  P(5, `✅ Phase 5 完成 — 最终报告 ${published.length} 字`)
  P(5, `🏁 深度研究《${card.title}》全部阶段完成`)

  return card
}
