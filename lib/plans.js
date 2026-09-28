/** Upper bound of retained plans; oldest non-executing entries drop first. */
const MAX_PLANS = 10;
const plans = new Map();
function prune() {
    if (plans.size <= MAX_PLANS)
        return;
    const ordered = [...plans.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const p of ordered) {
        if (plans.size <= MAX_PLANS)
            break;
        if (p.stage === 'executing')
            continue;
        plans.delete(p.planId);
    }
}
export function createPlan(planId, card) {
    const now = Date.now();
    const entry = { planId, stage: 'planning', card, createdAt: now, updatedAt: now, revisionRound: 0 };
    plans.set(planId, entry);
    prune();
    return entry;
}
export function getPlan(planId) {
    return plans.get(planId);
}
export function updatePlan(planId, patch) {
    const entry = plans.get(planId);
    if (!entry)
        return undefined;
    if (patch.stage !== undefined)
        entry.stage = patch.stage;
    if (patch.card !== undefined)
        entry.card = patch.card;
    if (patch.revisionRound !== undefined)
        entry.revisionRound = patch.revisionRound;
    entry.updatedAt = Date.now();
    return entry;
}
/** All retained plans, newest first (diagnostics/panel use). */
export function listPlans() {
    return [...plans.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
//# sourceMappingURL=plans.js.map