/**
 * Role prompt assets — ported from WorkBuddy gpt-researcher-team v2.0.0
 * (Expert Marketplace, MIT). Each file is the member's full system persona.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export type RoleId =
  | 'research-chief-editor'
  | 'research-planner'
  | 'topic-researcher'
  | 'draft-reviewer'
  | 'draft-reviser'
  | 'report-writer'
  | 'report-publisher'

const FILES: Record<RoleId, string> = {
  'research-chief-editor': 'research-chief-editor.md',
  'research-planner': 'research-planner.md',
  'topic-researcher': 'topic-researcher.md',
  'draft-reviewer': 'draft-reviewer.md',
  'draft-reviser': 'draft-reviser.md',
  'report-writer': 'report-writer.md',
  'report-publisher': 'report-publisher.md',
}

/** DSH-side bridge note appended to every persona: platform-specific rules. */
const DSH_BRIDGE = `

## DSH 平台桥接（重要，覆盖原平台约定）

- 你运行在 DeepSeek Harness（DSH）内，由编排器（插件 host 侧）通过一次性子代理方式调度你。
- 你可用的工具以当前会话目录为准（含 web_search / web_fetch 联网检索）。
- 「回传给主理人」= 你的最终输出文本就是回传物；编排器会把它转交下一阶段。不要试图调用 SendMessage 或团队工具——它们不存在。
- 「TeamCreate / 团队创建」由编排器承担，你永远不需要也不应该建团队。
- 严格按你角色规定的输出格式回传；除此之外不要输出寒暄或元话语。`

const cache = new Map<RoleId, string>()

/** Load one role persona (cached). Throws if the asset is missing. */
export function loadPersona(role: RoleId): string {
  const hit = cache.get(role)
  if (hit) return hit
  const text = readFileSync(join(HERE, 'prompts', FILES[role]), 'utf8')
  cache.set(role, text)
  return text
}

/** Persona = WorkBuddy role file + DSH bridge section. */
export function personaFor(role: RoleId): string {
  return loadPersona(role) + DSH_BRIDGE
}
