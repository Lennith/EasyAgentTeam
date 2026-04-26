import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeSettings,
  type RuntimeSettings
} from "../../../data/repository/system/runtime-settings-repository.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../../domain/models.js";
import { ensureAgentWorkspaces } from "../../agent-workspace-service.js";
import { ensureProjectAgentScripts } from "../../project-agent-script-service.js";
import { buildProjectRoutingSnapshot, type ProjectRoutingSnapshot } from "../../project-routing-snapshot-service.js";
import { buildProjectDispatchPromptContext } from "./project-dispatch-prompt-context.js";
import { buildProjectDispatchPrompt } from "./project-dispatch-prompt.js";
import { writeOrchestratorPromptArtifact } from "../shared/prompt-artifact-writer.js";

export type ProjectDispatchProviderId = "codex" | "minimax";

async function ensureRolePromptFile(project: ProjectRecord, role: string): Promise<void> {
  const roleFile = path.resolve(project.workspacePath, "Agents", role, "role.md");
  let content = "";
  try {
    content = await fs.readFile(roleFile, "utf8");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      throw new Error(`role.md missing for role=${role}`);
    }
    throw error;
  }
  if (!content.replace(/^\uFEFF/, "").trim()) {
    throw new Error(`role.md empty for role=${role}`);
  }
}

export interface PrepareProjectDispatchLaunchInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  providerId: ProjectDispatchProviderId;
  taskId: string | null;
  messages: ManagerToAgentMessage[];
  allTasks: TaskRecord[];
  rolePromptMap: Map<string, string>;
  roleSummaryMap: Map<string, string>;
  registeredAgentIds: string[];
  startedAt: string;
  dispatchId: string;
}

export interface PreparedProjectDispatchLaunch {
  routingSnapshot: ProjectRoutingSnapshot;
  prompt: string;
  promptArtifactPath: string;
  modelCommand: string | undefined;
  modelParams: Record<string, string>;
}

export interface ProjectDispatchLaunchPreparationOperations {
  getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings>;
  ensureProjectAgentScripts(project: ProjectRecord): Promise<unknown>;
  ensureAgentWorkspaces: typeof ensureAgentWorkspaces;
  ensureRolePromptFile(project: ProjectRecord, role: string): Promise<void>;
  buildProjectRoutingSnapshot: typeof buildProjectRoutingSnapshot;
  buildProjectDispatchPromptContext: typeof buildProjectDispatchPromptContext;
  buildProjectDispatchPrompt: typeof buildProjectDispatchPrompt;
  writeOrchestratorPromptArtifact: typeof writeOrchestratorPromptArtifact;
}

const defaultProjectDispatchLaunchPreparationOperations: ProjectDispatchLaunchPreparationOperations = {
  getRuntimeSettings,
  ensureProjectAgentScripts,
  ensureAgentWorkspaces,
  ensureRolePromptFile,
  buildProjectRoutingSnapshot,
  buildProjectDispatchPromptContext,
  buildProjectDispatchPrompt,
  writeOrchestratorPromptArtifact
};

export async function prepareProjectDispatchLaunch(
  input: PrepareProjectDispatchLaunchInput,
  operations: ProjectDispatchLaunchPreparationOperations = defaultProjectDispatchLaunchPreparationOperations
): Promise<PreparedProjectDispatchLaunch> {
  await operations.ensureProjectAgentScripts(input.project);
  await operations.ensureAgentWorkspaces(
    input.project,
    input.rolePromptMap,
    [input.session.role],
    input.roleSummaryMap
  );
  await operations.ensureRolePromptFile(input.project, input.session.role);

  const routingSnapshot = operations.buildProjectRoutingSnapshot(
    input.project,
    input.session.role,
    input.registeredAgentIds
  );
  const runtimeSettings = await operations.getRuntimeSettings(input.dataRoot);
  const modelConfig = input.project.agentModelConfigs?.[input.session.role];
  const modelCommand =
    input.providerId === "minimax"
      ? undefined
      : (runtimeSettings.providers?.codex.cliCommand ?? runtimeSettings.codexCliCommand);
  const modelParams: Record<string, string> = {};
  if (modelConfig?.model) {
    modelParams.model = modelConfig.model;
  }
  if (modelConfig?.effort) {
    if (input.providerId === "codex") {
      modelParams.config = `model_reasoning_effort="${modelConfig.effort}"`;
    }
  }

  const promptContext = operations.buildProjectDispatchPromptContext({
    project: input.project,
    session: input.session,
    taskId: input.taskId,
    messages: input.messages,
    routingSnapshot,
    allTasks: input.allTasks
  });
  const prompt = operations.buildProjectDispatchPrompt(promptContext);
  const promptArtifactPath = await operations.writeOrchestratorPromptArtifact({
    directory: input.paths.promptsDir,
    startedAt: input.startedAt,
    sessionId: input.session.sessionId,
    dispatchId: input.dispatchId,
    prompt
  });

  return {
    routingSnapshot,
    prompt,
    promptArtifactPath,
    modelCommand,
    modelParams
  };
}
