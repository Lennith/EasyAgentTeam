import { buildOrchestratorContextSessionKey } from "../../orchestrator-core.js";
import { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";

class WorkflowRunMutationMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(runId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(runId) === current) {
        this.tails.delete(runId);
      }
    }
  }

  clear(runId: string): void {
    this.tails.delete(runId);
  }

  clearAll(): void {
    this.tails.clear();
  }

  prune(activeRunIds: Set<string>): void {
    for (const runId of Array.from(this.tails.keys())) {
      if (!activeRunIds.has(runId)) {
        this.tails.delete(runId);
      }
    }
  }
}

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
  runExclusiveRuntimeMutation<T>(runId: string, operation: () => Promise<T>): Promise<T>;
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
  const runMutationMutex = new WorkflowRunMutationMutex();

  return {
    activeRunIds,
    inFlightDispatchSessionKeys,
    runHoldState,
    runAutoFinishStableTicks,
    sessionHeartbeatThrottle,
    runExclusiveRuntimeMutation: async <T>(runId: string, operation: () => Promise<T>) =>
      await runMutationMutex.runExclusive(runId, operation),
    buildRunSessionKey: (runId: string, sessionId: string) => buildOrchestratorContextSessionKey(runId, sessionId),
    clearRunScopedState: (runId: string) => {
      runHoldState.delete(runId);
      runAutoFinishStableTicks.delete(runId);
      runMutationMutex.clear(runId);
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
      runMutationMutex.clearAll();
      inFlightDispatchSessionKeys.clear();
    },
    pruneInactiveRunScopedState: (nextActiveRunIds: Set<string>) => {
      pruneRunStateMap(runHoldState, nextActiveRunIds);
      pruneRunStateMap(runAutoFinishStableTicks, nextActiveRunIds);
      runMutationMutex.prune(nextActiveRunIds);
      pruneRunScopedEntries(Array.from(sessionHeartbeatThrottle.keys()), nextActiveRunIds, (key) =>
        sessionHeartbeatThrottle.delete(key)
      );
      pruneRunScopedEntries(Array.from(inFlightDispatchSessionKeys), nextActiveRunIds, (key) =>
        inFlightDispatchSessionKeys.delete(key)
      );
    }
  };
}
