/**
 * @dsh-external/dsh-research-team — client 面板（settings.section slot）。
 * 设置区「深度研究团队」页：团队介绍 + 实时运行监视器（轮询 host 侧
 * GET /dsh-research-team/api/status，展示每次 deep_research 的阶段进度、
 * 成员活动与章节状态灯）。
 */
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState, type ReactElement } from 'react'

type ClientContext = {
  slots: SlotRegistry
  effect(effect: () => void | (() => void), label?: string): void
}

export const name = '@dsh-external/dsh-research-team/client'
export const inject = ['slots']

const STYLE_ID = 'dsh-research-team-style'
const STATUS_API = '/dsh-research-team/api/status'
const POLL_MS = 3000

// ───────────────────────────── status contract ─────────────────────────────

interface MemberActivity {
  label: string
  since: number
  outcome?: 'ok' | 'timeout' | 'error' | 'degraded'
}

interface ChapterProgress {
  index: number
  title: string
  status?: 'drafting' | 'reviewing' | 'revising' | 'pass' | 'degraded'
  reviewRound: number
}

interface RunStatus {
  runId: string
  topic: string
  mode: string
  startedAt: number
  updatedAt: number
  state: 'running' | 'done' | 'error'
  phase: number
  headline: string
  log: string[]
  members: MemberActivity[]
  chapters: ChapterProgress[]
  reportPath?: string
  title?: string
  sourceCount?: number
  error?: string
}

interface StatusSnapshot {
  runs: RunStatus[]
}

// ───────────────────────────── formatting helpers ─────────────────────────────

const PHASES = ['立项', '初调', '大纲', '逐章研究', '框架', '发布']

function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms)
}

