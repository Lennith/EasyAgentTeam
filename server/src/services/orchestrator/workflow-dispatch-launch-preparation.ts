import { listAgents } from "../../data/agent-store.js";
import { getRuntimeSettings, type RuntimeSettings } from "../../data/runtime-settings-store.js";
import { resolveImportedSkillPromptSegments, resolveSkillIdsForAgent } from "../../data/skill-store.js";
import type { ProjectRecord, WorkflowRunRecord, WorkflowSessionRecord } from "../../domain/models.js";
import { buildDefaultRolePrompt, ensureAgentWorkspaces } from "../agent-workspace-service.js";
import { resolveSessionProviderId } from "../provider-runtime.js";
import { buildOrchestratorAgentCatalog, resolveOrchestratorRolePromptSkillBundle } from "./shared/index.js";

export interface PreparedWorkflowDispatchLaunch {
  requestedSkillIds: string[];
  importedSkillPrompt: { segments: string[] };
  settings: RuntimeSettings;
  providerId: string;
  tokenLimit: number;
  maxOutputTokens: number;
  rolePrompt: string;
}

export interface PrepareWorkflowDispatchLaunchInput {
  dataRoot: string;
  run: WorkflowRunRecord;
  role: string;
  session: WorkflowSessionRecord;
}

export interface WorkflowDispatchLaunchPreparationOperations {
  listAgents: typeof listAgents;
  resolveSkillIdsForAgent: typeof resolveSkillIdsForAgent;
  resolveImportedSkillPromptSegments: typeof resolveImportedSkillPromptSegments;
  getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings>;
  ensureAgentWorkspaces: typeof ensureAgentWorkspaces;
  buildDefaultRolePrompt: typeof buildDefaultRolePrompt;
}

export const defaultWorkflowDispatchLaunchPreparationOperations: WorkflowDispatchLaunchPreparationOperations = {
  listAgents,
  resolveSkillIdsForAgent,
  resolveImportedSkillPromptSegments,
  getRuntimeSettings,
  ensureAgentWorkspaces,
  buildDefaultRolePrompt
};

export async function prepareWorkflowDispatchLaunch(
  input: PrepareWorkflowDispatchLaunchInput,
  operations: WorkflowDispatchLaunchPreparationOperations = defaultWorkflowDispatchLaunchPreparationOperations
): Promise<PreparedWorkflowDispatchLaunch> {
  const agents = await operations.listAgents(input.dataRoot);
  const runRoles = Array.from(
    new Set(
      [...input.run.tasks.map((item) => item.ownerRole), input.role]
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
  );
  const agentCatalog = buildOrchestratorAgentCatalog(agents);
  const workspaceProject: ProjectRecord = {
    schemaVersion: "1.0",
    projectId: `workflow-${input.run.runId}`,
    name: input.run.name,
    workspacePath: input.run.workspacePath,
    agentIds: runRoles,
    createdAt: input.run.createdAt,
    updatedAt: input.run.updatedAt
  };
  await operations.ensureAgentWorkspaces(
    workspaceProject,
    agentCatalog.rolePromptMap,
    runRoles,
    agentCatalog.roleSummaryMap
  );

  const rolePromptSkillBundle = await resolveOrchestratorRolePromptSkillBundle(
    {
      dataRoot: input.dataRoot,
      role: input.role,
      agents,
      trimRolePrompt: true,
      fallbackRolePrompt: operations.buildDefaultRolePrompt
    },
    {
      listAgents: operations.listAgents,
      resolveSkillIdsForAgent: operations.resolveSkillIdsForAgent,
      resolveImportedSkillPromptSegments: operations.resolveImportedSkillPromptSegments
    }
  );
  const settings = await operations.getRuntimeSettings(input.dataRoot);

  return {
    requestedSkillIds: rolePromptSkillBundle.skillIds,
    importedSkillPrompt: { segments: rolePromptSkillBundle.skillSegments },
    settings,
    providerId: input.session.provider ?? resolveSessionProviderId(input.run, input.role, "minimax"),
    tokenLimit: settings.minimaxTokenLimit ?? 180000,
    maxOutputTokens: settings.minimaxMaxOutputTokens ?? 16384,
    rolePrompt: rolePromptSkillBundle.rolePrompt ?? operations.buildDefaultRolePrompt(input.role)
  };
}
