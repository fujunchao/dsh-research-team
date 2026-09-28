/**
 * 成稿质量门（draft quality gate）：拦截"写作计划/工作笔记/元话语"冒充章节成稿。
 *
 * 2026-09-26 火影 run 实证三类泄漏形态（证据：审稿 feedback + 子代理 transcript）：
 *  1. 占位骨架 —— "Final structure:" + `[6 prose paragraphs, ~1400字]` / `[table ~24 rows, 5 cols]`，悬空 ### 收尾；
 *  2. 英文写作/核证笔记 —— "JACKPOT — the last search revealed…"、"Word count check"、"Now assemble…"；
 *  3. 元话语前言 —— 把全文写进工作区文件后只回传"已写入 xx.md，以下为全文回传"（正文缺失）。
 *
 * 编排器在落档/送审/修订回写前调用本模块；不合格 → 重派一次，仍不合格 → 降级。
 * 纯函数、零依赖；单测见 test/assess.test.js（先 build 出 lib/assess.js 再跑）。
 */
export type DraftKind = 'chapter' | 'revision';
export interface DraftAssessment {
    ok: boolean;
    /** 不合格理由（中文，可直接进重派警告 / carryOverWarnings / 进度行）。 */
    reasons: string[];
}
export interface AssessOptions {
    kind: DraftKind;
    /** 最短成稿长度（字符）。章节缺省 800；修订由调用方按原稿长度折算传入。 */
    minChars?: number;
}
/** 评估一段成员输出是否为合格成稿；ok=false 时 reasons 给出可直接转述的理由。 */
export declare function assessDraft(text: string, opts: AssessOptions): DraftAssessment;
