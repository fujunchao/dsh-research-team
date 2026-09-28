/**
 * The Research Card (研究参数卡) — the single shared context object threaded
 * through all 5 phases, ported from the WorkBuddy team protocol.
 */
export function nowDate() {
    return new Date().toISOString().slice(0, 10);
}
export function createCard(input) {
    const maxSections = input.mode === 'full'
        ? Math.min(10, Math.max(1, input.maxChapters ?? 5))
        : input.mode === 'quick' ? 3 : 1;
    return {
        ...input,
        maxSections,
        sourcePool: [],
        sections: [],
        globalWarnings: [],
        log: [],
    };
}
/** Compact card digest injected into every member dispatch. */
export function cardDigest(card) {
    const lines = [];
    lines.push(`【研究参数卡】`);
    lines.push(`- 课题: ${card.topic}`);
    lines.push(`- 执行模式: ${card.mode} (maxSections=${card.maxSections})`);
    lines.push(`- 时效窗口: ${card.timeRange}`);
    lines.push(`- 引用格式: ${card.citationFormat}；输出格式: ${card.outputFormat}`);
    lines.push(`- 语言: ${card.language}`);
    if (card.extraConstraints)
        lines.push(`- 用户特殊要求: ${card.extraConstraints}`);
    if (card.scoutingSummary) {
        // 初调摘要超长时截断：原协议摘要应 500-1000 字，实测模型可能输出 2 万+ 字符；
        // 全量内联会淹没章节任务指令、放大成员输出失稳（2026-09-26 冒烟实证：摘要
        // 28044 字符 → 章节调研两次输出英文笔记未过质量门）。
        const MAX_SUMMARY_CHARS = 6000;
        const summary = card.scoutingSummary.length > MAX_SUMMARY_CHARS
            ? `${card.scoutingSummary.slice(0, MAX_SUMMARY_CHARS)}\n…（初调摘要共 ${card.scoutingSummary.length} 字符，已截断至 ${MAX_SUMMARY_CHARS}；完整全文见 checkpoint）`
            : card.scoutingSummary;
        lines.push(`\n【Phase 1 初调摘要】\n${summary}`);
    }
    if (card.sourcePool.length > 0) {
        lines.push(`\n【已收集来源池】共 ${card.sourcePool.length} 条：`);
        for (const s of card.sourcePool)
            lines.push(`  ${s}`);
    }
    if (card.title)
        lines.push(`\n【报告标题】${card.title}`);
    if (card.sections.length > 0) {
        lines.push(`\n【大纲】共 ${card.sections.length} 章：`);
        for (const s of card.sections) {
            const flags = [];
            if (s.verdict)
                flags.push(`审稿=${s.verdict}`);
            if (s.draft)
                flags.push(`已有草稿(${s.draft.length}字)`);
            lines.push(`  ${s.index}. ${s.title}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
        }
    }
    // 已完成章节摘要（≤100字/章）：串行模式下后续章节与审稿/框架阶段据此保持跨章上下文。
    const summarized = card.sections.filter((s) => s.summary);
    if (summarized.length > 0) {
        lines.push(`\n【已完成章节摘要】`);
        for (const s of summarized)
            lines.push(`  第${s.index}章 ${s.title}：${s.summary}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=card.js.map