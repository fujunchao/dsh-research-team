/**
 * The Research Card (研究参数卡) — the single shared context object threaded
 * through all 5 phases, ported from the WorkBuddy team protocol.
 */
export type ExecutionMode = 'full' | 'quick' | 'single';
export type TimeRange = 'last_6_months' | 'last_1_year' | 'last_2_years' | 'last_5_years' | 'all';
export type CitationFormat = 'APA' | 'IEEE' | 'Chicago';
export type OutputFormat = 'markdown' | 'html';
export interface ChapterState {
    index: number;
    title: string;
    /** 谭溯源 chapter draft (latest revision). */
    draft?: string;
    /** 明鉴秋 verdict: PASS / REVISE; undefined before first review. */
    verdict?: 'PASS' | 'REVISE';
    reviewRound: number;
    /** 明鉴秋 latest review feedback (when REVISE). */
    feedback?: string;
    /** 任润泽 change log from the latest revision. */
    revisionNote?: string;
    /** true = 审稿 REVISE 已落定（feedback 待修订处理）；修订完成后清除。断点续跑据此跳过重审直接派修订. */
    reviewPending?: boolean;
    /** 第 3 轮强制通过时遗留的审稿警告. */
    carryOverWarnings: string[];
    /** 本章新增来源（来源池增量）. */
    newSources: string[];
    /** 谭溯源章末「本章小结（≤100字）」，串行模式下传给后续章节（原协议「已完成章节摘要」）. */
    summary?: string;
}
export interface ResearchCard {
    /** 研究课题. */
    topic: string;
    mode: ExecutionMode;
    timeRange: TimeRange;
    citationFormat: CitationFormat;
    outputFormat: OutputFormat;
    language: string;
    maxSections: number;
    /** 季要纲判定的章节独立性：true=可并行调研，false=有依赖需串行；undefined=未判定（回退 >5 章规则）. */
    parallelChapters?: boolean;
    /** 用户补充约束. */
    extraConstraints?: string;
    /** Phase 1: 谭溯源初步调研摘要. */
    scoutingSummary?: string;
    /** Phase 1: 已收集来源池. */
    sourcePool: string[];
    /** Phase 2: 季要纲大纲. */
    title?: string;
    sections: ChapterState[];
    /** Phase 4: 程文成 JSON 产出. */
    frame?: {
        table_of_contents: string;
        introduction: string;
        conclusion: string;
        sources: string[];
    };
    /** Phase 5: 傅梓铭最终报告. */
    finalReport?: string;
    /** 跨阶段全局警告（初调降级/来源不足等），最终汇入「待完善事项」. */
    globalWarnings: string[];
    /** Progress log lines (进度通报). */
    log: string[];
}
export declare function nowDate(): string;
export declare function createCard(input: {
    topic: string;
    mode: ExecutionMode;
    timeRange: TimeRange;
    citationFormat: CitationFormat;
    outputFormat: OutputFormat;
    language: string;
    extraConstraints?: string;
    /** full 模式章节数上限（插件配置 maxChapters），quick/single 固定 3/1. */
    maxChapters?: number;
}): ResearchCard;
/** Compact card digest injected into every member dispatch. */
export declare function cardDigest(card: ResearchCard): string;
