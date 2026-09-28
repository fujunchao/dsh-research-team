window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-research-team",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperties(exports, {
			__esModule: { value: true },
			[Symbol.toStringTag]: { value: "Module" }
		});
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		const name = "@dsh-external/dsh-research-team/client";
		const inject = ["slots"];
		const STYLE_ID = "dsh-research-team-style";
		const STATUS_API = "/dsh-research-team/api/status";
		const POLL_MS = 3e3;
		const PHASES = [
			"立项",
			"初调",
			"大纲",
			"逐章研究",
			"框架",
			"发布"
		];
		function fmtTime(ms) {
			return new Intl.DateTimeFormat("zh-CN", {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			}).format(ms);
		}
		function fmtDuration(from, to) {
			const s = Math.max(0, Math.round((to - from) / 1e3));
			if (s < 60) return `${s}s`;
			const m = Math.floor(s / 60);
			if (m < 60) return `${m}m${s % 60}s`;
			return `${Math.floor(m / 60)}h${m % 60}m`;
		}
		const OUTCOME_ICON = {
			ok: "✅",
			timeout: "⏱️",
			error: "❌",
			degraded: "⚠️"
		};
		const CHAPTER_ICON = {
			drafting: "📝",
			reviewing: "🔍",
			revising: "✏️",
			pass: "✅",
			degraded: "⚠️"
		};
		function RunCard({ run }) {
			const running = run.state === "running" || run.state === "paused";
			const paused = run.state === "paused";
			const action = run.kind === "action";
			const [showLog, setShowLog] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `drt-run${running ? " drt-run--live" : ""}${paused ? " drt-run--paused" : ""}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-run-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `drt-run-dot${running ? paused ? " drt-run-dot--paused" : " drt-run-dot--live" : run.state === "error" ? " drt-run-dot--err" : ""}` }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "drt-run-topic",
								children: run.title ?? run.topic
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "drt-run-mode",
								children: run.mode
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "drt-run-time",
								children: [
									fmtTime(run.startedAt),
									" · ",
									fmtDuration(run.startedAt, running ? Date.now() : run.updatedAt)
								]
							})
						]
					}),
					!action && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "drt-phases-bar",
						children: PHASES.map((p, i) => {
							const active = running && run.phase === i;
							const done = run.phase > i || !running && run.state === "done";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `drt-phase-chip${active ? " drt-phase-chip--active" : ""}${done ? " drt-phase-chip--done" : ""}`,
								children: [i === 0 ? "" : `${i}/`, p]
							}, p);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "drt-headline",
						children: run.state === "error" ? `❌ ${run.error ?? "失败"}` : paused ? `🟡 ${run.headline}` : run.headline
					}),
					run.members.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "drt-members",
						children: run.members.slice(-8).map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: `drt-member${m.outcome === void 0 ? " drt-member--live" : ""}`,
							children: [
								m.outcome === void 0 ? "⏳" : OUTCOME_ICON[m.outcome],
								" ",
								m.label
							]
						}, m.label))
					}),
					run.chapters.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "drt-chapters",
						children: run.chapters.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "drt-chapter",
							children: [
								CHAPTER_ICON[c.status ?? "drafting"],
								" ",
								c.index,
								". ",
								c.title,
								c.reviewRound > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [" R", c.reviewRound] })
							]
						}, c.index))
					}),
					run.state === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-outcome",
						children: [
							"✅ 完成 · ",
							run.sourceCount ?? 0,
							" 来源 · ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: run.reportPath })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "drt-log-toggle",
						onClick: () => setShowLog(!showLog),
						children: showLog ? "收起进度日志" : `展开进度日志（${run.log.length}）`
					}),
					showLog && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "drt-log",
						children: run.log.join("\n")
					})
				]
			});
		}
		function Monitor() {
			const [snap, setSnap] = (0, react.useState)(null);
			const [failure, setFailure] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				let timer;
				const poll = async () => {
					try {
						const controller = new AbortController();
						const t = window.setTimeout(() => controller.abort(), 5e3);
						try {
							const res = await fetch(STATUS_API, { signal: controller.signal });
							if (!res.ok) throw new Error(`HTTP ${res.status}`);
							const body = await res.json();
							if (!alive) return;
							setSnap(body.value);
							setFailure(null);
						} finally {
							window.clearTimeout(t);
						}
					} catch {
						if (alive) setFailure("状态服务不可达（host 侧插件未加载或版本过旧）");
					}
					if (alive) timer = setTimeout(poll, POLL_MS);
				};
				poll();
				return () => {
					alive = false;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, []);
			if (failure !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "drt-monitor drt-monitor--empty",
				children: ["📡 ", failure]
			});
			if (snap === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "drt-monitor drt-monitor--empty",
				children: "📡 正在连接研究团队状态服务…"
			});
			const live = snap.runs.filter((r) => r.state === "running" || r.state === "paused");
			const settled = snap.runs.filter((r) => r.state !== "running" && r.state !== "paused");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "drt-monitor",
				children: [
					live.length === 0 && settled.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-monitor--empty",
						children: [
							"💤 当前没有运行中的研究。对 agent 说 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "用 deep_research 研究 …" }),
							" 启动一次。"
						]
					}),
					live.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunCard, { run: r }, r.runId)),
					live.length > 0 && settled.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "drt-monitor-sep",
						children: "近期完成"
					}),
					settled.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunCard, { run: r }, r.runId))
				]
			});
		}
		function Panel() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "drt-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-hero",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "drt-kicker",
								children: "Multi-Agent Research Pipeline"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "drt-title",
								children: "🔬 深度研究团队"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "drt-subtitle",
								children: [
									"移植自 WorkBuddy「深度研究团队」专家团协议：主理人顾全之调度 6 位领域专家， 按三工作流（完整 / 快速 / 单章）产出带多源超链接引用的专业研究报告。 完整模式在大纲产出后暂停等待确认（🟡），确认后续跑至报告落盘。 所有成员子会话以 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "🔬 [深度研究]" }),
									" 前缀出现在会话列表，可点入查看完整工作过程。"
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "📡 运行监视器" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Monitor, {})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "👥 团队成员" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "drt-grid",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "顾全之 · 主理人" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "research-chief-editor：确认课题参数、建团队、阶段调度、汇编交付" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "季要纲 · 研究编辑" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "research-planner：基于初调摘要产出章节大纲（JSON）" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "谭溯源 · 课题研究员" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "topic-researcher：信息引擎，初调 + 逐章深研，来源池建设" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "明鉴秋 · 审稿人" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "draft-reviewer：6 维审查，REVISE/PASS，第 3 轮强制通过" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "任润泽 · 修订员" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "draft-reviser：逐条回应审稿意见，补真实引用" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "程文成 · 撰写人" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "report-writer：引言 + 结论 + 目录 + APA 参考文献去重" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "drt-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "傅梓铭 · 发布员" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "report-publisher：Final QA 12 项检查，拼装最终 Markdown" })]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "drt-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "🔄 三工作流" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "drt-phases",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "drt-phase",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { children: "A" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["完整 full（默认）", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
											"初调 → 大纲（含并行/串行判定）→ ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "用户确认" }),
											" → 逐章调研→审稿→修订（≤3 轮）→ 框架 → 发布。章节独立则并行调研，有依赖则串行（小结+来源池逐章传递）。"
										] })] })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "drt-phase",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { children: "B" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["快速 quick", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "3 章、跳过审稿修订、免大纲确认，报告顶部标注「未经审稿」。要速度选它。" })] })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "drt-phase",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { children: "C" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["单章 single", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "收窄范围只深研一个子课题，走完整审稿循环，直接输出单章报告（无引言/结论）。" })] })]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "drt-usage",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "用法" }),
									"：",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "deep_research" }),
									" 完整流水线（full 首次调用返回大纲与 planId，确认/反馈后续跑）； 单一动作（只要调研/审稿/改稿/框架/整合）用 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "research_member" }),
									"； 已完成报告可 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "planId + reviseChapter" }),
									" 重修某章。 报告自动写入工作区 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "reports/" }),
									" 目录。"
								]
							})
						]
					})
				]
			});
		}
		function apply(ctx) {
			document.getElementById(STYLE_ID)?.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLE;
			document.head.append(style);
			ctx.effect(() => () => style.remove(), "@dsh-external/dsh-research-team: style");
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "@dsh-external/dsh-research-team",
				order: 63,
				label: () => "深度研究团队"
			}, Panel)), "@dsh-external/dsh-research-team: panel");
		}
		var client_default = {
			name,
			inject,
			apply
		};
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
.drt-run-dot--paused { background:#f79009; }
.drt-run-dot--err { background:#d92d20; }
.drt-run--paused { border-color:rgba(247,144,9,.45); box-shadow:0 0 0 1px rgba(247,144,9,.18); }
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
`;
		//#endregion
		exports.apply = apply;
		exports.default = client_default;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map