function fmtDuration(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

const OUTCOME_ICON: Record<NonNullable<MemberActivity['outcome']>, string> = {
  ok: '✅', timeout: '⏱️', error: '❌', degraded: '⚠️',
}

const CHAPTER_ICON: Record<NonNullable<ChapterProgress['status']>, string> = {
  drafting: '📝', reviewing: '🔍', revising: '✏️', pass: '✅', degraded: '⚠️',
}

// ───────────────────────────── run monitor UI ─────────────────────────────

function RunCard({ run }: { run: RunStatus }): ReactElement {
  const running = run.state === 'running'
  const [showLog, setShowLog] = useState(false)
  return (
    <div className={`drt-run${running ? ' drt-run--live' : ''}`}>
      <div className="drt-run-head">
        <span className={`drt-run-dot${running ? ' drt-run-dot--live' : run.state === 'error' ? ' drt-run-dot--err' : ''}`} />
        <span className="drt-run-topic">{run.title ?? run.topic}</span>
        <span className="drt-run-mode">{run.mode}</span>
        <span className="drt-run-time">{fmtTime(run.startedAt)} · {fmtDuration(run.startedAt, running ? Date.now() : run.updatedAt)}</span>
      </div>

      {/* phase stepper */}
      <div className="drt-phases-bar">
        {PHASES.map((p, i) => {
          const active = running && run.phase === i
          const done = run.phase > i || (!running && run.state === 'done')
          return (
            <span key={p} className={`drt-phase-chip${active ? ' drt-phase-chip--active' : ''}${done ? ' drt-phase-chip--done' : ''}`}>
              {i === 0 ? '' : `${i}/`}{p}
            </span>
          )
        })}
      </div>
      <div className="drt-headline">{run.state === 'error' ? `❌ ${run.error ?? '失败'}` : run.headline}</div>

      {/* member activity */}
      {run.members.length > 0 && (
        <div className="drt-members">
          {run.members.slice(-8).map((m) => (
            <span key={m.label} className={`drt-member${m.outcome === undefined ? ' drt-member--live' : ''}`}>
              {m.outcome === undefined ? '⏳' : OUTCOME_ICON[m.outcome]} {m.label}
            </span>
          ))}
        </div>
      )}

      {/* chapter lights */}
      {run.chapters.length > 0 && (
        <div className="drt-chapters">
          {run.chapters.map((c) => (
            <span key={c.index} className="drt-chapter">
              {CHAPTER_ICON[c.status ?? 'drafting']} {c.index}. {c.title}
              {c.reviewRound > 0 && <small> R{c.reviewRound}</small>}
            </span>
          ))}
        </div>
      )}

      {/* outcome */}
      {run.state === 'done' && (
        <div className="drt-outcome">
          ✅ 完成 · {run.sourceCount ?? 0} 来源 · <code>{run.reportPath}</code>
        </div>
      )}

      {/* log toggle */}
      <button type="button" className="drt-log-toggle" onClick={() => setShowLog(!showLog)}>
        {showLog ? '收起进度日志' : `展开进度日志（${run.log.length}）`}
      </button>
      {showLog && (
        <pre className="drt-log">{run.log.join('\n')}</pre>
      )}
    </div>
  )
}

function Monitor(): ReactElement {
  const [snap, setSnap] = useState<StatusSnapshot | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const controller = new AbortController()
        const t = window.setTimeout(() => controller.abort(), 5000)
        try {
          const res = await fetch(STATUS_API, { signal: controller.signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = (await res.json()) as { ok: boolean; value: StatusSnapshot }
          if (!alive) return
          setSnap(body.value)
          setFailure(null)
        } finally {
          window.clearTimeout(t)
        }
      } catch {
        if (alive) setFailure('状态服务不可达（host 侧插件未加载或版本过旧）')
      }
      if (alive) timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer) }
  }, [])

  if (failure !== null) {
    return <div className="drt-monitor drt-monitor--empty">📡 {failure}</div>
  }
  if (snap === null) {
    return <div className="drt-monitor drt-monitor--empty">📡 正在连接研究团队状态服务…</div>
  }
  const live = snap.runs.filter((r) => r.state === 'running')
  const settled = snap.runs.filter((r) => r.state !== 'running')
  return (
    <div className="drt-monitor">
      {live.length === 0 && settled.length === 0 && (
        <div className="drt-monitor--empty">💤 当前没有运行中的研究。对 agent 说 <code>用 deep_research 研究 …</code> 启动一次。</div>
      )}
      {live.map((r) => <RunCard key={r.runId} run={r} />)}
      {live.length > 0 && settled.length > 0 && <div className="drt-monitor-sep">近期完成</div>}
      {settled.map((r) => <RunCard key={r.runId} run={r} />)}
    </div>
  )
}

// ───────────────────────────── settings panel ─────────────────────────────

