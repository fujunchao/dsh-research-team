/**
 * @dsh-external/dsh-research-team — 深度研究专家团插件（host 半）。
 *
 * 注册 `deep_research` 工具：主理人（顾全之）编排 6 位领域专家，按
 * WorkBuddy 原版三工作流（A 完整 / B 快速 / C 单章）产出带多源超链接
 * 引用的专业研究报告，写入工作区 reports/ 目录。full 模式在大纲产出后
 * 暂停等待用户确认（planId 往返）；另注册 `research_member` 单动作直调
 * 工具（原版路由表）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createCard, nowDate, type CitationFormat, type ExecutionMode, type OutputFormat, type ResearchCard, type TimeRange } from './card.js'
import { ResearchInterrupted, runResearch, reviseChapter, type RunTracker } from './orchestrator.js'
import { dispatchMember, type AppContext } from './dispatch.js'
import * as plans from './plans.js'
import { findResumableByTopic, loadCheckpoint, saveCheckpoint } from './checkpoint.js'
import * as status from './status.js'

export const name = '@dsh-external/dsh-research-team'
// webServer (optional) serves GET /dsh-research-team/api/status for the client
// panel's live monitor; subagents/tools are the hard requirements.
export const inject = ['subagents', 'tools']

/** Client-panel status endpoint (must match src/client/index.tsx). */
export const STATUS_API_PREFIX = '/dsh-research-team/api/status'

/** Minimal structural type for the optional webServer service. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** Monotonic local run id for the status registry (also the planId space). */
let runCounter = 0
function runIdSeq(): string {
  runCounter += 1
  return `run-${Date.now().toString(36)}-${runCounter}`
}

export interface Config {
  /** full 模式章节数上限（quick=3 / single=1 固定）。 */
  maxChapters: number
  /** 报告输出目录名（相对当前工作区根）。 */
  reportsDir: string
}

/** Schemastery object schema for {@link Config} (type-annotated for portability). */
export const Config = z.object({
  maxChapters: z.number().min(1).max(10).default(5),
  reportsDir: z.string().default('reports'),
}).description('深度研究专家团配置') as unknown as {
  (): Config
  (options: { maxChapters?: number; reportsDir?: string }): Config
}

/** Write the report(s) under the workspace; returns md (and optional html) paths. */
async function writeReports(ctx: Context & AppContext, exec: unknown, config: Config, card: ResearchCard): Promise<{ mdPath: string; htmlPath?: string }> {
  const wsRoot = resolveWorkspaceRoot(ctx, exec)
  const slug = slugify(card.title ?? card.topic)
  const dir = join(wsRoot, config.reportsDir)
  await mkdir(dir, { recursive: true })
  const mdPath = join(dir, `${slug}-research-report-${nowDate()}.md`)
  await writeFile(mdPath, card.finalReport ?? '', 'utf8')
  const html = card.outputFormat === 'html' ? extractHtml(card.finalReport ?? '') : undefined
  const htmlPath = html ? join(dir, `${slug}-research-report-${nowDate()}.html`) : undefined
  if (htmlPath && html) await writeFile(htmlPath, html, 'utf8')
  return htmlPath ? { mdPath, htmlPath } : { mdPath }
}

