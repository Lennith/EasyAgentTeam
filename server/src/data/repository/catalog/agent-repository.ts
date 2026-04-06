import path from "node:path";
import type { ProviderId } from "@autodev/agent-library";
import type { AgentDefinition, AgentRegistryState } from "../../../domain/models.js";
import { ensureDirectory } from "../../internal/persistence/file-utils.js";
import { readJsonFile, writeJsonFile } from "../../internal/persistence/store/store-runtime.js";

export class AgentStoreError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_AGENT_ID" | "INVALID_PROMPT" | "AGENT_EXISTS" | "AGENT_NOT_FOUND"
  ) {
    super(message);
  }
}

function registryPath(dataRoot: string): string {
  return path.join(dataRoot, "agents", "registry.json");
}

function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new AgentStoreError("agent_id is invalid", "INVALID_AGENT_ID");
  }
  return normalized;
}

function defaultRegistry(): AgentRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    agents: []
  };
}

async function readRegistry(dataRoot: string): Promise<AgentRegistryState> {
  const file = registryPath(dataRoot);
  return readJsonFile<AgentRegistryState>(file, defaultRegistry());
}

async function writeRegistry(dataRoot: string, state: AgentRegistryState): Promise<void> {
  const file = registryPath(dataRoot);
  await ensureDirectory(path.dirname(file));
  await writeJsonFile(file, state);
}

export async function listAgents(dataRoot: string): Promise<AgentDefinition[]> {
  const state = await readRegistry(dataRoot);
  state.agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return state.agents;
}

export async function createAgent(
  dataRoot: string,
  input: {
    agentId: string;
    displayName?: string;
    prompt: string;
    summary?: string;
    skillList?: string[];
    defaultCliTool?: ProviderId;
    defaultModelParams?: Record<string, any>;
    modelSelectionEnabled?: boolean;
  }
): Promise<AgentDefinition> {
  const state = await readRegistry(dataRoot);
  const agentId = normalizeAgentId(input.agentId);
  if (!input.prompt || !input.prompt.trim()) {
    throw new AgentStoreError("prompt is required", "INVALID_PROMPT");
  }
  if (state.agents.some((item) => item.agentId === agentId)) {
    throw new AgentStoreError(`agent '${agentId}' already exists`, "AGENT_EXISTS");
  }

  const now = new Date().toISOString();
  const agent: AgentDefinition = {
    schemaVersion: "1.0",
    agentId,
    displayName: input.displayName?.trim() || agentId,
    prompt: input.prompt.trim(),
    summary: input.summary?.trim() || undefined,
    skillList:
      input.skillList
        ?.map((item) => item.trim())
        .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index) ?? [],
    createdAt: now,
    updatedAt: now,
    defaultCliTool: input.defaultCliTool,
    defaultModelParams: input.defaultModelParams,
    modelSelectionEnabled: input.modelSelectionEnabled
  };
  state.agents.push(agent);
  state.updatedAt = now;
  state.agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  await writeRegistry(dataRoot, state);
  return agent;
}

export async function patchAgent(
  dataRoot: string,
  agentIdRaw: string,
  patch: {
    displayName?: string;
    prompt?: string;
    summary?: string | null;
    skillList?: string[];
    defaultCliTool?: ProviderId;
    defaultModelParams?: Record<string, any>;
    modelSelectionEnabled?: boolean;
  }
): Promise<AgentDefinition> {
  const state = await readRegistry(dataRoot);
  const agentId = normalizeAgentId(agentIdRaw);
  const idx = state.agents.findIndex((item) => item.agentId === agentId);
  if (idx < 0) {
    throw new AgentStoreError(`agent '${agentId}' not found`, "AGENT_NOT_FOUND");
  }
  if (patch.prompt !== undefined && !patch.prompt.trim()) {
    throw new AgentStoreError("prompt is required", "INVALID_PROMPT");
  }
  const existing = state.agents[idx];
  const normalizedSkillList =
    patch.skillList === undefined
      ? existing.skillList
      : patch.skillList
          .map((item) => item.trim())
          .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
  const next: AgentDefinition = {
    ...existing,
    displayName: patch.displayName?.trim() || existing.displayName,
    prompt: patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt,
    summary:
      patch.summary === undefined ? existing.summary : patch.summary === null ? undefined : patch.summary.trim() || undefined,
    skillList: normalizedSkillList,
    defaultCliTool: patch.defaultCliTool ?? existing.defaultCliTool,
    defaultModelParams: patch.defaultModelParams ?? existing.defaultModelParams,
    modelSelectionEnabled: patch.modelSelectionEnabled ?? existing.modelSelectionEnabled,
    updatedAt: new Date().toISOString()
  };
  state.agents[idx] = next;
  state.updatedAt = next.updatedAt;
  await writeRegistry(dataRoot, state);
  return next;
}

export async function deleteAgent(dataRoot: string, agentIdRaw: string): Promise<AgentDefinition> {
  const state = await readRegistry(dataRoot);
  const agentId = normalizeAgentId(agentIdRaw);
  const idx = state.agents.findIndex((item) => item.agentId === agentId);
  if (idx < 0) {
    throw new AgentStoreError(`agent '${agentId}' not found`, "AGENT_NOT_FOUND");
  }
  const [removed] = state.agents.splice(idx, 1);
  state.updatedAt = new Date().toISOString();
  await writeRegistry(dataRoot, state);
  return removed;
}
