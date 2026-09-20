/**
 * One-shot subagent dispatch helper: spawn a team member with its persona,
 * wait for settlement, and return the final assistant text.
 *
 * Uses `ctx.subagents.start('spawn', ...)` — the same one-shot seam the
 * official subagent tool uses — with `persona` (scoped persona shadowing)
 * and structured output where a phase needs machine-readable results.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { personaFor, type RoleId } from './personas.js'

export type AppContext = Context & {
  subagents: {
    start(
      name: string,
      request: {
        label?: string
        prompt: { type: 'text'; text: string }[]
        parent: unknown
        signal: AbortSignal
        persona?: string
        outputSchema?: Record<string, unknown>
      },
    ): Promise<{ result: Promise<SubagentResult>; dispose(): Promise<void> }>
  }
}

export interface DispatchOpts {
  parent: unknown
  signal: AbortSignal
  role: RoleId
  label: string
  task: string
  forceJson?: boolean
  outputSchema?: Record<string, unknown>
  /** Per-member wall-clock budget in ms (default 10 min, 0 = no timeout). */
  timeoutMs?: number
}

export interface DispatchResult {
  ok: boolean
  text: string
  structured?: unknown
  stopReason: string
  diagnostic?: string
}

const JSON_NOTE =
  '\n\n【输出格式强制】你的最终输出必须是单个 JSON 对象（不要 markdown 代码围栏、不要额外说明文字），严格符合给定 schema。'

/** Extract the first balanced JSON object from model text (tolerates fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text].filter((t): t is string => typeof t === 'string')
  for (const c of candidates) {
    const start = c.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < c.length; i++) {
      const ch = c[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = !inStr
      if (inStr) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  throw new Error('no parseable JSON object in member output')
}

/** Default per-member wall-clock budgets, scaled from the 原协议 maxTurns
 * table (topic-researcher 80 vs the others 20-30): the researcher does real
 * multi-source web work and needs the headroom; schema-bound roles are quick. */
const ROLE_BUDGETS_MS: Record<RoleId, number> = {
  'topic-researcher': 15 * 60 * 1000,
  'research-planner': 5 * 60 * 1000,
  'draft-reviewer': 6 * 60 * 1000,
  'draft-reviser': 8 * 60 * 1000,
  'report-writer': 8 * 60 * 1000,
  'report-publisher': 8 * 60 * 1000,
  'research-chief-editor': 10 * 60 * 1000,
}

/** One dispatch attempt (no retry). */
async function dispatchOnce(ctx: AppContext, opts: DispatchOpts, budgetMs: number): Promise<DispatchResult> {
  const persona = personaFor(opts.role) + (opts.forceJson ? JSON_NOTE : '')
  const run = await ctx.subagents.start('spawn', {
    label: opts.label,
    prompt: [{ type: 'text', text: opts.task }],
    parent: opts.parent,
    signal: opts.signal,
    persona,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    if (Number.isFinite(budgetMs)) timer = setTimeout(() => resolve('timeout'), budgetMs)
  })
  try {
    const settled = await Promise.race([run.result.then(() => 'done' as const), timedOut])
    if (settled === 'timeout') {
      void run.dispose().catch(() => {})
      return { ok: false, text: '', stopReason: 'timeout', diagnostic: `成员 ${opts.label} 超过 ${Math.round(budgetMs / 60000)} 分钟预算，按超时降级处理` }
    }
    const result = await run.result
    const text = result.output
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
      .trim()
    return {
      ok: result.stopReason === 'completed',
      text,
      structured: result.structured,
      stopReason: result.stopReason,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void run.dispose().catch(() => {})
  }
}

/**
 * Spawn one member as a one-shot child of `parent`, with the 兜底表's
 * dispatch-failure rule: an errored spawn settles after ONE retry (timeout
 * does not retry — the wall-clock budget is already spent).
 * `task` is the 研究参数卡 + phase-specific assignment text.
 * A member that exceeds its wall-clock budget settles as
 * `stopReason: 'timeout'` (the caller's degradation table decides what
 * happens next); the underlying run is disposed so a stuck request cannot
 * hold the whole pipeline forever.
 */
export async function dispatchMember(ctx: AppContext, opts: DispatchOpts): Promise<DispatchResult> {
  const budgetMs = opts.timeoutMs === 0
    ? Number.POSITIVE_INFINITY
    : (opts.timeoutMs ?? ROLE_BUDGETS_MS[opts.role])
  const first = await dispatchOnce(ctx, opts, budgetMs).catch((e: unknown) => ({
    ok: false,
    text: '',
    stopReason: 'error',
    diagnostic: e instanceof Error ? e.message : String(e),
  }))
  if (first.ok || first.stopReason === 'timeout') return first
  // 调度失败重试 1 次（原协议兜底表第一行）
  const second = await dispatchOnce(ctx, opts, budgetMs).catch((e: unknown) => ({
    ok: false,
    text: '',
    stopReason: 'error',
    diagnostic: e instanceof Error ? e.message : String(e),
  }))
  if (second.ok || second.stopReason !== first.stopReason || second.diagnostic !== first.diagnostic) return second
  return { ...second, diagnostic: `${second.diagnostic ?? 'dispatch failed'}（已重试 1 次仍失败）` }
}
