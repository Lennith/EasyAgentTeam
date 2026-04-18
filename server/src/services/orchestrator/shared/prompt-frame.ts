import type { OrchestratorPromptFrame } from "./contracts.js";

export const DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES = [
  "Focus task first: prioritize this-turn focus task over other visible tasks.",
  "Non-focus task report is allowed only when dependencies are already satisfied; treat it as non-preferred side work.",
  "Never report IN_PROGRESS/DONE for tasks whose dependencies are not ready.",
  "If report fails due to dependencies, wait for dependency completion signal/reminder and then retry; retract or downgrade conflicting premature completion claims to draft."
] as const;

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
