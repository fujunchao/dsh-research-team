# @dsh-external/dsh-research-team

**深度研究专家团** — DeepSeek Harness (DSH) 插件：把 WorkBuddy「深度研究团队」（`gpt-researcher-team@experts`）的专家团协议移植为 DSH 原生多代理工具。

对 agent 暴露两个工具：

- **`deep_research`** — 主理人（顾全之）编排 6 位领域专家，按三工作流产出带多源超链接引用的专业研究报告，写入工作区 `reports/` 目录。
- **`research_member`** — 单动作直调（原版路由表）：只要调研 / 审稿 / 改稿 / 框架 / 整合某一个动作时，单独调度对应成员。

## 团队

| 成员 | 角色 | 职责 |
|---|---|---|
| 顾全之 Gu | research-chief-editor | 主理人（由编排器承担）：确认课题参数、阶段调度、汇编交付 |
| 季要纲 Ji | research-planner | 研究编辑：基于初调摘要产出章节大纲（JSON） |
| 谭溯源 Tan | topic-researcher | 课题研究员：信息引擎，初调 + 逐章深研 + 来源池建设 |
| 明鉴秋 Min | draft-reviewer | 审稿人：6 维审查，REVISE/PASS，第 3 轮强制通过 |
| 任润泽 Ren | draft-reviser | 修订员：逐条回应审稿意见，补真实引用 |
| 程文成 Cheng | report-writer | 撰写人：引言 + 结论 + 目录 + APA 参考文献去重 |
| 傅梓铭 Fu | report-publisher | 发布员：Final QA 12 项检查，拼装最终报告 |

## 三工作流（对齐原版协议）

### Workflow A — 完整 full（默认）

```
Phase 1 初调（谭溯源）→ Phase 2 大纲（季要纲）→ 🟡 用户确认大纲
  → Phase 3 逐章 调研→审稿→修订（≤3 轮，第 3 轮强制通过）
  → Phase 4 框架（程文成）→ Phase 5 发布（傅梓铭）→ 写入 reports/
```

- **大纲确认（planId 往返）**：首次调用跑到大纲即返回 `status: 'awaiting-outline-confirm'` + `planId` + 章节列表；把大纲给用户看——
  - 用户要改 → 带 `planId + outlineFeedback` 再调（季要纲按反馈重新规划，可多轮）；
  - 用户确认 → 只带 `planId` 再调，续跑 Phase 3-5 至报告落盘；
  - 全自动场景 → 首次调用传 `skipOutlineConfirm: true` 一次跑完。
- **章节调度（原版规则）**：≤5 章串行——每章完成后 ≤100 字小结与新来源随研究参数卡传给下一章；>5 章并行（共享参数卡，输出跨章一致性警告）。
- 章节数上限由插件配置 `maxChapters` 控制（缺省 5）。

### Workflow B — 快速 quick

3 章、**跳过审稿修订**、免大纲确认，一次跑完。报告顶部固定标注 `⚠️ 本次为快速研究，未经审稿`。要速度选它。

### Workflow C — 单章 single

收窄范围只深研一个子课题：跳过大纲规划（季要纲）与框架/发布（程文成/傅梓铭），单章走完整调研→审稿循环，编排器直接拼装单章报告（参考文献从该章引用抽取）。

## 用法

```
用 deep_research 研究一下 2025 年开源模型推理框架的演进        # full：出大纲后等你确认
用 deep_research 快速研究一下 XX，quick 模式                   # quick：一次跑完
只用一章深研 XX 的推理性能对比                                  # single
帮我审一下这段研究草稿（research_member review）                # 单动作直调
```

### deep_research 参数

| 参数 | 说明 | 缺省 |
|---|---|---|
| `topic` | 研究课题（新研究必填；带 planId 时可省） | — |
| `planId` | 续跑 / 大纲反馈 / 重修章节时传入上次返回的 planId | — |
| `outlineFeedback` | 对大纲的修改意见（触发重新规划并追加进研究约束） | — |
| `skipOutlineConfirm` | full 模式跳过大纲确认一次跑完 | `false` |
| `reviseChapter` | 对已完成报告重修第 N 章（与 planId 同用） | — |
| `chapterFeedback` | 重修该章的附加要求 | — |
| `mode` | `full` / `quick` / `single` | `full` |
| `timeRange` | 时效窗口（last_6_months … all） | 按课题自动选择 |
| `citationFormat` | `APA` / `IEEE` / `Chicago` | `APA` |
| `outputFormat` | `markdown` / `html` | `markdown` |
| `extraConstraints` | 特殊要求（必须覆盖的点、地域限定等） | — |

