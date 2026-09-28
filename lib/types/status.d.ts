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
    label: string;
    /** Epoch ms when this member was dispatched. */
    since: number;
    /** Settled members carry the outcome; running members omit it. */
    outcome?: 'ok' | 'timeout' | 'error' | 'degraded';
}
export interface ChapterProgress {
    index: number;
    title: string;
    /** undefined = not drafted yet. */
    status?: 'drafting' | 'reviewing' | 'revising' | 'pass' | 'degraded';
    reviewRound: number;
}
export interface RunStatus {
    /** Local run id (also the poll-merge key). */
    runId: string;
    topic: string;
    mode: string;
    /** Run shape: 'pipeline' = deep_research 全流水线（缺省），'action' = research_member 单动作直调. */
    kind?: 'pipeline' | 'action';
    startedAt: number;
    updatedAt: number;
    /** 'running' | 'paused' | 'done' | 'error'. paused = 等待用户确认大纲. */
    state: 'running' | 'paused' | 'done' | 'error';
    /** 0-5 phase number (0 = 立项中). */
    phase: number;
    /** Human progress line (latest progress callback text). */
    headline: string;
    /** Recent progress lines (bounded tail, newest last). */
    log: string[];
    members: MemberActivity[];
    chapters: ChapterProgress[];
    /** Settled fields. */
    reportPath?: string;
    title?: string;
    sourceCount?: number;
    error?: string;
}
export interface StatusSnapshot {
    runs: RunStatus[];
}
export declare function snapshot(): StatusSnapshot;
/** Create a new run entry; prunes old settled runs. Returns the run handle. */
export declare function startRun(runId: string, topic: string, mode: string, kind?: 'pipeline' | 'action'): RunStatus;
export declare function getRun(runId: string): RunStatus | undefined;
/** Progress callback target: append a log line + refresh headline/phase. */
export declare function pushProgress(run: RunStatus, phase: number, line: string): void;
/** A member dispatch started (label without the team prefix). */
export declare function memberStarted(run: RunStatus, label: string): void;
/** A member dispatch settled. */
export declare function memberSettled(run: RunStatus, label: string, outcome: MemberActivity['outcome']): void;
/** Replace the chapter progress table (called on phase transitions). */
export declare function setChapters(run: RunStatus, chapters: ChapterProgress[]): void;
/** Pause a run (full-mode pipeline awaiting the user's outline confirmation). */
export declare function pauseRun(run: RunStatus, headline: string): void;
/** Resume a paused run (outline confirmed / feedback round starting). */
export declare function resumeRun(run: RunStatus): void;
export declare function finishRun(run: RunStatus, result: {
    reportPath?: string;
    title?: string;
    sourceCount?: number;
    error?: string;
}): void;
