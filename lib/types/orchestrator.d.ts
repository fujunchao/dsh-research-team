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
import { type AppContext } from './dispatch.js';
import type { ResearchCard } from './card.js';
import * as status from './status.js';
export type ProgressFn = (line: string) => void;
/** Optional live-status tracking hook (phase number + the progress line). */
export interface RunTracker {
    /** Called on every progress line; `phase` is 0-5. */
    progress(phase: number, line: string): void;
    /** A member dispatch started/settled (label WITHOUT the team prefix). */
    member(label: string, event: 'start' | {
        settle: 'ok' | 'timeout' | 'error' | 'degraded';
    }): void;
    /** Chapter table replaced (call on every chapter transition). */
    chapters(chapters: status.ChapterProgress[]): void;
}
/** Where a pipeline stopped (only full mode pauses; others run to completion). */
export type PipelineStop = 'completed' | 'awaiting-outline-confirm';
/**
 * Thrown when the pipeline observes an aborted exec signal: the card keeps
 * everything already produced and the run resumes from its checkpoint —
 * unlike a member failure, an interrupt must NOT fall through the
 * degradation table (that would overwrite finished chapters with
 * placeholders and let the pipeline write a garbage report).
 */
export declare class ResearchInterrupted extends Error {
    constructor(detail: string);
}
/** Shared options for every pipeline entry point. */
export interface RunOptions {
    /** Outline feedback from the user (planId round 2+); re-plans Phase 2. */
    outlineFeedback?: string;
    /** Skip the outline-confirmation pause (full mode, unattended scenarios). */
    skipConfirm?: boolean;
    /** Called after each durable milestone; the host persists the card here. */
    onCheckpoint?: () => void;
    /** Workspace root — enables the workspace rescue path when a member writes
     * its draft into a file instead of returning it inline. */
    wsRoot?: string;
}
export declare function runResearch(ctx: AppContext, card: ResearchCard, parent: unknown, signal: AbortSignal, progress: ProgressFn, track?: RunTracker, opts?: RunOptions): Promise<PipelineStop>;
/**
 * Phase 3-5 execution (shared by fresh quick/single runs, confirmed full
 * resumes, and reviseChapter re-runs).
 */
export declare function executePhases(ctx: AppContext, card: ResearchCard, parent: unknown, signal: AbortSignal, progress: ProgressFn, track: RunTracker | undefined, opts?: RunOptions): Promise<void>;
/** Re-run one chapter (调研→审稿循环) then Phase 4/5 — reviseChapter tool. */
export declare function reviseChapter(ctx: AppContext, card: ResearchCard, parent: unknown, signal: AbortSignal, progress: ProgressFn, track: RunTracker | undefined, chapterIndex: number, chapterFeedback?: string, wsRoot?: string): Promise<ResearchCard>;
