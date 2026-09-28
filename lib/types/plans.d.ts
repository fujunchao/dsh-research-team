/**
 * In-memory plan registry: a full-mode deep_research pauses after Phase 2
 * (outline) awaiting the user's confirmation, and the ResearchCard lives here
 * between the tool calls that carry the same `planId`.
 *
 * Bounded LRU (the dsh process holds no durable state: a restart drops
 * unconfirmed plans, by design — the tool contract says so).
 */
import type { ResearchCard } from './card.js';
/** Plan lifecycle, mirrored on the card between tool calls. */
export type PlanStage = 'planning' | 'awaiting-confirm' | 'executing' | 'interrupted' | 'done' | 'error';
export interface PlanEntry {
    planId: string;
    stage: PlanStage;
    card: ResearchCard;
    createdAt: number;
    updatedAt: number;
    /** Outline-revision round counter (for progress display). */
    revisionRound: number;
}
export declare function createPlan(planId: string, card: ResearchCard): PlanEntry;
export declare function getPlan(planId: string): PlanEntry | undefined;
export declare function updatePlan(planId: string, patch: Partial<Pick<PlanEntry, 'stage' | 'revisionRound'>> & {
    card?: ResearchCard;
}): PlanEntry | undefined;
/** All retained plans, newest first (diagnostics/panel use). */
export declare function listPlans(): PlanEntry[];
