import path from "node:path";
import type { AgentTemplateDefinition, AgentTemplateRegistryState } from "../../../domain/models.js";
import { ensureDirectory } from "../../internal/persistence/file-utils.js";
import { readJsonFile, writeJsonFile } from "../../internal/persistence/store/store-runtime.js";

export class AgentTemplateStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_TEMPLATE_ID"
      | "INVALID_PROMPT"
      | "TEMPLATE_EXISTS"
      | "TEMPLATE_NOT_FOUND"
  ) {
    super(message);
  }
}

function registryPath(dataRoot: string): string {
  return path.join(dataRoot, "agents", "templates.json");
}

function normalizeTemplateId(templateId: string): string {
  const normalized = templateId.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new AgentTemplateStoreError("template_id is invalid", "INVALID_TEMPLATE_ID");
  }
  return normalized;
}

function defaultRegistry(): AgentTemplateRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    templates: []
  };
}

async function readRegistry(dataRoot: string): Promise<AgentTemplateRegistryState> {
  return readJsonFile<AgentTemplateRegistryState>(registryPath(dataRoot), defaultRegistry());
}

async function writeRegistry(dataRoot: string, state: AgentTemplateRegistryState): Promise<void> {
  const file = registryPath(dataRoot);
  await ensureDirectory(path.dirname(file));
  await writeJsonFile(file, state);
}

export async function listCustomAgentTemplates(dataRoot: string): Promise<AgentTemplateDefinition[]> {
  const state = await readRegistry(dataRoot);
  state.templates.sort((a, b) => a.templateId.localeCompare(b.templateId));
  return state.templates;
}

export async function createCustomAgentTemplate(
  dataRoot: string,
  input: { templateId: string; displayName?: string; prompt: string; basedOnTemplateId?: string }
): Promise<AgentTemplateDefinition> {
  const state = await readRegistry(dataRoot);
  const templateId = normalizeTemplateId(input.templateId);
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) {
    throw new AgentTemplateStoreError("prompt is required", "INVALID_PROMPT");
  }
  if (state.templates.some((item) => item.templateId === templateId)) {
    throw new AgentTemplateStoreError(`template '${templateId}' already exists`, "TEMPLATE_EXISTS");
  }

  const now = new Date().toISOString();
  const template: AgentTemplateDefinition = {
    schemaVersion: "1.0",
    templateId,
    displayName: input.displayName?.trim() || templateId,
    prompt,
    createdAt: now,
    updatedAt: now,
    basedOnTemplateId: input.basedOnTemplateId?.trim() || undefined
  };
  state.templates.push(template);
  state.updatedAt = now;
  state.templates.sort((a, b) => a.templateId.localeCompare(b.templateId));
  await writeRegistry(dataRoot, state);
  return template;
}

export async function patchCustomAgentTemplate(
  dataRoot: string,
  templateIdRaw: string,
  patch: { displayName?: string; prompt?: string; basedOnTemplateId?: string | null }
): Promise<AgentTemplateDefinition> {
  const state = await readRegistry(dataRoot);
  const templateId = normalizeTemplateId(templateIdRaw);
  const idx = state.templates.findIndex((item) => item.templateId === templateId);
  if (idx < 0) {
    throw new AgentTemplateStoreError(`template '${templateId}' not found`, "TEMPLATE_NOT_FOUND");
  }
  if (patch.prompt !== undefined && !patch.prompt.trim()) {
    throw new AgentTemplateStoreError("prompt is required", "INVALID_PROMPT");
  }

  const existing = state.templates[idx];
  const updated: AgentTemplateDefinition = {
    ...existing,
    displayName: patch.displayName?.trim() || existing.displayName,
    prompt: patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt,
    basedOnTemplateId:
      patch.basedOnTemplateId === null
        ? undefined
        : patch.basedOnTemplateId?.trim() || existing.basedOnTemplateId,
    updatedAt: new Date().toISOString()
  };
  state.templates[idx] = updated;
  state.updatedAt = updated.updatedAt;
  await writeRegistry(dataRoot, state);
  return updated;
}

export async function deleteCustomAgentTemplate(
  dataRoot: string,
  templateIdRaw: string
): Promise<AgentTemplateDefinition> {
  const state = await readRegistry(dataRoot);
  const templateId = normalizeTemplateId(templateIdRaw);
  const idx = state.templates.findIndex((item) => item.templateId === templateId);
  if (idx < 0) {
    throw new AgentTemplateStoreError(`template '${templateId}' not found`, "TEMPLATE_NOT_FOUND");
  }
  const [removed] = state.templates.splice(idx, 1);
  state.updatedAt = new Date().toISOString();
  await writeRegistry(dataRoot, state);
  return removed;
}
