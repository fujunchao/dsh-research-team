# @dsh-external/dsh-research-team

**深度研究专家团** — DeepSeek Harness (DSH) 插件：把 WorkBuddy「深度研究团队」（`gpt-researcher-team@experts`）的专家团协议移植为 DSH 原生多代理工具。

对 agent 暴露一个 `deep_research` 工具：主理人（顾全之）编排 6 位领域专家，按 5 阶段流水线产出带多源超链接引用的专业研究报告，写入工作区 `reports/` 目录。

## 团队

| 成员 | 角色 | 职责 |
|---|---|---|
| 顾全之 Gu | research-chief-editor | 主理人：确认课题参数、建团队、阶段调度、汇编交付 |
| 季要纲 Ji | research-planner | 研究编辑：基于初调摘要产出章节大纲（JSON） |
| 谭溯源 Tan | topic-researcher | 课题研究员：信息引擎，初调 + 逐章深研 + 来源池建设 |
| 明鉴秋 Min | draft-reviewer | 审稿人：6 维审查，REVISE/PASS，第 3 轮强制通过 |
| 任润泽 Ren | draft-reviser | 修订员：逐条回应审稿意见，补真实引用 |
| 程文成 Cheng | report-writer | 撰写人：引言 + 结论 + 目录 + APA 参考文献去重 |
| 傅梓铭 Fu | report-publisher | 发布员：Final QA 12 项检查，拼装最终报告 |

## 五阶段流水线

1. **初调**（谭溯源）— 广泛初调 500-1000 字摘要 + 来源池 ≥8-15 条
2. **大纲规划**（季要纲）— 完整 ≤5 章 / 快速 3 章 / 单章 1 章
3. **逐章研究**（谭溯源 → 明鉴秋 → 任润泽）— 调研 → 审稿 → 修订循环，最多 3 轮，第 3 轮强制通过（遗留项写入「待完善事项」）
4. **报告框架**（程文成）— 引言 + 结论 + 目录 + 参考文献去重（目标 ≥20 来源）
5. **发布输出**（傅梓铭）— Final QA + 拼装最终 Markdown，写入 `reports/`

## 用法

对 agent 说：

```
用 deep_research 研究一下 2025 年开源模型推理框架的演进
```

参数：

| 参数 | 说明 | 缺省 |
|---|---|---|
| `topic` | 研究课题（必填） | — |
| `mode` | `full` / `quick` / `single` | `full` |
| `timeRange` | 时效窗口（last_6_months … all） | 按课题自动选择 |
| `citationFormat` | `APA` / `IEEE` / `Chicago` | `APA` |
| `outputFormat` | `markdown` / `html` | `markdown` |
| `extraConstraints` | 特殊要求（必须覆盖的点、地域限定等） | — |

浏览器端：设置面板新增「深度研究团队」页（团队介绍 + 流水线说明）。

## 安装

```bash
# 方式一：官方装配（推荐）
dsh --profile web plugin add <本仓库目录>
dsh --profile web            # 重启后生效

# 方式二：package.json 依赖 + bundles
# dependencies 加 "@dsh-external/dsh-research-team": "link:/path/to/dsh-research-team"
# dsh.profile.bundles 加 "@dsh-external/dsh-research-team"
```

要求：DSH ≥ 0.1.5-rc（提供 `tools` / `subagents` / `workspaceRegistry` 服务）。

## 构建

```bash
npm run build     # tsc 类型检查 + 声明，tsdown 打包浏览器端，复制 prompt 资产
```

构建脚本按本机布局链接类型依赖（profile node_modules / dsh 全局安装 / vault pnpm store），详见 `scripts/build.sh`。

## 设计说明

- 每个成员是一次性子代理：`ctx.subagents.start('spawn', { persona, outputSchema, ... })`，persona = WorkBuddy 角色文件全文 + DSH 平台桥接段（禁用不存在的团队工具、明确「最终输出即回传」）。
- 阶段间以「研究参数卡」（`card.ts`）为唯一中转：课题参数 → 初调摘要 → 来源池 → 大纲 → 各章状态 → 框架 → 最终报告。
- 需要结构化输出的阶段（大纲/审稿/框架）用 `outputSchema` 强制 JSON；解析失败走降级路径（审稿失败视为 PASS + 遗留警告，符合原协议的超时降级表）。
- Phase 3 章节初稿并行调研（共享参数卡），审稿-修订串行（跨章一致性优先）——与原协议一致。

## License

MIT
