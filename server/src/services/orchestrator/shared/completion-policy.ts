import { readPayloadString } from "./dispatch-engine.js";

export interface OrchestratorCompletionEventLike {
  eventType: string;
  taskId?: string | null;
  payload: unknown;
}

function parsePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function isOrchestratorTerminalTaskState(state: string): boolean {
  return state === "DONE" || state === "CANCELED";
}

export function countOrchestratorTaskDispatches<TEvent extends OrchestratorCompletionEventLike>(
  taskId: string,
  recentEvents: readonly TEvent[]
): number {
  return recentEvents.filter((event) => {
    if (event.taskId !== taskId || event.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "dispatchKind") === "task";
  }).length;
}

export function hasOrchestratorSuccessfulRunFinishEvent<TEvent extends OrchestratorCompletionEventLike>(
  taskId: string,
  recentEvents: readonly TEvent[]
): boolean {
  return recentEvents.some((event) => {
    if (event.taskId !== taskId) {
      return false;
    }
    if (event.eventType !== "CODEX_RUN_FINISHED" && event.eventType !== "MINIMAX_RUN_FINISHED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return payload.exitCode === 0;
  });
}

export function isOrchestratorValidProgressContent(content: string | undefined): boolean {
  return (content ?? "").replace(/^\uFEFF/, "").trim().length > 50;
}
