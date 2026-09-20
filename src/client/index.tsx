/**
 * @dsh-external/dsh-research-team — client 面板（settings.section slot）。
 * 设置区新增「深度研究团队」页：团队介绍、用法说明、5 阶段流水线图示。
 */
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, type ReactElement } from 'react'

type ClientContext = {
  slots: SlotRegistry
  effect(effect: () => void | (() => void), label?: string): void
}

export const name = '@dsh-external/dsh-research-team/client'
export const inject = ['slots']

const STYLE_ID = 'dsh-research-team-style'

const STYLE = `
.drt-root { display:flex; flex-direction:column; gap:16px; min-width:0; color:var(--dsw-alias-label-primary,#111827); }
.drt-hero { position:relative; overflow:hidden; padding:20px; border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16)); border-radius:16px; background:linear-gradient(135deg,rgba(49,91,255,.10),rgba(45,212,191,.07) 58%,transparent); }
.drt-kicker { color:var(--dsw-alias-label-secondary,#667085); font-size:11px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.drt-title { margin:4px 0 5px; font-size:22px; line-height:1.2; font-weight:720; letter-spacing:-.025em; }
.drt-subtitle { max-width:650px; color:var(--dsw-alias-label-secondary,#667085); font-size:12px; line-height:1.6; }
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
@media (prefers-reduced-motion:reduce) { .drt-root * { transition:none!important; } }
`

function Panel(): ReactElement {
  return (
    <div className="drt-root">
      <div className="drt-hero">
        <div className="drt-kicker">Multi-Agent Research Pipeline</div>
        <div className="drt-title">🔬 深度研究团队</div>
        <div className="drt-subtitle">
          移植自 WorkBuddy「深度研究团队」专家团协议：主理人顾全之调度 6 位领域专家，
          按 journalistic 5 阶段流水线产出带多源超链接引用的专业研究报告。
        </div>
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
