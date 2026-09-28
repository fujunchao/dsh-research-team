export type RoleId = 'research-chief-editor' | 'research-planner' | 'topic-researcher' | 'draft-reviewer' | 'draft-reviser' | 'report-writer' | 'report-publisher';
/** Load one role persona (cached). Throws if the asset is missing. */
export declare function loadPersona(role: RoleId): string;
/** Persona = WorkBuddy role file + DSH bridge section. */
export declare function personaFor(role: RoleId): string;
