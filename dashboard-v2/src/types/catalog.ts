import type { ProviderId } from "@autodev/agent-library";

export interface AgentModelConfig {
  provider_id: ProviderId;
  model: string;
  effort?: "low" | "medium" | "high";
}

export interface AgentDefinition {
  agentId: string;
  displayName: string;
  prompt: string;
  summary?: string;
  skillList?: string[];
  updatedAt: string;
  defaultCliTool?: ProviderId;
  defaultModelParams?: Record<string, unknown>;
  modelSelectionEnabled?: boolean;
  createdAt?: string;
}

export interface SkillDefinition {
  schemaVersion: "1.0";
  skillId: string;
  name: string;
  description: string;
  license: string;
  compatibility: string;
  sourceType: "opencode" | "codex" | "local";
  sourcePath: string;
  packagePath: string;
  entryFile: string;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillImportItem {
  skill: SkillDefinition;
  action: "created" | "updated";
  warnings: string[];
}

export interface SkillImportResult {
  imported: SkillImportItem[];
  warnings: string[];
}

export interface SkillListDefinition {
  schemaVersion: "1.0";
  listId: string;
  displayName: string;
  description?: string;
  includeAll: boolean;
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplateDefinition {
  templateId: string;
  displayName: string;
  prompt: string;
  source: "built-in" | "custom";
  basedOnTemplateId?: string | null;
}

export interface TemplateDefinition {
  templateId: string;
  name: string;
  description?: string;
}

export type AgentView = "sessions" | "agents" | "templates";

export type DebugView = "agent-sessions" | "session-prompts" | "agent-output";

export type SkillView = "library" | "lists";
