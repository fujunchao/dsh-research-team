/**
 * @dsh-external/dsh-research-team — client 面板（settings.section slot）。
 * 设置区「深度研究团队」页：团队介绍 + 实时运行监视器（轮询 host 侧
 * GET /dsh-research-team/api/status，展示每次 deep_research 的阶段进度、
 * 成员活动与章节状态灯）。
 */
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
type ClientContext = {
    slots: SlotRegistry;
    effect(effect: () => void | (() => void), label?: string): void;
};
export declare const name = "@dsh-external/dsh-research-team/client";
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