function Panel(): ReactElement {
  return (
    <div className="drt-root">
      <div className="drt-hero">
        <div className="drt-kicker">Multi-Agent Research Pipeline</div>
        <div className="drt-title">🔬 深度研究团队</div>
        <div className="drt-subtitle">
          移植自 WorkBuddy「深度研究团队」专家团协议：主理人顾全之调度 6 位领域专家，
          按 5 阶段流水线产出带多源超链接引用的专业研究报告。所有成员子会话以
          <code>🔬 [深度研究]</code> 前缀出现在会话列表，可点入查看完整工作过程。
        </div>
      </div>

      <div className="drt-section">
        <h3>📡 运行监视器</h3>
        <Monitor />
      </div>

      <div className="drt-section">
        <h3>👥 团队成员</h3>
        <div className="drt-grid">
          <div className="drt-card"><b>顾全之 · 主理人</b><span>research-chief-editor：确认课题参数、建团队、阶段调度、汇编交付</span></div>
          <div className="drt-card"><b>季要纲 · 研究编辑</b><span>research-planner：基于初调摘要产出章节大纲（JSON）</span></div>
          <div className="drt-card"><b>谭溯源 · 课题研究员</b><span>topic-researcher：信息引擎，初调 + 逐章深研，来源池建设</span></div>
          <div className="drt-card"><b>明鉴秋 · 审稿人</b><span>draft-reviewer：6 维审查，REVISE/PASS，第 3 轮强制通过</span></div>
          <div className="drt-card"><b>任润泽 · 修订员</b><span>draft-reviser：逐条回应审稿意见，补真实引用</span></div>
          <div className="drt-card"><b>程文成 · 撰写人</b><span>report-writer：引言 + 结论 + 目录 + APA 参考文献去重</span></div>
          <div className="drt-card"><b>傅梓铭 · 发布员</b><span>report-publisher：Final QA 12 项检查，拼装最终 Markdown</span></div>
        </div>
      </div>

      <div className="drt-section">
        <h3>🔄 五阶段流水线</h3>
        <div className="drt-phases">
          <div className="drt-phase"><i>1</i><div>初调（谭溯源）<small>广泛初调 500-1000 字摘要 + 来源池 ≥8-15 条</small></div></div>
          <div className="drt-phase"><i>2</i><div>大纲规划（季要纲）<small>完整 ≤5 章 / 快速 3 章 / 单章 1 章</small></div></div>
          <div className="drt-phase"><i>3</i><div>逐章研究（谭溯源 → 明鉴秋 → 任润泽）<small>调研 → 审稿 → 修订循环，最多 3 轮，第 3 轮强制通过</small></div></div>
          <div className="drt-phase"><i>4</i><div>报告框架（程文成）<small>引言 + 结论 + 目录 + 参考文献（目标 ≥20 来源）</small></div></div>
          <div className="drt-phase"><i>5</i><div>发布输出（傅梓铭）<small>Final QA + 拼装最终报告，写入工作区 reports/</small></div></div>
        </div>
        <div className="drt-usage">
          <b>用法</b>：对 agent 说 <code>用 deep_research 研究 …</code>，或直接让它深度研究某个课题。
          报告自动写入工作区 <code>reports/</code> 目录。完整模式耗时较长，窄主题建议 quick / single。
        </div>
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  const old = document.getElementById(STYLE_ID)
  old?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.append(style)
  ctx.effect(() => () => style.remove(), '@dsh-external/dsh-research-team: style')

  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: '@dsh-external/dsh-research-team',
      order: 63,
      label: () => '深度研究团队',
    }, Panel),
  ), '@dsh-external/dsh-research-team: panel')
}

export default { name, inject, apply }

// ───────────────────────────── styles ─────────────────────────────