### research_member 参数（单动作直调）

| action | 调度谁 | 必需参数 |
|---|---|---|
| `scout` | 谭溯源（模式一） | `topic`（可选 `timeRange`） |
| `research_chapter` | 谭溯源（模式二） | `topic`、`chapterTitle`（可选 `context`） |
| `review` | 明鉴秋 | `draft`（可选 `requirements`） |
| `revise` | 任润泽 | `draft`、`feedback` |
| `frame` | 程文成 | `title`、`chaptersText` |
| `assemble` | 傅梓铭 | `title`、`sections`（可选 `references`） |

浏览器端：设置面板「深度研究团队」页（团队介绍 + 实时运行监视器：full 暂停等待确认时显示 🟡）。

## 降级与兜底（对齐原版超时降级表）

| 异常 | 处理 |
|---|---|
| 成员调度失败 | 自动重试 1 次；仍失败按行降级 |
| 谭溯源超时（初调） | 有部分文本则采用 + 标注「摘要可能不完整」；无文本则如实报错（不编造来源） |
| 谭溯源超时（章节） | 该章以大纲要点占位，记入「待完善事项」 |
| 季要纲失败/解析失败 | 编排器生成 3 章占位大纲，流程继续 |
| 明鉴秋超时/解析失败 | 视为 PASS + 遗留警告 |
| 任润泽失败 | 保留修订前版本为最终稿 + 审稿警告 |
| 程文成失败 | 占位框架（目录=大纲、参考文献=来源池），Phase 5 继续 |
| 傅梓铭失败 | 编排器直接拼装最小可用报告，保证落盘 |
| 初调来源池 <8 / 某章 <5 来源 / 全文 <20 来源 | 警告行 + 记入「待完善事项」 |

成员墙钟预算按原版 maxTurns 比例差异化：谭溯源 15 分钟、季要纲 5 分钟、明鉴秋 6 分钟、其余 8 分钟。

## 已知限制

- **plan 存于内存**（LRU 上限 10 个）：dsh 进程重启后未确认的 planId 丢失，需重新发起研究。
- **执行中不可打断**：Phase 3-5 运行中无法追加信息或中止（工具调用模型限制）；需求变更请等 run 结束后用 `reviseChapter` 重修对应章节。
- full 模式 ≤5 章串行调研，耗时约为并行版的 3-5 倍——这是原版协议的质量取舍（跨章上下文传递），要快用 quick。

## 安装

```bash
# 方式一：官方装配（推荐）
dsh --profile web plugin add <本仓库目录>
dsh --profile web            # 重启后生效

# 方式二：package.json 依赖 + bundles
# dependencies 加 "@dsh-external/dsh-research-team": "link:/path/to/dsh-research-team"
# dsh.profile.bundles 加 "@dsh-external/dsh-research-team"
```

要求：DSH ≥ 0.1.5-rc（提供 `tools` / `subagents` 服务）。

## 构建

```bash
npm run build     # tsc 类型检查 + 声明，tsdown 打包浏览器端，复制 prompt 资产
```

构建脚本按本机布局链接类型依赖（profile node_modules / dsh 全局安装 / vault pnpm store），详见 `scripts/build.sh`。

## 设计说明

- 每个成员是一次性子代理：`ctx.subagents.start('spawn', { persona, outputSchema, ... })`，persona = WorkBuddy 角色文件全文 + DSH 平台桥接段（禁用不存在的团队工具、明确「最终输出即回传」）。
- 阶段间以「研究参数卡」（`card.ts`）为唯一中转：课题参数 → 初调摘要 → 来源池 → 大纲 → 各章状态（含 ≤100 字小结）→ 框架 → 最终报告。
- 需要结构化输出的阶段（大纲/审稿/框架）用 `outputSchema` 强制 JSON；解析失败走降级路径。
- 大纲确认以进程内 plan 注册表（`plans.ts`）支撑 planId 往返；运行状态（`status.ts`）经 `GET /dsh-research-team/api/status` 供浏览器面板轮询。

## License

MIT
