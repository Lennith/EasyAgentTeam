import type { ProviderSessionRunInput } from "../../provider-session-types.js";
import {
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorProviderSessionId
} from "./orchestrator-runtime-helpers.js";

export interface BuildOrchestratorToolSessionInput {
  prompt: string;
  sessionId: string;
  providerSessionId?: string | null;
  workspaceDir: string;
  workspaceRoot: string;
  model?: string;
  reasoningEffort?: string;
  role?: string;
  rolePrompt?: string;
  contextKind?: string;
  contextOverride?: string;
  runtimeConstraints?: string[];
  skillManifestPath?: string;
  skillSegments?: string[];
  skillIds?: string[];
  requiredSkillIds?: string[];
  env?: Record<string, string>;
  sessionDirFallback?: string | null;
  apiBaseFallback: string;
  modelFallback: string;
}

export function buildOrchestratorToolSessionInput(
  input: BuildOrchestratorToolSessionInput,
  extra: Partial<ProviderSessionRunInput> = {}
): ProviderSessionRunInput {
  return {
    prompt: input.prompt,
    providerSessionId: resolveOrchestratorProviderSessionId(input.sessionId, input.providerSessionId),
    workspaceDir: input.workspaceDir,
    workspaceRoot: input.workspaceRoot,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    role: input.role,
    rolePrompt: input.rolePrompt,
    contextKind: input.contextKind,
    contextOverride: input.contextOverride,
    runtimeConstraints: input.runtimeConstraints,
    skillManifestPath: input.skillManifestPath,
    skillSegments: input.skillSegments,
    skillIds: input.skillIds,
    requiredSkillIds: input.requiredSkillIds,
    env: input.env,
    sessionDirFallback: input.sessionDirFallback?.trim() || buildOrchestratorMinimaxSessionDir(input.workspaceRoot),
    apiBaseFallback: input.apiBaseFallback,
    modelFallback: input.modelFallback,
    ...extra
  };
}
