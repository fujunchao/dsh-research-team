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

/**
 * Spawn one member as a one-shot child of `parent`.
 * `task` is the 研究参数卡 + phase-specific assignment text.
 */
export async function dispatchMember(ctx: AppContext, opts: DispatchOpts): Promise<DispatchResult> {
  const persona = personaFor(opts.role) + (opts.forceJson ? JSON_NOTE : '')
  const run = await ctx.subagents.start('spawn', {
    label: opts.label,
    prompt: [{ type: 'text', text: opts.task }],
    parent: opts.parent,
    signal: opts.signal,
    persona,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
  })
  try {
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
    void run.dispose().catch(() => {})
  }
}
