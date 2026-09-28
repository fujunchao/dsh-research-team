/**
 * @dsh-external/dsh-research-team — 深度研究专家团插件（host 半）。
 *
 * 注册 `deep_research` 工具：主理人（顾全之）编排 6 位领域专家，按
 * WorkBuddy 原版三工作流（A 完整 / B 快速 / C 单章）产出带多源超链接
 * 引用的专业研究报告，写入工作区 reports/ 目录。full 模式在大纲产出后
 * 暂停等待用户确认（planId 往返）；另注册 `research_member` 单动作直调
 * 工具（原版路由表）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type AppContext } from './dispatch.js';
export declare const name = "@dsh-external/dsh-research-team";
export declare const inject: string[];
/** Client-panel status endpoint (must match src/client/index.tsx). */
export declare const STATUS_API_PREFIX = "/dsh-research-team/api/status";
export interface Config {
    /** full 模式章节数上限（quick=3 / single=1 固定）。 */
    maxChapters: number;
    /** 报告输出目录名（相对当前工作区根）。 */
    reportsDir: string;
}
/** Schemastery object schema for {@link Config} (type-annotated for portability). */
export declare const Config: {
    (): Config;
    (options: {
        maxChapters?: number;
        reportsDir?: string;
    }): Config;
};
export declare function apply(ctx: Context & AppContext, config: Config): void;