export function apply(ctx: Context & AppContext, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'deep_research',
    description: [
      '启动深度研究专家团（主理人+6专家），产出带多源超链接引用的专业研究报告并写入工作区 reports/ 目录。',
      '三种模式（对齐原版协议）：full=完整（初调→大纲→【用户确认大纲】→逐章审稿修订→框架→发布，≤maxChapters 章，串行调度）；',
      'quick=快速（3 章、跳过审稿、免大纲确认、报告标注「未经审稿」）；single=单章（跳过大纲/引言/结论，直接深研一个子课题）。',
      'full 模式首次调用跑到大纲即返回 planId 待确认；用户给反馈则带 outlineFeedback 再调（重新出大纲）；确认后只带 planId 再调续跑至完成。',
      '对已完成报告可用 planId + reviseChapter 重修某一章。',
      '中断容错：研究中断（用户停止/进程重启）后所有已完成工作保留在断点——带 planId 或同课题再调即从断点续跑（已完成章节自动跳过）；forceNew=true 强制全新。',
      '适用：行业研究、竞品分析、市场调研、学术综述、技术综述。',
    ].join(''),
    parameters: {
      topic: { type: 'string', description: '研究课题（一句话，必须明确可研究）。续跑/反馈/重修已有 planId 时可省略' },
      planId: { type: 'string', description: '续跑/反馈大纲/重修章节时传入上次返回的 planId' },
      outlineFeedback: { type: 'string', description: '对大纲的修改意见或新增要求（与 planId 同用；会触发季要纲重新规划并追加进研究约束）' },
      skipOutlineConfirm: { type: 'boolean', description: 'full 模式跳过大纲确认一次跑完（全自动场景，缺省 false）' },
      reviseChapter: { type: 'number', description: '对已完成报告重修第 N 章（与 planId 同用；重跑该章调研→审稿→报告框架→发布）' },
      chapterFeedback: { type: 'string', description: '与 reviseChapter 同用：重修该章的附加要求（可选）' },
      mode: {
        type: 'string',
        enum: ['full', 'quick', 'single'] as const,
        description: '执行模式，缺省 full。quick=快速 3 章免审稿；single=单章深研',
      },
      timeRange: {
        type: 'string',
        enum: ['last_6_months', 'last_1_year', 'last_2_years', 'last_5_years', 'all'] as const,
        description: '时效窗口。缺省按课题类型自动选择（科技=last_1_year，行业=last_2_years，学术=last_5_years）',
      },
      citationFormat: {
        type: 'string',
        enum: ['APA', 'IEEE', 'Chicago'] as const,
        description: '引用格式，缺省 APA。',
      },
      outputFormat: {
        type: 'string',
        enum: ['markdown', 'html'] as const,
        description: '输出格式，缺省 markdown；html 额外产出自包含网页版。',
      },
      extraConstraints: { type: 'string', description: '用户特殊要求（可选）：必须覆盖的点、指定维度、地域限定等' },
      forceNew: { type: 'boolean', description: '忽略同课题的未完成断点、强制全新研究。缺省 false：同课题自动从断点续跑（已完成章节不重做）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true, description: 'completed | awaiting-outline-confirm | interrupted | error' },
          planId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          outline: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
          reportPath: { type: 'string', required: true },
          chapters: { type: 'array', items: { type: 'string' }, required: true },
          sourceCount: { type: 'number', required: true },
          reportExcerpt: { type: 'string', required: true },
          htmlPath: { type: 'string', required: true },
          progressLog: { type: 'array', items: { type: 'string' }, required: true },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render(args, value) {
        const v = value as { ok?: boolean; status?: string; planId?: string; title?: string; reportPath?: string; error?: string; sourceCount?: number; outline?: string[]; resumed?: boolean }
        const text = !v?.ok
          ? `❌ 深度研究失败：${v?.error ?? '未知错误'}`
          : v.status === 'awaiting-outline-confirm'
            ? `📋 《${v.title ?? ''}》大纲已就绪（planId: ${v.planId ?? ''}），共 ${v.outline?.length ?? 0} 章：\n${(v.outline ?? []).join('\n')}\n请向用户展示；确认→只带 planId 再调；修改→带 planId + outlineFeedback 再调`
            : `✅ 《${v.title ?? ''}》研究报告完成（${v.sourceCount ?? 0} 个来源${v.resumed ? '，♻️ 含断点续跑' : ''}）→ ${v.reportPath ?? ''}`
        return [{ type: 'text', text }] satisfies ContentBlock[]
      },
    },
    async execute(args, exec) {
      const progress: string[] = []
      const progress_ = (line: string): void => {
        progress.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
        ctx.logger?.info?.(`[research-team] ${line}`)
      }

      // ───────── planId 续跑 / 反馈 / 重修分支（内存未命中时从磁盘 checkpoint 恢复） ─────────
      const wsRoot = resolveWorkspaceRoot(ctx, exec.agent)
      let effectivePlanId: string | undefined = args.planId !== undefined ? String(args.planId) : undefined
      if (effectivePlanId === undefined && args.topic !== undefined && args.forceNew !== true) {
        // 同课题自动续跑：新会话里模型没有 planId，纯 topic 重调也能接上断点
        const cp = await findResumableByTopic(wsRoot, config.reportsDir, String(args.topic))
        if (cp) {
          progress_(`♻️ 检测到同课题未完成研究 ${cp.planId}（${cp.card.sections.filter((x) => x.draft).length}/${cp.card.sections.length} 章已有草稿，stage=${cp.stage}）——自动从断点续跑；如需全新研究请传 forceNew=true`)
          effectivePlanId = cp.planId
        }
      }
      if (effectivePlanId !== undefined) {
        const pid = effectivePlanId
        let resumed = args.planId === undefined // 同课题自动续跑
        let entryMaybe = plans.getPlan(pid)
        if (!entryMaybe) {
          const cp = await loadCheckpoint(wsRoot, config.reportsDir, pid)
          if (cp) {
            entryMaybe = plans.createPlan(cp.planId, cp.card)
            resumed = true
            // 磁盘上残留 executing = 当时的进程已死（存活进程的 executing 一定在内存里）→ 可续跑
            const stage = cp.stage === 'executing' ? 'interrupted' : cp.stage
            plans.updatePlan(cp.planId, { stage, revisionRound: cp.revisionRound })
            progress_(`📦 已从磁盘 checkpoint 恢复研究 ${cp.planId}（stage=${stage}）`)
          }
        }
        if (!entryMaybe) {
          return { ok: false, status: 'error', error: `planId ${pid} 不存在（内存与磁盘 checkpoint 均未找到）`, planId: '', reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
        }
        const entry = entryMaybe
        if (entry.stage === 'executing') {
          return { ok: false, status: 'error', error: `planId ${pid} 正在执行中，请等待完成后再调用`, planId: '', reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
        }
        const card = entry.card
        const saveCp = (stage: plans.PlanStage): void => {
          void saveCheckpoint(wsRoot, config.reportsDir, { planId: pid, stage, revisionRound: plans.getPlan(pid)?.revisionRound ?? 0, updatedAt: Date.now(), card }).catch(() => {})
        }
        const run = status.getRun(entry.planId) ?? status.startRun(entry.planId, card.topic, card.mode)
        const track: RunTracker = {
          progress: (phase, line) => status.pushProgress(run, phase, line),
          member: (label, event) => {
            if (event === 'start') status.memberStarted(run, label)
            else status.memberSettled(run, label, event.settle)
          },
          chapters: (chapters) => status.setChapters(run, chapters),
        }
        try {
          // 重修章节分支（要求报告已完成）
          if (args.reviseChapter !== undefined) {
            if (entry.stage !== 'done' && entry.stage !== 'error') {
              return { ok: false, status: 'error', error: `reviseChapter 仅适用于已完成的研究（当前 stage=${entry.stage}）`, planId: '', reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
            }
            plans.updatePlan(entry.planId, { stage: 'executing' })
            status.resumeRun(run)
            progress_(`重修第 ${args.reviseChapter} 章（planId=${entry.planId}）`)
            await reviseChapter(ctx, card, exec.agent, exec.signal, progress_, track, Number(args.reviseChapter), args.chapterFeedback)
            const paths = await writeReports(ctx, exec.agent, config, card)
            plans.updatePlan(entry.planId, { stage: 'done', card })
            saveCp('done')
            const result = {
              ok: true, status: 'completed', planId: entry.planId, resumed,
              title: card.title ?? card.topic, reportPath: paths.mdPath,
              outline: [], message: '',
              chapters: card.sections.map((s) => `${s.index}. ${s.title}${s.carryOverWarnings.length ? '（有遗留建议）' : ''}`),
              sourceCount: new Set(card.sourcePool).size,
              reportExcerpt: (card.finalReport ?? '').slice(0, 1500), progressLog: progress,
              htmlPath: paths.htmlPath ?? '', error: '',
            }
            status.finishRun(run, { reportPath: paths.mdPath, title: card.title ?? card.topic, sourceCount: new Set(card.sourcePool).size })
            return result
          }

          // 大纲反馈分支：带 outlineFeedback → 重新规划并再次暂停
          if (args.outlineFeedback) {
            plans.updatePlan(entry.planId, { stage: 'executing', revisionRound: entry.revisionRound + 1 })
            status.resumeRun(run)
            if (args.outlineFeedback !== entry.card.extraConstraints) {
              card.extraConstraints = [card.extraConstraints, `大纲反馈：${args.outlineFeedback}`].filter(Boolean).join('；')
            }
            progress_(`按用户反馈修订大纲（第 ${entry.revisionRound + 1} 轮）`)
            const stop = await runResearch(ctx, card, exec.agent, exec.signal, progress_, track, { outlineFeedback: String(args.outlineFeedback), onCheckpoint: () => saveCp('executing') })
            if (stop === 'awaiting-outline-confirm') {
              plans.updatePlan(entry.planId, { stage: 'awaiting-confirm', card })
              saveCp('awaiting-confirm')
              status.pauseRun(run, '等待用户确认修订后的大纲')
              return {
                ok: true, status: 'awaiting-outline-confirm', planId: entry.planId,
                title: card.title ?? card.topic,
                outline: card.sections.map((s) => `${s.index}. ${s.title}`),
                chapters: [],
                message: '大纲已按反馈修订，请再次确认（只带 planId 调用即确认开工；可继续带 outlineFeedback 调整）',
                reportPath: '', sourceCount: 0, reportExcerpt: '', htmlPath: '', error: '', progressLog: progress,
              }
            }
          } else {
            // 确认分支：只带 planId → 从 Phase 3 续跑到落盘
            plans.updatePlan(entry.planId, { stage: 'executing' })
            status.resumeRun(run)
            progress_(`大纲已确认（planId=${entry.planId}），续跑 Phase 3-5`)
            const stop = await runResearch(ctx, card, exec.agent, exec.signal, progress_, track, { onCheckpoint: () => saveCp('executing') })
            if (stop === 'awaiting-outline-confirm') {
              // quick/single 不会走到这；防御性处理
              plans.updatePlan(entry.planId, { stage: 'awaiting-confirm', card })
              saveCp('awaiting-confirm')
              status.pauseRun(run, '等待用户确认大纲')
              return {
                ok: true, status: 'awaiting-outline-confirm', planId: entry.planId,
                title: card.title ?? card.topic,
                outline: card.sections.map((s) => `${s.index}. ${s.title}`),
                chapters: [],
                message: '请确认大纲（只带 planId 调用即确认开工）', reportPath: '', sourceCount: 0, reportExcerpt: '', htmlPath: '', error: '', progressLog: progress,
              }
            }
          }

          // completed 路径：写盘 + 收尾
          const paths = await writeReports(ctx, exec.agent, config, card)
          plans.updatePlan(entry.planId, { stage: 'done', card })
          saveCp('done')
          const result = {
            ok: true, status: 'completed', planId: entry.planId, resumed,
            title: card.title ?? card.topic, reportPath: paths.mdPath,
            outline: [], message: '',
            chapters: card.sections.map((s) => `${s.index}. ${s.title}${s.carryOverWarnings.length ? '（有遗留建议）' : ''}`),
            sourceCount: new Set(card.sourcePool).size,
            reportExcerpt: (card.finalReport ?? '').slice(0, 1500), progressLog: progress,
            htmlPath: paths.htmlPath ?? '', error: '',
          }
          status.finishRun(run, { reportPath: paths.mdPath, title: card.title ?? card.topic, sourceCount: new Set(card.sourcePool).size })
          return result
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // 中断 ≠ 失败：保留断点等待续跑，不写报告、不标 done/error
          if (e instanceof ResearchInterrupted || (e instanceof Error && e.name === 'AbortError')) {
            progress_(`⏸️ ${msg}`)
            plans.updatePlan(entry.planId, { stage: 'interrupted', card })
            saveCp('interrupted')
            status.pauseRun(run, '已中断——带 planId（或同课题）再调即从断点续跑')
            return { ok: false, status: 'interrupted', error: msg, planId: entry.planId, reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
          }
          progress_(`❌ 失败：${msg}`)
          plans.updatePlan(entry.planId, { stage: 'error' })
          saveCp('error')
          status.finishRun(run, { error: msg })
          return { ok: false, status: 'error', error: msg, planId: entry.planId, reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
        }
      }

      // ───────── 全新 run ─────────
      if (!args.topic) {
        return { ok: false, status: 'error', error: '新研究必须提供 topic（或提供 planId 续跑）', planId: '', reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
      }
      const mode = (args.mode ?? 'full') as ExecutionMode
      const timeRange = (args.timeRange ?? defaultTimeRange(args.topic)) as TimeRange
      const citationFormat = (args.citationFormat ?? 'APA') as CitationFormat
      const outputFormat = (args.outputFormat ?? 'markdown') as OutputFormat

      const card = createCard({
        topic: args.topic,
        mode,
        timeRange,
        citationFormat,
        outputFormat,
        language: '中文',
        maxChapters: config.maxChapters,
        ...(args.extraConstraints ? { extraConstraints: args.extraConstraints } : {}),
      })

      const planId = runIdSeq()
      const run = status.startRun(planId, args.topic, mode)
      const track: RunTracker = {
        progress: (phase, line) => status.pushProgress(run, phase, line),
        member: (label, event) => {
          if (event === 'start') status.memberStarted(run, label)
          else status.memberSettled(run, label, event.settle)
        },
        chapters: (chapters) => status.setChapters(run, chapters),
      }
      plans.createPlan(planId, card)
      const saveCp = (stage: plans.PlanStage): void => {
        void saveCheckpoint(wsRoot, config.reportsDir, { planId, stage, revisionRound: plans.getPlan(planId)?.revisionRound ?? 0, updatedAt: Date.now(), card }).catch(() => {})
      }

      try {
        progress_(`立项：${args.topic}（${mode} / ${timeRange}）`)
        const skipConfirm = mode !== 'full' || args.skipOutlineConfirm === true
        const stop = await runResearch(ctx, card, exec.agent, exec.signal, progress_, track, { skipConfirm, onCheckpoint: () => saveCp('executing') })
        if (stop === 'awaiting-outline-confirm') {
          plans.updatePlan(planId, { stage: 'awaiting-confirm', card })
          saveCp('awaiting-confirm')
          status.pauseRun(run, '等待用户确认大纲')
          return {
            ok: true, status: 'awaiting-outline-confirm', planId,
            title: card.title ?? args.topic,
            outline: card.sections.map((s) => `${s.index}. ${s.title}`),
            chapters: [],
            message: '大纲已产出。请向用户展示并确认：只带 planId 再次调用即确认开工；带 outlineFeedback 则按意见重新规划；也可带 reviseChapter（未来重修用）',
            reportPath: '', sourceCount: 0, reportExcerpt: '', htmlPath: '', error: '', progressLog: progress,
          }
        }

        const paths = await writeReports(ctx, exec.agent, config, card)
        plans.updatePlan(planId, { stage: 'done', card })
        saveCp('done')
        const result = {
          ok: true, status: 'completed', planId,
          title: card.title ?? args.topic, reportPath: paths.mdPath,
          outline: [], message: '',
          chapters: card.sections.map((s) => `${s.index}. ${s.title}${s.carryOverWarnings.length ? '（有遗留建议）' : ''}`),
          sourceCount: new Set(card.sourcePool).size,
          reportExcerpt: (card.finalReport ?? '').slice(0, 1500), progressLog: progress,
          htmlPath: paths.htmlPath ?? '', error: '',
        }
        status.finishRun(run, {
          reportPath: paths.mdPath,
          title: card.title ?? args.topic,
          sourceCount: new Set(card.sourcePool).size,
        })
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 中断 ≠ 失败：保留断点等待续跑，不写报告、不标 done/error
        if (e instanceof ResearchInterrupted || (e instanceof Error && e.name === 'AbortError')) {
          progress_(`⏸️ ${msg}`)
          plans.updatePlan(planId, { stage: 'interrupted', card })
          saveCp('interrupted')
          status.pauseRun(run, '已中断——带 planId（或同课题）再调即从断点续跑')
          return { ok: false, status: 'interrupted', error: msg, planId, reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
        }
        progress_(`❌ 失败：${msg}`)
        plans.updatePlan(planId, { stage: 'error' })
        saveCp('error')
        status.finishRun(run, { error: msg })
        return { ok: false, status: 'error', error: msg, planId, reportPath: '', chapters: [], sourceCount: 0, reportExcerpt: '', htmlPath: '', title: '', outline: [], message: '', progressLog: progress }
      }
    },
  })))

  // ───────── 单动作直调（原版路由表）：一次调度一位成员 ─────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'research_member',
    description: [
      '深度研究团队单动作直调（原版路由表）：不需要完整流水线、只要团队某位成员单独做一件事时使用。',
      'scout=简要调研某课题；research_chapter=对某子主题写一段带引用的深度草稿；review=按 6 维标准审一段草稿；',
      'revise=按审稿意见修改草稿；frame=为已有章节写引言/结论/目录/参考文献；assemble=把已有分段整合成规范报告。',
      '完整研究报告请改用 deep_research。',
    ].join(''),
    parameters: {
      action: {
        type: 'string',
        enum: ['scout', 'research_chapter', 'review', 'revise', 'frame', 'assemble'] as const,
        description: '单动作类型（对应原版路由表）',
      },
      topic: { type: 'string', description: 'scout/research_chapter：研究课题或子主题' },
      chapterTitle: { type: 'string', description: 'research_chapter：章节标题/子主题聚焦点' },
      context: { type: 'string', description: 'research_chapter：已有上下文（初调摘要/来源池等，可选）' },
      timeRange: {
        type: 'string',
        enum: ['last_6_months', 'last_1_year', 'last_2_years', 'last_5_years', 'all'] as const,
        description: 'scout/research_chapter：时效窗口（可选）',
      },
      draft: { type: 'string', description: 'review/revise：待审/待改的草稿全文' },
      requirements: { type: 'string', description: 'review：章节预期覆盖要点（可选）' },
      feedback: { type: 'string', description: 'revise：审稿意见' },
      title: { type: 'string', description: 'frame/assemble：报告标题' },
      chaptersText: { type: 'string', description: 'frame：各章节正文（拼接）' },
      sections: { type: 'string', description: 'assemble：各分段正文（拼接）' },
      references: { type: 'string', description: 'assemble：参考文献列表（可选，缺省从正文抽取）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          member: { type: 'string', required: true },
          text: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render(args, value) {
        const v = value as { ok?: boolean; member?: string; verdict?: string; error?: string }
        const text = !v?.ok
          ? `❌ research_member 失败：${v?.error ?? '未知错误'}`
          : v.verdict
            ? `${v.verdict === 'PASS' ? '✅' : '✏️'} ${v.member ?? ''}：${v.verdict}`
            : `✅ ${v.member ?? ''} 完成`
        return [{ type: 'text', text }] satisfies ContentBlock[]
      },
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const run = status.startRun(runIdSeq(), String(args.topic ?? args.title ?? action), action, 'action')
      const progress = (line: string): void => {
        status.pushProgress(run, 0, line)
        ctx.logger?.info?.(`[research-member] ${line}`)
      }
      const settle = (label: string, start: boolean, outcome?: 'ok' | 'timeout' | 'error' | 'degraded'): void => {
        if (start) status.memberStarted(run, label)
        else if (outcome) status.memberSettled(run, label, outcome)
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

      type Spec = { role: Parameters<typeof dispatchMember>[1]['role']; label: string; task: string; forceJson?: boolean; outputSchema?: Record<string, unknown> }
      let spec: Spec
      const timeRange = (args.timeRange ?? 'last_2_years') as string
      switch (action) {
        case 'scout':
          if (!args.topic) throw new Error('scout 需要 topic')
          spec = {
            role: 'topic-researcher', label: '谭溯源·简要调研',
            task: `模式：初步调研。\n\n【课题】${args.topic}\n【时效窗口】${timeRange}\n\n请按你角色「模式一」产出 500-1000 字研究摘要（全部带真实超链接引用）+「已收集来源池」清单（≥8-15 条）。`,
          }
          break
        case 'research_chapter':
          if (!args.topic) throw new Error('research_chapter 需要 topic')
          spec = {
            role: 'topic-researcher', label: '谭溯源·章节深研',
            task: `模式：深度研究（章节调研）。\n\n【课题】${args.topic}\n【章节聚焦】${args.chapterTitle ?? args.topic}\n【时效窗口】${timeRange}\n${args.context ? `\n【已有上下文】\n${args.context}\n` : ''}\n请按你角色「模式二」产出完整章节草稿（800-1500 字、≥5 来源 ≥3 类型、带真实引用），末尾附「本章新增来源」清单。`,
          }
          break
        case 'review':
          if (!args.draft) throw new Error('review 需要 draft')
          spec = {
            role: 'draft-reviewer', label: '明鉴秋·单稿审查', forceJson: true, outputSchema: REVIEW_SCHEMA,
            task: `【current_round】1/3\n${args.requirements ? `【章节任务】${args.requirements}\n` : ''}\n【待审草稿】\n${args.draft}\n\n请按 6 维标准审查，输出 JSON（verdict/must_fix/suggestions/carry_over）。`,
          }
          break
        case 'revise':
          if (!args.draft || !args.feedback) throw new Error('revise 需要 draft 和 feedback')
          spec = {
            role: 'draft-reviser', label: '任润泽·单稿修订',
            task: `【原草稿】\n${args.draft}\n\n【审稿意见】\n${args.feedback}\n\n请逐条回应审稿意见，输出完整修订稿（非 diff）+ 修改说明（以 --- 分隔）。补充引用必须用真实来源，禁止编造 URL。`,
          }
          break
        case 'frame':
          if (!args.title || !args.chaptersText) throw new Error('frame 需要 title 和 chaptersText')
          spec = {
            role: 'report-writer', label: '程文成·框架撰写', forceJson: true,
            outputSchema: {
              type: 'object',
              properties: {
                table_of_contents: { type: 'string' },
                introduction: { type: 'string' },
                conclusion: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
              },
              required: ['table_of_contents', 'introduction', 'conclusion', 'sources'],
              additionalProperties: false,
            },
            task: `【报告标题】${args.title}\n\n【各章节正文】\n${args.chaptersText}\n\n请产出 JSON：table_of_contents / introduction / conclusion / sources（APA 去重排序）。引言引出问题、结论回答问题，引用只用章节已有来源。`,
          }
          break
        case 'assemble':
          if (!args.title || !args.sections) throw new Error('assemble 需要 title 和 sections')
          spec = {
            role: 'report-publisher', label: '傅梓铭·整合交付',
            task: `【报告标题】${args.title}　【日期】${nowDate()}\n\n【各分段正文】\n${args.sections}\n${args.references ? `\n【参考文献（供去重）】\n${args.references}\n` : ''}\n请执行 Final QA 并整合为完整 Markdown 报告（章节编号连续、--- 分隔、链接统一、参考文献去重、末尾附免责声明）。`,
          }
          break
        default:
          throw new Error(`未知 action：${action}`)
      }

      try {
        progress(`▶ ${spec.label}（${action}）`)
        settle(spec.label, true)
        const r = await dispatchMember(ctx, { parent: exec.agent, signal: exec.signal, role: spec.role, label: `🔬 [深度研究] ${spec.label}`, task: spec.task, ...(spec.forceJson ? { forceJson: true } : {}), ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}) })
        settle(spec.label, false, r.ok ? 'ok' : (r.stopReason === 'timeout' ? 'timeout' : 'error'))
        if (!r.ok && !r.text) {
          throw new Error(`${spec.label} 未完成（${r.diagnostic ?? r.stopReason}）`)
        }
        let verdict: string | undefined
        if (action === 'review') {
          try {
            const parsed = (r.structured ?? JSON.parse(r.text)) as { verdict?: string }
            verdict = parsed.verdict
          } catch { verdict = undefined }
        }
        progress(`✅ ${spec.label} 完成${verdict ? `（${verdict}）` : ''}`)
        status.finishRun(run, {})
        return { ok: true, action, member: spec.label, text: r.text, verdict: verdict ?? '', error: '' }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        progress(`❌ 失败：${msg}`)
        status.finishRun(run, { error: msg })
        return { ok: false, action, member: '', text: '', verdict: '', error: msg }
      }
    },
  })))

  // Live-status HTTP endpoint for the client panel. Reading `ctx.webServer`
  // without declaring it in `inject` throws ("cannot get property ... without
  // inject"), and adding it to the static `inject` would keep the plugin
  // INACTIVE in headless profiles. The callback-style `ctx.inject` activates
  // the scope only when the service is actually provided.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as Context & { webServer: WebServerLike }).webServer
    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: STATUS_API_PREFIX,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        if (req.method !== 'GET' || url.pathname !== STATUS_API_PREFIX) {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: 'GET /dsh-research-team/api/status only' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, value: status.snapshot() }))
      },
    }))
  })

  ctx.logger?.info?.('[dsh-research-team] deep_research / research_member 工具已注册')
}

