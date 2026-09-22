/**
 * In-memory plan registry: a full-mode deep_research pauses after Phase 2
 * (outline) awaiting the user's confirmation, and the ResearchCard lives here
 * between the tool calls that carry the same `planId`.
 *
 * Bounded LRU (the dsh process holds no durable state: a restart drops
 * unconfirmed plans, by design — the tool contract says so).
 */
import type { ResearchCard } from './card.js'

/** Plan lifecycle, mirrored on the card between tool calls. */
export type PlanStage = 'planning' | 'awaiting-confirm' | 'executing' | 'interrupted' | 'done' | 'error'

export interface PlanEntry {
  planId: string
  stage: PlanStage
  card: ResearchCard
  createdAt: number
  updatedAt: number
  /** Outline-revision round counter (for progress display). */
  revisionRound: number
}

/** Upper bound of retained plans; oldest non-executing entries drop first. */
const MAX_PLANS = 10

const plans = new Map<string, PlanEntry>()

function prune(): void {
  if (plans.size <= MAX_PLANS) return
  const ordered = [...plans.values()].sort((a, b) => a.updatedAt - b.updatedAt)
  for (const p of ordered) {
    if (plans.size <= MAX_PLANS) break
    if (p.stage === 'executing') continue
    plans.delete(p.planId)
  }
}

export function createPlan(planId: string, card: ResearchCard): PlanEntry {
  const now = Date.now()
  const entry: PlanEntry = { planId, stage: 'planning', card, createdAt: now, updatedAt: now, revisionRound: 0 }
  plans.set(planId, entry)
  prune()
  return entry
}

export function getPlan(planId: string): PlanEntry | undefined {
  return plans.get(planId)
}

export function updatePlan(planId: string, patch: Partial<Pick<PlanEntry, 'stage' | 'revisionRound'>> & { card?: ResearchCard }): PlanEntry | undefined {
  const entry = plans.get(planId)
  if (!entry) return undefined
  if (patch.stage !== undefined) entry.stage = patch.stage
  if (patch.card !== undefined) entry.card = patch.card
  if (patch.revisionRound !== undefined) entry.revisionRound = patch.revisionRound
  entry.updatedAt = Date.now()
  return entry
}

/** All retained plans, newest first (diagnostics/panel use). */
export function listPlans(): PlanEntry[] {
  return [...plans.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}
