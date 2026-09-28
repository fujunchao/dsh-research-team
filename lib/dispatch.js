import { personaFor } from './personas.js';
const JSON_NOTE = '\n\n【输出格式强制】你的最终输出必须是单个 JSON 对象（不要 markdown 代码围栏、不要额外说明文字），严格符合给定 schema。';
/** Extract the first balanced JSON object from model text (tolerates fences). */
export function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [fenced?.[1], text].filter((t) => typeof t === 'string');
    for (const c of candidates) {
        const start = c.indexOf('{');
        if (start < 0)
            continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < c.length; i++) {
            const ch = c[i];
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === '\\') {
                esc = true;
                continue;
            }
            if (ch === '"')
                inStr = !inStr;
            if (inStr)
                continue;
            if (ch === '{')
                depth++;
            if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(c.slice(start, i + 1));
                    }
                    catch {
                        break;
                    }
                }
            }
        }
    }
    throw new Error('no parseable JSON object in member output');
}
/** Default per-member wall-clock budgets — 60 min everywhere (2026-09-26:
 * the report-publisher was disposed at 30:00.1 mid-output and the report fell
 * back to degraded assembly, so the user raised the floor to 1 hour).
 * glm-5.3-flash at max reasoning effort routinely thinks 10+ minutes before
 * emitting, and long web-research members legitimately run past 30 min. */
const ROLE_BUDGETS_MS = {
    'topic-researcher': 60 * 60 * 1000,
    'research-planner': 60 * 60 * 1000,
    'draft-reviewer': 60 * 60 * 1000,
    'draft-reviser': 60 * 60 * 1000,
    'report-writer': 60 * 60 * 1000,
    'report-publisher': 60 * 60 * 1000,
    'research-chief-editor': 60 * 60 * 1000,
};
/** One dispatch attempt (no retry). */
async function dispatchOnce(ctx, opts, budgetMs) {
    const persona = personaFor(opts.role) + (opts.forceJson ? JSON_NOTE : '');
    const run = await ctx.subagents.start('spawn', {
        label: opts.label,
        prompt: [{ type: 'text', text: opts.task }],
        parent: opts.parent,
        signal: opts.signal,
        persona,
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    });
    let timer;
    const timedOut = new Promise((resolve) => {
        if (Number.isFinite(budgetMs))
            timer = setTimeout(() => resolve('timeout'), budgetMs);
    });
    try {
        const settled = await Promise.race([run.result.then(() => 'done'), timedOut]);
        if (settled === 'timeout') {
            void run.dispose().catch(() => { });
            return { ok: false, text: '', stopReason: 'timeout', diagnostic: `成员 ${opts.label} 超过 ${Math.round(budgetMs / 60000)} 分钟预算，按超时降级处理` };
        }
        const result = await run.result;
        // 只取 text 块：result.output 可能携带 reasoning/thinking 块（英文思考过程），
        // 拼进回传文本会稀释中文占比、引入元话语误判（2026-09-26 冒烟实证）。
        const text = result.output
            .map((b) => {
            if (!b || typeof b !== 'object' || !('text' in b))
                return '';
            const blk = b;
            if (blk.type !== undefined && blk.type !== 'text')
                return '';
            return String(blk.text);
        })
            .join('')
            .trim();
        return {
            ok: result.stopReason === 'completed',
            text,
            structured: result.structured,
            stopReason: result.stopReason,
            ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        void run.dispose().catch(() => { });
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
export async function dispatchMember(ctx, opts) {
    const budgetMs = opts.timeoutMs === 0
        ? Number.POSITIVE_INFINITY
        : (opts.timeoutMs ?? ROLE_BUDGETS_MS[opts.role]);
    const first = await dispatchOnce(ctx, opts, budgetMs).catch((e) => ({
        ok: false,
        text: '',
        stopReason: 'error',
        diagnostic: e instanceof Error ? e.message : String(e),
    }));
    if (first.ok || first.stopReason === 'timeout')
        return first;
    // 调度失败重试 1 次（原协议兜底表第一行）
    const second = await dispatchOnce(ctx, opts, budgetMs).catch((e) => ({
        ok: false,
        text: '',
        stopReason: 'error',
        diagnostic: e instanceof Error ? e.message : String(e),
    }));
    if (second.ok || second.stopReason !== first.stopReason || second.diagnostic !== first.diagnostic)
        return second;
    return { ...second, diagnostic: `${second.diagnostic ?? 'dispatch failed'}（已重试 1 次仍失败）` };
}
//# sourceMappingURL=dispatch.js.map