/** 默认时效窗口：按课题关键词粗选，与原协议建议一致。 */
function defaultTimeRange(topic: string): TimeRange {
  if (/20\d{2}|最新|前沿|趋势|AI|大模型|LLM/i.test(topic)) return 'last_1_year'
  if (/学术|综述|理论|历史|演进/.test(topic)) return 'last_5_years'
  return 'last_2_years'
}

/** 当前会话工作区根：registry 命中会话 → 最后一个 workspace → 回退 cwd。 */
function resolveWorkspaceRoot(ctx: Context & { workspaceRegistry?: { list(): { path: string }[] } }, agent: unknown): string {
  try {
    const list = ctx.workspaceRegistry?.list?.() ?? []
    const last = list[list.length - 1]
    if (last?.path) return last.path
  } catch { /* registry 未就绪 */ }
  const cwd = (agent as { session?: { cwd?: string } } | undefined)?.session?.cwd
  return cwd || process.cwd()
}

function slugify(title: string): string {
  const t = title.replace(/[\\/:*?"<>|\s#]+/g, '-').replace(/^-+|-+$/g, '')
  return t.slice(0, 40) || 'research'
}

/** 从发布员输出里提取 HTML 部分（若要求 html 且发布员附带了）。 */
function extractHtml(report: string): string | undefined {
  const m = report.match(/<!DOCTYPE html[\s\S]*<\/html>/i)
  return m?.[0]
}
