import type { MiniMaxSessionRunInput } from "../../provider-runtime.js";
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
  extra: Partial<MiniMaxSessionRunInput> = {}
): MiniMaxSessionRunInput {
  return {
    prompt: input.prompt,
    providerSessionId: resolveOrchestratorProviderSessionId(input.sessionId, input.providerSessionId),
    workspaceDir: input.workspaceDir,
    workspaceRoot: input.workspaceRoot,
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
