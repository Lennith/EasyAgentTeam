import type { EventRecord, TaskRecord } from "../../../domain/models.js";
import {
  countOrchestratorTaskDispatches,
  hasOrchestratorSuccessfulRunFinishEvent,
  isOrchestratorTerminalTaskState,
  isOrchestratorValidProgressContent
} from "../shared/index.js";

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
