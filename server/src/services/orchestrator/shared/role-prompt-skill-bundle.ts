import { listAgents } from "../../../data/repository/catalog/agent-repository.js";
import {
  resolveImportedSkillPromptSegments,
  resolveSkillIdsForAgent
} from "../../../data/repository/catalog/skill-repository.js";

type OrchestratorAgentRecord = Awaited<ReturnType<typeof listAgents>>[number];

export interface ResolveOrchestratorRolePromptSkillBundleInput {
  dataRoot: string;
  role: string;
  agents?: OrchestratorAgentRecord[];
  trimRolePrompt?: boolean;
  fallbackRolePrompt?: (role: string) => string;
}

export interface ResolveOrchestratorRolePromptSkillBundleResult {
  agents: OrchestratorAgentRecord[];
  rolePrompt?: string;
  skillIds: string[];
  skillSegments: string[];
}

export interface OrchestratorRolePromptSkillBundleOperations {
  listAgents(dataRoot: string): Promise<OrchestratorAgentRecord[]>;
  resolveSkillIdsForAgent(dataRoot: string, skillListRaw: string[] | undefined): Promise<string[]>;
  resolveImportedSkillPromptSegments(dataRoot: string, skillIds: string[]): Promise<{ segments: string[] }>;
}

export const defaultOrchestratorRolePromptSkillBundleOperations: OrchestratorRolePromptSkillBundleOperations = {
  listAgents,
  resolveSkillIdsForAgent,
  resolveImportedSkillPromptSegments
};

export async function resolveOrchestratorRolePromptSkillBundle(
  input: ResolveOrchestratorRolePromptSkillBundleInput,
  operations: OrchestratorRolePromptSkillBundleOperations = defaultOrchestratorRolePromptSkillBundleOperations
): Promise<ResolveOrchestratorRolePromptSkillBundleResult> {
  const agents = input.agents ?? (await operations.listAgents(input.dataRoot));
  const roleAgent = agents.find((item) => item.agentId === input.role);
  const rolePromptRaw = roleAgent?.prompt;
  const rolePromptResolved = input.trimRolePrompt ? rolePromptRaw?.trim() : rolePromptRaw;
  const rolePrompt =
    rolePromptResolved && rolePromptResolved.length > 0 ? rolePromptResolved : input.fallbackRolePrompt?.(input.role);
  const skillIds = await operations.resolveSkillIdsForAgent(input.dataRoot, roleAgent?.skillList);
  const importedSkillPrompt = await operations.resolveImportedSkillPromptSegments(input.dataRoot, skillIds);
  return {
    agents,
    rolePrompt,
    skillIds,
    skillSegments: importedSkillPrompt.segments
  };
}
