import type { ResearchCard } from './card.js';
import type { PlanStage } from './plans.js';
export interface Checkpoint {
    planId: string;
    stage: PlanStage;
    revisionRound: number;
    updatedAt: number;
    card: ResearchCard;
}
export declare function saveCheckpoint(wsRoot: string, reportsDir: string, cp: Checkpoint): Promise<void>;
export declare function loadCheckpoint(wsRoot: string, reportsDir: string, planId: string): Promise<Checkpoint | undefined>;
/** Latest resumable (non-done) checkpoint for a normalized-equal topic. */
export declare function findResumableByTopic(wsRoot: string, reportsDir: string, topic: string): Promise<Checkpoint | undefined>;
