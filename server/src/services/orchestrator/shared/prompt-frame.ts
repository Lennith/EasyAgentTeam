import type { OrchestratorPromptFrame } from "./contracts.js";
import { buildFocusTaskExecutionContractLines } from "../../prompt-contract.js";

export const DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES = buildFocusTaskExecutionContractLines();

export function createOrchestratorPromptFrame(input: OrchestratorPromptFrame): OrchestratorPromptFrame {
  return {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    role: input.role,
    sessionId: input.sessionId ?? null,
    teamWorkspace: input.teamWorkspace,
    yourWorkspace: input.yourWorkspace,
    focusTaskId: input.focusTaskId ?? null,
    visibleActionableTasks: [...input.visibleActionableTasks],
    visibleBlockedTasks: [...input.visibleBlockedTasks],
    dependenciesReady: input.dependenciesReady,
    unresolvedDependencies: [...input.unresolvedDependencies],
    executionContractLines: [...input.executionContractLines]
  };
}
