/**
 * @dsh-external/dsh-research-team — 深度研究专家团插件。
 *
 * 注册 `deep_research` 工具：一个主理人编排的 5 阶段多代理研究流水线
 * （初调 → 大纲 → 逐章审稿修订循环 → 框架 → 发布），每个成员是一次
 * persona 注入的一次性子代理（ctx.subagents.start('spawn', ...)）。
 * 最终报告写入当前工作区 reports/ 并回传摘要。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createCard, nowDate, type CitationFormat, type ExecutionMode, type OutputFormat, type TimeRange } from './card.js'
import { runResearch } from './orchestrator.js'
import type { AppContext } from './dispatch.js'

export const name = '@dsh-external/dsh-research-team'
// workspaceRegistry is optional: some profiles (e.g. headless) do not provide
// it, and resolveWorkspaceRoot() falls back to the session cwd / process cwd.
export const inject = ['subagents', 'tools']

export interface Config {
  /** 单章最少来源数提示（硬性要求写死在成员 prompt 中，此处仅透传展示）。 */
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

export function apply(ctx: Context & AppContext, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'deep_research',
    description: [
      '启动深度研究专家团（主理人+6专家，5阶段：初调→大纲→逐章审稿修订→框架→发布），',
      '产出带多源超链接引用的专业研究报告并写入工作区 reports/ 目录。',
      '适用：行业研究、竞品分析、市场调研、学术综述、技术综述。',
      '完整模式约 3-5 章、耗时较长；快速模式 3 章；单章模式适合窄主题。',
    ].join(''),
    parameters: {
      topic: { type: 'string', required: true, description: '研究课题（一句话，必须明确可研究）' },
      mode: {
        type: 'string',
        enum: ['full', 'quick', 'single'] as const,
        description: '执行模式：full=完整(≤5章) / quick=快速(3章) / single=单章。缺省 full。',
      },
      timeRange: {
        type: 'string',
        enum: ['last_6_months', 'last_1_year', 'last_2_years', 'last_5_years', 'all'] as const,
        description: '时效窗口。缺省按课题类型自动选择（科技=last_1_year，行业=last_2_years，学术=last_5_years）。',
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
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          title: { type: 'string' },
          reportPath: { type: 'string' },
          chapters: { type: 'array', items: { type: 'string' } },
          sourceCount: { type: 'number' },
          reportExcerpt: { type: 'string' },
          progressLog: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(args, value) {
        const v = value as { ok?: boolean; title?: string; reportPath?: string; error?: string; sourceCount?: number }
        const text = v?.ok
          ? `✅ 《${v.title ?? ''}》研究报告完成（${v.sourceCount ?? 0} 个来源）→ ${v.reportPath ?? ''}`
          : `❌ 深度研究失败：${v?.error ?? '未知错误'}`
        return [{ type: 'text', text }] satisfies ContentBlock[]
      },
    },
    async execute(args, exec) {
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
        ...(args.extraConstraints ? { extraConstraints: args.extraConstraints } : {}),
      })

      const progress: string[] = []
      const progress_ = (line: string): void => {
        progress.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
        ctx.logger?.info?.(`[research-team] ${line}`)
      }

      try {
        progress_(`立项：${args.topic}（${mode} / ${timeRange}）`)
        await runResearch(ctx, card, exec.agent, exec.signal, progress_)

        // 写入工作区
        const wsRoot = resolveWorkspaceRoot(ctx, exec.agent)
        const slug = slugify(card.title ?? args.topic)
        const dir = join(wsRoot, config.reportsDir)
        await mkdir(dir, { recursive: true })
        const mdPath = join(dir, `${slug}-research-report-${nowDate()}.md`)
        await writeFile(mdPath, card.finalReport ?? '', 'utf8')
        const html = outputFormat === 'html' ? extractHtml(card.finalReport ?? '') : undefined
        const htmlPath = html ? join(dir, `${slug}-research-report-${nowDate()}.html`) : undefined
        if (htmlPath) await writeFile(htmlPath, html ?? '', 'utf8')

        const result: {
          ok: boolean
          title: string
          reportPath: string
          chapters: string[]
          sourceCount: number
          reportExcerpt: string
          progressLog: string[]
          htmlPath?: string
        } = {
          ok: true,
          title: card.title ?? args.topic,
          reportPath: mdPath,
          chapters: card.sections.map((s) => `${s.index}. ${s.title}${s.carryOverWarnings.length ? '（有遗留建议）' : ''}`),
          sourceCount: new Set(card.sourcePool).size,
          reportExcerpt: (card.finalReport ?? '').slice(0, 1500),
          progressLog: progress,
        }
        if (htmlPath) result.htmlPath = htmlPath
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        progress_(`❌ 失败：${msg}`)
        return { ok: false, error: msg, progressLog: progress }
      }
    },
  })))

  ctx.logger?.info?.('[dsh-research-team] deep_research 工具已注册')
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
