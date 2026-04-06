import { buildOrchestratorContextSessionKey } from "../../orchestrator-core.js";
import { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";

function extractRunIdFromScopedKey(key: string): string {
  const separator = key.indexOf("::");
  if (separator <= 0) {
    return "";
  }
  return key.slice(0, separator);
}

function removeScopedEntriesByRunId(keys: Iterable<string>, runId: string, remove: (key: string) => void): void {
  for (const key of keys) {
    if (extractRunIdFromScopedKey(key) === runId) {
      remove(key);
    }
  }
}

function pruneRunScopedEntries(keys: Iterable<string>, activeRunIds: Set<string>, remove: (key: string) => void): void {
  for (const key of keys) {
    const runId = extractRunIdFromScopedKey(key);
    if (!runId || !activeRunIds.has(runId)) {
      remove(key);
    }
  }
}

function pruneRunStateMap<TValue>(stateMap: Map<string, TValue>, activeRunIds: Set<string>): void {
  for (const runId of Array.from(stateMap.keys())) {
    if (!activeRunIds.has(runId)) {
      stateMap.delete(runId);
    }
  }
}

export interface WorkflowOrchestratorTransientState {
  activeRunIds: Set<string>;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  runHoldState: Map<string, boolean>;
  runAutoFinishStableTicks: Map<string, number>;
  sessionHeartbeatThrottle: Map<string, number>;
  buildRunSessionKey(runId: string, sessionId: string): string;
  clearRunScopedState(runId: string): void;
  clearAllTransientState(): void;
  pruneInactiveRunScopedState(activeRunIds: Set<string>): void;
}

export function createWorkflowOrchestratorTransientState(): WorkflowOrchestratorTransientState {
  const activeRunIds = new Set<string>();
  const inFlightDispatchSessionKeys = new OrchestratorSingleFlightGate();
  const runHoldState = new Map<string, boolean>();
  const runAutoFinishStableTicks = new Map<string, number>();
  const sessionHeartbeatThrottle = new Map<string, number>();

  return {
    activeRunIds,
    inFlightDispatchSessionKeys,
    runHoldState,
    runAutoFinishStableTicks,
    sessionHeartbeatThrottle,
    buildRunSessionKey: (runId: string, sessionId: string) => buildOrchestratorContextSessionKey(runId, sessionId),
    clearRunScopedState: (runId: string) => {
      runHoldState.delete(runId);
      runAutoFinishStableTicks.delete(runId);
      removeScopedEntriesByRunId(Array.from(sessionHeartbeatThrottle.keys()), runId, (key) =>
        sessionHeartbeatThrottle.delete(key)
      );
      removeScopedEntriesByRunId(Array.from(inFlightDispatchSessionKeys), runId, (key) =>
        inFlightDispatchSessionKeys.delete(key)
      );
    },
    clearAllTransientState: () => {
      activeRunIds.clear();
      runHoldState.clear();
      runAutoFinishStableTicks.clear();
      sessionHeartbeatThrottle.clear();
      inFlightDispatchSessionKeys.clear();
    },
    pruneInactiveRunScopedState: (nextActiveRunIds: Set<string>) => {
      pruneRunStateMap(runHoldState, nextActiveRunIds);
      pruneRunStateMap(runAutoFinishStableTicks, nextActiveRunIds);
      pruneRunScopedEntries(Array.from(sessionHeartbeatThrottle.keys()), nextActiveRunIds, (key) =>
        sessionHeartbeatThrottle.delete(key)
      );
      pruneRunScopedEntries(Array.from(inFlightDispatchSessionKeys), nextActiveRunIds, (key) =>
        inFlightDispatchSessionKeys.delete(key)
      );
    }
  };
}
