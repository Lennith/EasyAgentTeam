import type { EventRecord, TaskRecord } from "../../domain/models.js";

const TERMINAL_TASK_STATES = new Set(["DONE", "CANCELED"]);

export function isTerminalTaskState(state: string): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function countRecentTaskDispatches(taskId: string, recentEvents: EventRecord[]): number {
  return recentEvents.filter((event) => {
    if (event.taskId !== taskId || event.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return payload.dispatchKind === "task";
  }).length;
}

export function hasSuccessfulRunFinishEvent(taskId: string, recentEvents: EventRecord[]): boolean {
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

export function isValidAgentProgressContent(content: string | undefined): boolean {
  return (content ?? "").replace(/^\uFEFF/, "").trim().length > 50;
}

export function shouldMarkTaskMayBeDone(input: {
  task: TaskRecord;
  dispatchCount: number;
  threshold: number;
  hasValidOutput: boolean;
}): boolean {
  if (isTerminalTaskState(input.task.state) || input.task.state === "MAY_BE_DONE") {
    return false;
  }
  if (input.dispatchCount < input.threshold) {
    return false;
  }
  return input.hasValidOutput;
}
