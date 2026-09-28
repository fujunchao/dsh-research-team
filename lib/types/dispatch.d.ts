/**
 * One-shot subagent dispatch helper: spawn a team member with its persona,
 * wait for settlement, and return the final assistant text.
 *
 * Uses `ctx.subagents.start('spawn', ...)` — the same one-shot seam the
 * official subagent tool uses — with `persona` (scoped persona shadowing)
 * and structured output where a phase needs machine-readable results.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { type RoleId } from './personas.js';
export type AppContext = Context & {
    subagents: {
        start(name: string, request: {
            label?: string;
            prompt: {
                type: 'text';
                text: string;
            }[];
            parent: unknown;
            signal: AbortSignal;
            persona?: string;
            outputSchema?: Record<string, unknown>;
        }): Promise<{
            result: Promise<SubagentResult>;
            dispose(): Promise<void>;
        }>;
    };
};
export interface DispatchOpts {
    parent: unknown;
    signal: AbortSignal;
    role: RoleId;
    label: string;
    task: string;
    forceJson?: boolean;
    outputSchema?: Record<string, unknown>;
    /** Per-member wall-clock budget in ms (default 10 min, 0 = no timeout). */
    timeoutMs?: number;
}
export interface DispatchResult {
    ok: boolean;
    text: string;
    structured?: unknown;
    stopReason: string;
    diagnostic?: string;
}
/** Extract the first balanced JSON object from model text (tolerates fences). */
export declare function extractJson(text: string): unknown;
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
export declare function dispatchMember(ctx: AppContext, opts: DispatchOpts): Promise<DispatchResult>;
