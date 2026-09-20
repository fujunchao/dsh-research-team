/**
 * In-memory run-status registry: every live deep_research execution publishes
 * its phase/member/chapter progress here, and the client panel polls it over
 * `GET /dsh-research-team/api/status`. Pure data, no DSH imports.
 *
 * One entry per deep_research tool call (keyed by a local run id). Entries
 * settle into `done`/`error` and are retained (bounded) so the panel can show
 * the last outcomes, then are pruned on the next run.
 */

export interface MemberActivity {
  /** Dispatch label WITHOUT the team prefix (e.g. 谭溯源·第2章R1). */
  label: string
  /** Epoch ms when this member was dispatched. */
  since: number
  /** Settled members carry the outcome; running members omit it. */
  outcome?: 'ok' | 'timeout' | 'error' | 'degraded'
}

export interface ChapterProgress {
  index: number
  title: string
  /** undefined = not drafted yet. */
  status?: 'drafting' | 'reviewing' | 'revising' | 'pass' | 'degraded'
  reviewRound: number
}

export interface RunStatus {
  /** Local run id (also the poll-merge key). */
  runId: string
  topic: string
  mode: string
  /** Run shape: 'pipeline' = deep_research 全流水线（缺省），'action' = research_member 单动作直调. */
  kind?: 'pipeline' | 'action'
  startedAt: number
  updatedAt: number
  /** 'running' | 'paused' | 'done' | 'error'. paused = 等待用户确认大纲. */
  state: 'running' | 'paused' | 'done' | 'error'
  /** 0-5 phase number (0 = 立项中). */
  phase: number
  /** Human progress line (latest progress callback text). */
  headline: string
  /** Recent progress lines (bounded tail, newest last). */
  log: string[]
  members: MemberActivity[]
  chapters: ChapterProgress[]
  /** Settled fields. */
  reportPath?: string
  title?: string
  sourceCount?: number
  error?: string
}

export interface StatusSnapshot {
  runs: RunStatus[]
}

/** Bounded per-run log tail. */
const MAX_LOG = 60
/** Retained settled runs (most recent first after live ones). */
const MAX_SETTLED = 5

const runs = new Map<string, RunStatus>()

function prune(): void {
  const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  const settled = all.filter((r) => r.state !== 'running' && r.state !== 'paused')
  for (const r of settled.slice(MAX_SETTLED)) runs.delete(r.runId)
}

export function snapshot(): StatusSnapshot {
  const live = [...runs.values()].filter((r) => r.state === 'running' || r.state === 'paused')
  const settled = [...runs.values()].filter((r) => r.state !== 'running' && r.state !== 'paused')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SETTLED)
  return { runs: [...live, ...settled] }
}

/** Create a new run entry; prunes old settled runs. Returns the run handle. */
export function startRun(runId: string, topic: string, mode: string, kind: 'pipeline' | 'action' = 'pipeline'): RunStatus {
  const now = Date.now()
  const run: RunStatus = {
    runId,
    topic,
    mode,
    kind,
    startedAt: now,
    updatedAt: now,
    state: 'running',
    phase: 0,
    headline: '立项中…',
    log: [],
    members: [],
    chapters: [],
  }
  runs.set(runId, run)
  prune()
  return run
}

export function getRun(runId: string): RunStatus | undefined {
  return runs.get(runId)
}

/** Progress callback target: append a log line + refresh headline/phase. */
export function pushProgress(run: RunStatus, phase: number, line: string): void {
  run.phase = phase
  run.headline = line
  run.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG)
  run.updatedAt = Date.now()
}

/** A member dispatch started (label without the team prefix). */
export function memberStarted(run: RunStatus, label: string): void {
  run.members = run.members.filter((m) => m.label !== label)
  run.members.push({ label, since: Date.now() })
  run.updatedAt = Date.now()
}

/** A member dispatch settled. */
export function memberSettled(run: RunStatus, label: string, outcome: MemberActivity['outcome']): void {
  const m = run.members.find((x) => x.label === label)
  if (m) m.outcome = outcome
  else run.members.push({ label, since: Date.now(), outcome })
  run.updatedAt = Date.now()
}

/** Replace the chapter progress table (called on phase transitions). */
export function setChapters(run: RunStatus, chapters: ChapterProgress[]): void {
  run.chapters = chapters
  run.updatedAt = Date.now()
}

/** Pause a run (full-mode pipeline awaiting the user's outline confirmation). */
export function pauseRun(run: RunStatus, headline: string): void {
  run.state = 'paused'
  run.headline = headline
  run.log.push(`[${new Date().toISOString().slice(11, 19)}] ${headline}`)
  run.updatedAt = Date.now()
}

/** Resume a paused run (outline confirmed / feedback round starting). */
export function resumeRun(run: RunStatus): void {
  run.state = 'running'
  run.updatedAt = Date.now()
}

export function finishRun(run: RunStatus, result: { reportPath?: string; title?: string; sourceCount?: number; error?: string }): void {
  run.state = result.error !== undefined ? 'error' : 'done'
  run.error = result.error
  run.reportPath = result.reportPath
  run.title = result.title
  run.sourceCount = result.sourceCount
  run.updatedAt = Date.now()
}