const STYLE = `
.drt-root { display:flex; flex-direction:column; gap:16px; min-width:0; color:var(--dsw-alias-label-primary,#111827); }
.drt-hero { position:relative; overflow:hidden; padding:20px; border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16)); border-radius:16px; background:linear-gradient(135deg,rgba(49,91,255,.10),rgba(45,212,191,.07) 58%,transparent); }
.drt-kicker { color:var(--dsw-alias-label-secondary,#667085); font-size:11px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.drt-title { margin:4px 0 5px; font-size:22px; line-height:1.2; font-weight:720; letter-spacing:-.025em; }
.drt-subtitle { max-width:650px; color:var(--dsw-alias-label-secondary,#667085); font-size:12px; line-height:1.6; }
.drt-subtitle code { background:rgba(0,0,0,.06); padding:1px 5px; border-radius:4px; font-size:11px; }
.drt-section { border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16)); border-radius:14px; padding:16px; }
.drt-section h3 { margin:0 0 10px; font-size:14px; font-weight:680; }
.drt-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; }
.drt-card { padding:12px; border:1px solid rgba(127,127,127,.13); border-radius:12px; background:var(--dsw-alias-bg-base,rgba(255,255,255,.72)); }
.drt-card b { display:block; font-size:13px; margin-bottom:4px; }
.drt-card span { color:var(--dsw-alias-label-secondary,#667085); font-size:12px; line-height:1.55; }
.drt-phases { display:flex; flex-direction:column; gap:8px; }
.drt-phase { display:grid; grid-template-columns:26px minmax(0,1fr); gap:10px; align-items:baseline; }
.drt-phase i { font-style:normal; width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:rgba(49,91,255,.10); color:#315bff; font-size:11px; font-weight:700; }
.drt-phase div { font-size:12.5px; line-height:1.6; }
.drt-phase div small { display:block; color:var(--dsw-alias-label-tertiary,#98a2b3); }
.drt-usage { margin-top:8px; padding:10px 12px; background:rgba(99,102,241,.08); border-radius:10px; font-size:12.5px; line-height:1.7; }
.drt-usage code { background:rgba(0,0,0,.06); padding:1px 5px; border-radius:4px; font-size:12px; }
/* monitor */
.drt-monitor { display:flex; flex-direction:column; gap:10px; }
.drt-monitor--empty { padding:18px; text-align:center; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:12px; }
.drt-monitor--empty code { background:rgba(0,0,0,.06); padding:1px 5px; border-radius:4px; }
.drt-monitor-sep { color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; font-weight:700; letter-spacing:.08em; margin-top:4px; }
.drt-run { border:1px solid rgba(127,127,127,.16); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; }
.drt-run--live { border-color:rgba(49,91,255,.35); box-shadow:0 0 0 1px rgba(49,91,255,.15); }
.drt-run-head { display:flex; align-items:center; gap:8px; min-width:0; }
.drt-run-dot { width:8px; height:8px; border-radius:50%; background:#98a2b3; flex:none; }
.drt-run-dot--live { background:#315bff; animation:drt-pulse 1.6s ease-in-out infinite; }
.drt-run-dot--err { background:#d92d20; }
@keyframes drt-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.drt-run-topic { font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drt-run-mode { flex:none; padding:2px 7px; border-radius:999px; background:rgba(49,91,255,.09); color:#315bff; font-size:10px; font-weight:700; }
.drt-run-time { margin-left:auto; flex:none; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; font-variant-numeric:tabular-nums; }
.drt-phases-bar { display:flex; gap:4px; flex-wrap:wrap; }
.drt-phase-chip { padding:2px 8px; border-radius:999px; background:rgba(127,127,127,.10); color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:10.5px; font-weight:650; }
.drt-phase-chip--active { background:#315bff; color:#fff; animation:drt-pulse 1.6s ease-in-out infinite; }
.drt-phase-chip--done { background:rgba(18,183,106,.12); color:#039855; }
.drt-headline { font-size:12.5px; line-height:1.6; color:var(--dsw-alias-label-secondary,#667085); }
.drt-members { display:flex; gap:5px; flex-wrap:wrap; }
.drt-member { padding:2px 8px; border-radius:999px; background:rgba(127,127,127,.08); font-size:11px; color:var(--dsw-alias-label-secondary,#667085); }
.drt-member--live { background:rgba(49,91,255,.10); color:#315bff; animation:drt-pulse 1.6s ease-in-out infinite; }
.drt-chapters { display:flex; gap:5px; flex-wrap:wrap; }
.drt-chapter { padding:3px 9px; border:1px solid rgba(127,127,127,.14); border-radius:8px; font-size:11.5px; }
.drt-chapter small { color:var(--dsw-alias-label-tertiary,#98a2b3); }
.drt-outcome { font-size:12px; color:#039855; }
.drt-outcome code { background:rgba(0,0,0,.05); padding:1px 5px; border-radius:4px; font-size:11px; }
.drt-log-toggle { align-self:flex-start; border:none; background:none; padding:0; color:#315bff; font-size:11.5px; cursor:pointer; }
.drt-log { margin:0; padding:10px; max-height:220px; overflow:auto; border-radius:8px; background:rgba(127,127,127,.07); font-size:11px; line-height:1.7; white-space:pre-wrap; word-break:break-all; }
@media (prefers-reduced-motion:reduce) { .drt-root * { transition:none!important; animation:none!important; } }
`
