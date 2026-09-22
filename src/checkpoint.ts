/**
 * Durable checkpoints: the ResearchCard persisted to the workspace after
 * every phase/chapter milestone, so an interrupted run (user abort, service
 * restart, headless process death) resumes from the last checkpoint instead
 * of restarting the whole pipeline.
 *
 * Layout: `<wsRoot>/<reportsDir>/.plans/<planId>.json` — plain JSON, atomic
 * tmp+rename writes. Done-stage checkpoints are retained too (reviseChapter
 * needs the card after completion); only the topic auto-resume ignores them.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchCard } from './card.js'
import type { PlanStage } from './plans.js'

export interface Checkpoint {
  planId: string
  stage: PlanStage
  revisionRound: number
  updatedAt: number
  card: ResearchCard
}

/** Retained checkpoint files (oldest `done` pruned first beyond this). */
const MAX_CHECKPOINTS = 20
/** Stages a same-topic fresh call may auto-attach to. */
const RESUMABLE_STAGES: readonly PlanStage[] = ['awaiting-confirm', 'executing', 'interrupted']

function plansDir(wsRoot: string, reportsDir: string): string {
  return join(wsRoot, reportsDir, '.plans')
}

function normalizeTopic(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ')
}

interface CheckpointFileMeta {
  file: string
  stage: PlanStage
  updatedAt: number
}

async function readCheckpointFile(dir: string, file: string): Promise<Checkpoint | undefined> {
  try {
    const raw = await readFile(join(dir, file), 'utf8')
    const cp = JSON.parse(raw) as Checkpoint
    if (!cp?.planId || !cp?.card?.topic || typeof cp.stage !== 'string') return undefined
    return cp
  } catch {
    return undefined
  }
}

async function listCheckpoints(wsRoot: string, reportsDir: string): Promise<{ dir: string; files: string[] }> {
  const dir = plansDir(wsRoot, reportsDir)
  const files = await readdir(dir).then((all) => all.filter((f) => f.endsWith('.json')), () => [] as string[])
  return { dir, files }
}

export async function saveCheckpoint(wsRoot: string, reportsDir: string, cp: Checkpoint): Promise<void> {
  const dir = plansDir(wsRoot, reportsDir)
  await mkdir(dir, { recursive: true })
  const finalPath = join(dir, `${cp.planId}.json`)
  const tmpPath = `${finalPath}.tmp-${Date.now().toString(36)}`
  await writeFile(tmpPath, JSON.stringify(cp), 'utf8')
  await rename(tmpPath, finalPath)
  // 容量淘汰：超上限时先删最旧的 done，再删最旧的其余
  const { files } = await listCheckpoints(wsRoot, reportsDir)
  if (files.length <= MAX_CHECKPOINTS) return
  const metas: CheckpointFileMeta[] = []
  for (const f of files) {
    const c = await readCheckpointFile(dir, f)
    if (c) metas.push({ file: f, stage: c.stage, updatedAt: c.updatedAt })
  }
  const victims = [
    ...metas.filter((m) => m.stage === 'done').sort((a, b) => a.updatedAt - b.updatedAt),
    ...metas.filter((m) => m.stage !== 'done').sort((a, b) => a.updatedAt - b.updatedAt),
  ].slice(0, Math.max(0, files.length - MAX_CHECKPOINTS))
  await Promise.allSettled(victims.map((v) => rm(join(dir, v.file), { force: true })))
}

export async function loadCheckpoint(wsRoot: string, reportsDir: string, planId: string): Promise<Checkpoint | undefined> {
  const { dir, files } = await listCheckpoints(wsRoot, reportsDir)
  const file = `${planId}.json`
  if (!files.includes(file)) return undefined
  return readCheckpointFile(dir, file)
}

/** Latest resumable (non-done) checkpoint for a normalized-equal topic. */
export async function findResumableByTopic(wsRoot: string, reportsDir: string, topic: string): Promise<Checkpoint | undefined> {
  const { dir, files } = await listCheckpoints(wsRoot, reportsDir)
  const want = normalizeTopic(topic)
  let best: Checkpoint | undefined
  for (const f of files) {
    const cp = await readCheckpointFile(dir, f)
    if (!cp || !RESUMABLE_STAGES.includes(cp.stage)) continue
    if (normalizeTopic(cp.card.topic) !== want) continue
    if (!best || cp.updatedAt > best.updatedAt) best = cp
  }
  return best
}
