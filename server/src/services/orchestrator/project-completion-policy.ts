import type { EventRecord, TaskRecord } from "../../domain/models.js";
import {
  countOrchestratorTaskDispatches,
  hasOrchestratorSuccessfulRunFinishEvent,
  isOrchestratorTerminalTaskState,
  isOrchestratorValidProgressContent,
  resolveOrchestratorMayBeDoneSettings
} from "./shared/index.js";

export function isTerminalTaskState(state: string): boolean {
  return isOrchestratorTerminalTaskState(state);
}

export function countRecentTaskDispatches(taskId: string, recentEvents: EventRecord[]): number {
  return countOrchestratorTaskDispatches(taskId, recentEvents);
}

export function hasSuccessfulRunFinishEvent(taskId: string, recentEvents: EventRecord[]): boolean {
  return hasOrchestratorSuccessfulRunFinishEvent(taskId, recentEvents);
}

export function isValidAgentProgressContent(content: string | undefined): boolean {
  return isOrchestratorValidProgressContent(content);
}

export function resolveProjectMayBeDoneSettings() {
  return resolveOrchestratorMayBeDoneSettings();
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
